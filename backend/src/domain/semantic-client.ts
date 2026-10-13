import { SemanticGoal, ScriptQuestion } from './types';

export interface SemanticCandidate {
  id: string;
  text: string;
}

export function buildSemanticCandidates(questions: ScriptQuestion[]): SemanticCandidate[] {
  return questions.flatMap((question) => (question.semanticGoals || []).flatMap((goal: SemanticGoal) =>
    goal.requiredPoints.map((point) => ({
      id: `${goal.id}:${point.id}`,
      // goal 名称提供业务语境，子要点与认可表达提供具体判别内容。
      // 这样自建向量服务既能区分目标，也不会只依赖孤立关键词。
      text: [goal.name, point.label, ...point.matchAny].filter(Boolean).join('。'),
    }))
  ));
}

/** Call the optional self-hosted vector service. Network/model errors degrade to rule-only matching. */
export async function findVectorCandidates(
  text: string,
  candidates: SemanticCandidate[],
  serviceUrl: string | undefined,
  threshold = 0.78
): Promise<Set<string>> {
  if (!serviceUrl || !candidates.length) return new Set();
  try {
    const response = await fetch(`${serviceUrl.replace(/\/$/, '')}/v1/rank`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: text, candidates, min_score: threshold }),
      signal: AbortSignal.timeout(1200),
    });
    if (!response.ok) return new Set();
    const result = (await response.json()) as { matches?: { id: string }[] };
    return new Set((result.matches || []).map((item) => item.id));
  } catch {
    return new Set();
  }
}

