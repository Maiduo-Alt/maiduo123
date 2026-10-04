/**
 * 响应时长的「轮次」建模（抖店官方口径，2026-10-02 取得）。
 *
 * 官方原文：飞鸽平均响应时长 = 近 30 天工作时间消费者与商家飞鸽对话轮次的回复时长之和
 * ÷ 近 30 天工作时间人工咨询对话轮次总数；未回复本轮记 600 秒；消极敷衍回复判为无效回复，
 * 后续有有效回复则本轮记「用户发消息到首条有效回复」的时长，仍无有效回复则记 600 秒。
 *
 * 落到本系统（单次接待、不切时间窗）：
 * 1. 一轮 = 一个提问轮次（questions 里的一个 seq）。轮次总数既做分母，也决定未回复轮次要补多少个 600 秒。
 * 2. 轮次时长 = 该轮买家消息 → 该轮**首条有效回复**；服务端只在首条有效回复上写 response_sec，
 *    所以这里直接取该轮「有 response_sec 的客服消息」，同一轮客服连发多条不会重复计。
 * 3. 没有有效回复的轮次（含完全未回复、回复被判无效且之后也没有有效回复）记 UNREPLIED_SECONDS。
 *
 * 该模块是纯函数：不依赖数据库、时间或随机数，输入消息 + 提问序列 + 参数即可复算。
 */
import { ScoreMessage, ScriptQuestion, SystemParams } from './types';

/** 官方口径：未回复（或始终没有有效回复）的轮次记 600 秒。 */
export const UNREPLIED_SECONDS = 600;

export interface RoundTiming {
  seq: number;
  /** 该轮是否计到了有效回复时长（有 response_sec） */
  answered: boolean;
  /** 该轮进入平均值计算的秒数：有有效回复用实际值，否则为 UNREPLIED_SECONDS */
  countedSec: number;
}

export interface ResponseRoundsResult {
  rounds: RoundTiming[];
  totalRounds: number;
  answeredRounds: number;
  /** 首次响应（第一轮的首条有效回复），无任何有效回复时为 null */
  firstResponseSec: number | null;
  /** 轮次加权平均：Σ轮次时长 ÷ 轮次总数 */
  avgResponseSec: number | null;
  /** 3 分钟回复率（方案口径保持不动）：≤ timeoutSec 的回复条数占比 */
  replyRatePct: number;
  timeoutCount: number;
}

/**
 * 按轮次算出响应时长指标。
 *
 * @param messages 该会话的消息流（按时间正序）
 * @param questions 该会话的提问序列（每个 seq 一轮）
 */
export function computeResponseRounds(
  messages: ScoreMessage[],
  questions: ScriptQuestion[],
  params: SystemParams
): ResponseRoundsResult {
  const agentMessages = messages.filter((m) => m.sender === 'agent');
  const timed = agentMessages.filter((m) => typeof m.responseSec === 'number' && (m.responseSec as number) >= 0);

  // 轮次边界：优先用提问序列；没有提问序列时退化为「消息里出现过的轮次号」
  const seqs = questions.length
    ? questions.map((q) => q.seq)
    : [...new Set(agentMessages.map((m) => m.questionSeq).filter((v): v is number => typeof v === 'number'))];

  const rounds: RoundTiming[] = seqs.map((seq) => {
    // 该轮的第一条「有响应时长」的客服消息 = 该轮首条有效回复
    const hit = timed.find((m) => m.questionSeq === seq);
    return {
      seq,
      answered: !!hit,
      countedSec: hit ? Math.round(hit.responseSec as number) : UNREPLIED_SECONDS,
    };
  });

  const totalRounds = rounds.length;
  const answeredRounds = rounds.filter((r) => r.answered).length;
  const sum = rounds.reduce((acc, r) => acc + r.countedSec, 0);

  // 首次响应：按消息顺序的第一条有效回复（与轮次无关，方案 4.2 口径）
  const firstResponseSec = timed.length ? Math.round(timed[0].responseSec as number) : null;
  const replyRatePct = timed.length
    ? (timed.filter((m) => (m.responseSec as number) <= params.timeoutSec).length / timed.length) * 100
    : 0;

  return {
    rounds,
    totalRounds,
    answeredRounds,
    firstResponseSec,
    avgResponseSec: totalRounds ? sum / totalRounds : null,
    replyRatePct,
    timeoutCount: messages.filter((m) => m.isTimeout).length,
  };
}

/** 服务端写 sessions.avg_response_sec 时复用同一套权重（跨轮次补 600 秒）。 */
export function weightedAvgResponseSec(repliedSecs: number[], totalRounds: number): number | null {
  if (!totalRounds) return repliedSecs.length ? Math.round(repliedSecs.reduce((a, b) => a + b, 0) / repliedSecs.length) : null;
  const sum = repliedSecs.reduce((a, b) => a + b, 0) + Math.max(0, totalRounds - repliedSecs.length) * UNREPLIED_SECONDS;
  return Math.round(sum / totalRounds);
}
