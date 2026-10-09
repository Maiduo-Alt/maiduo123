import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { SettingsService } from '../settings/settings.service';
import { ReceptionGateway } from './reception.gateway';
import { SCHEDULER, SchedulerLike } from './scheduler.types';
import { BizError, ERR } from '../../common/errors';
import { AuthUser } from '../../common/decorators';
import { nextNo } from '../../common/ids';
import {
  DEFAULT_PARAMS,
  DEFAULT_LEVEL_TOTAL,
  LEVELS,
  ScoreMessage,
  ScriptCandidate,
  ScriptQuestion,
  SystemParams,
} from '../../domain/types';
import { pickScripts } from '../../domain/extraction';
import { KEY_POINT_ALIASES } from '../../domain/key-point-aliases';
import { scoreAttempt, scoreSession } from '../../domain/scoring';
import { updateEmotion } from '../../domain/emotion';
import { createRng } from '../../domain/rng';
import { shouldAbortAsDisconnected } from '../../domain/disconnect';
import { weightedAvgResponseSec } from '../../domain/response-rounds';
import { judgeValidReplies } from '../../domain/reply-validity';
import { cloneParams } from '../../domain/params';
import { buildSimulatedOrder, orderStageForQuestion, OrderStage, SimulatedOrder } from '../../domain/order';
import { mixQuestionSeq } from '../../domain/question-seq';
import { ORDER_AFTERSALE_QUESTIONS, PRESALE_PRODUCT_QUESTIONS } from '../../db/seed-content';
import {
  actionStageHint,
  findBusinessAction,
  renderActionPhrase,
} from '../../domain/business-actions';
import { isLevelAllowedByTask, isScriptInTaskScope } from '../../domain/task-scope';
import { isProductCompatibleWithQuestions } from '../../domain/product-consistency';
import { TasksService } from '../tasks/tasks.service';

interface SessionRow {
  id: number;
  attempt_id: number;
  script_id: number;
  product_id: number | null;
  buyer_name: string;
  style_code: string;
  state: string;
  current_seq: number;
  total_questions: number;
  questions: ScriptQuestion[];
  products: any[];
  order_no: string | null;
  order_amount: string | null;
  order_status: string | null;
  /** 订单卡片完整快照（客户 2026-10-03 的三态订单） */
  order_payload: SimulatedOrder | null;
  last_buyer_at: string | null;
  last_agent_at: string | null;
  first_reply_at: string | null;
  join_at: string;
  finished_at: string | null;
  finished_reason: string | null;
  max_response_sec: number | null;
  avg_response_sec: number | null;
  timeout_count: number;
  emotion_value: number;
  unresolved_streak: number;
  transferred_seqs: number[];
  score: string | null;
}

@Injectable()
export class ReceptionService implements OnModuleInit {
  private readonly logger = new Logger(ReceptionService.name);

  /** 沟通风格对买家消息的影响（情绪化风格会触发升级追问）。 */
  private readonly styleBehavior: Record<string, { emotional: boolean; transform: (q: string) => string[] }> = {
    friendly: { emotional: false, transform: (q) => [q] },
    impatient: { emotional: true, transform: (q) => [q.replace(/？$/, '！'), '你们到底能不能处理？'] },
    direct: { emotional: false, transform: (q) => [q] },
    hesitant: { emotional: true, transform: (q) => [q, '我怕不合适，能保证吗？'] },
    silent: { emotional: false, transform: (q) => [q.length > 12 ? `${q.slice(0, 12)}？` : q] },
  };

  /** 客服回复后，买家「思考」多久再抛下一个问题；服务重启补挂定时器时沿用同一口径。 */
  private readonly REPLY_THINK_DELAY_MS = 1500;

  constructor(
    private readonly db: DbService,
    private readonly settings: SettingsService,
    private readonly gateway: ReceptionGateway,
    @Inject(SCHEDULER) private readonly scheduler: SchedulerLike,
    private readonly tasks: TasksService
  ) {}

  async onModuleInit(): Promise<void> {
    await this.recoverRunningAttempts();
    this.scheduler.every('timeout-scan', 5000, () => this.scanTimeout());
    this.scheduler.every('timer-tick', 1000, () => this.broadcastTimerTick());
    // 方案 3.6：截止后任务自动关闭。定时扫描放在这里（而不是 TasksModule），
    // 是为了避免 TasksModule ⇄ ReceptionModule 的循环依赖——调度器与 TasksService 这里都已经有了。
    this.scheduler.every('tasks:close-expired', 60000, async () => {
      const closed = await this.tasks.closeExpiredTasks();
      if (closed) this.logger.log(`已自动关闭 ${closed} 个到期任务`);
    });
  }

  /**
   * 服务重启后的状态恢复（方案 5.11 可用性：接待状态可从数据库恢复，允许会话继续计时）。
   *
   * - 进行中的接待保持 running，不再被判为异常中止；
   * - 等待时长始终按数据库里的 last_buyer_at 计算，重启后自动接着计时；
   * - 只把内存中丢失的定时器按会话状态重新挂上：
   *   wait（买家还没进线）补一次进线推送，waiting_buyer（客服已回复）补一次下一条推送。
   */
  private async recoverRunningAttempts(): Promise<void> {
    const attempts = await this.db.many<{ id: number }>(`SELECT id FROM attempts WHERE status = 'running'`);
    if (!attempts.length) return;

    const idList = attempts.map((a) => a.id);
    const sessions = await this.db.many<{ id: number; state: string }>(
      `SELECT id, state FROM sessions
       WHERE attempt_id IN (${idList.map((_, i) => `$${i + 1}`).join(',')})
         AND state NOT IN ('finished','transferred','aborted')`,
      idList
    );

    let rearmed = 0;
    for (const session of sessions) {
      if (session.state === 'wait') {
        this.scheduler.schedule(`join:${session.id}`, 2000, () => this.pushNextQuestion(session.id));
        rearmed += 1;
      } else if (session.state === 'waiting_buyer') {
        this.scheduler.schedule(`next:${session.id}`, this.REPLY_THINK_DELAY_MS, () => this.pushNextQuestion(session.id));
        rearmed += 1;
      }
    }
    this.logger.log(
      `服务启动：恢复 ${attempts.length} 个进行中的接待，重新挂载 ${rearmed} 个待推送任务；未超时的会话继续按 last_buyer_at 计时`
    );

    // C5：重启后按「同时在线」重新补位，让还在排队的待接入买家继续进线
    for (const attempt of attempts) await this.promoteWaiting(attempt.id);
  }

  /* ---------------- 开始接待 ---------------- */

  /**
   * 当前进行中的接待（方案 F1-13 断线续接的补充）。
   * 客服中途离开接待页 / 换了设备回来时，凭这个接口把没结束的接待找回来，
   * 而不是只能等到断线宽限期后被判异常中止。
   */
  async current(accountId: number) {
    const attempt = await this.db.one<any>(
      `SELECT id, attempt_no AS "attemptNo", level, source, started_at AS "startedAt"
       FROM attempts WHERE account_id = $1 AND status = 'running' ORDER BY id DESC LIMIT 1`,
      [accountId]
    );
    if (!attempt) return null;
    return {
      attemptId: Number(attempt.id),
      attemptNo: attempt.attemptNo,
      level: attempt.level,
      source: attempt.source,
      startedAt: attempt.startedAt,
    };
  }

  async start(
    user: AuthUser,
    body: {
      level: string;
      source?: string;
      taskId?: number;
      /** C5：本局覆盖——只写进这次接待的参数快照，仅管理员/主管可用 */
      totalCount?: number;
      concurrentCount?: number;
    }
  ) {
    const accountId = user.id;
    const params = await this.settings.getParams();
    const level = LEVELS[body.level];
    if (!level) throw new BizError(ERR.PARAM, '难度档位不合法');

    // 客户新增需求 C5：管理员/主管可以在**开局时当场指定这一局**的接入人数与合计接待人数。
    // 覆盖只写进本次接待的参数快照（历史复盘、补位、重启恢复都按它算），不改全局系统参数。
    // 客服（新人）不能自己指定，任务训练也不给入口。
    const override = body as { totalCount?: number; concurrentCount?: number };
    const hasOverride = override.totalCount !== undefined || override.concurrentCount !== undefined;
    if (hasOverride && user.roleCode !== 'admin' && user.roleCode !== 'leader') {
      throw new BizError(ERR.FORBIDDEN, '只有管理员/主管可以指定本局的接待人数');
    }
    const effectiveParams = cloneParams(params);
    if (override.concurrentCount !== undefined) {
      const value = Number(override.concurrentCount);
      if (!Number.isFinite(value) || value < 1 || value > 4) {
        throw new BizError(ERR.PARAM, '本局接入人数取值范围为 1～4');
      }
      effectiveParams.levelConcurrent[level.code] = Math.round(value);
    }
    if (override.totalCount !== undefined) {
      const value = Number(override.totalCount);
      if (!Number.isFinite(value) || value < 1 || value > 20) {
        throw new BizError(ERR.PARAM, '本局总接待人数取值范围为 1～20');
      }
      effectiveParams.levelTotal[level.code] = Math.round(value);
    }

    // 客户新增需求：客服（新人）不开放自由练习，只做任务训练。
    // 放在最前面：菜单/首页/接待页都藏了入口，这里兜住直接调接口与旧链接。
    if (body.source !== 'task' && user.roleCode === 'agent') {
      throw new BizError(ERR.FORBIDDEN, '客服暂未开放模拟训练，请从《我的任务》进入训练');
    }

    // 任务训练：校验「下发给本人」「难度在任务允许范围内」，并取出剧本范围（方案 F6-02 / F6-03 / F6-04）
    let task: any = null;
    if (body.source === 'task') {
      if (!body.taskId) throw new BizError(ERR.PARAM, '任务训练必须带上任务编号');
      task = await this.db.one<any>(`SELECT * FROM tasks WHERE id = $1`, [body.taskId]);
      if (!task) throw new BizError(ERR.NOT_FOUND, '训练任务不存在');
      const assigned = await this.db.one<{ id: number }>(
        `SELECT id FROM task_assignees WHERE task_id = $1 AND account_id = $2`,
        [task.id, accountId]
      );
      if (!assigned) throw new BizError(ERR.FORBIDDEN, '该任务没有下发给当前账号');
      if (task.status !== 'running') throw new BizError(ERR.PARAM, '该任务已结束，无法继续训练');
      // 方案 3.6：截止后任务自动关闭——状态可能还没被定时扫描更新，这里按截止时间直接判断
      if (await this.tasks.isExpired(task.id)) {
        throw new BizError(ERR.PARAM, '该任务已截止，无法继续训练（未完成的记录仍保留在任务报表里）');
      }
      if (!isLevelAllowedByTask(level.code, task.levels)) {
        throw new BizError(ERR.PARAM, `该任务只允许 ${(task.levels || []).join(' / ')} 难度`);
      }
    }

    // 方案 4.4 / F1-02：难度要**逐步解锁**——客服只能开已经解锁的档位。
    // 之前只有界面显示「未解锁」，后端没拦，导致客服能直接开高档位（用户反馈的现象）。
    // 管理员/主管不受限：他们需要能试任意档位，也可以给别人开放难度（POST /api/accounts/:id/unlock-levels）。
    if (user.roleCode === 'agent' && !(await this.isLevelUnlocked(accountId, level.code))) {
      throw new BizError(
        ERR.FORBIDDEN,
        `${level.code} ${level.name} 还没解锁：先在同一档位达标 ${params.unlockConsecutive} 次解锁下一档，或让带教在《账号》里为你开放难度`
      );
    }

    const running = await this.db.one<{ id: number }>(
      `SELECT id FROM attempts WHERE account_id = $1 AND status = 'running'`,
      [accountId]
    );
    if (running) throw new BizError(ERR.RECEPTION_RUNNING, '请先结束当前接待，再进行新的接待');

    const candidateRows = await this.db.many<any>(
      `SELECT s.id, s.script_no, s.name, s.qa_id, s.style_id, s.stage, s.question_seq,
              s.practiced_count, s.last_practiced_at, s.category, s.product_ids AS "productIds",
              COALESCE(st.is_emotional,false) AS is_emotional
       FROM scripts s LEFT JOIN styles st ON st.id = s.style_id WHERE s.status = 1`
    );
    if (!candidateRows.length) throw new BizError(ERR.PARAM, '当前没有可用剧本，请先创建剧本');

    /**
     * 客户 2026-10-03：任务可按**商品种类**（男装 / 女装 …）圈定训练内容，
     * 所以先把「剧本 → 关联商品的分类」查出来带上；同时用它做一次
     * **商品与问题的一致性兜底**：历史数据或人工导入的剧本如果出现
     * 「数码商品配尺码问题」这种冲突，就不进候选，而不是推给客服。
     */
    const allProductIds = Array.from(
      new Set(
        candidateRows
          .flatMap((row: any) => (Array.isArray(row.productIds) ? row.productIds : []))
          .map((id: any) => Number(id))
          .filter((id: number) => Number.isFinite(id))
      )
    );
    const productCategoryRows = allProductIds.length
      ? await this.db.many<{ id: number; category: string }>(
          `SELECT id, category FROM products WHERE id IN (${allProductIds.map((_, i) => `$${i + 1}`).join(',')})`,
          allProductIds
        )
      : [];
    const categoryByProduct = new Map(productCategoryRows.map((row) => [Number(row.id), String(row.category || '')]));

    const withCategories = candidateRows.map((row: any) => {
      const ids = (Array.isArray(row.productIds) ? row.productIds : []).map((id: any) => Number(id));
      const categorySet = new Set<string>();
      ids.forEach((id: number) => {
        const name = categoryByProduct.get(id);
        if (name) categorySet.add(name);
      });
      const productCategories: string[] = Array.from(categorySet);
      const questions: string[] = ((row.question_seq || []) as any[]).map((q: any) => String(q?.question || ''));
      const consistent = !productCategories.length
        ? true
        : productCategories.some((name) => isProductCompatibleWithQuestions(name, questions));
      return { ...row, productCategories, consistent };
    });
    const inconsistent = withCategories.filter((row: any) => !row.consistent);
    if (inconsistent.length) {
      this.logger.warn(
        `商品与问题不一致的剧本已跳过 ${inconsistent.length} 条（示例：${inconsistent[0].script_no}）——` +
          '请检查剧本关联商品或问题内容'
      );
    }
    const compatibleRows = withCategories.filter((row: any) => row.consistent);
    if (!compatibleRows.length) {
      throw new BizError(ERR.PARAM, '当前没有与商品匹配的可用剧本，请先创建剧本');
    }

    // 任务范围限定：只从任务圈定的剧本里抽（F6-03）
    const scopedRows = task
      ? compatibleRows.filter((row) =>
          isScriptInTaskScope(row, { type: task.scope_type, value: task.scope_value })
        )
      : compatibleRows;
    if (!scopedRows.length) {
      const scopeHint =
        task?.scope_type === 'product_category'
          ? '任务限定的商品种类下还没有可用剧本，请让带教调整任务范围或先补充该品类的剧本'
          : task?.scope_type === 'scripts_products'
            ? '任务限定的「剧本 + 商品」组合下没有可用剧本，请让带教调整任务范围'
          : '任务限定的剧本已被停用或不存在，请让带教调整任务范围';
      throw new BizError(ERR.PARAM, scopeHint);
    }

    const candidates: ScriptCandidate[] = scopedRows.map((r: any) => ({
      id: r.id,
      scriptNo: r.script_no,
      name: r.name,
      qaId: r.qa_id,
      styleId: r.style_id,
      stage: r.stage,
      questionSeq: r.question_seq || [],
      practicedCount: r.practiced_count,
      lastPracticedAt: r.last_practiced_at,
      emotionStyle: r.is_emotional,
    }));

    // 接入人数：客户新增需求允许管理账号按档位配置，默认仍是 1/2/3/4
    // 注意用 effectiveParams（含「本局覆盖」），而不是全局 params
    const configuredConcurrent = Number(effectiveParams.levelConcurrent?.[level.code] ?? level.concurrent);
    const concurrent = Math.max(1, Math.min(configuredConcurrent, effectiveParams.maxConcurrent));
    // C5：本次模拟的总接待人数（含还没接入的排队买家）。客户 2026-10-03：默认 10 人，管理员可提前设置。
    const configuredTotal = Number(effectiveParams.levelTotal?.[level.code] ?? DEFAULT_LEVEL_TOTAL);
    const total = Math.max(1, Math.min(Number.isFinite(configuredTotal) ? configuredTotal : DEFAULT_LEVEL_TOTAL, 20));
    // 总量比同时在线还小时，总量就是硬上限（优先保证「只接待 N 个」这个口径）
    const activeSlots = Math.min(concurrent, total);
    const picked = pickScripts(candidates, level, total, effectiveParams);
    if (!picked.length) throw new BizError(ERR.PARAM, '没有符合条件的剧本');

    const rng = createRng(Date.now());
    const attemptNo = nextNo('AT');
    const attempt = await this.db.one<{ id: number }>(
      `INSERT INTO attempts (attempt_no, account_id, level, source, task_id, param_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING id`,
      [
        attemptNo,
        accountId,
        level.code,
        body.source === 'task' ? 'task' : 'free',
        body.taskId ?? null,
        // 用含「本局覆盖」的参数快照：补位、重启恢复、历史复盘都按这一份算
        JSON.stringify(effectiveParams),
      ]
    );

    const createdSessions: SessionRow[] = [];
    for (let i = 0; i < picked.length; i += 1) {
      const script = picked[i];
      const styleRow = await this.db.one<{ code: string; emotion_base: number }>(
        `SELECT code, emotion_base FROM styles WHERE id = $1`,
        [script.styleId]
      );
      const styleCode = styleRow?.code || 'friendly';
      const product = await this.pickProduct(script.id);
      const baseQuestions: ScriptQuestion[] = script.questionSeq.length
        ? script.questionSeq
        : [{ seq: 1, question: '请问在吗？', keyPoints: ['回应'], needTransfer: false }];
      /**
       * 客户 2026-10-03：一次接待的问题要**按比例混合售前 / 售后**——
       * 大部分是「还没有订单、只咨询商品信息」的售前问题，小部分是「买完商品后」的订单类问题
       * （改地址 / 改快递 / 催发货 / 改单）。比例来自系统参数 aftersaleQuestionRatio（默认 20%）。
       * 剧本是售前就混售后问题，剧本是售后就混售前问题——两种都保证「大部分还是剧本本身的话题」。
       */
      const scriptStage: 'presale' | 'aftersale' = script.stage === 'aftersale' ? 'aftersale' : 'presale';
      const mixStage: 'presale' | 'aftersale' = scriptStage === 'aftersale' ? 'presale' : 'aftersale';
      const mixRatio = Number(effectiveParams.aftersaleQuestionRatio ?? DEFAULT_PARAMS.aftersaleQuestionRatio);
      const mixPool = mixStage === 'aftersale' ? ORDER_AFTERSALE_QUESTIONS : PRESALE_PRODUCT_QUESTIONS;
      const questions =
        mixRatio > 0
          ? mixQuestionSeq(baseQuestions, {
              ratioPct: mixRatio,
              pool: mixPool,
              stage: mixStage,
              // 用会话在一局里的序号错开题库起点：同一局不同买家不会拿到同一句售后问题
              offset: i,
            })
          : baseQuestions;
      const joinDelaySec =
        i >= activeSlots
          ? 0
          : i === 0
          ? 0
          : Math.round(
              effectiveParams.levelJoinDelaySec[0] +
                rng() * (effectiveParams.levelJoinDelaySec[1] - effectiveParams.levelJoinDelaySec[0])
            );
      const joinAt = new Date(Date.now() + joinDelaySec * 1000);
      // C5：超出同时在线人数的先按「待接入」建好，等有位置再进线
      const initialState = i < activeSlots ? 'wait' : 'pending';
      const row = await this.db.one<SessionRow>(
        `INSERT INTO sessions (attempt_id, script_id, product_id, buyer_name, style_code, state, total_questions,
                               questions, products, order_no, order_amount, order_status, join_at, emotion_value)
         VALUES ($1,$2,$3,$4,$5,$14,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13) RETURNING *`,
        [
          attempt.id,
          script.id,
          product?.id ?? null,
          `买家${String(1000000 + Math.floor(rng() * 8999999)).slice(0, 7)}`,
          styleCode,
          questions.length,
          JSON.stringify(questions),
          JSON.stringify(product ? [product] : []),
          // 订单在拿到会话 id 之后再生成（订单号/金额以 session id 为种子，保证同一局订单稳定）
          null,
          null,
          null,
          joinAt.toISOString(),
          styleRow?.emotion_base ?? 20,
          initialState,
        ]
      );
      // 开局就按「第一个问题的订单状态」生成订单：售前=待支付/待发货，售后=已发货
      const firstStage: OrderStage = questions[0].orderStage || orderStageForQuestion(questions[0]);
      const order = this.buildOrder(Number(row.id), firstStage, Date.parse(String(row.join_at)));
      await this.persistOrder(Number(row.id), order);
      createdSessions.push({
        ...row,
        order_no: order.orderNo,
        // 金额列是 NUMERIC，驱动回传的是字符串，这里按同一口径写字符串
        order_amount: String(order.amount),
        order_status: order.statusText,
        order_payload: order,
      });
      if (initialState === 'wait') {
        this.scheduler.schedule(`join:${row.id}`, joinDelaySec * 1000, () => this.pushNextQuestion(row.id));
      }
    }

    const payload = {
      attemptId: attempt.id,
      attemptNo,
      level: level.code,
      levelName: level.name,
      readyCountdown: 3,
      sessions: createdSessions.map((s) => this.toSessionDto(s)),
    };
    this.gateway.emitToUser(accountId, 'reception.ready', payload);
    return payload;
  }

  /* ---------------- 买家消息推送 ---------------- */

  /**
   * 按问题所属的订单状态生成/推进订单（客户 2026-10-03 口径）。
   * 同一局用 session id 当种子 → 订单号与金额稳定不变，变的只是状态相关字段
   * （下单 → 付款 → 承诺发货 → 发货/物流/签收），也就是"同一笔订单在推进"。
   * 时间锚点用会话进线时间：否则每次推问题都会把「下单时间」往后挪，看着像订单变了。
   */
  private buildOrder(sessionId: number, stage: OrderStage, anchorMs = Date.now()): SimulatedOrder {
    return buildSimulatedOrder(sessionId * 7919 + 13, stage, anchorMs);
  }

  /** 把订单写回会话（单号/金额冗余在列上，完整快照放 JSONB）。 */
  private async persistOrder(sessionId: number, order: SimulatedOrder): Promise<void> {
    await this.db.query(
      `UPDATE sessions SET order_no = $2, order_amount = $3, order_status = $4, order_payload = $5::jsonb WHERE id = $1`,
      [sessionId, order.orderNo, order.amount, order.statusText, JSON.stringify(order)]
    );
  }

  /**
   * C5：本次模拟的总接待人数可能大于同时在线人数，多出来的会话以 `pending`（待接入）建好。
   *
   * 补位口径（客户 2026-10-03 看过赤兔火眼实测后拍板）：**空位即补**——
   * 只要有一个会话进入终态，就把空出来的名额立刻补上「待接入」里最早的买家，
   * 新买家在**几秒内**进线（对齐赤兔火眼实测的 1～6 秒），而不是等这一批全部结束再换一轮。
   * 没有空位或没有待接入时是空操作；整局结束由 `finalizeAttempt` 判断。
   */
  private async promoteWaiting(attemptId: number): Promise<void> {
    const attempt = await this.db.one<{ level: string; param_snapshot: SystemParams | null }>(
      `SELECT level, param_snapshot FROM attempts WHERE id = $1`,
      [attemptId]
    );
    if (!attempt) return;
    const params = (attempt.param_snapshot as SystemParams) || (await this.settings.getParams());
    const level = LEVELS[attempt.level];
    const configured = Number(params.levelConcurrent?.[attempt.level] ?? level?.concurrent ?? 1);
    const limit = Math.max(1, Math.min(configured, params.maxConcurrent));

    const active = await this.db.one<{ count: string }>(
      `SELECT count(*)::text AS count FROM sessions
       WHERE attempt_id = $1 AND state NOT IN ('finished','transferred','aborted','pending')`,
      [attemptId]
    );
    let slots = limit - Number(active?.count ?? 0);
    while (slots > 0) {
      const next = await this.db.one<{ id: number }>(
        `SELECT id FROM sessions WHERE attempt_id = $1 AND state = 'pending' ORDER BY id LIMIT 1`,
        [attemptId]
      );
      if (!next) return;
      await this.db.query(`UPDATE sessions SET state = 'wait', join_at = now() WHERE id = $1`, [next.id]);
      // 新买家「走进来」到发出第一条问题之间留几秒（赤兔火眼实测 1～6 秒），避免突兀地秒进
      const joinDelay = 1500 + Math.round(Math.random() * 3000);
      this.scheduler.schedule(`join:${next.id}`, joinDelay, () => this.pushNextQuestion(next.id));
      slots -= 1;
    }
  }

  async pushNextQuestion(sessionId: number): Promise<void> {
    const session = await this.loadSession(sessionId);
    if (!session || ['finished', 'transferred', 'aborted', 'pending'].includes(session.state)) return;
    const nextSeq = session.current_seq + 1;
    if (nextSeq > session.total_questions) {
      await this.completeSession(sessionId, 'normal');
      return;
    }
    const question = session.questions.find((q) => q.seq === nextSeq);
    if (!question) {
      await this.completeSession(sessionId, 'normal');
      return;
    }
    const behavior = this.styleBehavior[session.style_code] || this.styleBehavior.friendly;
    const texts = behavior.transform(question.question);
    /**
     * 客户 2026-10-03：**推送哪个问题，就带出与之关联的订单状态**。
     * 售前问题配「待支付 / 待发货」，售后问题配「已发货」——同一笔记订单随问题推进状态。
     */
    const orderStage: OrderStage = question.orderStage || orderStageForQuestion(question);
    const order = this.buildOrder(sessionId, orderStage, Date.parse(String(session.join_at)));
    await this.persistOrder(sessionId, order);
    for (const text of texts) {
      await this.db.query(`INSERT INTO messages (session_id, sender, content, seq) VALUES ($1,'buyer',$2,$3)`, [
        sessionId,
        text,
        nextSeq,
      ]);
    }
    await this.db.query(`UPDATE sessions SET current_seq = $2, state = 'serving', last_buyer_at = now() WHERE id = $1`, [
      sessionId,
      nextSeq,
    ]);
    const updated = await this.loadSession(sessionId);
    const attempt = await this.db.one<{ account_id: number }>(`SELECT account_id FROM attempts WHERE id = $1`, [
      updated.attempt_id,
    ]);
    this.gateway.emitToUser(attempt.account_id, 'buyer.message', {
      attemptId: updated.attempt_id,
      sessionId,
      seq: nextSeq,
      contents: texts,
      emotion: updated.emotion_value,
      question,
      // 售前问题不带订单；售后问题会在这里带上自动生成的订单（前端据此直接刷新订单卡）
      order,
      questionStage: question.stage || null,
      // 服务端发送时间：供前端与压测工具测算端到端推送延迟（方案 9.3）
      sentAt: new Date().toISOString(),
    });
  }

  /* ---------------- 客服回复 ---------------- */

  async sendMessage(
    accountId: number,
    attemptId: number,
    sessionId: number,
    content: string,
    /**
     * 业务动作消息的附加信息（客户 2026-10-03）。
     * 带 businessAction 的消息：不参与「无效 / 敷衍回复」判定（连点两次催付是正常操作），
     * 其余（计入本轮响应时长、要点命中、情绪变化）与普通回复一致。
     */
    meta?: { businessAction?: { code: string; name: string } }
  ) {
    const attempt = await this.assertAttempt(accountId, attemptId);
    // 判定与计分一律按开局时的参数快照：系统参数改完只对新接待生效，历史接待按旧快照复算
    const params = (attempt.param_snapshot as SystemParams) || (await this.settings.getParams());
    const session = await this.loadSession(sessionId);
    if (!session || session.attempt_id !== attemptId) throw new BizError(ERR.NOT_FOUND, '会话不存在');
    if (session.state === 'pending') throw new BizError(ERR.SESSION_STATE, '该买家还在排队待接入，请稍候');
    if (['finished', 'transferred', 'aborted'].includes(session.state)) throw new BizError(ERR.SESSION_STATE, '该会话已结束');

    const text = String(content || '').trim();
    if (!text) throw new BizError(ERR.PARAM, '请输入有效回复');
    if (text.length > params.messageMaxLength) throw new BizError(ERR.PARAM, `单条消息不能超过 ${params.messageMaxLength} 字`);
    if (this.isMeaningless(text)) throw new BizError(ERR.PARAM, '请输入有效回复内容');

    const tolerance = params.waitToleranceFactor[attempt.level] ?? 1;
    const now = Date.now();
    const lastBuyerAt = session.last_buyer_at ? new Date(session.last_buyer_at).getTime() : null;

    const currentQuestion = session.questions.find((q) => q.seq === session.current_seq) || null;
    const hitPoints = currentQuestion ? this.matchKeyPoints(text, currentQuestion.keyPoints) : [];
    const hitAny = hitPoints.length > 0;

    // C6：无效 / 敷衍回复判定（默认关闭）。走领域纯函数，规则来自 param_snapshot。
    const historyRows = await this.db.many<any>(
      `SELECT sender, content, seq, rule_result FROM messages WHERE session_id = $1 ORDER BY id`,
      [sessionId]
    );
    const historyMessages: ScoreMessage[] = historyRows.map((m) => ({
      sender: m.sender,
      content: m.content,
      questionSeq: m.rule_result?.questionSeq ?? m.seq,
      hitPoints: m.rule_result?.hitPoints || [],
    }));
    const currentIndex = historyMessages.length;
    const validityRounds = judgeValidReplies(
      [...historyMessages, { sender: 'agent', content: text, questionSeq: session.current_seq, hitPoints }],
      session.questions,
      params
    );
    const invalidReason =
      // 业务动作话术不算敷衍：连点两次催付、或者模板话术与上一条相同，都不该判无效
      meta?.businessAction
        ? null
        : validityRounds.find((r) => r.seq === session.current_seq)?.reasons.find((r) => r.index === currentIndex)?.reason ||
          null;

    // 抖店口径 / 方案 4.2：同一轮多条回复只计首条。
    // 先看这一轮是否已经计过时长；计过就记 null，避免「连发多条各计一次」把平均响应算歪。
    // 注意 last_buyer_at 在客服回复时**不刷新**，所以本轮稍后的第一条有效回复天然按
    // 「买家发消息 → 该条回复」计时，正好满足官方「回退到首条有效回复」的要求。
    // 被判无效的回复同样不计时，把这一轮留给后面的有效回复（始终没有则按 600 秒）。
    const alreadyCounted = await this.db.one<{ id: number }>(
      `SELECT id FROM messages WHERE session_id = $1 AND seq = $2 AND sender = 'agent' AND response_sec IS NOT NULL LIMIT 1`,
      [sessionId, session.current_seq]
    );
    const responseSec =
      !alreadyCounted && !invalidReason && lastBuyerAt ? Math.max(0, Math.round((now - lastBuyerAt) / 1000)) : null;
    const isTimeout = responseSec !== null && responseSec > Math.round(params.timeoutSec * tolerance);

    const emotion = updateEmotion(session.emotion_value, text, params, {
      unresolvedStreak: session.unresolved_streak,
      hitAnyPoint: hitAny,
    });

    const ruleResult = {
      questionSeq: session.current_seq,
      hitPoints,
      missingPoints: currentQuestion ? currentQuestion.keyPoints.filter((p) => !hitPoints.includes(p)) : [],
      emotionDelta: emotion.delta,
      emotionValue: emotion.value,
      emotionReason: emotion.reason,
      escalated: emotion.escalated,
      isTimeout,
      // C6：被判无效时把原因一起落库，明细页据此标注「被判无效的轮次与依据」
      ...(invalidReason ? { invalid: true, invalidReason } : {}),
      // 客户 2026-10-03：业务动作（催付 / 改价 / 去发货…）在消息上留痕，对话与复盘里都能看到
      ...(meta?.businessAction ? { businessAction: meta.businessAction } : {}),
    };

    const inserted = await this.db.one<{ id: number }>(
      `INSERT INTO messages (session_id, sender, content, seq, response_sec, is_timeout, rule_result)
       VALUES ($1,'agent',$2,$3,$4,$5,$6::jsonb) RETURNING id`,
      [sessionId, text, session.current_seq, responseSec, isTimeout, JSON.stringify(ruleResult)]
    );

    // 平均响应按官方口径：Σ轮次时长 ÷ 轮次总数，未回复/无有效回复的轮次记 600 秒
    const roundRows = await this.db.many<{ sec: number | string }>(
      `SELECT min(response_sec) AS sec FROM messages
       WHERE session_id = $1 AND sender = 'agent' AND response_sec IS NOT NULL GROUP BY seq`,
      [sessionId]
    );
    const maxResponseSec = Math.max(session.max_response_sec || 0, responseSec || 0);
    const avgResponseSec = weightedAvgResponseSec(
      roundRows.map((r) => Number(r.sec)),
      session.total_questions
    );
    await this.db.query(
      `UPDATE sessions SET state = 'waiting_buyer',
                           last_agent_at = now(),
                           first_reply_at = COALESCE(first_reply_at, now()),
                           max_response_sec = $2,
                           avg_response_sec = $3,
                           emotion_value = $4,
                           unresolved_streak = $5
       WHERE id = $1`,
      [sessionId, maxResponseSec, avgResponseSec, emotion.value, hitAny ? 0 : session.unresolved_streak + 1]
    );

    this.gateway.emitToUser(accountId, 'agent.message.ack', {
      sessionId,
      messageId: inserted.id,
      responseSec,
      isTimeout,
      ruleResult,
      // C6 实时预警：被判无效 / 敷衍时，前端当场提醒并在该条消息上打标
      invalid: !!invalidReason,
      invalidReason,
    });

    // 方案 3.7.4 / 9.2 场景四：情绪值达到升级阈值后，买家在同一轮追加一条升级追问（每轮只追加一次）
    if (emotion.escalated) {
      const escalation = '你们这样处理我实在接受不了，我要投诉你们！';
      const already = await this.db.one<{ count: string }>(
        `SELECT count(*)::text AS count FROM messages WHERE session_id = $1 AND seq = $2 AND content = $3`,
        [sessionId, session.current_seq, escalation]
      );
      if (Number(already?.count || 0) === 0) {
        await this.db.query(`INSERT INTO messages (session_id, sender, content, seq) VALUES ($1,'buyer',$2,$3)`, [
          sessionId,
          escalation,
          session.current_seq,
        ]);
        this.gateway.emitToUser(accountId, 'buyer.message', {
          attemptId: attempt.id,
          sessionId,
          seq: session.current_seq,
          contents: [escalation],
          emotion: emotion.value,
          escalated: true,
          sentAt: new Date().toISOString(),
        });
      }
    }

    const rng = createRng(now + sessionId);
    const thinkDelay = 3000 + Math.round(rng() * 4000);
    this.scheduler.schedule(`next:${sessionId}`, thinkDelay, () => this.pushNextQuestion(sessionId));

    return { messageId: inserted.id, responseSec, isTimeout, ruleResult, level: attempt.level };
  }

  /**
   * 业务动作（客户 2026-10-03）：「点击后记为一次业务动作」。
   *
   * 订单卡片上的催付 / 改价 / 去发货 等在真实工作台里是平台写操作，训练环境不接平台，改成
   * ① 落一条业务动作记录（复盘可见「这次接待点过哪些动作」）；
   * ② 同时按动作发一句标准话术给买家（复用 sendMessage，所以响应时长 / 命中要点 / 情绪变化照算，
   *    但不参与「无效 / 敷衍回复」判定——连点两次催付是正常操作）。
   */
  async recordBusinessAction(accountId: number, attemptId: number, sessionId: number, code: string) {
    const attempt = await this.assertAttempt(accountId, attemptId);
    const session = await this.loadSession(sessionId);
    if (!session || session.attempt_id !== attemptId) throw new BizError(ERR.NOT_FOUND, '会话不存在');
    if (session.state === 'pending') throw new BizError(ERR.SESSION_STATE, '该买家还在排队待接入，请稍候');
    if (['finished', 'transferred', 'aborted'].includes(session.state)) throw new BizError(ERR.SESSION_STATE, '该会话已结束');

    const action = findBusinessAction(String(code || '').trim());
    if (!action) throw new BizError(ERR.PARAM, '不支持的业务动作');

    const order = (session.order_payload as SimulatedOrder | null) || null;
    if (order && !action.stages.includes(order.stage)) {
      throw new BizError(ERR.PARAM, `「${action.name}」只适用于${actionStageHint(action)}的订单`);
    }

    const product = (session.products || [])[0] || null;
    const content = renderActionPhrase(action, {
      productTitle: product?.title,
      orderNo: order?.orderNo,
      receiver: order?.receiver,
      address: order?.address,
      trackingCompany: order?.trackingCompany,
      trackingNo: order?.trackingNo,
    });

    const sent = await this.sendMessage(accountId, attemptId, sessionId, content, {
      businessAction: { code: action.code, name: action.name },
    });
    await this.db.query(
      `INSERT INTO session_actions (session_id, attempt_id, action_code, action_name, order_stage, content)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [sessionId, attemptId, action.code, action.name, order?.stage ?? null, content]
    );

    return { action: { code: action.code, name: action.name, content }, ...sent, level: attempt.level };
  }

  /* ---------------- 转交与结束 ---------------- */

  async transfer(accountId: number, attemptId: number, sessionId: number) {
    await this.assertAttempt(accountId, attemptId);
    const session = await this.loadSession(sessionId);
    if (!session || session.attempt_id !== attemptId) throw new BizError(ERR.NOT_FOUND, '会话不存在');
    if (session.state === 'pending') throw new BizError(ERR.SESSION_STATE, '该买家还在排队待接入，请稍候');
    if (['finished', 'transferred', 'aborted'].includes(session.state)) throw new BizError(ERR.SESSION_STATE, '该会话已结束');
    const transferred = Array.from(new Set([...(session.transferred_seqs || []), session.current_seq]));
    await this.db.query(`UPDATE sessions SET transferred_seqs = $2::jsonb WHERE id = $1`, [
      sessionId,
      JSON.stringify(transferred),
    ]);
    await this.db.query(`INSERT INTO messages (session_id, sender, content, seq) VALUES ($1,'system',$2,$3)`, [
      sessionId,
      '客服已发起转交，系统已记录',
      session.current_seq,
    ]);
    this.scheduler.cancel(`next:${sessionId}`);
    this.scheduler.schedule(`next:${sessionId}`, this.REPLY_THINK_DELAY_MS, () => this.pushNextQuestion(sessionId));
    this.gateway.emitToUser(accountId, 'session.transferred', { sessionId, transferredSeqs: transferred });
    return { success: true, transferredSeqs: transferred };
  }

  async finishSession(accountId: number, attemptId: number, sessionId: number) {
    await this.assertAttempt(accountId, attemptId);
    const session = await this.loadSession(sessionId);
    if (!session || session.attempt_id !== attemptId) throw new BizError(ERR.NOT_FOUND, '会话不存在');
    if (session.state === 'pending') throw new BizError(ERR.SESSION_STATE, '该买家还在排队待接入，请稍候');
    if (['finished', 'transferred', 'aborted'].includes(session.state)) throw new BizError(ERR.SESSION_STATE, '该会话已结束');
    const reason = session.current_seq >= session.total_questions ? 'normal' : 'early';
    this.scheduler.cancel(`next:${sessionId}`);
    await this.completeSession(sessionId, reason);
    return { success: true, reason };
  }

  async finishAttempt(accountId: number, attemptId: number) {
    await this.assertAttempt(accountId, attemptId);
    const sessions = await this.db.many<SessionRow>(`SELECT * FROM sessions WHERE attempt_id = $1`, [attemptId]);
    for (const s of sessions) {
      if (!['finished', 'transferred', 'aborted'].includes(s.state)) {
        this.scheduler.cancel(`next:${s.id}`);
        this.scheduler.cancel(`join:${s.id}`);
        await this.completeSession(s.id, s.current_seq >= s.total_questions ? 'normal' : 'early');
      }
    }
    return this.finalizeAttempt(attemptId);
  }

  /* ---------------- 评分与收尾 ---------------- */

  async completeSession(sessionId: number, reason: 'normal' | 'early' | 'transferred' | 'aborted'): Promise<void> {
    const session = await this.loadSession(sessionId);
    if (!session) return;
    if (['finished', 'transferred', 'aborted'].includes(session.state)) return;

    const attemptRow = await this.db.one<{ account_id: number; param_snapshot: SystemParams }>(
      `SELECT account_id, param_snapshot FROM attempts WHERE id = $1`,
      [session.attempt_id]
    );
    const params = attemptRow?.param_snapshot || (await this.settings.getParams());
    const messages = await this.db.many<any>(
      `SELECT sender, content, seq, response_sec, is_timeout, rule_result FROM messages WHERE session_id = $1 ORDER BY id`,
      [sessionId]
    );
    const styleEmotional = !!this.styleBehavior[session.style_code]?.emotional;

    const result = scoreSession({
      questions: session.questions.filter((q) => q.seq <= session.total_questions),
      messages: messages.map((m) => ({
        sender: m.sender,
        content: m.content,
        questionSeq: m.rule_result?.questionSeq ?? m.seq,
        responseSec: m.response_sec,
        isTimeout: m.is_timeout,
        hitPoints: m.rule_result?.hitPoints || [],
      })),
      transferredQuestionSeqs: session.transferred_seqs || [],
      emotionFinal: session.emotion_value,
      hasEmotionScenario: styleEmotional,
      params,
    });

    const aborted = reason === 'aborted';
    const finalScore = aborted ? 0 : result.total;
    await this.db.tx(async (client) => {
      await client.query(
        `INSERT INTO scores (session_id, attempt_id, response_score, solving_score, wording_score, emotion_score, total_score, deductions, metrics)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb) ON CONFLICT (session_id) DO NOTHING`,
        [
          sessionId,
          session.attempt_id,
          aborted ? 0 : result.responseScore,
          aborted ? 0 : result.solvingScore,
          aborted ? 0 : result.wordingScore,
          aborted ? 0 : result.emotionScore,
          finalScore,
          JSON.stringify(result.deductions),
          JSON.stringify(result.metrics),
        ]
      );
      await client.query(
        `UPDATE sessions SET state = $2, finished_reason = $3, finished_at = now(), score = $4 WHERE id = $1`,
        [sessionId, aborted ? 'aborted' : 'finished', reason, finalScore]
      );
    });

    if (attemptRow) {
      this.gateway.emitToUser(attemptRow.account_id, 'session.finished', {
        attemptId: session.attempt_id,
        sessionId,
        reason,
        score: finalScore,
        dimensions: aborted
          ? null
          : {
              response: result.responseScore,
              solving: result.solvingScore,
              wording: result.wordingScore,
              emotion: result.emotionScore,
            },
        deductions: aborted ? [] : result.deductions,
      });
    }

    // C5：这个会话让出了并发位，把「待接入」的买家补进来（没有待接入时是空操作）
    await this.promoteWaiting(session.attempt_id);

    const remaining = await this.db.one<{ count: string }>(
      `SELECT count(*)::text AS count FROM sessions WHERE attempt_id = $1 AND state NOT IN ('finished','transferred','aborted')`,
      [session.attempt_id]
    );
    if (Number(remaining.count) === 0) await this.finalizeAttempt(session.attempt_id);
  }

  async finalizeAttempt(attemptId: number): Promise<any> {
    const attempt = await this.db.one<any>(`SELECT * FROM attempts WHERE id = $1`, [attemptId]);
    if (!attempt) throw new BizError(ERR.NOT_FOUND, '接待任务不存在');
    if (attempt.status !== 'running') return this.attemptResult(attemptId);

    const sessions = await this.db.many<any>(
      `SELECT s.id, s.total_questions, COALESCE(sc.total_score, 0) AS score
       FROM sessions s LEFT JOIN scores sc ON sc.session_id = s.id WHERE s.attempt_id = $1`,
      [attemptId]
    );
    const aggregated = scoreAttempt(sessions.map((s) => ({ score: Number(s.score), questionCount: s.total_questions })));
    const params = attempt.param_snapshot as SystemParams;
    const conclusion = aggregated.total >= params.passLine ? 'pass' : 'fail';
    await this.db.query(
      `UPDATE attempts SET status = 'finished', finished_at = now(), total_score = $2, conclusion = $3 WHERE id = $1`,
      [attemptId, aggregated.total, conclusion]
    );

    const scriptIds = await this.db.many<{ script_id: number }>(
      `SELECT DISTINCT script_id FROM sessions WHERE attempt_id = $1`,
      [attemptId]
    );
    for (const { script_id } of scriptIds) {
      const avgRow = await this.db.one<{ avg: string | null }>(
        `SELECT avg(sc.total_score) AS avg
         FROM scores sc JOIN sessions s2 ON s2.id = sc.session_id
         WHERE s2.script_id = $1`,
        [script_id]
      );
      const avgScore =
        avgRow?.avg === null || avgRow?.avg === undefined ? null : Math.round(Number(avgRow.avg) * 100) / 100;
      await this.db.query(
        `UPDATE scripts SET practiced_count = practiced_count + 1,
                            avg_score = COALESCE($2, avg_score),
                            last_practiced_at = now()
         WHERE id = $1`,
        [script_id, avgScore]
      );
    }

    // 客户 2026-10-02 确认：任务训练与自由练习都计入解锁进度
    // （方案 F1-02 原写「自由练习不计入解锁进度」，已按客户口径覆盖并登记在看板里）
    await this.updateUnlock(attempt.account_id, attempt.level, conclusion === 'pass');

    if (attempt.source === 'task') {
      try {
        await this.tasks.evaluateAttempt(attemptId);
      } catch (err) {
        this.logger.warn(`任务达成判定失败: ${(err as Error).message}`);
      }
    }

    const result = await this.attemptResult(attemptId);
    this.gateway.emitToUser(attempt.account_id, 'reception.finished', result);
    return result;
  }

  async updateUnlock(accountId: number, level: string, passed: boolean): Promise<void> {
    const params = await this.settings.getParams();
    const row = await this.db.one<{ id: number; streak: number }>(
      `SELECT id, streak FROM unlock_progress WHERE account_id = $1 AND level = $2`,
      [accountId, level]
    );
    const streak = passed ? (row?.streak || 0) + 1 : 0;
    if (row) await this.db.query(`UPDATE unlock_progress SET streak = $2, updated_at = now() WHERE id = $1`, [row.id, streak]);
    else await this.db.query(`INSERT INTO unlock_progress (account_id, level, streak, unlocked) VALUES ($1,$2,$3,false)`, [accountId, level, streak]);

    const levels = Object.keys(LEVELS);
    const index = levels.indexOf(level);
    if (streak >= params.unlockConsecutive && index >= 0 && index < levels.length - 1) {
      const nextLevel = levels[index + 1];
      const next = await this.db.one<{ id: number }>(
        `SELECT id FROM unlock_progress WHERE account_id = $1 AND level = $2`,
        [accountId, nextLevel]
      );
      if (next) await this.db.query(`UPDATE unlock_progress SET unlocked = true, updated_at = now() WHERE id = $1`, [next.id]);
      else await this.db.query(`INSERT INTO unlock_progress (account_id, level, streak, unlocked) VALUES ($1,$2,0,true)`, [accountId, nextLevel]);
    }
  }

  /* ---------------- 查询 ---------------- */

  async snapshot(accountId: number, attemptId: number) {
    const attempt = await this.assertAttempt(accountId, attemptId);
    const sessions = await this.db.many<SessionRow>(`SELECT * FROM sessions WHERE attempt_id = $1 ORDER BY id`, [attemptId]);
    const sessionIds = sessions.map((s) => s.id);
    const messages = sessionIds.length
      ? await this.db.many<any>(
          `SELECT id, session_id AS "sessionId", sender, content, seq, created_at AS "createdAt",
                  response_sec AS "responseSec", is_timeout AS "isTimeout", rule_result AS "ruleResult"
           FROM messages WHERE session_id IN (${sessionIds.map((_, i) => `$${i + 1}`).join(',')}) ORDER BY id`,
          sessionIds
        )
      : [];
    const params = attempt.param_snapshot as SystemParams;
    const now = Date.now();
    const level = LEVELS[attempt.level];
    const limit = Math.round(params.timeoutSec * (params.waitToleranceFactor[attempt.level] ?? 1));

    // 任务训练时把任务信息一并带出去，接待页据此显示任务名 / 目标 / 进度（方案 F6-05 / F6-06）
    const task = attempt.task_id
      ? await this.db.one<any>(
          `SELECT id, task_no AS "taskNo", name, levels, deadline, target_count AS "targetCount"
           FROM tasks WHERE id = $1`,
          [attempt.task_id]
        )
      : null;
    const taskTargets = task
      ? await this.db.many<any>(`SELECT metric, operator, threshold FROM task_targets WHERE task_id = $1 ORDER BY id`, [
          task.id,
        ])
      : [];
    const taskProgress = task
      ? await this.db.one<any>(`SELECT done_count AS "doneCount", status FROM task_assignees WHERE task_id = $1 AND account_id = $2`, [
          task.id,
          accountId,
        ])
      : null;

    return {
      attempt: {
        id: attempt.id,
        attemptNo: attempt.attempt_no,
        level: attempt.level,
        levelName: level?.name,
        status: attempt.status,
        source: attempt.source,
        startedAt: attempt.started_at,
        task: task
          ? {
              ...task,
              targets: taskTargets.map((t) => ({ ...t, threshold: Number(t.threshold) })),
              doneCount: Number(taskProgress?.doneCount ?? 0),
            }
          : null,
      },
      sessions: sessions.map((s) => {
        const lastBuyer = s.last_buyer_at ? new Date(s.last_buyer_at).getTime() : null;
        const waitedSec = lastBuyer ? Math.round((now - lastBuyer) / 1000) : 0;
        return { ...this.toSessionDto(s), waitedSec, timeoutLimitSec: limit, remainSec: Math.max(0, limit - waitedSec) };
      }),
      messages,
    };
  }

  async unlockState(accountId: number) {
    const params = await this.settings.getParams();
    const rows = await this.db.many<{ level: string; streak: number; unlocked: boolean }>(
      `SELECT level, streak, unlocked FROM unlock_progress WHERE account_id = $1`,
      [accountId]
    );
    const map = new Map(rows.map((r) => [r.level, r]));
    return Object.values(LEVELS).map((l) => {
      const row = map.get(l.code);
      // 接入人数取「客户在系统参数里配的值」，没配就用方案的 1/2/3/4
      const configured = Number(params.levelConcurrent?.[l.code] ?? l.concurrent);
      // C5：本次模拟合计接待人数（客户 2026-10-03 默认 10 人）——开局界面按它预填，管理员可当场改
      const configuredTotal = Number(params.levelTotal?.[l.code] ?? DEFAULT_LEVEL_TOTAL);
      return {
        code: l.code,
        name: l.name,
        concurrent: Math.max(1, Math.min(configured, params.maxConcurrent)),
        defaultConcurrent: l.concurrent,
        total: Math.max(1, Math.min(configuredTotal, 20)),
        defaultTotal: configured,
        rounds: l.rounds,
        waitTolerance: l.waitTolerance,
        unlocked: row ? row.unlocked || l.code === 'L1' : l.code === 'L1',
        streak: row?.streak || 0,
        requiredStreak: params.unlockConsecutive,
      };
    });
  }

  async attemptResult(attemptId: number) {
    const attempt = await this.db.one<any>(`SELECT * FROM attempts WHERE id = $1`, [attemptId]);
    if (!attempt) throw new BizError(ERR.NOT_FOUND, '接待任务不存在');
    const sessions = await this.db.many<any>(
      `SELECT s.id, s.buyer_name AS "buyerName", s.state, s.finished_reason AS "finishedReason", s.score,
              s.emotion_value AS "emotionValue", s.timeout_count AS "timeoutCount", s.total_questions AS "totalQuestions",
              sc.response_score AS "responseScore", sc.solving_score AS "solvingScore", sc.wording_score AS "wordingScore",
              sc.emotion_score AS "emotionScore", sc.total_score AS "totalScore", sc.deductions, sc.metrics,
              sc2.name AS "scriptName", sc2.script_no AS "scriptNo", st.name AS "styleName"
       FROM sessions s
       LEFT JOIN scores sc ON sc.session_id = s.id
       LEFT JOIN scripts sc2 ON sc2.id = s.script_id
       LEFT JOIN styles st ON st.id = sc2.style_id
       WHERE s.attempt_id = $1 ORDER BY s.id`,
      [attemptId]
    );
    return {
      attemptId,
      attemptNo: attempt.attempt_no,
      accountId: attempt.account_id,
      level: attempt.level,
      levelName: LEVELS[attempt.level]?.name,
      totalScore: attempt.total_score === null ? null : Number(attempt.total_score),
      conclusion: attempt.conclusion,
      status: attempt.status,
      startedAt: attempt.started_at,
      finishedAt: attempt.finished_at,
      sessions,
    };
  }

  /* ---------------- 内部工具 ---------------- */

  /**
   * 断线超时中止（方案 4.1 / 4.7 / 4.8）：
   * 客服端曾连接过、当前无活动连接且超过 disconnectGraceSec 没有任何信号时，
   * 该客服进行中的会话按异常中止处理（会话 0 分计入接待任务）。
   * 只用 HTTP 调接口、从未建立实时连接的账号不会命中此规则。
   */
  private async abortDisconnectedAttempts(): Promise<void> {
    const params = await this.settings.getParams();
    const graceMs = params.disconnectGraceSec * 1000;
    const now = Date.now();
    const rows = await this.db.many<{ id: number; attempt_id: number; account_id: number; startedAt: string }>(
      `SELECT s.id, s.attempt_id, a.account_id, a.started_at AS "startedAt"
       FROM sessions s JOIN attempts a ON a.id = s.attempt_id
       WHERE a.status = 'running' AND s.state NOT IN ('finished','transferred','aborted')`
    );
    const stale = rows.filter((row) => {
      const presence = this.gateway.presenceOf(row.account_id);
      return shouldAbortAsDisconnected({
        startedAt: new Date(row.startedAt).getTime(),
        lastSeenAt: presence.lastSeenAt,
        sockets: presence.sockets,
        everConnected: presence.everConnected,
        now,
        graceMs,
      });
    });
    if (!stale.length) return;

    const byAttempt = new Map<number, number[]>();
    for (const row of stale) {
      const list = byAttempt.get(row.attempt_id) || [];
      list.push(row.id);
      byAttempt.set(row.attempt_id, list);
    }
    for (const [attemptId, sessionIds] of byAttempt) {
      for (const sessionId of sessionIds) await this.completeSession(sessionId, 'aborted');
      this.logger.warn(
        `接待任务 ${attemptId}：客服端断线超过 ${params.disconnectGraceSec} 秒，${sessionIds.length} 个会话已按异常中止处理`
      );
    }
  }

  /**
   * 每秒把服务端计时推给正在接待的客服（方案 5.5）。
   * 口径与 snapshot 完全一致：等待时长由服务端按 last_buyer_at 计算，
   * 前端只负责展示，不作为计时权威；心跳信息一并回传，便于前端判断连接健康。
   */
  private async broadcastTimerTick(): Promise<void> {
    const rows = await this.db.many<any>(
      `SELECT s.id, s.attempt_id, s.state, s.last_buyer_at, a.account_id, a.level, a.param_snapshot
       FROM sessions s JOIN attempts a ON a.id = s.attempt_id
       WHERE a.status = 'running'`
    );
    if (!rows.length) return;

    const now = Date.now();
    const grouped = new Map<number, { accountId: number; sessions: any[] }>();
    for (const row of rows) {
      const params = row.param_snapshot as SystemParams;
      const limit = Math.round(params.timeoutSec * (params.waitToleranceFactor[row.level] ?? 1));
      const lastBuyer = row.last_buyer_at ? new Date(row.last_buyer_at).getTime() : null;
      const waitedSec = lastBuyer ? Math.max(0, Math.round((now - lastBuyer) / 1000)) : 0;

      const entry = grouped.get(row.attempt_id) ?? { accountId: row.account_id, sessions: [] };
      entry.sessions.push({
        sessionId: row.id,
        state: row.state,
        waitedSec,
        timeoutLimitSec: limit,
        remainSec: Math.max(0, limit - waitedSec),
      });
      grouped.set(row.attempt_id, entry);
    }

    for (const [attemptId, entry] of grouped) {
      this.gateway.emitToUser(entry.accountId, 'timer.tick', {
        attemptId,
        serverTime: new Date(now).toISOString(),
        lastAckAt: this.gateway.lastAck(entry.accountId)?.at ?? null,
        sessions: entry.sessions,
      });
    }
  }

  private async scanTimeout(): Promise<void> {
    await this.abortDisconnectedAttempts();
    await this.broadcastTimerTick();
    const rows = await this.db.many<any>(
      `SELECT s.id, s.attempt_id, s.last_buyer_at, s.state, a.level, a.account_id, a.param_snapshot
       FROM sessions s JOIN attempts a ON a.id = s.attempt_id
       WHERE a.status = 'running' AND s.state IN ('serving','waiting_buyer','wait','timeout')`
    );
    for (const row of rows) {
      if (!row.last_buyer_at) continue;
      const params = row.param_snapshot as SystemParams;
      const tolerance = params.waitToleranceFactor[row.level] ?? 1;
      const limitMs = params.timeoutSec * tolerance * 1000;
      const elapsed = Date.now() - new Date(row.last_buyer_at).getTime();
      if (elapsed <= limitMs) continue;
      const already = await this.db.one<{ count: string }>(
        `SELECT count(*)::text AS count FROM messages
         WHERE session_id = $1 AND is_timeout = true AND seq = (SELECT current_seq FROM sessions WHERE id = $1)`,
        [row.id]
      );
      if (Number(already.count) > 0) continue;
      const current = await this.loadSession(row.id);
      await this.db.query(`INSERT INTO messages (session_id, sender, content, seq, is_timeout) VALUES ($1,'system',$2,$3,true)`, [
        row.id,
        `该会话已超过 ${Math.round(params.timeoutSec * tolerance)} 秒未回复，系统记录一次超时`,
        current?.current_seq || 0,
      ]);
      await this.db.query(`UPDATE sessions SET timeout_count = timeout_count + 1, state = 'timeout' WHERE id = $1`, [row.id]);
      this.gateway.emitToUser(row.account_id, 'timeout.warning', {
        attemptId: row.attempt_id,
        sessionId: row.id,
        timeoutSec: Math.round(params.timeoutSec * tolerance),
      });
    }
  }

  /**
   * 难度是否已解锁（方案 4.4 / F1-02 逐步解锁）。
   * L1 永远开放；其余看 unlock_progress（达标自动解锁下一档，或由带教/管理员手工开放）。
   */
  private async isLevelUnlocked(accountId: number, code: string): Promise<boolean> {
    if (code === 'L1') return true;
    const row = await this.db.one<{ unlocked: boolean }>(
      `SELECT unlocked FROM unlock_progress WHERE account_id = $1 AND level = $2`,
      [accountId, code]
    );
    return !!row?.unlocked;
  }

  private async assertAttempt(accountId: number, attemptId: number) {
    const attempt = await this.db.one<any>(`SELECT * FROM attempts WHERE id = $1`, [attemptId]);
    if (!attempt) throw new BizError(ERR.NOT_FOUND, '接待任务不存在');
    if (attempt.account_id !== accountId) throw new BizError(ERR.FORBIDDEN, '无权操作该接待任务');
    if (attempt.status !== 'running') throw new BizError(ERR.RECEPTION_FINISHED, '该接待任务已结束');
    return attempt;
  }

  private async loadSession(sessionId: number): Promise<SessionRow | null> {
    return this.db.one<SessionRow>(`SELECT * FROM sessions WHERE id = $1`, [sessionId]);
  }

  private async pickProduct(scriptId: number): Promise<any | null> {
    // 方案 4.5：同一剧本关联多个商品时随机取其一，保证同批次训练的商品多样性。
    const script = await this.db.one<{ product_ids: any }>(`SELECT product_ids FROM scripts WHERE id = $1`, [scriptId]);
    const ids = Array.isArray(script?.product_ids)
      ? script!.product_ids.map((item: any) => Number(item)).filter((item: number) => Number.isFinite(item))
      : [];
    if (!ids.length) return null;
    const rows = await this.db.many<any>(
      /**
       * 客户 2026-10-03：接待页的「规格 / 属性」要看得到**管理员在《商品库》里配的真实信息**，
       * 所以会话快照里的商品要把属性字段一次带全（规格 SKU、服务承诺、适用场景、库存、划线价、
       * 分类、详情图、上架状态），前端弹窗直接渲染这些数据，不再另发请求。
       */
      `SELECT p.id, p.product_no AS "productNo", p.title, p.price, p.cover_url AS "coverUrl", p.skus, p.attributes, p.services,
              p.scenes, p.stock, p.origin_price AS "originPrice", p.category, p.status,
              p.detail_images AS "detailImages"
       FROM products p WHERE p.id IN (${ids.map((_, i) => `$${i + 1}`).join(',')}) AND p.deleted_at IS NULL ORDER BY p.id`,
      ids
    );
    if (!rows.length) return null;
    return rows[Math.floor(Math.random() * rows.length)];
  }

  /**
   * 要点命中判定：关键词直接包含 + 同义词。
   * 同义词表见 domain/key-point-aliases.ts；内容库中的归纳性要点
   * （如「解决方案」「处理时效」）必须依靠它才能被客服的自然回复命中。
   */
  matchKeyPoints(content: string, keyPoints: string[]): string[] {
    const normalized = String(content || '').replace(/\s/g, '');
    return keyPoints.filter((point) => {
      const key = String(point || '').replace(/\s/g, '');
      if (!key) return false;
      if (normalized.includes(key)) return true;
      const list = KEY_POINT_ALIASES[key] || [];
      return list.some((alias) => normalized.includes(alias));
    });
  }

  private isMeaningless(text: string): boolean {
    const stripped = text.replace(/[\s~～!！?？。，,、.…—\-_=+*#@$%^&()（）\[\]【】"'’“”]/g, '');
    return stripped.length === 0;
  }

  private toSessionDto(s: SessionRow) {
    return {
      sessionId: s.id,
      buyerName: s.buyer_name,
      styleCode: s.style_code,
      state: s.state,
      seq: s.current_seq,
      totalQuestions: s.total_questions,
      questions: s.questions,
      product: (s.products || [])[0] || null,
      order: s.order_no
        ? /**
           * 订单卡片的完整快照（客户 2026-10-03：待支付 / 待发货 / 已发货三态，
           * 字段与操作按钮各不相同）。快照存在 sessions.order_payload 里，
           * 单号/金额/状态另外冗余在列上，便于查询统计。
           */
          (s.order_payload as SimulatedOrder) || {
            orderNo: s.order_no,
            amount: s.order_amount,
            statusText: s.order_status,
            placedAt: new Date(new Date(s.join_at).getTime() - 3600 * 1000).toISOString(),
          }
        : null,
      emotionValue: s.emotion_value,
      timeoutCount: s.timeout_count,
      score: s.score === null ? null : Number(s.score),
      joinAt: s.join_at,
    };
  }
}
