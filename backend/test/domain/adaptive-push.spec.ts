import { decidePush, buildFollowUpText, buildMissingPointFollowUpText, buildTopicTransitionText, followUpEmotionDelta, MAX_FOLLOWUPS } from '../../src/domain/adaptive-push';

describe('decidePush：自适应推送决策', () => {
  it('命中任意要点 → 推进下一题', () => {
    expect(decidePush(true, false, 0)).toBe('advance');
    expect(decidePush(true, false, 1)).toBe('advance');
  });

  it('执行过业务动作（催付/改价等）→ 视为有效处理，推进下一题', () => {
    expect(decidePush(false, true, 0)).toBe('advance');
    expect(decidePush(false, true, 1)).toBe('advance');
  });

  it('未命中且未超追问上限 → 追问', () => {
    expect(decidePush(false, false, 0)).toBe('followup');
    expect(decidePush(false, false, MAX_FOLLOWUPS - 1)).toBe('followup');
  });

  it('未命中但追问次数已达上限 → 推进（防死循环）', () => {
    expect(decidePush(false, false, MAX_FOLLOWUPS)).toBe('advance');
    expect(decidePush(false, false, MAX_FOLLOWUPS + 5)).toBe('advance');
  });
});

describe('buildFollowUpText：追问话术按风格与次数变化', () => {
  const q = '这套装能单买吗？';

  it('每种风格都能生成包含原问题的追问', () => {
    for (const style of ['friendly', 'hesitant', 'direct', 'impatient', 'silent']) {
      const first = buildFollowUpText(style, q, 0);
      expect(first).toContain('这套装能单买吗？');
      const second = buildFollowUpText(style, q, 1);
      expect(second).toContain('这套装能单买吗？');
      expect(second).not.toBe(first);
    }
  });

  it('未知风格回退到 friendly 话术', () => {
    expect(buildFollowUpText('unknown-style', q, 0)).toBe(buildFollowUpText('friendly', q, 0));
  });

  it('急躁型第 2 次追问语气明显加重', () => {
    expect(buildFollowUpText('impatient', q, 1)).toContain('最后一次');
  });

  it('round 越界时按边界取值，不报错', () => {
    expect(buildFollowUpText('friendly', q, 99)).toBe(buildFollowUpText('friendly', q, 1));
    expect(buildFollowUpText('friendly', q, -3)).toBe(buildFollowUpText('friendly', q, 0));
  });
});

describe('followUpEmotionDelta：追问带来的情绪变化', () => {
  it('第 1 次 -4，第 2 次 -7', () => {
    expect(followUpEmotionDelta(0)).toBe(-4);
    expect(followUpEmotionDelta(1)).toBe(-7);
  });
});


describe('buildMissingPointFollowUpText：部分完成只追缺失语义点', () => {
  it('不复读整道原题，而是围绕缺失点追问', () => {
    const text = buildMissingPointFollowUpText('friendly', ['是否影响二次销售'], 0);
    expect(text).toContain('是否影响二次销售');
    expect(text).not.toContain('我是想问');
  });

  it('多个缺失点最多合并前两个，保持买家问题简洁', () => {
    const text = buildMissingPointFollowUpText('direct', ['走线牢固度', '内衬材质', '洗涤方式'], 0);
    expect(text).toContain('走线牢固度');
    expect(text).toContain('内衬材质');
    expect(text).not.toContain('洗涤方式');
  });
});


describe('buildTopicTransitionText：跨主题转场', () => {
  it('切换话题时增加自然转场，但不改变原问题语义', () => {
    const text = buildTopicTransitionText('friendly', '现在有什么优惠吗？');
    expect(text).toContain('对了');
    expect(text).toContain('现在有什么优惠吗？');
  });

  it('不同沟通风格只改变表达方式，不注入新的业务问题', () => {
    const question = '多久可以发货？';
    for (const style of ['friendly', 'hesitant', 'direct', 'impatient', 'silent']) {
      expect(buildTopicTransitionText(style, question)).toContain(question);
    }
  });
});
