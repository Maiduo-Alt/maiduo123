import { createRng, pickIndex } from './rng';
import { LevelDef, ScriptCandidate, SystemParams } from './types';

/**
 * 剧本抽取规则（方案 4.5）：
 * 1) 过滤可用剧本；2) 按被练次数升序、最近练习时间升序排序；
 * 3) 同一"买家咨询内容"只出现一次；4) 高难度对售后/情绪化剧本加权；5) 候选不足时允许重复。
 */
export function pickScripts(
  candidates: ScriptCandidate[],
  level: LevelDef,
  count: number,
  params: SystemParams,
  seed = Date.now()
): ScriptCandidate[] {
  const rng = createRng(seed);
  const highLevel = level.code === 'L3' || level.code === 'L4';

  const stageScore = (s: ScriptCandidate) => {
    if (level.stagePreference === 'presale') return s.stage === 'presale' ? 0 : 1;
    if (level.stagePreference === 'mixed') return 0;
    return s.stage === 'aftersale' ? 0 : 1;
  };

  const ordered = [...candidates]
    .map((c) => ({
      candidate: c,
      weight:
        1 +
        (highLevel && c.emotionStyle ? params.highLevelStyleBoost - 1 : 0) +
        (highLevel && c.stage === 'aftersale' ? 0.5 : 0),
    }))
    .sort((a, b) => {
      const practiced = (a.candidate.practicedCount || 0) - (b.candidate.practicedCount || 0);
      if (practiced !== 0) return practiced;
      const stage = stageScore(a.candidate) - stageScore(b.candidate);
      if (stage !== 0) return stage;
      const ta = a.candidate.lastPracticedAt ? new Date(a.candidate.lastPracticedAt).getTime() : 0;
      const tb = b.candidate.lastPracticedAt ? new Date(b.candidate.lastPracticedAt).getTime() : 0;
      return ta - tb;
    });

  const picked: ScriptCandidate[] = [];
  const usedQa = new Set<number>();
  const pool = ordered.map((o) => o.candidate);
  const matchesPreference = (c: ScriptCandidate) => {
    if (level.stagePreference === 'presale') return c.stage === 'presale';
    if (level.stagePreference === 'aftersale') return c.stage === 'aftersale';
    return true;
  };

  // 第一轮：去重抽取，且优先满足档位的接待类型偏好
  while (picked.length < count && pool.length) {
    const available = pool.filter((c) => !usedQa.has(c.qaId));
    if (!available.length) break;
    const preferred = available.filter(matchesPreference);
    const source = preferred.length ? preferred : available;
    const weights = source.map(
      (c) => 1000 + (highLevel && c.emotionStyle ? (params.highLevelStyleBoost - 1) * 1000 : 0)
    );
    const chosen = source[pickIndex(rng, weights)];
    usedQa.add(chosen.qaId);
    picked.push(chosen);
    pool.splice(pool.indexOf(chosen), 1);
  }

  // 第二轮：候选不足时允许重复内容，取剩余中"被练次数最少"的
  while (picked.length < count && pool.length) {
    const remaining = [...pool].sort((a, b) => (a.practicedCount || 0) - (b.practicedCount || 0));
    picked.push(remaining[0]);
    pool.splice(pool.indexOf(remaining[0]), 1);
  }

  return picked.slice(0, count);
}

/** 剧本轮数校验：返回提示信息（无提示返回 null）。 */
export function checkRounds(rounds: number, params: SystemParams): string | null {
  const [min, max] = params.levelRounds;
  if (rounds < min) return `轮数不足，建议补充追问（当前 ${rounds} 轮，建议 ${min}～${max} 轮）`;
  if (rounds > max) return `轮数超出建议区间，接待时将按前 ${max} 轮执行`;
  return null;
}
