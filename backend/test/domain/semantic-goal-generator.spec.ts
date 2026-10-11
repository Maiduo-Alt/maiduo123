import { generateSemanticGoals } from '../../src/domain/semantic-goal-generator';
import { ScriptQuestion } from '../../src/domain/types';

describe('generateSemanticGoals', () => {
  it('builds editable goals from question points, synonyms, and buyer background', () => {
    const questions: ScriptQuestion[] = [{
      seq: 2,
      question: '如果商品不合适，可以怎么处理？',
      keyPoints: ['退换', '处理时效'],
    }];

    const [generated] = generateSemanticGoals(questions, '退换货咨询 买家担心处理麻烦');
    expect(generated.semanticGoals).toHaveLength(1);
    expect(generated.semanticGoals![0].name).toContain('退换货咨询');
    expect(generated.semanticGoals![0].requiredPoints).toEqual([
      expect.objectContaining({ label: '退换', matchAny: expect.arrayContaining(['退换', '退货', '换货']) }),
      expect.objectContaining({ label: '处理时效', matchAny: expect.arrayContaining(['处理时效', '工作日', '尽快']) }),
    ]);
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
