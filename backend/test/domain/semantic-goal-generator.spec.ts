import { generateSemanticGoals } from '../../src/domain/semantic-goal-generator';
import { ScriptQuestion } from '../../src/domain/types';

describe('generateSemanticGoals', () => {
  it('builds editable goals from question points, synonyms, and buyer background', () => {
    const questions: ScriptQuestion[] = [{
      seq: 2,
      question: '如果商品不合适，可以怎么处理？',
      keyPoints: ['退换', '处理时效'],
    }];

    const [generated] = generateSemanticGoals(questions, '退换货咨询 买家担心处理麻烦', () => 0);
    expect(generated.semanticGoals).toHaveLength(1);
    expect(generated.semanticGoals![0].name).toContain('退换货咨询');
    expect(generated.semanticGoals![0].requiredPoints).toEqual([
      expect.objectContaining({ label: '退换', matchAny: expect.arrayContaining(['退换', '退货', '换货']) }),
      expect.objectContaining({ label: '处理时效', matchAny: expect.arrayContaining(['处理时效', '工作日', '尽快']) }),
    ]);
    expect(generated.semanticGoals![0].requiredPoints[0].isPrimary).toBe(true);
  });

  it('selects a deterministic primary point from core questions and preserves conversation order', () => {
    const generated = generateSemanticGoals([
      { seq: 1, question: '材质是什么？', keyPoints: ['面料', '透气'], sourceType: 'core' },
      { seq: 2, question: '推荐什么尺码？', keyPoints: ['尺码', '偏大'], sourceType: 'core' },
      { seq: 3, question: '何时发货？', keyPoints: ['发货时间'], sourceType: 'optional' },
    ], '', () => 0.99);
    const primary = generated.flatMap((question) => question.semanticGoals || [])
      .flatMap((goal) => goal.requiredPoints.filter((point) => point.isPrimary));
    expect(primary).toHaveLength(1);
    expect(primary[0].label).toBe('面料');
    expect(generated.map((question) => question.question)).toEqual(['材质是什么？', '推荐什么尺码？', '何时发货？']);
    expect(generated[0].goalPriority).toBe('primary');
    expect(generated[2].goalPriority).toBe('secondary');
    expect(generated[0].seq).toBe(1);
  });

  it('never promotes an optional padding question to the primary goal', () => {
    const generated = generateSemanticGoals([
      { seq: 1, question: '是包边还是锁边？', keyPoints: ['工艺', '走线'], sourceType: 'core' },
      { seq: 2, question: '那大概多久能处理好呢？', keyPoints: ['发货', '时间'], sourceType: 'optional', requiresContext: true },
    ], '关注耐穿与打理成本', () => 0.999);
    expect(generated[0].primaryGoal).toBe('工艺');
    expect(generated[0].goalPriority).toBe('primary');
    expect(generated[1].goalPriority).toBe('secondary');
  });

  it('derives a readable customer goal from topic, background and accepted answer', () => {
    const generated = generateSemanticGoals([
      { seq: 1, question: '是包边还是锁边？', keyPoints: ['工艺', '走线'], sourceType: 'core' },
      { seq: 2, question: '有内衬吗？', keyPoints: ['内衬'], sourceType: 'core' },
    ], '关注耐穿与打理成本', () => 0, {
      templateName: '咨询工艺细节',
      acceptedAnswer: '说明工艺做法与走线水平，可提供细节实拍',
    });

    expect(generated[0].customerGoal).toBe('确认商品工艺质量和耐穿程度');
    expect(generated[1].customerGoal).toBeUndefined();
  });

  it('leaves generic fallback points on the existing keyword path', () => {
    const [generated] = generateSemanticGoals([{
      seq: 1,
      question: '您好，请问想了解什么？',
      keyPoints: ['有效回应'],
    }]);
    expect(generated.semanticGoals).toBeUndefined();
  });
});


describe('conversation plan topic consistency', () => {
  it('secondary questions use their own topic instead of inheriting the primary topic', () => {
    const generated = generateSemanticGoals([
      { seq: 1, question: '是包边还是锁边？', keyPoints: ['工艺', '走线'], sourceType: 'core' },
      { seq: 2, question: '有内衬吗？', keyPoints: ['内衬'], sourceType: 'core' },
    ], '关注耐穿与打理成本');
    expect(generated[0].conversationPlan?.topic).toBe('工艺');
    expect(generated[1].conversationPlan?.topic).toBe('内衬');
    expect(generated[0].conversationPlan?.followUpTemplates[0]).toContain('做工');
    expect(generated[1].conversationPlan?.followUpTemplates[0]).toContain('做工');
  });
});
