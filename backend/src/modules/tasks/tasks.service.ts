import { Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { BizError, ERR } from '../../common/errors';
import { nextNo } from '../../common/ids';
import { AuthUser } from '../../common/decorators';

interface TargetInput {
  metric: 'total_score' | 'first_response' | 'timeout_count';
  operator: 'gte' | 'lte';
  threshold: number;
}

@Injectable()
export class TasksService {
  constructor(private readonly db: DbService) {}

  /**
   * 方案 3.6 / F6：「截止后任务自动关闭，未完成的记录保留并计入未通过名单」。
   * 这里只把过期任务的状态置为 finished；完成/未完成明细仍在 task_assignees 里保留（报表照旧能看）。
   * 调用时机：① 读任务列表前（保证界面立刻正确）；② 由接待服务挂的分钟级定时任务兜底（无人访问也会关）。
   */
  async closeExpiredTasks(): Promise<number> {
    const rows = await this.db.many<{ id: number }>(
      `UPDATE tasks SET status = 'finished' WHERE status = 'running' AND deadline <= now() RETURNING id`
    );
    return rows.length;
  }

  /** 任务是否已过截止时间（开局校验用，不依赖状态字段是否已被扫描更新）。 */
  async isExpired(taskId: number): Promise<boolean> {
    const row = await this.db.one<{ expired: boolean }>(
      `SELECT (deadline <= now()) AS expired FROM tasks WHERE id = $1`,
      [taskId]
    );
    return !!row?.expired;
  }

  async list(user: AuthUser) {
    // 方案 3.6：截止后任务自动关闭——读列表前先落一次状态，避免界面还显示「进行中」。
    await this.closeExpiredTasks();
    const args: unknown[] = [];
    let filter = '';
    if (user.roleCode === 'agent') {
      // 方案 2.2：客服仅接收与执行任务，只看下发给自己的那些
      // （不用关联子查询：pg-mem 对子查询里引用外层别名支持不完整，会报 column "t.id" does not exist）
      const assigned = await this.db.many<{ task_id: number }>(
        `SELECT task_id FROM task_assignees WHERE account_id = $1`,
        [user.id]
      );
      const taskIds = assigned.map((row) => Number(row.task_id)).filter((id) => Number.isFinite(id));
      if (!taskIds.length) return [];
      args.push(...taskIds);
      filter = `AND t.id IN (${taskIds.map((_, i) => `$${i + 1}`).join(',')})`;
    }
    const rows = await this.db.many<any>(
      // scopeValue 一起返回：任务列表要显示「范围」那一列（客户 2026-10-03）
      `SELECT t.id, t.task_no AS "taskNo", t.name, t.levels, t.scope_type AS "scopeType",
              t.scope_value AS "scopeValue", t.start_at AS "startAt",
              t.deadline, t.target_count AS "targetCount", t.status
       FROM tasks t WHERE 1=1 ${filter} ORDER BY t.id DESC`,
      args
    );
    const assigneeStats = await this.db.many<any>(
      `SELECT task_id, count(*)::int AS "assigneeCount", sum(CASE WHEN status = 'done' THEN 1 ELSE 0 END)::int AS "doneCount"
       FROM task_assignees GROUP BY task_id`
    );
    const statMap = new Map(
      assigneeStats.map((s) => [Number(s.task_id), { assigneeCount: Number(s.assigneeCount || 0), doneCount: Number(s.doneCount || 0) }])
    );
    const targets = await this.db.many<any>(`SELECT task_id, metric, operator, threshold FROM task_targets ORDER BY id`);
    const targetMap = new Map<number, any[]>();
    targets.forEach((t) => {
      const list = targetMap.get(Number(t.task_id)) || [];
      list.push({ metric: t.metric, operator: t.operator, threshold: Number(t.threshold) });
      targetMap.set(Number(t.task_id), list);
    });
    // 是否下发给当前账号：带教/管理员能看到全部任务，但只有被下发的人才能开这一局，
    // 前端据此决定要不要显示「开始训练」，避免点进去才报「未下发给当前账号」。
    const mine = await this.db.many<{ task_id: number }>(
      `SELECT task_id FROM task_assignees WHERE account_id = $1`,
      [user.id]
    );
    const mineSet = new Set(mine.map((row) => Number(row.task_id)));
    const myProgressRows = await this.db.many<{ task_id: number; done_count: number; status: string }>(
      `SELECT task_id, done_count, status FROM task_assignees WHERE account_id = $1`,
      [user.id]
    );
    const myProgressMap = new Map(myProgressRows.map((row) => [Number(row.task_id), row]));
    return rows.map((row) => ({
      ...row,
      ...(statMap.get(Number(row.id)) || { assigneeCount: 0, doneCount: 0 }),
      targets: targetMap.get(Number(row.id)) || [],
      assignedToMe: mineSet.has(Number(row.id)),
      // 当前账号自己的完成次数：客服在《我的任务》里看的是「我完成几次 / 需完成几次」，
      // 而上面的 doneCount 是「已完成人数」——两个口径混在一列会出现「需完成 3 / 进度 0/1」。
      myDoneCount: Number(myProgressMap.get(Number(row.id))?.done_count || 0),
      myStatus: myProgressMap.get(Number(row.id))?.status || null,
    }));
  }

  /**
   * 任务催办（方案 F6-10）：给客服列出「快到期 / 已过期但还没完成」的任务。
   * 默认看未来 24 小时；已经过期的也一并返回，避免过期后反而没人提醒。
   * 只做站内提醒（首页与接待页的待办区），不发短信/邮件。
   */
  async reminders(user: AuthUser, withinHours = 24) {
    const cutoff = new Date(Date.now() + withinHours * 3600 * 1000).toISOString();
    const rows = await this.db.many<any>(
      `SELECT t.id, t.task_no AS "taskNo", t.name, t.deadline, t.target_count AS "targetCount",
              ta.done_count AS "doneCount"
       FROM tasks t
       JOIN task_assignees ta ON ta.task_id = t.id AND ta.account_id = $1
       WHERE t.status = 'running' AND ta.status <> 'done' AND t.deadline <= $2
       ORDER BY t.deadline`,
      [user.id, cutoff]
    );
    const now = Date.now();
    return {
      withinHours,
      items: rows.map((row) => {
        const deadline = Date.parse(row.deadline);
        const hoursLeft = Math.round(((deadline - now) / 3600000) * 10) / 10;
        return {
          id: Number(row.id),
          taskNo: row.taskNo,
          name: row.name,
          deadline: row.deadline,
          targetCount: Number(row.targetCount || 0),
          doneCount: Number(row.doneCount || 0),
          hoursLeft,
          overdue: hoursLeft < 0,
        };
      }),
    };
  }

  async create(
    user: AuthUser,
    body: { name: string; levels: string[]; startAt: string; deadline: string; targetCount: number; targets: TargetInput[]; assignees: number[]; scopeType?: string; scopeValue?: any }
  ) {
    if (!body.name) throw new BizError(ERR.PARAM, '任务名称不能为空');
    if (!body.levels?.length) throw new BizError(ERR.PARAM, '请选择难度档位');
    if (!body.deadline) throw new BizError(ERR.PARAM, '请设置截止时间');
    const taskNo = nextNo('TK');
    const task = await this.db.one<{ id: number }>(
      `INSERT INTO tasks (task_no, name, levels, scope_type, scope_value, start_at, deadline, target_count, status, created_by)
       VALUES ($1,$2,$3::jsonb,$4,$5::jsonb,$6,$7,$8,'running',$9) RETURNING id`,
      [
        taskNo,
        body.name,
        JSON.stringify(body.levels),
        body.scopeType || 'all',
        JSON.stringify(body.scopeValue || {}),
        body.startAt || new Date().toISOString(),
        body.deadline,
        body.targetCount || 1,
        user.id,
      ]
    );
    for (const target of body.targets || []) {
      await this.db.query(`INSERT INTO task_targets (task_id, metric, operator, threshold) VALUES ($1,$2,$3,$4)`, [
        task.id,
        target.metric,
        target.operator,
        target.threshold,
      ]);
    }
    for (const accountId of body.assignees || []) {
      await this.db.query(`INSERT INTO task_assignees (task_id, account_id) VALUES ($1,$2)`, [task.id, accountId]);
    }
    return { id: task.id, taskNo };
  }

  /** 任务达成判定：接待结束后调用。 */
  async evaluateAttempt(attemptId: number): Promise<{ taskId: number; passed: boolean; details: any[] } | null> {
    const attempt = await this.db.one<any>(`SELECT * FROM attempts WHERE id = $1`, [attemptId]);
    if (!attempt || attempt.source !== 'task' || !attempt.task_id) return null;
    const targets = await this.db.many<{ metric: string; operator: string; threshold: string }>(
      `SELECT metric, operator, threshold FROM task_targets WHERE task_id = $1`,
      [attempt.task_id]
    );
    const metrics = await this.db.one<any>(
      `SELECT COALESCE(max(s.max_response_sec),0) AS "firstResponse", COALESCE(sum(s.timeout_count),0) AS "timeoutCount"
       FROM sessions s WHERE s.attempt_id = $1`,
      [attemptId]
    );
    const details = targets.map((t) => {
      let actual = 0;
      if (t.metric === 'total_score') actual = Number(attempt.total_score || 0);
      else if (t.metric === 'first_response') actual = Number(metrics.firstResponse || 0);
      else actual = Number(metrics.timeoutCount || 0);
      const threshold = Number(t.threshold);
      const passed = t.operator === 'gte' ? actual >= threshold : actual <= threshold;
      return { metric: t.metric, operator: t.operator, threshold, actual, passed };
    });
    const passed = details.every((d) => d.passed);
    if (passed) {
      await this.db.query(
        `UPDATE task_assignees SET done_count = done_count + 1,
                                   status = CASE WHEN done_count + 1 >= (SELECT target_count FROM tasks WHERE id = $2) THEN 'done' ELSE 'doing' END
         WHERE task_id = $2 AND account_id = $1`,
        [attempt.account_id, attempt.task_id]
      );
      // 方案 F6-08：所有下发的客服都达到「完成次数」要求后，任务本身就是「已完成」。
      // 之前只把客服标成 done，任务状态一直停在 running，只能等截止扫描来关。
      await this.db.query(
        `UPDATE tasks SET status = 'finished'
         WHERE id = $1 AND status = 'running'
           AND NOT EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = $1 AND ta.status <> 'done')`,
        [attempt.task_id]
      );
    }
    return { taskId: attempt.task_id, passed, details };
  }

  async report(taskId: number) {
    const task = await this.db.one(`SELECT * FROM tasks WHERE id = $1`, [taskId]);
    if (!task) throw new BizError(ERR.NOT_FOUND, '任务不存在');
    const assignees = await this.db.many<any>(
      `SELECT ta.account_id AS "accountId", ac.display_name AS "accountName", ta.done_count AS "doneCount",
              ta.status, avg(a.total_score) AS "avgScoreRaw",
              COALESCE(max(a.total_score),0) AS "bestScore",
              count(a.id)::int AS "attemptCount"
       FROM task_assignees ta
       LEFT JOIN accounts ac ON ac.id = ta.account_id
       LEFT JOIN attempts a ON a.account_id = ta.account_id AND a.task_id = ta.task_id
       WHERE ta.task_id = $1
       GROUP BY ta.id, ta.account_id, ac.display_name, ta.done_count, ta.status
       ORDER BY ta.id`,
      [taskId]
    );
    const rows = assignees.map((row) => ({
      ...row,
      avgScore: Math.round(Number(row.avgScoreRaw || 0) * 10) / 10,
      avgScoreRaw: undefined,
      bestScore: Number(row.bestScore || 0),
    }));
    const doneCount = rows.filter((row) => row.status === 'done').length;
    // 方案 F6-09：任务报表要能直接看到「完成率」与「未通过名单」
    return {
      task,
      assignees: rows,
      participantCount: rows.length,
      doneCount,
      completionRate: rows.length ? Math.round((doneCount / rows.length) * 1000) / 10 : 0,
      failedAssignees: rows
        .filter((row) => row.status !== 'done')
        .map((row) => ({
          accountId: row.accountId,
          accountName: row.accountName,
          doneCount: row.doneCount,
          bestScore: row.bestScore,
          status: row.status,
        })),
    };
  }

  async remove(id: number) {
    await this.db.query(`DELETE FROM task_targets WHERE task_id = $1`, [id]);
    await this.db.query(`DELETE FROM task_assignees WHERE task_id = $1`, [id]);
    await this.db.query(`DELETE FROM tasks WHERE id = $1`, [id]);
    return { success: true };
  }
}
