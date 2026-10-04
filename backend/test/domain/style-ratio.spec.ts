import { allocateCounts, allocateStyles, normalizeRatios } from '../../src/domain/style-ratio';
import { createRng } from '../../src/domain/rng';

describe('沟通风格占比（方案 3.7.4 / 4.6）', () => {
  const styles = [
    { code: 'friendly', ratio: 30 },
    { code: 'impatient', ratio: 15 },
    { code: 'direct', ratio: 20 },
    { code: 'hesitant', ratio: 20 },
    { code: 'silent', ratio: 15 },
  ];

  it('占比总和超过 100% 应抛出异常', () => {
    expect(() => normalizeRatios([{ code: 'a', ratio: 60 }, { code: 'b', ratio: 60 }])).toThrow(/100%/);
  });

  it('未填写占比的行应按剩余比例平均分配', () => {
    const result = normalizeRatios([{ code: 'a', ratio: 40 }, { code: 'b', ratio: null }, { code: 'c', ratio: null }]);
    expect(result.find((r) => r.code === 'b').ratio).toBe(30);
    expect(result.find((r) => r.code === 'c').ratio).toBe(30);
    expect(result.reduce((sum, r) => sum + r.ratio, 0)).toBe(100);
  });

  it('100 个剧本的风格分布与理论值偏差不超过 ±5', () => {
    const counts = allocateCounts(styles, 100);
    expect(counts.friendly).toBe(30);
    expect(counts.impatient).toBe(15);
    expect(counts.direct).toBe(20);
    expect(counts.hesitant).toBe(20);
    expect(counts.silent).toBe(15);
  });

  it('小样本分配总量精确且分布均匀', () => {
    const list = allocateStyles(styles, 7, createRng(1));
    expect(list.length).toBe(7);
    const counts: Record<string, number> = {};
    list.forEach((c) => (counts[c] = (counts[c] || 0) + 1));
    expect(counts.friendly).toBeGreaterThanOrEqual(2);
    expect(counts.friendly).toBeLessThanOrEqual(3);
  });
});
