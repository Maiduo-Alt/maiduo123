/** 领域层公共类型定义（纯数据，不依赖 NestJS）。 */

export type Sender = 'buyer' | 'agent' | 'system';
export type SessionState =
  /** 待接入：已抽好剧本但还没轮到进线（客户新增需求 C5：本次模拟总接待人数 > 同时在线人数时出现） */
  | 'pending'
  | 'wait'
  | 'serving'
  | 'waiting_buyer'
  | 'timeout'
  | 'finished'
  | 'transferred'
  | 'aborted';

export interface ScoreWeights {
  response: number;
  solving: number;
  wording: number;
  emotion: number;
}

export interface SystemParams {
  firstResponseLimitSec: number;
  avgResponseLimitSec: number;
  replyRateLimitPct: number;
  timeoutSec: number;
  timeoutPenalty: number;
  weights: ScoreWeights;
  passLine: number;
  unlockConsecutive: number;
  /**
   * 各难度档位的实际接入买家数（客户新增需求：管理账号可设置并发接待人数）。
   * 默认仍是方案的 1/2/3/4；实际取 min(本档人数, maxConcurrent)。
   */
  levelConcurrent: Record<string, number>;
  /**
   * 各难度档位「本次模拟的总接待人数」（客户新增需求 C5）。
   * 客户 2026-10-03 口径：**默认 10 人**（管理员可在系统参数里提前设置）。
   * 总量小于同时在线时，总量即硬上限（优先保证总量）。
   */
  levelTotal: Record<string, number>;
  maxConcurrent: number;
  levelRounds: [number, number];
  waitToleranceFactor: Record<string, number>;
  levelJoinDelaySec: [number, number];
  highLevelStyleBoost: number;
  emotionEscalateThreshold: number;
  emotionSootheStep: number;
  emotionNegativeStep: number;
  defaultStyleRatio: Record<string, number>;
  messageMaxLength: number;
  disconnectGraceSec: number;
  batchAsyncThreshold: number;
  /** 提示模式（方案 F1-15）：带教开启后，客服长时间未回复会看到话术思路提示；仅用于教学，不参与评分 */
  hintMode: boolean;
  hintDelaySec: number;
  /** 登录安全（方案 F8-10） */
  loginMaxFailures: number;
  loginLockMinutes: number;
  passwordMaxAgeDays: number;
  emotionNeutralFullScore: boolean;
  greetingWords: string[];
  closingWords: string[];
  sootheWords: string[];
  negativeWords: string[];
  forbiddenWords: string[];
  /**
   * 无效 / 敷衍回复判定（客户新增需求 C6，默认关闭）。
   * 官方只公布三条情形并声明「以系统判定为准」，没有公开词表；banalWords 由业务方自行维护。
   */
  invalidReplyEnabled: boolean;
  /** identical：与上一条客服回复完全相同即判无效；streak：同一内容连续 N 次才判无效 */
  invalidReplyDuplicateMode: 'identical' | 'streak';
  invalidReplyDuplicateStreak: number;
  /** 连续 N 轮命中要点为 0（近似官方「买家明确要求后仍未改善」） */
  invalidReplyUnresolvedEnabled: boolean;
  invalidReplyUnresolvedStreak: number;
  /** 自定义敷衍词表：与 forbiddenWords 分离，避免同一句被三重惩罚 */
  banalWords: string[];
  /**
   * 客户 2026-10-03：一次接待里的问题按比例混合售前 / 售后——
   * 大部分是「还没有订单、只咨询商品信息」的售前问题，小部分是「买完商品后」的订单类售后问题
   * （改地址 / 改快递 / 催发货 / 改单…）。这里是后者的占比（%，0～80），默认 20。
   */
  aftersaleQuestionRatio: number;
}

/** 客户 2026-10-03：本次模拟的总接待人数默认 10 人（管理员可提前设置）。 */
export const DEFAULT_LEVEL_TOTAL = 10;

export const DEFAULT_PARAMS: SystemParams = {
  firstResponseLimitSec: 30,
  avgResponseLimitSec: 60,
  replyRateLimitPct: 90,
  timeoutSec: 180,
  timeoutPenalty: 3,
  weights: { response: 40, solving: 35, wording: 15, emotion: 10 },
  passLine: 80,
  // 客户 2026-10-02 确认：达标 1 次即解锁下一档（方案默认 2 次，属客户覆盖值）
  unlockConsecutive: 1,
  levelConcurrent: { L1: 1, L2: 2, L3: 3, L4: 4 },
  // 客户新增需求 C5：本次模拟的总接待人数。客户 2026-10-03 明确默认 10 人，
  // 管理员可在《系统参数 → 难度与接待参数》里提前按档位设置。
  levelTotal: { L1: 10, L2: 10, L3: 10, L4: 10 },
  maxConcurrent: 4,
  levelRounds: [6, 10],
  waitToleranceFactor: { L1: 1.5, L2: 1, L3: 1, L4: 1 },
  levelJoinDelaySec: [10, 30],
  highLevelStyleBoost: 1.5,
  emotionEscalateThreshold: 80,
  emotionSootheStep: 15,
  emotionNegativeStep: 20,
  defaultStyleRatio: { friendly: 30, impatient: 15, direct: 20, hesitant: 20, silent: 15 },
  // 客户 2026-10-03：对齐飞鸽会话页的输入上限（方案 10.3 原值 500，已登记为客户覆盖值）
  messageMaxLength: 800,
  disconnectGraceSec: 60,
  batchAsyncThreshold: 100,
  hintMode: false,
  hintDelaySec: 60,
  loginMaxFailures: 5,
  loginLockMinutes: 15,
  passwordMaxAgeDays: 90,
  emotionNeutralFullScore: true,
  greetingWords: ['您好', '你好', '在的', '亲', '很高兴为您服务'],
  closingWords: ['还有其他', '还有什么', '感谢您的咨询', '祝您', '再见', '随时联系'],
  sootheWords: ['理解', '抱歉', '非常抱歉', '不好意思', '马上为您', '立刻为您', '放心', '请您放心', '我帮您', '为您处理'],
  negativeWords: ['不知道', '没办法', '你自己看', '不清楚', '不归我管', '随便你', '就是这样'],
  forbiddenWords: ['不知道', '没办法', '你自己看', '不归我管', '与我无关', '你懂不懂'],
  // 客户新增需求 C6：默认关闭，开启后按下面的阈值判定无效 / 敷衍回复
  invalidReplyEnabled: false,
  invalidReplyDuplicateMode: 'streak',
  invalidReplyDuplicateStreak: 3,
  invalidReplyUnresolvedEnabled: false,
  invalidReplyUnresolvedStreak: 3,
  banalWords: [],
  // 客户 2026-10-03：一次接待里约两成问题是「买完商品后」的订单类售后问题，其余是商品咨询（售前）
  aftersaleQuestionRatio: 20,
};

/** 难度档位定义。 */
export interface LevelDef {
  code: 'L1' | 'L2' | 'L3' | 'L4';
  name: string;
  concurrent: number;
  rounds: [number, number];
  waitTolerance: number;
  stagePreference: 'presale' | 'mixed' | 'aftersale';
}

export const LEVELS: Record<string, LevelDef> = {
  L1: { code: 'L1', name: '话术适应', concurrent: 1, rounds: [6, 10], waitTolerance: 1.5, stagePreference: 'presale' },
  L2: { code: 'L2', name: '简单', concurrent: 2, rounds: [6, 10], waitTolerance: 1, stagePreference: 'mixed' },
  L3: { code: 'L3', name: '进阶', concurrent: 3, rounds: [6, 10], waitTolerance: 1, stagePreference: 'aftersale' },
  L4: { code: 'L4', name: '困难', concurrent: 4, rounds: [6, 10], waitTolerance: 1, stagePreference: 'aftersale' },
};

/** 剧本中的一个提问轮次。 */
export interface ScriptQuestion {
  seq: number;
  question: string;
  keyPoints: string[];
  needTransfer?: boolean;
  /**
   * 该问题属于售前还是售后（方案 3.3 / 客户 2026-10-03 反馈）。
   * 目前同一条咨询内容的问题都继承它的接待阶段；字段独立存在是为了以后能出现
   * 「售前内容里夹带售后问题」的混合剧本——推送时会按它决定要不要自动生成订单。
   */
  stage?: 'presale' | 'aftersale';
  /**
   * 该问题对应的模拟订单状态（客户 2026-10-03：售前/售后以发货为节点）。
   * 待支付 / 待发货 = 售前；已发货 = 售后。推送时按它生成或推进订单。
   */
  orderStage?: 'unpaid' | 'unshipped' | 'shipped';
}

/** 会话消息（评分输入）。 */
export interface ScoreMessage {
  sender: Sender;
  content: string;
  questionSeq?: number | null;
  responseSec?: number | null;
  isTimeout?: boolean;
  hitPoints?: string[];
}

export interface SessionScoreInput {
  questions: ScriptQuestion[];
  messages: ScoreMessage[];
  transferredQuestionSeqs?: number[];
  emotionFinal: number;
  hasEmotionScenario: boolean;
  params: SystemParams;
}

export interface Deduction {
  dimension: 'response' | 'solving' | 'wording' | 'emotion';
  reason: string;
  points: number;
  questionSeq?: number | null;
}

export interface SessionScore {
  responseScore: number;
  solvingScore: number;
  wordingScore: number;
  emotionScore: number;
  total: number;
  deductions: Deduction[];
  metrics: {
    firstResponseSec: number | null;
    avgResponseSec: number | null;
    replyRatePct: number;
    timeoutCount: number;
    solvedCount: number;
    questionCount: number;
  };
}

export interface StyleDef {
  code: string;
  id?: number;
  name: string;
  ratio: number;
  isEmotional?: boolean;
}

export interface ScriptCandidate {
  id: number;
  scriptNo: string;
  name: string;
  qaId: number;
  styleId: number;
  stage: 'presale' | 'aftersale';
  questionSeq: ScriptQuestion[];
  practicedCount: number;
  lastPracticedAt?: Date | string | null;
  emotionStyle?: boolean;
}
