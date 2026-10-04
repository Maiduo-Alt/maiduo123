import { DEFAULT_PARAMS, SystemParams } from './types';

/** 深度合并系统参数（用于持久化配置与默认值合并）。 */
export function mergeParams(partial: Partial<SystemParams> | null | undefined): SystemParams {
  if (!partial) return cloneParams(DEFAULT_PARAMS);
  return {
    ...DEFAULT_PARAMS,
    ...partial,
    weights: { ...DEFAULT_PARAMS.weights, ...(partial.weights || {}) },
    waitToleranceFactor: { ...DEFAULT_PARAMS.waitToleranceFactor, ...(partial.waitToleranceFactor || {}) },
    levelConcurrent: { ...DEFAULT_PARAMS.levelConcurrent, ...(partial.levelConcurrent || {}) },
    levelTotal: { ...DEFAULT_PARAMS.levelTotal, ...(partial.levelTotal || {}) },
    defaultStyleRatio: { ...DEFAULT_PARAMS.defaultStyleRatio, ...(partial.defaultStyleRatio || {}) },
    greetingWords: partial.greetingWords ?? DEFAULT_PARAMS.greetingWords,
    closingWords: partial.closingWords ?? DEFAULT_PARAMS.closingWords,
    sootheWords: partial.sootheWords ?? DEFAULT_PARAMS.sootheWords,
    negativeWords: partial.negativeWords ?? DEFAULT_PARAMS.negativeWords,
    forbiddenWords: partial.forbiddenWords ?? DEFAULT_PARAMS.forbiddenWords,
    banalWords: partial.banalWords ?? DEFAULT_PARAMS.banalWords,
    levelRounds: partial.levelRounds ?? DEFAULT_PARAMS.levelRounds,
    levelJoinDelaySec: partial.levelJoinDelaySec ?? DEFAULT_PARAMS.levelJoinDelaySec,
  };
}

export function cloneParams(params: SystemParams): SystemParams {
  return JSON.parse(JSON.stringify(params));
}

/** 校验评分权重之和必须为 100。 */
export function validateWeights(params: SystemParams): void {
  const sum = params.weights.response + params.weights.solving + params.weights.wording + params.weights.emotion;
  if (sum !== 100) {
    throw new Error(`评分权重之和必须等于 100，当前为 ${sum}`);
  }
}
