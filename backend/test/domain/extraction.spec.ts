import { DEFAULT_PARAMS, LEVELS, ScriptCandidate } from '../../src/domain/types';
import { pickScripts, checkRounds } from '../../src/domain/extraction';

function candidate(id: number, qaId: number, extra: Partial<ScriptCandidate> = {}): ScriptCandidate {
  return {
    id,
    scriptNo: `SC${id}`,
    name: `剧本${id}`,
    qaId,
    styleId: 1,
    stage: 'presale',
    questionSeq: [{ seq: 1, question: 'Q', keyPoints: ['A'] }],
    practicedCount: 0,
    lastPracticedAt: null,
    emotionStyle: false,
    ...extra,
  };
}

describe('剧本抽取（方案 4.5）', () => {
  it('同一买家咨询内容在一次接待中不重复出现', () => {
    const candidates = [candidate(1, 100), candidate(2, 100), candidate(3, 101), candidate(4, 102)];
    const picked = pickScripts(candidates, LEVELS.L3, 3, DEFAULT_PARAMS, 42);
    const qaIds = picked.map((p) => p.qaId);
    expect(new Set(qaIds).size).toBe(3);
  });

  it('优先抽取被练次数少的剧本', () => {
    const candidates = [
      candidate(1, 100, { practicedCount: 9 }),
      candidate(2, 101, { practicedCount: 0 }),
      candidate(3, 102, { practicedCount: 4 }),
    ];
    const picked = pickScripts(candidates, LEVELS.L1, 1, DEFAULT_PARAMS, 7);
    expect(picked[0].id).toBe(2);
  });

  it('候选不足时允许重复内容以保证并发数量', () => {
    const candidates = [candidate(1, 100), candidate(2, 100)];
    const picked = pickScripts(candidates, LEVELS.L2, 2, DEFAULT_PARAMS, 3);
    expect(picked.length).toBe(2);
  });

  it('L1 优先售前剧本，L3 优先售后剧本', () => {
    const candidates = [
      candidate(1, 100, { stage: 'presale' }),
      candidate(2, 101, { stage: 'aftersale' }),
    ];
    expect(pickScripts(candidates, LEVELS.L1, 1, DEFAULT_PARAMS, 11)[0].stage).toBe('presale');
    expect(pickScripts(candidates, LEVELS.L3, 1, DEFAULT_PARAMS, 11)[0].stage).toBe('aftersale');
  });

  it('轮数不足与超出上限时给出提示', () => {
    expect(checkRounds(4, DEFAULT_PARAMS)).toMatch(/轮数不足/);
    expect(checkRounds(12, DEFAULT_PARAMS)).toMatch(/超出建议区间/);
    expect(checkRounds(8, DEFAULT_PARAMS)).toBeNull();
  });
});
