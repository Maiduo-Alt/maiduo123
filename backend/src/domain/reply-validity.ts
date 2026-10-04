/**
 * 无效 / 敷衍回复判定（客户新增需求 C6，2026-10-02）。
 *
 * 官方只公布了三条「敷衍回复」判定情形，并声明「以系统判定为准」，**没有公开词表**：
 *  1) 回复内容与上一轮完全相同；2) 连续多条回复完全相同；3) 买家明确要求后仍未改善。
 * 本模块按其可落地的部分实现：
 *  - 重复判定：完全相同（与上一条客服回复一致）/ 连续 N 次（全程连续出现 N 次）；
 *  - 未解决判定：连续 N 轮「命中要点为 0」——用来**近似**官方第 3 条（文档已注明是近似）；
 *  - 自定义敷衍词表：业务方自行维护，界面标注「非平台官方口径」。
 *
 * 判定结果要能复算：入参只有消息 + 提问序列 + 参数，出参是每一轮的有效/无效回复序号。
 * 该词表与 forbiddenWords 分离，避免同一句被「话术扣分 + 情绪上升 + 600 秒」三重惩罚。
 */
import { ScoreMessage, ScriptQuestion, SystemParams } from './types';

export interface ReplyValidityParams {
  enabled: boolean;
  /** identical：与上一条客服回复完全相同即无效；streak：连续 N 次完全相同才无效 */
  duplicateMode: 'identical' | 'streak';
  duplicateStreak: number;
  unresolvedEnabled: boolean;
  unresolvedStreak: number;
  banalWords: string[];
}

export interface RoundValidity {
  seq: number;
  /** 该轮首条有效回复在 messages 里的下标；没有有效回复时为 null */
  validReplyIndex: number | null;
  /** 被判无效的回复下标（用于给消息打标） */
  invalidReplyIndexes: number[];
  /** 该轮无效的原因（按回复下标） */
  reasons: { index: number; reason: string }[];
}

/** 从系统参数里取判定规则（总开关关闭时直接返回空规则）。 */
export function resolveValidityParams(params: SystemParams): ReplyValidityParams {
  return {
    enabled: !!params.invalidReplyEnabled,
    duplicateMode: params.invalidReplyDuplicateMode === 'identical' ? 'identical' : 'streak',
    duplicateStreak: Math.min(10, Math.max(2, Number(params.invalidReplyDuplicateStreak) || 3)),
    unresolvedEnabled: !!params.invalidReplyUnresolvedEnabled,
    unresolvedStreak: Math.max(1, Number(params.invalidReplyUnresolvedStreak) || 3),
    banalWords: params.banalWords || [],
  };
}

/**
 * 逐轮判定有效回复。
 *
 * @param messages 会话消息流（按时间正序，含买家与客服消息）
 * @param questions 提问序列，用来确定轮次边界
 * @param params 系统参数（含判定规则）
 */
export function judgeValidReplies(
  messages: ScoreMessage[],
  questions: ScriptQuestion[],
  params: SystemParams
): RoundValidity[] {
  const rule = resolveValidityParams(params);
  const seqs = questions.length
    ? questions.map((q) => q.seq)
    : [...new Set(messages.map((m) => m.questionSeq).filter((v): v is number => typeof v === 'number'))];

  const result: RoundValidity[] = seqs.map((seq) => ({ seq, validReplyIndex: null, invalidReplyIndexes: [], reasons: [] }));
  const bySeq = new Map(result.map((r) => [r.seq, r]));

  // 全局顺序遍历客服回复，维护「连发重复」与「连续未命中」两个游标
  let previousContent = '';
  let sameContentRun = 0;
  let unresolvedRun = 0;

  for (const seq of seqs) {
    const round = bySeq.get(seq)!;
    const roundIndexes = messages
      .map((m, index) => ({ m, index }))
      .filter(({ m }) => m.sender === 'agent' && m.questionSeq === seq);

    // 该轮是否命中过要点（整轮取最大值：任一条命中即算解决）
    const hitAny = roundIndexes.some(({ m }) => (m.hitPoints || []).length > 0);
    if (rule.unresolvedEnabled) {
      unresolvedRun = hitAny ? 0 : unresolvedRun + 1;
    }
    const unresolvedInvalid = rule.unresolvedEnabled && !hitAny && unresolvedRun >= rule.unresolvedStreak;

    for (const { m, index } of roundIndexes) {
      const content = String(m.content || '').trim();
      const reasons: string[] = [];

      if (rule.enabled) {
        if (content && content === previousContent) {
          sameContentRun += 1;
        } else {
          sameContentRun = 1;
        }
        previousContent = content;

        if (content && sameContentRun >= 2 && rule.duplicateMode === 'identical') {
          reasons.push(`与上一条回复完全相同`);
        }
        if (content && sameContentRun >= rule.duplicateStreak) {
          reasons.push(`同一内容连续发送 ${sameContentRun} 次（阈值 ${rule.duplicateStreak}）`);
        }
        const banal = rule.banalWords.find((word) => word && content.includes(word));
        if (banal) reasons.push(`命中敷衍词表：${banal}`);
      }

      if (unresolvedInvalid) {
        reasons.push(`连续 ${unresolvedRun} 轮命中要点为 0（近似官方「买家要求后仍未改善」）`);
      }

      if (reasons.length) {
        round.invalidReplyIndexes.push(index);
        round.reasons.push({ index, reason: reasons.join('；') });
      } else if (round.validReplyIndex === null) {
        round.validReplyIndex = index;
      }
    }

    // 同一轮里后续的重复内容也要按「上一条」继续比较，所以游标不在这里重置
  }

  return result;
}
