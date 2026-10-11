import { KEY_POINT_ALIASES } from './key-point-aliases';
import { ScriptQuestion } from './types';

/**
 * Create editable semantic goals from the question and its existing coaching key points.
 * Each generated round remains reviewable/editable in the script preview before training.
 */
export function generateSemanticGoals(
  questions: ScriptQuestion[],
  buyerContext = '',
  random: () => number = Math.random,
): ScriptQuestion[] {
  const context = String(buyerContext || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const candidates = questions.flatMap((question, questionIndex) =>
    [...new Set((question.keyPoints || []).map((point) => String(point || '').trim()))]
      .filter((point) => point && point !== '有效回应')
      .map((point) => ({ questionIndex, point }))
  );
  if (!candidates.length) return questions;
  const primaryIndex = Math.min(candidates.length - 1, Math.floor(Math.max(0, random()) * candidates.length));
  const primary = candidates[primaryIndex];

  const generated = questions.map((question) => {
    if (question.semanticGoals?.length) return { ...question, goalPriority: question.goalPriority || 'secondary' as const };
    const keyPoints = [...new Set((question.keyPoints || []).map((point) => String(point || '').trim()))]
      .filter((point) => point && point !== '有效回应');
    if (!keyPoints.length) return { ...question, goalPriority: 'secondary' as const };

    const title = String(question.question || '').replace(/[？?。！!]+$/u, '').slice(0, 48);
    const isPrimaryRound = question === questions[primary.questionIndex];
    const orderedPoints = isPrimaryRound
      ? [primary.point, ...keyPoints.filter((point) => point !== primary.point)]
      : keyPoints;
    return {
      ...question,
      question: isPrimaryRound ? derivePrimaryQuestion(question.question, primary.point) : question.question,
      goalPriority: isPrimaryRound ? 'primary' as const : 'secondary' as const,
      ...(isPrimaryRound ? { primaryGoal: primary.point, baseQuestion: question.question } : {}),
      semanticGoals: [{
        id: `auto-goal-${question.seq}`,
        name: [context ? `「${context}」场景` : '', title ? `回应：${title}` : '回应本轮咨询', isPrimaryRound ? `主目标：${primary.point}` : '次要目标'].filter(Boolean).join(' '),
        requiredPoints: orderedPoints.map((point, index) => ({
          id: `auto-point-${question.seq}-${index + 1}`,
          label: point,
          ...(isPrimaryRound && index === 0 ? { isPrimary: true } : {}),
          matchAny: [...new Set([point, ...(KEY_POINT_ALIASES[point] || [])])],
        })),
      }],
    };
  });
  // Put the main target first so the session pushes the detailed question before the lighter topics.
  return generated
    .sort((a, b) => Number(b.goalPriority === 'primary') - Number(a.goalPriority === 'primary') || a.seq - b.seq)
    .map((question, index) => ({ ...question, seq: index + 1 }));
}

/** Add one focused follow-up to the chosen main target; secondary questions stay concise. */
export function derivePrimaryQuestion(question: string, goal: string): string {
  const base = String(question || '').trim().replace(/[？?。！!]+$/u, '');
  const target = String(goal || '').trim();
  let followUp = `另外我主要想了解${target}，能结合这个商品再具体说明一下吗？`;
  if (/材质|面料/u.test(target)) followUp = '另外我比较关注材质，具体是什么面料，穿起来会不会闷或扎？';
  else if (/尺码|码数|尺寸/u.test(target)) followUp = '另外想请您结合商品版型推荐一下尺码，版型偏大还是偏小？';
  else if (/发货|物流|快递|配送/u.test(target)) followUp = '另外我比较关心发货时间，大概什么时候发出，物流预计多久能到？';
  return base ? `${base} ${followUp}` : followUp;
}
