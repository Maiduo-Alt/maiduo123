import { conversationTopic, getGoalProgress, SemanticReplyEvaluation } from './semantic-goals';
import { ConversationState, ScriptQuestion } from './types';

export interface KeywordQuestionProgress {
  seq: number;
  covered: number;
  total: number;
}

export function buildKeywordQuestionProgress(
  questions: ScriptQuestion[],
  messages: Array<{ questionSeq?: number | null; hitPoints?: string[] }>,
): KeywordQuestionProgress[] {
  const hitsBySeq = new Map<number, Set<string>>();
  for (const message of messages || []) {
    const seq = Number(message.questionSeq || 0);
    if (!seq) continue;
    const set = hitsBySeq.get(seq) || new Set<string>();
    (message.hitPoints || []).forEach((point) => set.add(String(point)));
    hitsBySeq.set(seq, set);
  }

  return questions
    .filter((question) => !(question.semanticGoals || []).length)
    .map((question) => {
      const required = [...new Set((question.keyPoints || []).filter((point) => point && point !== '有效回应'))];
      const hits = hitsBySeq.get(question.seq) || new Set<string>();
      const covered = required.length
        ? required.filter((point) => hits.has(point)).length
        : hits.size > 0 ? 1 : 0;
      return {
        seq: question.seq,
        covered,
        total: required.length || 1,
      };
    });
}

const clamp = (value: number, min = 0, max = 100): number => Math.max(min, Math.min(max, Math.round(value)));

function stripGeneratedGoalName(value: string): string {
  return String(value || '')
    .replace(/^「[^」]+」场景\s*/u, '')
    .replace(/^(?:主目标|次要目标)[:：]\s*/u, '')
    .trim();
}

/** 从剧本已有的核心问题/主目标推断客户本场真正想解决的事情。 */
export function inferCustomerGoal(questions: ScriptQuestion[]): string {
  const core = questions.filter((question) => (question.sourceType || 'core') === 'core');
  const primary = core.find((question) => question.goalPriority === 'primary') || core[0];
  if (!primary) return '完成当前咨询';

  if (primary.customerGoal) return primary.customerGoal;
  if (primary.primaryGoal) return `确认${primary.primaryGoal}`;
  const goalName = stripGeneratedGoalName(primary.semanticGoals?.[0]?.name || '');
  if (goalName) return goalName;
  return String(primary.baseQuestion || primary.question || '完成当前咨询').trim();
}

/**
 * 从持久化语义评估重建会话状态。
 *
 * 这是“客户行为层”的状态快照，不参与模型生成；服务重启后可以完全由数据库消息恢复。
 */
export function deriveConversationState(
  questions: ScriptQuestion[],
  evaluations: SemanticReplyEvaluation[],
  options: {
    currentSeq?: number;
    skippedSeqs?: number[];
    emotionValue?: number;
    timeoutCount?: number;
    unresolvedStreak?: number;
    followUps?: number;
    keywordProgress?: KeywordQuestionProgress[];
  } = {},
): ConversationState {
  const skipped = new Set(options.skippedSeqs || []);
  const progress = getGoalProgress(questions, evaluations);
  const goalToQuestion = new Map<string, ScriptQuestion>();
  questions.forEach((question) => {
    (question.semanticGoals || []).forEach((goal) => goalToQuestion.set(goal.id, question));
  });

  const activeProgress = progress.filter((item) => {
    const question = goalToQuestion.get(item.goal.id);
    return question && !skipped.has(question.seq) && (question.sourceType || 'core') !== 'optional';
  });

  const resolvedGoalIds = activeProgress.filter((item) => item.status === 'completed').map((item) => item.goal.id);
  const partialGoalIds = activeProgress.filter((item) => item.status === 'partial').map((item) => item.goal.id);
  const unresolvedGoalIds = activeProgress.filter((item) => item.status === 'untriggered').map((item) => item.goal.id);

  const keywordQuestionBySeq = new Map(
    questions
      .filter((question) => !(question.semanticGoals || []).length)
      .map((question) => [question.seq, question] as const),
  );
  const activeKeywordProgress = (options.keywordProgress || []).filter((item) => {
    const question = keywordQuestionBySeq.get(item.seq);
    return question && !skipped.has(item.seq) && (question.sourceType || 'core') !== 'optional';
  });
  for (const item of activeKeywordProgress) {
    const id = `keyword-seq-${item.seq}`;
    const ratio = item.total > 0 ? item.covered / item.total : 0;
    if (ratio >= 0.8) resolvedGoalIds.push(id);
    else if (ratio > 0) partialGoalIds.push(id);
    else unresolvedGoalIds.push(id);
  }

  const semanticTotalPoints = activeProgress.reduce((sum, item) => sum + (item.goal.requiredPoints || []).length, 0);
  const semanticCoveredPoints = activeProgress.reduce((sum, item) => sum + item.coveredPointIds.length, 0);
  const keywordTotalPoints = activeKeywordProgress.reduce((sum, item) => sum + Math.max(1, item.total), 0);
  const keywordCoveredPoints = activeKeywordProgress.reduce((sum, item) => sum + Math.min(item.total, item.covered), 0);
  const totalPoints = semanticTotalPoints + keywordTotalPoints;
  const coveredPoints = semanticCoveredPoints + keywordCoveredPoints;
  const resolutionScore = totalPoints ? clamp((coveredPoints / totalPoints) * 100) : 0;

  const emotionValue = Number(options.emotionValue ?? 20);
  const emotionPenalty = Math.max(0, emotionValue - 30) * 0.6;
  const timeoutPenalty = Math.max(0, Number(options.timeoutCount || 0)) * 4;
  const unresolvedPenalty = Math.max(0, Number(options.unresolvedStreak || 0)) * 5;
  const followUpPenalty = Math.max(0, Number(options.followUps || 0)) * 3;
  const riskPenalty = evaluations.reduce(
    (sum, evaluation) => sum + (evaluation.riskItems || []).reduce((inner, item) => inner + Math.min(10, Math.max(0, item.penalty || 0)), 0),
    0,
  );
  const satisfaction = clamp(
    35 + resolutionScore * 0.65 - emotionPenalty - timeoutPenalty - unresolvedPenalty - followUpPenalty - riskPenalty,
  );

  const currentSeq = Number(options.currentSeq || 0);
  const current = questions.find((question) => question.seq === currentSeq);
  const currentTopic = current ? conversationTopic(current) : null;
  const currentSubtopic = current
    ? String(current.primaryGoal || current.keyPoints?.[0] || current.conversationPlan?.topic || '').trim() || null
    : null;

  const customerIntent: ConversationState['customerIntent'] =
    currentTopic === 'complaint'
      ? 'complaint_resolution'
      : ['refund', 'exchange', 'quality'].includes(String(currentTopic))
        ? 'aftersale_resolution'
        : ['shipping', 'delivery', 'order'].includes(String(currentTopic))
          ? 'order_service'
          : ['promotion', 'payment', 'inventory'].includes(String(currentTopic))
            ? 'purchase_decision'
            : 'product_evaluation';

  const purchaseIntent = clamp(
    customerIntent === 'complaint_resolution'
      ? 5
      : customerIntent === 'aftersale_resolution'
        ? 10 + satisfaction * 0.1
        : 15 + resolutionScore * 0.35 + satisfaction * 0.3 +
          (customerIntent === 'purchase_decision' ? 20 : customerIntent === 'order_service' ? 10 : 0),
  );

  const hasTrackedGoals = activeProgress.length > 0 || activeKeywordProgress.length > 0;
  const allResolved = hasTrackedGoals && partialGoalIds.length === 0 && unresolvedGoalIds.length === 0;
  const primaryGoalIds = new Set(
    questions
      .filter((question) => (question.sourceType || 'core') === 'core' && question.goalPriority === 'primary')
      .flatMap((question) => {
        const semanticIds = (question.semanticGoals || []).map((goal) => goal.id);
        return semanticIds.length ? semanticIds : [`keyword-seq-${question.seq}`];
      })
  );
  const primaryResolved =
    primaryGoalIds.size > 0 &&
    [...primaryGoalIds].every((goalId) => resolvedGoalIds.includes(goalId));

  const coreGoalIds = new Set(
    questions
      .filter((question) => (question.sourceType || 'core') === 'core')
      .flatMap((question) => {
        const semanticIds = (question.semanticGoals || []).map((goal) => goal.id);
        return semanticIds.length ? semanticIds : [`keyword-seq-${question.seq}`];
      })
  );
  const allCoreResolved =
    coreGoalIds.size > 0 &&
    [...coreGoalIds].every((goalId) => resolvedGoalIds.includes(goalId));

  // 可以不把“衍生问题”全部问完，但原始 core 问题不能因为满意度稍高就被提前跳过。
  // 因此自然收尾要求：全部目标完成，或所有 core 目标已完成且整体覆盖度足够。
  const shouldClose = satisfaction >= 60 && (allResolved || (primaryResolved && allCoreResolved && resolutionScore >= 70));

  let stage: ConversationState['conversationStage'] = 'discovery';
  if (currentSeq <= 0) stage = 'opening';
  else if (shouldClose) stage = 'closing';
  else if (partialGoalIds.length > 0) stage = 'clarification';
  else if (resolutionScore >= 70) stage = 'decision';

  const currentGoalIds = new Set(
    (current?.semanticGoals || []).map((goal) => goal.id),
  );
  const currentPartial = activeProgress.find(
    (item) => currentGoalIds.has(item.goal.id) && item.status === 'partial',
  );
  const currentUnresolved = activeProgress.find(
    (item) => currentGoalIds.has(item.goal.id) && item.status === 'untriggered',
  );
  const fallbackPartial = activeProgress.find((item) => item.status === 'partial');
  const fallbackUnresolved = activeProgress.find((item) => item.status === 'untriggered');
  const currentKeywordConcern = activeKeywordProgress
    .filter((item) => item.seq === currentSeq && item.covered < item.total)
    .map((item) => keywordQuestionBySeq.get(item.seq)?.question)
    .find(Boolean);
  const currentSemanticConcern =
    currentPartial?.goal.requiredPoints.find((point) => currentPartial.missingPointIds.includes(point.id))?.label ||
    currentUnresolved?.goal.name;
  const fallbackSemanticConcern =
    fallbackPartial?.goal.requiredPoints.find((point) => fallbackPartial.missingPointIds.includes(point.id))?.label ||
    fallbackUnresolved?.goal.name;
  const pendingConcern =
    currentSemanticConcern ||
    currentKeywordConcern ||
    fallbackSemanticConcern ||
    (
      activeKeywordProgress
        .filter((item) => item.covered < item.total)
        .map((item) => keywordQuestionBySeq.get(item.seq)?.question)
        .find(Boolean)
    ) ||
    null;

  return {
    customerGoal: inferCustomerGoal(questions),
    currentTopic,
    currentSubtopic,
    customerIntent,
    pendingConcern,
    resolvedGoalIds,
    partialGoalIds,
    unresolvedGoalIds,
    satisfaction,
    purchaseIntent,
    resolutionScore,
    conversationStage: stage,
    shouldClose,
  };
}
