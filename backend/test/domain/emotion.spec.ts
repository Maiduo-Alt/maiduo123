import { updateEmotion } from '../../src/domain/emotion';
import { DEFAULT_PARAMS } from '../../src/domain/types';

describe('买家情绪值更新（方案 3.7.4 / 4.3）', () => {
  const params = DEFAULT_PARAMS;

  it('命中安抚词：情绪按固定步长下降', () => {
    const result = updateEmotion(50, '亲，非常抱歉给您带来不便，我帮您处理', params);
    expect(result.reason).toBe('soothe');
    expect(result.delta).toBe(-params.emotionSootheStep);
    expect(result.value).toBe(35);
    expect(result.escalated).toBe(false);
  });

  it('命中负面词：情绪按固定步长上升', () => {
    const result = updateEmotion(50, '这个我不知道', params);
    expect(result.reason).toBe('negative');
    expect(result.delta).toBe(params.emotionNegativeStep);
    expect(result.value).toBe(70);
  });

  it('同时命中安抚词与负面词时，负面词优先', () => {
    const result = updateEmotion(50, '抱歉，但是我不知道', params);
    expect(result.reason).toBe('negative');
    expect(result.value).toBe(70);
  });

  it('连续两轮未正面回应：情绪上升', () => {
    const result = updateEmotion(40, '好的我看下', params, { hitAnyPoint: false, unresolvedStreak: 2 });
    expect(result.reason).toBe('unresolved');
    expect(result.value).toBe(60);
  });

  it('只差一轮未回应时不升级情绪', () => {
    const result = updateEmotion(40, '好的我看下', params, { hitAnyPoint: false, unresolvedStreak: 1 });
    expect(result.reason).toBe('none');
    expect(result.delta).toBe(0);
    expect(result.value).toBe(40);
  });

  it('命中安抚词时不再走“未回应”判定', () => {
    const result = updateEmotion(40, '好的，我帮您查一下物流', params, { hitAnyPoint: false, unresolvedStreak: 5 });
    expect(result.reason).toBe('soothe');
  });

  it('有效回应且无关键词：情绪不变', () => {
    const neutral = updateEmotion(40, '好的，稍等一下', params, { hitAnyPoint: true, unresolvedStreak: 5 });
    expect(neutral.reason).toBe('none');
    expect(neutral.value).toBe(40);
  });

  it('情绪值被限制在 0～100 之间', () => {
    const floor = updateEmotion(6, '非常抱歉，请您放心', params);
    expect(floor.value).toBe(0);
    expect(floor.delta).toBe(-6);

    const ceil = updateEmotion(95, '你自己看', params);
    expect(ceil.value).toBe(100);
    expect(ceil.delta).toBe(5);
  });

  it('达到升级阈值时标记 escalated', () => {
    expect(updateEmotion(60, '这个我不知道', params)).toMatchObject({ value: 80, escalated: true });
    expect(updateEmotion(59, '这个我不知道', params)).toMatchObject({ value: 79, escalated: false });
  });

  it('空回复不会误触发关键词', () => {
    const result = updateEmotion(30, '', params, { hitAnyPoint: true });
    expect(result.reason).toBe('none');
    expect(result.value).toBe(30);
  });
});
