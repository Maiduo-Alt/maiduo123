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
  const satisfaction = clamp(35 + resolutionScore * 0.65 - emotionPenalty);

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

  // 客户不是“把所有题问完”才会结束：核心目标已经解决，且整体信息覆盖到一定程度，
  // 就可以进入自然收尾；全部目标解决当然也满足。
  const shouldClose = satisfaction >= 60 && (allResolved || (primaryResolved && resolutionScore >= 70));

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
