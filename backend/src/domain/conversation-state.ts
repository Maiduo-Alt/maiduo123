import { getGoalProgress, SemanticReplyEvaluation } from './semantic-goals';
import { ConversationState, ScriptQuestion } from './types';

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

  const totalPoints = activeProgress.reduce((sum, item) => sum + (item.goal.requiredPoints || []).length, 0);
  const coveredPoints = activeProgress.reduce((sum, item) => sum + item.coveredPointIds.length, 0);
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
  const currentTopic = current?.conversationPlan?.topic || current?.primaryGoal || null;

  const hasTrackedGoals = activeProgress.length > 0;
  const allResolved = hasTrackedGoals && partialGoalIds.length === 0 && unresolvedGoalIds.length === 0;
  const primaryGoalIds = new Set(
    questions
      .filter((question) => (question.sourceType || 'core') === 'core' && question.goalPriority === 'primary')
      .flatMap((question) => (question.semanticGoals || []).map((goal) => goal.id))
  );
  const primaryResolved =
    primaryGoalIds.size > 0 &&
    [...primaryGoalIds].every((goalId) => resolvedGoalIds.includes(goalId));

  const coreGoalIds = new Set(
    questions
      .filter((question) => (question.sourceType || 'core') === 'core')
      .flatMap((question) => (question.semanticGoals || []).map((goal) => goal.id))
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

  return {
    customerGoal: inferCustomerGoal(questions),
    currentTopic,
    resolvedGoalIds,
    partialGoalIds,
    unresolvedGoalIds,
    satisfaction,
    resolutionScore,
    conversationStage: stage,
    shouldClose,
  };
}
