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

export function selectNextQuestion(
  questions: ScriptQuestion[],
  currentSeq: number,
  completedGoalIds: Set<string>,
  alreadySkipped: number[] = []
): { nextSeq: number | null; skippedSeqs: number[] } {
  const skipped = new Set(alreadySkipped);
  let seq = currentSeq + 1;
  const finalSeq = questions.reduce((max, question) => Math.max(max, question.seq), 0);
  while (seq <= finalSeq) {
    const question = questions.find((item) => item.seq === seq);
    const goals = question?.semanticGoals || [];
    if (!goals.length || !goals.every((goal) => completedGoalIds.has(goal.id))) break;
    skipped.add(seq);
    seq += 1;
  }
  return { nextSeq: seq <= finalSeq ? seq : null, skippedSeqs: [...skipped] };
}

export function isNaturalClosingReply(text: string): boolean {
  return /(?:不用了|没有其他(?:问题)?|没有别的(?:问题)?|不需要了|先这样|就这样|谢谢(?:您|啦|了)?)[。！!～~\s]*$/u.test(String(text || '').trim());
}

