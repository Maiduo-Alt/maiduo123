import { KEY_POINT_ALIASES } from './key-point-aliases';
import { ScriptQuestion } from './types';

/**
 * Create editable semantic goals from the question and its existing coaching key points.
 * This is deliberately deterministic: every generated point can be reviewed and adjusted
 * by a supervisor in the script preview before the script is used in training.
 */
export function generateSemanticGoals(questions: ScriptQuestion[], buyerContext = ''): ScriptQuestion[] {
  const context = String(buyerContext || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return questions.map((question) => {
    if (question.semanticGoals?.length) return question;
    const keyPoints = [...new Set((question.keyPoints || []).map((point) => String(point || '').trim()))]
      .filter((point) => point && point !== '有效回应');
    if (!keyPoints.length) return question;

    const title = String(question.question || '').replace(/[？?。！!]+$/u, '').slice(0, 48);
    return {
      ...question,
      semanticGoals: [{
        id: `auto-goal-${question.seq}`,
        name: [context ? `「${context}」场景` : '', title ? `回应：${title}` : '回应本轮咨询'].filter(Boolean).join(' '),
        requiredPoints: keyPoints.map((point, index) => ({
          id: `auto-point-${question.seq}-${index + 1}`,
          label: point,
          matchAny: [...new Set([point, ...(KEY_POINT_ALIASES[point] || [])])],
        })),
      }],
    };
  });
}
