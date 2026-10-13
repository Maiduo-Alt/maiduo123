import { ScriptQuestion, SemanticGoal, SemanticGoalPoint, SemanticRiskRule } from './types';

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

type ConversationTopic =
  | 'craft'
  | 'material'
  | 'size'
  | 'logistics'
  | 'aftersale'
  | 'price'
  | 'order'
  | 'general';

function conversationTopic(question?: ScriptQuestion | null): ConversationTopic {
  const text = [question?.conversationPlan?.topic, question?.question, ...(question?.keyPoints || [])].filter(Boolean).join(' ');
  if (/工艺|做工|走线|缝线|包边|锁边|内衬|耐穿|开线|脱线/u.test(text)) return 'craft';
  if (/材质|面料|透气|厚度|起球|掉色|缩水|洗涤/u.test(text)) return 'material';
  if (/尺码|码数|尺寸|偏大|偏小|裙长|衣长|身高|体重/u.test(text)) return 'size';
  if (/发货|物流|快递|配送|现货|预售|到货|时效/u.test(text)) return 'logistics';
  if (/退|换|退款|售后|补发|赔偿|质量|破损/u.test(text)) return 'aftersale';
  if (/价格|优惠|折扣|活动|便宜|券|满减/u.test(text)) return 'price';
  if (/支付|付款|下单|订单|发票/u.test(text)) return 'order';
  return 'general';
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
  alreadySkipped: number[] = []
): { nextSeq: number | null; skippedSeqs: number[] } {
  const skipped = new Set(alreadySkipped);
  // The persisted session cursor is monotonic. Never jump backwards: the caller
  // records current_seq as nextSeq - 1 and relies on sequential round accounting.
  const remaining = [...questions].filter((q) => q.seq > currentSeq).sort((a, b) => a.seq - b.seq);
  for (const question of remaining) {
    const goals = question.semanticGoals || [];
    if (goals.length && goals.every((goal) => completedGoalIds.has(goal.id))) {
      skipped.add(question.seq);
      continue;
    }
    // Optional context-dependent questions are not allowed to open a conversation.
    // Once at least one core question has been discussed, their original position
    // is respected to preserve persisted scoring and order state.
    if (question.requiresContext && currentSeq <= 0) {
      skipped.add(question.seq);
      continue;
    }
    return { nextSeq: question.seq, skippedSeqs: [...skipped].sort((a, b) => a - b) };
  }
  return { nextSeq: null, skippedSeqs: [...skipped].sort((a, b) => a - b) };
}

export function isNaturalClosingReply(text: string): boolean {
  return /(?:不用了|没有其他(?:问题)?|没有别的(?:问题)?|不需要了|先这样|就这样|谢谢(?:您|啦|了)?)[。！!～~\s]*$/u.test(String(text || '').trim());
}

