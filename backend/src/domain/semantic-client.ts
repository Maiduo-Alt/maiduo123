import { SemanticGoal, ScriptQuestion } from './types';

export interface SemanticCandidate {
  id: string;
  text: string;
}

export function buildSemanticCandidates(questions: ScriptQuestion[]): SemanticCandidate[] {
  return questions.flatMap((question) => (question.semanticGoals || []).flatMap((goal: SemanticGoal) =>
    goal.requiredPoints.map((point) => ({
      id: `${goal.id}:${point.id}`,
      // 只用子要点自身的表达构造候选：goal.name 含统一的背景前缀，会把所有候选
      //  embedding 拉到一起，无关回复也能拿到 0.7+（2026-10-12 实测），丧失区分度。
      text: [point.label, ...point.matchAny].filter(Boolean).join('。'),
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

