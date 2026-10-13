import { ConversationState, ScriptQuestion, SemanticGoal, SemanticGoalPoint, SemanticRiskRule } from './types';

export interface GoalPointMatch {
  goalId: string;
  pointIds: string[];
}

export interface RiskMatch {
  ruleId: string;
  label: string;
  penalty: number;
  goalId?: string;
}

export interface SemanticReplyEvaluation {
  goalMatches: GoalPointMatch[];
  riskItems: RiskMatch[];
}

const normalize = (value: string): string => String(value || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

function matchesAny(text: string, phrases: string[]): boolean {
  return phrases.some((phrase) => {
    const normalized = normalize(phrase);
    if (!normalized) return false;
    let offset = text.indexOf(normalized);
    while (offset >= 0) {
      const beginsWithNegation = /^(?:不|没|未|无|非)/u.test(normalized);
      const prefix = text.slice(Math.max(0, offset - 3), offset);
      const negated = /(?:不是|并非|不能|无法|不太|不|没|未|无)$/u.test(prefix);
      if (!negated || beginsWithNegation) return true;
      offset = text.indexOf(normalized, offset + normalized.length);
    }
    return false;
  });
}

function matchesFlexible(text: string, point: SemanticGoalPoint): boolean {
  const phrases = (point.matchAny || []).filter(Boolean);
  if (matchesAny(text, phrases)) return true;
  if (point.matchMode === 'strict') return false;
  const label = normalize(point.label);
  if (!label) return false;
  if (text.includes(label)) return true;
  if (point.matchMode === 'balanced') return false;
  // Flexible mode accepts meaningful chunks from a configured label. This stays
  // deterministic while handling natural wording such as “穿着不闷” vs “透气舒适”.
  const chunks = label.match(/[\u4e00-\u9fff]{2,}|[a-z0-9]{3,}/giu) || [];
  return chunks.some((chunk) => text.includes(chunk));
}

/**
 * Deterministic first-stage evaluator. It only recognizes explicitly configured concepts;
 * a vector model may later provide candidates, while business rules remain authoritative.
 */
export function evaluateSemanticReply(
  text: string,
  questions: ScriptQuestion[],
  vectorCandidates: Set<string> = new Set()
): SemanticReplyEvaluation {
  const normalizedText = normalize(text);
  const goalMatches: GoalPointMatch[] = [];
  const riskItems = new Map<string, RiskMatch>();

  for (const question of questions) {
    for (const goal of question.semanticGoals || []) {
      const pointIds = (goal.requiredPoints || [])
        .filter((point) => {
          const exactMatch = matchesFlexible(normalizedText, point);
          const vectorMatch = vectorCandidates.has(`${goal.id}:${point.id}`);
          if (!exactMatch && !vectorMatch) return false;
          const rules = point.businessRules;
          if (!rules) return true;
          return (rules.mustIncludeAll || []).every((term) => matchesAny(normalizedText, [term])) &&
            (!(rules.mustIncludeAny || []).length || matchesAny(normalizedText, rules.mustIncludeAny || [])) &&
            !matchesAny(normalizedText, rules.mustExclude || []);
        })
        .map((point) => point.id);
      if (pointIds.length) goalMatches.push({ goalId: goal.id, pointIds: [...new Set(pointIds)] });

      for (const rule of goal.riskRules || []) {
        addRiskIfMatched(riskItems, normalizedText, rule, goal.id);
      }
    }
  }

  // Known high-risk example from the handoff: a correct explanation followed by a guarantee
  // that a return will always be approved. Keep this independent of goal completion.
  const hasReturnPromiseRisk = [...riskItems.values()].some((item) =>
    /无条件.*退货|退货.*承诺|承诺.*退货/u.test(item.label) || /return.*promise|promise.*return/iu.test(item.ruleId)
  );
  if (!hasReturnPromiseRisk && /(肯定|一定|保证|无论如何).{0,8}(都|会|一定|肯定)?会?(能退|可以退|给您退|给你退|都会退|会退)/u.test(String(text || '')) &&
      !/(不能保证|不保证|不会|不能|无法|不一定|不承诺).{0,8}(肯定|一定|给您退|给你退)/u.test(String(text || ''))) {
    riskItems.set('unconditional-return-promise', {
      ruleId: 'unconditional-return-promise',
      label: '无条件承诺退货结果',
      penalty: 15,
    });
  }

  return { goalMatches: mergeGoalMatches(goalMatches), riskItems: [...riskItems.values()] };
}

function addRiskIfMatched(
  riskItems: Map<string, RiskMatch>,
  normalizedText: string,
  rule: SemanticRiskRule,
  goalId: string
): void {
  if (!matchesAny(normalizedText, rule.matchAny || [])) return;
  const key = `${goalId}:${rule.id}`;
  if (!riskItems.has(key)) {
    riskItems.set(key, { ruleId: rule.id, label: rule.label, penalty: Math.max(0, rule.penalty ?? 15), goalId });
  }
}

function mergeGoalMatches(matches: GoalPointMatch[]): GoalPointMatch[] {
  const merged = new Map<string, Set<string>>();
  for (const match of matches) {
    const points = merged.get(match.goalId) || new Set<string>();
    match.pointIds.forEach((id) => points.add(id));
    merged.set(match.goalId, points);
  }
  return [...merged].map(([goalId, pointIds]) => ({ goalId, pointIds: [...pointIds] }));
}

export interface GoalProgress {
  goal: SemanticGoal;
  coveredPointIds: string[];
  missingPointIds: string[];
  status: 'untriggered' | 'partial' | 'completed';
}

/** Rebuild goal progress from persisted message events so status survives process restarts. */
export function getGoalProgress(questions: ScriptQuestion[], evaluations: SemanticReplyEvaluation[]): GoalProgress[] {
  const goals = new Map<string, SemanticGoal>();
  for (const question of questions) {
    for (const goal of question.semanticGoals || []) goals.set(goal.id, goal);
  }
  const covered = new Map<string, Set<string>>();
  for (const evaluation of evaluations) {
    for (const match of evaluation.goalMatches || []) {
      const ids = covered.get(match.goalId) || new Set<string>();
      match.pointIds.forEach((id) => ids.add(id));
      covered.set(match.goalId, ids);
    }
  }
  return [...goals.values()].map((goal) => {
    const required = goal.requiredPoints || [];
    const matched = covered.get(goal.id) || new Set<string>();
    const coveredPointIds = required.filter((point) => matched.has(point.id)).map((point) => point.id);
    const missingPointIds = required.filter((point) => !matched.has(point.id)).map((point) => point.id);
    const status = coveredPointIds.length === 0 ? 'untriggered' : missingPointIds.length ? 'partial' : 'completed';
    return { goal, coveredPointIds, missingPointIds, status };
  });
}

export type ConversationTopic =
  | 'craft'
  | 'material'
  | 'fit'
  | 'care'
  | 'inventory'
  | 'promotion'
  | 'payment'
  | 'shipping'
  | 'delivery'
  | 'refund'
  | 'exchange'
  | 'quality'
  | 'complaint'
  | 'order'
  | 'general';

export function conversationTopic(question?: ScriptQuestion | null): ConversationTopic {
  const text = [question?.conversationPlan?.topic, question?.question, ...(question?.keyPoints || [])].filter(Boolean).join(' ');
  if (/投诉|主管|平台介入|举报|曝光/u.test(text)) return 'complaint';
  if (/退款|仅退款|退钱|退货/u.test(text)) return 'refund';
  if (/换货|换码|更换/u.test(text)) return 'exchange';
  if (/破损|瑕疵|质量|损坏|坏了|有问题/u.test(text)) return 'quality';
  if (/工艺|做工|走线|缝线|包边|锁边|内衬|耐穿|开线|脱线/u.test(text)) return 'craft';
  if (/洗涤|打理|清洗|机洗|手洗|缩水|掉色|起球|熨烫/u.test(text)) return 'care';
  if (/材质|面料|透气|厚度|成分|手感/u.test(text)) return 'material';
  if (/尺码|码数|尺寸|偏大|偏小|版型|裙长|衣长|身高|体重|能穿/u.test(text)) return 'fit';
  if (/库存|现货|缺货|补货|预售/u.test(text)) return 'inventory';
  if (/优惠|折扣|活动|便宜|优惠券|券|满减|赠品/u.test(text)) return 'promotion';
  if (/支付|付款|改价|催付/u.test(text)) return 'payment';
  if (/发货|出库|多久发|发出/u.test(text)) return 'shipping';
  if (/物流|快递|配送|到货|几天到|签收|物流单号/u.test(text)) return 'delivery';
  if (/下单|订单|发票|地址|收货信息/u.test(text)) return 'order';
  return 'general';
}

const NATURAL_TOPIC_TRANSITIONS: Partial<Record<ConversationTopic, ConversationTopic[]>> = {
  craft: ['quality', 'care', 'material'],
  material: ['care', 'quality', 'fit'],
  fit: ['inventory', 'exchange', 'promotion'],
  care: ['quality', 'material'],
  inventory: ['shipping', 'promotion', 'order'],
  promotion: ['payment', 'order'],
  payment: ['order', 'shipping'],
  shipping: ['delivery', 'order'],
  delivery: ['quality', 'refund', 'exchange'],
  quality: ['exchange', 'refund', 'complaint'],
  exchange: ['delivery', 'order'],
  refund: ['complaint'],
  complaint: ['refund', 'exchange'],
  order: ['shipping', 'delivery', 'payment'],
};

/** 同主题最高，常见相邻主题次之，生硬跨主题给负分。 */
export function topicTransitionScore(from: ConversationTopic, to: ConversationTopic): number {
  if (from === 'general' || to === 'general') return 0;
  if (from === to) return 45;
  if ((NATURAL_TOPIC_TRANSITIONS[from] || []).includes(to)) return 18;
  return -18;
}

function isQuestionCompleted(question: ScriptQuestion, completedGoalIds: Set<string>): boolean {
  const goals = question.semanticGoals || [];
  return goals.length > 0 && goals.every((goal) => completedGoalIds.has(goal.id));
}

/**
 * 选择下一条“自然可问”的问题。
 *
 * 与旧版 currentSeq + 1 不同：
 * 1. 已经被客服提前回答完整的目标直接跳过；
 * 2. core/derived 优先于 optional；
 * 3. 强依赖上下文的 optional 只有与当前话题一致时才允许出现；
 * 4. 同话题问题优先，避免“工艺 → 发货 → 优惠”式跳跃；
 * 5. 如果只剩不符合上下文的 optional，则自然结束，而不是为了覆盖率硬问。
 */
export function selectNextQuestion(
  questions: ScriptQuestion[],
  currentSeq: number,
  completedGoalIds: Set<string>,
  alreadySkipped: number[] = [],
  context: {
    conversationStage?: ConversationState['conversationStage'];
    resolutionScore?: number;
    purchaseIntent?: number;
    businessActionCodes?: string[];
    hasOrder?: boolean;
  } = {},
): { nextSeq: number | null; skippedSeqs: number[] } {
  const skipped = new Set(alreadySkipped);
  const current = questions.find((item) => item.seq === currentSeq) || null;
  const currentTopic = conversationTopic(current);

  const future = questions
    .filter((question) => question.seq > currentSeq)
    .filter((question) => !skipped.has(question.seq));

  const unresolved: ScriptQuestion[] = [];
  for (const question of future) {
    if (isQuestionCompleted(question, completedGoalIds)) {
      skipped.add(question.seq);
      continue;
    }
    unresolved.push(question);
  }

  if (!unresolved.length) {
    return { nextSeq: null, skippedSeqs: [...skipped].sort((a, b) => a - b) };
  }

  const eligible = unresolved.filter((question) => {
    const sourceType = question.sourceType || 'core';
    const trigger = question.triggerConditions;
    if (trigger) {
      if (trigger.stages?.length && (!context.conversationStage || !trigger.stages.includes(context.conversationStage))) {
        skipped.add(question.seq);
        return false;
      }
      if (trigger.minResolutionScore !== undefined && Number(context.resolutionScore || 0) < trigger.minResolutionScore) {
        skipped.add(question.seq);
        return false;
      }
      if (trigger.minPurchaseIntent !== undefined && Number(context.purchaseIntent || 0) < trigger.minPurchaseIntent) {
        skipped.add(question.seq);
        return false;
      }
      if (trigger.requiresOrder && !context.hasOrder) {
        skipped.add(question.seq);
        return false;
      }
      if (
        trigger.afterBusinessAction?.length &&
        !trigger.afterBusinessAction.some((code) => (context.businessActionCodes || []).includes(code))
      ) {
        skipped.add(question.seq);
        return false;
      }
      const currentTopicForTrigger = conversationTopic(current);
      if (trigger.topics?.length && !trigger.topics.includes(currentTopicForTrigger)) {
        skipped.add(question.seq);
        return false;
      }
    }
    if (sourceType !== 'optional') return true;

    // 明确 triggerConditions 已经完整描述了触发上下文；条件全部满足后直接允许，
    // 不再被下面的通用 optional 限制二次拦截。
    if (trigger) return currentSeq > 0 || !question.requiresContext;

    const candidateTopic = conversationTopic(question);
    // 可选话题不能在主目标尚未推进时突然抢话题。跨主题 optional 只有进入决策阶段后才允许出现。
    if (
      currentSeq > 0 &&
      currentTopic !== 'general' &&
      candidateTopic !== 'general' &&
      candidateTopic !== currentTopic &&
      (context.conversationStage !== 'decision' || Number(context.resolutionScore || 0) < 70)
    ) {
      skipped.add(question.seq);
      return false;
    }
    if (!question.requiresContext) return true;

    // 强依赖上下文的问题永远不能作为开场。
    if (currentSeq <= 0) {
      skipped.add(question.seq);
      return false;
    }
    // optional 只有与刚刚的主题一致时才允许触发，否则自然跳过。
    if (currentTopic !== 'general' && candidateTopic !== 'general' && candidateTopic !== currentTopic) {
      skipped.add(question.seq);
      return false;
    }
    return true;
  });

  if (!eligible.length) {
    return { nextSeq: null, skippedSeqs: [...skipped].sort((a, b) => a - b) };
  }

  // 开场必须尊重原始咨询顺序。主目标是训练重点，不等于客户第一句话必须从主目标开始。
  if (currentSeq <= 0) {
    const openingPool = eligible.filter((question) => (question.sourceType || 'core') !== 'optional');
    const opening = (openingPool.length ? openingPool : eligible)
      .sort((a, b) => a.seq - b.seq)[0];
    return {
      nextSeq: opening?.seq ?? null,
      skippedSeqs: [...skipped].sort((a, b) => a - b),
    };
  }

  // 只要还有核心/衍生问题，就不允许 optional 抢占主线。
  const substantive = eligible.filter((question) => (question.sourceType || 'core') !== 'optional');

  // 明确配置了语义目标的 core 问题属于作者定义的训练目标：只要它尚未完成，
  // 就必须尊重原始顺序，不能仅因为后面的主题“更接近当前话题”而跳过。
  // 没有语义目标的旧/脏数据仍允许用主题连续性做兜底重排。
  const earliestSemanticCore = substantive
    .filter((question) => (question.sourceType || 'core') === 'core' && (question.semanticGoals || []).length > 0)
    .sort((a, b) => a.seq - b.seq)[0];
  if (earliestSemanticCore) {
    return {
      nextSeq: earliestSemanticCore.seq,
      skippedSeqs: [...skipped].sort((a, b) => a - b),
    };
  }

  const pool = substantive.length ? substantive : eligible;

  const ranked = pool
    .map((question) => {
      const sourceType = question.sourceType || 'core';
      const candidateTopic = conversationTopic(question);
      let score = sourceType === 'core' ? 100 : sourceType === 'derived' ? 80 : 20;

      // 上下文连续性优先于题号顺序：同主题 > 常见相邻主题 > 生硬跨主题。
      score += topicTransitionScore(currentTopic, candidateTopic);
      if (question.goalPriority === 'primary') score += 15;
      if (current && question.stage === current.stage) score += 5;

      // 相关性相同才偏向原始顺序。
      score -= Math.max(0, question.seq - currentSeq) * 0.5;
      return { question, score };
    })
    .sort((a, b) => b.score - a.score || a.question.seq - b.question.seq);

  const selectedSeq = ranked[0]?.question.seq ?? null;
  if (selectedSeq !== null) {
    // 因上下文连续性被跨过的问题，本轮视为“未自然触发”，避免最终评分把它当漏答。
    for (const question of unresolved) {
      if (question.seq > currentSeq && question.seq < selectedSeq) skipped.add(question.seq);
    }
  }

  return {
    nextSeq: selectedSeq,
    skippedSeqs: [...skipped].sort((a, b) => a - b),
  };
}

export function isNaturalClosingReply(text: string): boolean {
  return /(?:不用了|没有其他(?:问题)?|没有别的(?:问题)?|不需要了|先这样|就这样|谢谢(?:您|啦|了)?)[。！!～~\s]*$/u.test(String(text || '').trim());
}

