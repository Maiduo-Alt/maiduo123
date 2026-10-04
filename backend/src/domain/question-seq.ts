import { ScriptQuestion } from './types';
import { FOLLOW_UPS_AFTERSALE, FOLLOW_UPS_PRESALE } from '../db/seed-content';
import { orderStageForQuestion } from './order';

/** 构建剧本所需的内容切片（买家咨询内容的最小输入）。 */
export interface QuestionSeqSource {
  question_list: string[];
  key_points: string[][];
  stage?: string | null;
  /** 必须转接主管才算处理好的问题序号（0 基），越界项会被忽略。 */
  transferIdxs?: number[];
}

/**
 * 由一条买家咨询内容构建剧本题干序列（方案 4.5 兜底规则）。
 *
 * 规则：
 * 1. 问题按 question_list 顺序展开，要点与问题一一对应；
 *    缺失要点时退化为「有效回应」，避免该轮无法得分。
 * 2. transferIdxs 标记的问题需要转接主管才算处理好（判定见 domain/scoring.ts）。
 * 3. 轮数不足下限时按接待阶段从追问库补足，超过上限则截断。
 *
 * 追问库放在 db/seed-content.ts，与其它训练内容一起维护；
 * 内置剧本（seed）与界面上的批量生成都走本函数，保证两者口径一致。
 */
export function buildQuestionSeq(qa: QuestionSeqSource, rounds: [number, number]): ScriptQuestion[] {
  const [minRounds, maxRounds] = rounds;
  const transferIdxs = new Set(qa.transferIdxs || []);
  const list = Array.isArray(qa.question_list) ? qa.question_list : [];
  const points = Array.isArray(qa.key_points) ? qa.key_points : [];

  // 问题级接待阶段：目前整条内容共用一个阶段，追问也随它（字段留在这里，
  // 是为了将来出现「售前内容夹带售后问题」时，推送端能按问题决定要不要生成订单）
  const questionStage: 'presale' | 'aftersale' = qa.stage === 'aftersale' ? 'aftersale' : 'presale';
  const seq: ScriptQuestion[] = list.map((question, i) => ({
    seq: i + 1,
    question,
    keyPoints: points[i] && points[i].length ? points[i] : ['有效回应'],
    needTransfer: transferIdxs.has(i),
    stage: questionStage,
  }));

  // 补追问时先避开与已有问题重复的条目（例如「我要投诉你们！」既可能是内容本身，
  // 也在售后追问池里），池子用尽后仍不足下限才允许重复。
  const followUps = qa.stage === 'aftersale' ? FOLLOW_UPS_AFTERSALE : FOLLOW_UPS_PRESALE;
  const used = new Set(seq.map((item) => item.question));
  let cursor = 0;
  let guard = 0;
  while (seq.length < minRounds && followUps.length && guard < followUps.length) {
    const f = followUps[cursor % followUps.length];
    cursor += 1;
    guard += 1;
    if (used.has(f.question)) continue;
    used.add(f.question);
    seq.push({ seq: seq.length + 1, question: f.question, keyPoints: f.keyPoints, needTransfer: false, stage: questionStage });
  }
  while (seq.length < minRounds && followUps.length) {
    const f = followUps[cursor % followUps.length];
    cursor += 1;
    seq.push({ seq: seq.length + 1, question: f.question, keyPoints: f.keyPoints, needTransfer: false, stage: questionStage });
  }
  // 每个问题带上它对应的订单状态（售前=发货前、售后=发货后），推送端据此生成/推进订单
  return seq.slice(0, maxRounds).map((item) => ({ ...item, orderStage: orderStageForQuestion(item) }));
}

/**
 * 客户 2026-10-03：一次接待里的问题要**按比例混合售前 / 售后**——
 * 大部分是「还没有订单、只咨询商品信息」的售前问题，小部分是「买完商品后」的订单类售后问题。
 *
 * 做法：保留剧本本身的话题作为主体（开头几轮不动），把**靠后的若干轮**替换成另一阶段的问题，
 * 这样既不会让开场就跑题，也能保证「大部分 + 小部分」的比例。
 *
 * @param seq       剧本原有的问题序列（已经带上 stage / orderStage）
 * @param ratioPct  另一阶段问题的占比（0～80，来自系统参数 aftersaleQuestionRatio）
 * @param pool      用来替换的题库（见 db/seed-content.ts 的 ORDER_AFTERSALE_QUESTIONS / PRESALE_PRODUCT_QUESTIONS）
 * @param stage     被替换进来的问题属于哪个阶段（售前 / 售后）
 * @param offset    从题库第几条开始取（同一局内不同会话错开，避免千篇一律）
 */
export function mixQuestionSeq(
  seq: ScriptQuestion[],
  options: { ratioPct: number; pool: { question: string; keyPoints: string[] }[]; stage: 'presale' | 'aftersale'; offset?: number }
): ScriptQuestion[] {
  const { pool, stage } = options;
  const ratio = Math.max(0, Math.min(80, Math.round(Number(options.ratioPct) || 0)));
  if (!pool.length || ratio <= 0 || seq.length < 3) return seq;

  // 「小部分」：最多替换掉一半（并且至少留 2 轮原话题，第一轮一定是剧本自己的开场）
  const count = Math.min(Math.max(1, Math.round((seq.length * ratio) / 100)), Math.floor(seq.length / 2), seq.length - 2);
  if (count <= 0) return seq;

  const start = seq.length - count;
  const offset = Math.max(0, Math.round(Number(options.offset) || 0));
  const next = [...seq];
  for (let i = 0; i < count; i += 1) {
    const source = pool[(offset + i) % pool.length];
    const index = start + i;
    next[index] = {
      ...next[index],
      question: source.question,
      keyPoints: source.keyPoints && source.keyPoints.length ? source.keyPoints : ['有效回应'],
      needTransfer: false,
      stage,
    };
  }
  // 替换后重新算订单状态：售后里的「催发货 / 改地址 / 改快递」发生在发货前 → 待发货
  return next.map((item) => ({ ...item, orderStage: orderStageForQuestion(item) }));
}
