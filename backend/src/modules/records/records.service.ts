import { Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { BizError, ERR } from '../../common/errors';
import { normalizePage, pageResult, PageQuery } from '../../common/pagination';
import { AuthUser } from '../../common/decorators';
import { buildXlsx } from '../../common/xlsx-writer';

@Injectable()
export class RecordsService {
  constructor(private readonly db: DbService) {}

  /**
   * 明细列表与导出共用的过滤条件（角色可见范围 + 查询条件）。
   * 抽出来是为了保证「导出」和「页面上看到的那一页」口径完全一致。
   */
  private buildFilters(
    user: AuthUser,
    query: {
      accountId?: string;
      level?: string;
      conclusion?: string;
      source?: string;
      keyword?: string;
      from?: string;
      to?: string;
      /** C6：只看有「被判无效回复」的接待（带教复盘用） */
      invalid?: string;
    }
  ): { whereSql: string; args: unknown[] } {
    const where: string[] = ["a.status <> 'running'"];
    const args: unknown[] = [];
    if (query.invalid === '1') {
      // 用非相关的 IN 子查询（不用相关 EXISTS）：pg-mem 解析不了子查询里引用外层别名
      where.push(
        `a.id IN (SELECT s2.attempt_id FROM sessions s2 JOIN messages m2 ON m2.session_id = s2.id
                  WHERE m2.rule_result->>'invalid' = 'true')`
      );
    }
    if (user.roleCode === 'agent') {
      args.push(user.id);
      where.push(`a.account_id = $${args.length}`);
    } else if (user.roleCode === 'leader' && user.groupId) {
      args.push(user.groupId);
      where.push(`ac.group_id = $${args.length}`);
    }
    if (query.accountId) {
      args.push(Number(query.accountId));
      where.push(`a.account_id = $${args.length}`);
    }
    if (query.level) {
      args.push(query.level);
      where.push(`a.level = $${args.length}`);
    }
    if (query.conclusion) {
      args.push(query.conclusion);
      where.push(`a.conclusion = $${args.length}`);
    }
    if (query.source) {
      args.push(query.source);
      where.push(`a.source = $${args.length}`);
    }
    if (query.keyword) {
      args.push(`%${query.keyword}%`);
      where.push(`(a.attempt_no ILIKE $${args.length} OR ac.display_name ILIKE $${args.length})`);
    }
    if (query.from) {
      args.push(query.from);
      where.push(`a.started_at >= $${args.length}`);
    }
    if (query.to) {
      args.push(query.to);
      where.push(`a.started_at <= $${args.length}`);
    }
    return { whereSql: where.join(' AND '), args };
  }

  /**
   * 导出明细为 Excel（方案 F2-08）：第一张表是接待明细，第二张表是对话全文。
   * 过滤条件与列表完全一致，避免「导出的比看到的多」。
   */
  /**
   * 个人成长曲线（方案 F2-09）：按天汇总最近 N 天的总分、首响时长与超时次数。
   * 客服只能看自己；带教/管理员可以指定要看谁。
   */
  /**
   * 成长曲线（方案 F2-09）。
   *
   * 两种粒度：
   * - `session`（默认）：**当天每一次模拟各一个点**——新入职客服一天会练很多局，
   *   按天平均只剩一个点，看不出走势；这是训练场景里更有用的口径。
   * - `day`：最近 N 天按天平均（方案原文口径，保留）。
   */
  async trend(user: AuthUser, query: { days?: string; accountId?: string; granularity?: string }) {
    const days = Math.min(90, Math.max(7, Number(query.days) || 30));
    const accountId =
      user.roleCode === 'agent' ? user.id : query.accountId ? Number(query.accountId) : user.id;
    const granularity = query.granularity === 'day' ? 'day' : 'session';
    // 当天口径按服务器本地日期算（8:00 起算更贴近排班；这里取 0 点，简单且可复算）
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const since = (granularity === 'session' ? todayStart : new Date(Date.now() - days * 24 * 3600 * 1000)).toISOString();

    const attempts = await this.db.many<any>(
      `SELECT id, started_at AS "startedAt", total_score AS "totalScore", conclusion
       FROM attempts
       WHERE account_id = $1 AND status <> 'running' AND started_at >= $2
       ORDER BY started_at`,
      [accountId, since]
    );
    const attemptIds = attempts.map((row) => Number(row.id));
    const sessionRows = attemptIds.length
      ? await this.db.many<any>(
          `SELECT attempt_id AS "attemptId",
                  COALESCE(max(max_response_sec), 0) AS "firstResponse",
                  COALESCE(sum(timeout_count), 0) AS "timeoutCount",
                  count(*) AS "sessionCount"
           FROM sessions WHERE attempt_id IN (${attemptIds.map((_, i) => `$${i + 1}`).join(',')})
           GROUP BY attempt_id`,
          attemptIds
        )
      : [];
    const byAttempt = new Map(sessionRows.map((row) => [Number(row.attemptId), row]));

    // 当天每局一个点：标签用 HH:mm，点的值就是这一局自己的表现（不再按天平均）
    if (granularity === 'session') {
      const sessionPoints = attempts.map((attempt) => {
        const extra = byAttempt.get(Number(attempt.id));
        const at = new Date(attempt.startedAt);
        const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
        return {
          date: hhmm,
          attemptId: Number(attempt.id),
          count: 1,
          sessions: Number(extra?.sessionCount || 0),
          score: attempt.totalScore === null || attempt.totalScore === undefined ? null : Number(attempt.totalScore),
          avgScore: attempt.totalScore === null || attempt.totalScore === undefined ? null : Number(attempt.totalScore),
          avgFirstResponse: Number(extra?.firstResponse || 0),
          timeoutCount: Number(extra?.timeoutCount || 0),
        };
      });
      const scores = sessionPoints.map((p) => p.score).filter((v): v is number => v !== null);
      return {
        granularity,
        days,
        accountId,
        date: todayStart.toISOString().slice(0, 10),
        points: sessionPoints,
        summary: {
          attempts: attempts.length,
          avgScore: scores.length ? Math.round((scores.reduce((s, v) => s + v, 0) / scores.length) * 10) / 10 : null,
          avgFirstResponse: sessionPoints.length
            ? Math.round(sessionPoints.reduce((s, p) => s + p.avgFirstResponse, 0) / sessionPoints.length)
            : null,
          timeoutCount: sessionPoints.reduce((sum, p) => sum + p.timeoutCount, 0),
          passCount: attempts.filter((row) => row.conclusion === 'pass').length,
        },
      };
    }

    const buckets = new Map<string, { date: string; count: number; scoreSum: number; scored: number; firstResponse: number; timeoutCount: number; sessions: number }>();
    for (const attempt of attempts) {
      // 注意：不能写 String(startedAt).slice(0,10)——驱动返回的是 Date 对象，
      // 那样会得到 "Wed Oct 01" 这种字符串：横轴标签不对，而且后面按字符串排序会把 30 天的点排乱。
      const at = new Date(attempt.startedAt);
      const date = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
      const bucket = buckets.get(date) || {
        date,
        count: 0,
        scoreSum: 0,
        scored: 0,
        firstResponse: 0,
        timeoutCount: 0,
        sessions: 0,
      };
      const extra = byAttempt.get(Number(attempt.id));
      bucket.count += 1;
      if (attempt.totalScore !== null && attempt.totalScore !== undefined) {
        bucket.scoreSum += Number(attempt.totalScore);
        bucket.scored += 1;
      }
      bucket.firstResponse += Number(extra?.firstResponse || 0);
      bucket.timeoutCount += Number(extra?.timeoutCount || 0);
      bucket.sessions += Number(extra?.sessionCount || 0);
      buckets.set(date, bucket);
    }

    const points = [...buckets.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((bucket) => ({
        date: bucket.date,
        count: bucket.count,
        sessions: bucket.sessions,
        avgScore: bucket.scored ? Math.round((bucket.scoreSum / bucket.scored) * 10) / 10 : null,
        avgFirstResponse: bucket.count ? Math.round(bucket.firstResponse / bucket.count) : 0,
        timeoutCount: bucket.timeoutCount,
      }));
    const avg = (list: number[]) => (list.length ? Math.round((list.reduce((s, v) => s + v, 0) / list.length) * 10) / 10 : null);
    return {
      granularity,
      days,
      accountId,
      points,
      summary: {
        attempts: attempts.length,
        avgScore: avg(points.map((p) => p.avgScore).filter((v): v is number => v !== null)),
        avgFirstResponse: avg(points.map((p) => p.avgFirstResponse)),
        timeoutCount: points.reduce((sum, p) => sum + p.timeoutCount, 0),
        passCount: attempts.filter((row) => row.conclusion === 'pass').length,
      },
    };
  }

  async exportXlsx(
    user: AuthUser,
    query: { accountId?: string; level?: string; conclusion?: string; source?: string; keyword?: string; from?: string; to?: string }
  ): Promise<Buffer> {
    const { whereSql, args } = this.buildFilters(user, query);
    const rows = await this.db.many<any>(
      `SELECT a.id, a.attempt_no AS "attemptNo", a.level, a.source, a.started_at AS "startedAt",
              a.finished_at AS "finishedAt", a.total_score AS "totalScore", a.conclusion,
              ac.display_name AS "accountName", g.name AS "groupName"
       FROM attempts a
       LEFT JOIN accounts ac ON ac.id = a.account_id
       LEFT JOIN groups g ON g.id = ac.group_id
       WHERE ${whereSql}
       ORDER BY a.started_at DESC`,
      args
    );

    const sessionRows = await this.db.many<any>(
      `SELECT s.id, s.attempt_id AS "attemptId", s.buyer_name AS "buyerName", s.state,
              sc.total_score AS "sessionScore"
       FROM sessions s LEFT JOIN scores sc ON sc.session_id = s.id
       WHERE s.attempt_id IN (SELECT a.id FROM attempts a LEFT JOIN accounts ac ON ac.id = a.account_id WHERE ${whereSql})`,
      args
    );
    const sessionsByAttempt = new Map<number, any[]>();
    sessionRows.forEach((row) => {
      const list = sessionsByAttempt.get(Number(row.attemptId)) || [];
      list.push(row);
      sessionsByAttempt.set(Number(row.attemptId), list);
    });

    const messageRows = await this.db.many<any>(
      `SELECT a.attempt_no AS "attemptNo", s.buyer_name AS "buyerName", m.sender, m.created_at AS "createdAt",
              m.content, m.response_sec AS "responseSec", m.is_timeout AS "isTimeout"
       FROM messages m
       JOIN sessions s ON s.id = m.session_id
       JOIN attempts a ON a.id = s.attempt_id
       LEFT JOIN accounts ac ON ac.id = a.account_id
       WHERE ${whereSql}
       ORDER BY a.started_at DESC, s.id, m.id`,
      args
    );

    const duration = (row: any) => {
      if (!row.finishedAt || !row.startedAt) return '';
      const seconds = Math.max(0, Math.round((Date.parse(row.finishedAt) - Date.parse(row.startedAt)) / 1000));
      return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`;
    };
    const senderLabel: Record<string, string> = { buyer: '买家', agent: '客服', system: '系统' };

    const detailSheet = [
      ['接待编号', '客服', '小组', '难度', '来源', '接待时长', '会话数', '总分', '结论', '开始时间', '结束时间'],
      ...rows.map((row) => [
        row.attemptNo,
        row.accountName ?? '',
        row.groupName ?? '',
        row.level,
        row.source === 'task' ? '任务训练' : '模拟训练',
        duration(row),
        (sessionsByAttempt.get(Number(row.id)) || []).length,
        row.totalScore === null || row.totalScore === undefined ? '' : Number(row.totalScore),
        row.conclusion === 'pass' ? '达标' : row.conclusion === 'fail' ? '未达标' : '进行中',
        row.startedAt ? new Date(row.startedAt).toLocaleString('zh-CN') : '',
        row.finishedAt ? new Date(row.finishedAt).toLocaleString('zh-CN') : '',
      ]),
    ];

    const conversationSheet = [
      ['接待编号', '买家', '角色', '时间', '内容', '响应耗时(秒)', '是否超时'],
      ...messageRows.map((row) => [
        row.attemptNo,
        row.buyerName ?? '',
        senderLabel[row.sender] || row.sender,
        row.createdAt ? new Date(row.createdAt).toLocaleString('zh-CN') : '',
        row.content,
        row.responseSec === null || row.responseSec === undefined ? '' : Number(row.responseSec),
        row.isTimeout ? '是' : '',
      ]),
    ];

    return buildXlsx([
      { name: '接待明细', rows: detailSheet },
      { name: '对话全文', rows: conversationSheet },
    ]);
  }

  /** 明细列表：客服仅可见本人，主管可见本组，管理员可见全部。 */
  async list(
    user: AuthUser,
    query: PageQuery & {
      accountId?: string;
      level?: string;
      conclusion?: string;
      source?: string;
      keyword?: string;
      from?: string;
      to?: string;
      invalid?: string;
    }
  ) {
    const { page, pageSize, offset, limit } = normalizePage(query);
    const { whereSql, args } = this.buildFilters(user, query);
    const total = await this.db.one<{ count: string }>(
      `SELECT count(*)::text AS count FROM attempts a LEFT JOIN accounts ac ON ac.id = a.account_id WHERE ${whereSql}`,
      args
    );
    const rows = await this.db.many<any>(
      `SELECT a.id, a.attempt_no AS "attemptNo", a.level, a.source, a.status,
              a.started_at AS "startedAt", a.finished_at AS "finishedAt",
              a.total_score AS "totalScore", a.conclusion,
              ac.display_name AS "accountName", g.name AS "groupName"
       FROM attempts a
       LEFT JOIN accounts ac ON ac.id = a.account_id
       LEFT JOIN groups g ON g.id = ac.group_id
       WHERE ${whereSql}
       ORDER BY a.started_at DESC OFFSET $${args.length + 1} LIMIT $${args.length + 2}`,
      [...args, offset, limit]
    );
    // 会话统计单独聚合（避免相关子查询在不同数据库方言下的差异）
    const attemptIds = rows.map((r) => r.id);
    const statsMap = new Map<number, { sessionCount: number; earlyCount: number; timeoutCount: number; invalidCount: number }>();
    if (attemptIds.length) {
      const placeholders = attemptIds.map((_, i) => `$${i + 1}`).join(',');
      const stats = await this.db.many<any>(
        `SELECT attempt_id, count(*)::int AS "sessionCount",
                sum(CASE WHEN finished_reason = 'early' THEN 1 ELSE 0 END)::int AS "earlyCount",
                sum(timeout_count)::int AS "timeoutCount"
         FROM sessions WHERE attempt_id IN (${placeholders}) GROUP BY attempt_id`,
        attemptIds
      );
      stats.forEach((s) =>
        statsMap.set(Number(s.attempt_id), {
          sessionCount: Number(s.sessionCount || 0),
          earlyCount: Number(s.earlyCount || 0),
          timeoutCount: Number(s.timeoutCount || 0),
          invalidCount: 0,
        })
      );
      // C6：被判无效 / 敷衍的回复条数（带教复盘时一眼能看出哪几局话术有问题）
      const invalidStats = await this.db.many<any>(
        `SELECT s.attempt_id, count(*)::int AS "invalidCount"
         FROM sessions s JOIN messages m ON m.session_id = s.id
         WHERE s.attempt_id IN (${placeholders}) AND m.rule_result->>'invalid' = 'true'
         GROUP BY s.attempt_id`,
        attemptIds
      );
      invalidStats.forEach((s) => {
        const current = statsMap.get(Number(s.attempt_id));
        if (current) current.invalidCount = Number(s.invalidCount || 0);
      });
    }
    const list = rows.map((row) => {
      const stat = statsMap.get(Number(row.id)) || { sessionCount: 0, earlyCount: 0, timeoutCount: 0, invalidCount: 0 };
      return {
        ...row,
        ...stat,
        durationSec: Math.max(
          0,
          Math.round((new Date(row.finishedAt || Date.now()).getTime() - new Date(row.startedAt).getTime()) / 1000)
        ),
      };
    });
    return pageResult(list, Number(total.count), page, pageSize);
  }

  async detail(user: AuthUser, attemptId: number) {
    const attempt = await this.db.one<any>(
      `SELECT a.*, ac.display_name AS "accountName" FROM attempts a LEFT JOIN accounts ac ON ac.id = a.account_id WHERE a.id = $1`,
      [attemptId]
    );
    if (!attempt) throw new BizError(ERR.NOT_FOUND, '接待记录不存在');
    if (user.roleCode === 'agent' && attempt.account_id !== user.id) throw new BizError(ERR.FORBIDDEN, '无权查看他人接待记录');

    const sessions = await this.db.many<any>(
      `SELECT s.id, s.buyer_name AS "buyerName", s.style_code AS "styleCode", s.state, s.current_seq AS "seq",
              s.total_questions AS "totalQuestions", s.emotion_value AS "emotionValue", s.timeout_count AS "timeoutCount",
              s.max_response_sec AS "maxResponseSec", s.avg_response_sec AS "avgResponseSec", s.score,
              s.finished_reason AS "finishedReason", s.questions, s.products,
              sc.response_score AS "responseScore", sc.solving_score AS "solvingScore", sc.wording_score AS "wordingScore",
              sc.emotion_score AS "emotionScore", sc.total_score AS "totalScore", sc.deductions, sc.metrics,
              sc2.id AS "scriptId", sc2.name AS "scriptName", sc2.script_no AS "scriptNo", st.name AS "styleName"
       FROM sessions s
       LEFT JOIN scores sc ON sc.session_id = s.id
       LEFT JOIN scripts sc2 ON sc2.id = s.script_id
       LEFT JOIN styles st ON st.id = sc2.style_id
       WHERE s.attempt_id = $1 ORDER BY s.id`,
      [attemptId]
    );
    const sessionIds = sessions.map((s) => s.id);
    const messages = sessionIds.length
      ? await this.db.many<any>(
          `SELECT id, session_id AS "sessionId", sender, content, seq, created_at AS "createdAt",
                  response_sec AS "responseSec", is_timeout AS "isTimeout", rule_result AS "ruleResult"
           FROM messages WHERE session_id IN (${sessionIds.map((_, i) => `$${i + 1}`).join(',')}) ORDER BY id`,
          sessionIds
        )
      : [];
    const annotations = await this.db.many<any>(
      `SELECT an.id, an.session_id AS "sessionId", an.message_id AS "messageId", an.content,
              an.reply_content AS "replyContent", an.created_at AS "createdAt", ac.display_name AS "authorName"
       FROM annotations an LEFT JOIN accounts ac ON ac.id = an.author_id
       WHERE an.attempt_id = $1 ORDER BY an.id`,
      [attemptId]
    );
    /** 客户 2026-10-03：这次接待点过哪些业务动作（催付 / 改价 / 去发货…），复盘时逐条可见。 */
    const businessActions = await this.db.many<any>(
      `SELECT id, session_id AS "sessionId", action_code AS "actionCode", action_name AS "actionName",
              order_stage AS "orderStage", content, created_at AS "createdAt"
       FROM session_actions WHERE attempt_id = $1 ORDER BY id`,
      [attemptId]
    );
    return { attempt, sessions, messages, annotations, businessActions };
  }

  async addAnnotation(user: AuthUser, attemptId: number, body: { sessionId?: number; messageId?: number; content: string }) {
    if (!body.content) throw new BizError(ERR.PARAM, '批注内容不能为空');
    // 方案 2.2 权限矩阵：批注属于带教能力，客服仅可查看与回复批注
    if (user.roleCode === 'agent') throw new BizError(ERR.FORBIDDEN, '客服仅可查看与回复批注，不能新建批注');
    const attempt = await this.db.one<{ account_id: number }>(`SELECT account_id FROM attempts WHERE id = $1`, [attemptId]);
    if (!attempt) throw new BizError(ERR.NOT_FOUND, '接待记录不存在');
    if (user.roleCode === 'leader') await this.assertGroupScope(user, attempt.account_id);
    const row = await this.db.one<{ id: number }>(
      `INSERT INTO annotations (attempt_id, session_id, message_id, author_id, content)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [attemptId, body.sessionId ?? null, body.messageId ?? null, user.id, body.content]
    );
    return { id: row.id };
  }

  async replyAnnotation(user: AuthUser, annotationId: number, replyContent: string) {
    // 回复批注同样按角色限定可见范围，避免通过批注 id 越权
    const annotation = await this.db.one<{ attempt_id: number }>(`SELECT attempt_id FROM annotations WHERE id = $1`, [
      annotationId,
    ]);
    if (!annotation) throw new BizError(ERR.NOT_FOUND, '批注不存在');
    const attempt = await this.db.one<{ account_id: number }>(`SELECT account_id FROM attempts WHERE id = $1`, [
      annotation.attempt_id,
    ]);
    if (!attempt) throw new BizError(ERR.NOT_FOUND, '接待记录不存在');
    if (user.roleCode === 'agent' && attempt.account_id !== user.id) {
      throw new BizError(ERR.FORBIDDEN, '无权回复该批注');
    }
    if (user.roleCode === 'leader') await this.assertGroupScope(user, attempt.account_id);
    await this.db.query(`UPDATE annotations SET reply_content = $2 WHERE id = $1`, [annotationId, replyContent]);
    return { success: true };
  }

  /** 主管只能操作本组客服的记录（方案 2.2：训练报表查看限定本组）。 */
  private async assertGroupScope(user: AuthUser, ownerId: number): Promise<void> {
    if (!user.groupId) return;
    const owner = await this.db.one<{ group_id: number }>(`SELECT group_id FROM accounts WHERE id = $1`, [ownerId]);
    if (owner && owner.group_id !== user.groupId) throw new BizError(ERR.FORBIDDEN, '无权操作其他小组的记录');
  }

  /** 个人成绩概览：用于首页仪表盘。 */
  async overview(user: AuthUser) {
    const rows = await this.db.many<any>(
      `SELECT a.id, a.attempt_no AS "attemptNo", a.level, a.level,
              a.total_score AS "totalScore", a.conclusion, a.started_at AS "startedAt", a.source
       FROM attempts a WHERE a.account_id = $1 AND a.status <> 'running'
       ORDER BY a.started_at DESC LIMIT 10`,
      [user.id]
    );
    const rawStats = await this.db.one<any>(
      `SELECT count(*)::int AS "totalCount",
              avg(a.total_score) AS "avgScoreRaw",
              COALESCE(max(a.total_score),0) AS "bestScore",
              COALESCE(sum(CASE WHEN a.conclusion = 'pass' THEN 1 ELSE 0 END),0)::int AS "passCount"
       FROM attempts a WHERE a.account_id = $1 AND a.status <> 'running'`,
      [user.id]
    );
    const stats = {
      totalCount: Number(rawStats?.totalCount || 0),
      avgScore: Math.round(Number(rawStats?.avgScoreRaw || 0) * 10) / 10,
      bestScore: Number(rawStats?.bestScore || 0),
      passCount: Number(rawStats?.passCount || 0),
    };
    // 难度档位不在概览里重复返回：/api/receptions/levels 才是唯一口径（含名称与并发数）
    return { stats, recent: rows };
  }
}
