import { buildSemanticCandidates, findVectorCandidates } from '../../src/domain/semantic-client';
import { ScriptQuestion } from '../../src/domain/types';

const questions: ScriptQuestion[] = [{
  seq: 1,
  question: '尺码偏大吗？',
  keyPoints: [],
  semanticGoals: [{
    id: 'size',
    name: '判断尺码',
    requiredPoints: [{ id: 'normal', label: '尺码正常', matchAny: ['标准尺码'] }],
  }],
}];

describe('self-hosted semantic client', () => {
  afterEach(() => jest.restoreAllMocks());

  it('builds candidate descriptions with stable goal and point IDs', () => {
    expect(buildSemanticCandidates(questions)).toEqual([
      { id: 'size:normal', text: '判断尺码。尺码正常。标准尺码' },
    ]);
  });

  it('sends the similarity threshold and returns only service candidates', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ matches: [{ id: 'size:normal', score: 0.86 }] }),
    } as Response);
    const result = await findVectorCandidates('平时穿 M 按 M 拿可以吗', buildSemanticCandidates(questions), 'http://semantic-api:8000', 0.81);
    expect(result).toEqual(new Set(['size:normal']));
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).min_score).toBe(0.81);
  });

  it('falls back to rules when the local service cannot be reached', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));
    await expect(findVectorCandidates('reply', buildSemanticCandidates(questions), 'http://semantic-api:8000'))
      .resolves.toEqual(new Set());
  });
});
