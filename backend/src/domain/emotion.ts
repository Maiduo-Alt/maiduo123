import { SystemParams } from './types';

export interface EmotionUpdate {
  value: number;
  delta: number;
  reason: 'soothe' | 'negative' | 'unresolved' | 'none';
  escalated: boolean;
}

function containsAny(text: string, words: string[]): boolean {
  if (!text) return false;
  return words.some((w) => w && text.includes(w));
}

/**
 * 更新买家情绪值。
 * 规则见方案 3.7.4 / 4.3：命中安抚词下降、命中负面词上升、连续未正面回应上升。
 * 为保证动作可复现，下降/上升使用固定步长（可在系统参数中配置）。
 */
export function updateEmotion(
  current: number,
  agentContent: string,
  params: SystemParams,
  options: { unresolvedStreak?: number; hitAnyPoint?: boolean } = {}
): EmotionUpdate {
  const { unresolvedStreak = 0, hitAnyPoint = true } = options;
  let delta = 0;
  let reason: EmotionUpdate['reason'] = 'none';

  if (containsAny(agentContent, params.negativeWords) || containsAny(agentContent, params.forbiddenWords)) {
    delta = params.emotionNegativeStep;
    reason = 'negative';
  } else if (containsAny(agentContent, params.sootheWords)) {
    delta = -params.emotionSootheStep;
    reason = 'soothe';
  } else if (!hitAnyPoint && unresolvedStreak >= 2) {
    delta = params.emotionNegativeStep;
    reason = 'unresolved';
  }

  const value = Math.max(0, Math.min(100, current + delta));
  return {
    value,
    delta: value - current,
    reason,
    escalated: value >= params.emotionEscalateThreshold,
  };
}
