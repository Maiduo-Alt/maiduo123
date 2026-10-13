import { buildQuestionSeq, normalizeLegacyQuestionSeq } from '../../src/domain/question-seq';
import { generateSemanticGoals } from '../../src/domain/semantic-goal-generator';
import { deriveConversationState } from '../../src/domain/conversation-state';
import { selectNextQuestion } from '../../src/domain/semantic-goals';
import { ScriptQuestion } from '../../src/domain/types';

describe('simulation flow regression: craft consultation', () => {
  it('keeps the full craft topic coherent from generation to next-question selection', () => {
    const base = buildQuestionSeq({
      question_list: ['是包边还是锁边？', '走线整齐吗？', '有内衬吗？'],
      key_points: [
        ['工艺', '包边', '锁边'],
        ['走线', '牢固'],
        ['内衬'],
      ],
      stage: 'presale',
    }, [6, 10]);

    const generated = generateSemanticGoals(
      base,
      '关注耐穿与打理成本',
      () => 0.999,
      {
        templateName: '咨询工艺细节',
        acceptedAnswer: '说明工艺做法与走线水平，可提供细节实拍',
      },
    );

    expect(generated).toHaveLength(3);
    expect(generated.map((q) => q.question)).toEqual([
      '是包边还是锁边？',
      '走线整齐吗？',
      '有内衬吗？',
    ]);
    expect(generated[0].customerGoal).toBe('确认商品工艺质量和耐穿程度');
    expect(generated[0].primaryGoal).toBe('工艺');
    expect(generated.every((q) => q.sourceType === 'core')).toBe(true);

    const state = deriveConversationState(generated, [], {
      currentSeq: 0,
      skippedSeqs: [],
      emotionValue: 20,
    });
    expect(state.customerGoal).toBe('确认商品工艺质量和耐穿程度');
    expect(state.conversationStage).toBe('opening');

    const first = selectNextQuestion(generated, 0, new Set(), [], {
      conversationStage: state.conversationStage,
      resolutionScore: state.resolutionScore,
    });
    expect(first).toEqual({ nextSeq: 1, skippedSeqs: [] });
  });

  it('repairs the exact legacy failure where shipping was randomly promoted ahead of craft questions', () => {
    const legacy: ScriptQuestion[] = [
      {
        seq: 1,
        question: '那大概多久能处理好呢？',
        keyPoints: ['发货', '时间'],
        goalPriority: 'primary',
        primaryGoal: '发货',
        semanticGoals: [{
          id: 'auto-goal-1',
          name: '主目标：发货',
          requiredPoints: [
            { id: 'a1', label: '发货', matchAny: ['发货'], isPrimary: true },
            { id: 'a2', label: '时间', matchAny: ['时间'] },
          ],
        }],
      },
      {
        seq: 2,
        question: '是包边还是锁边？',
        keyPoints: ['工艺', '包边', '锁边'],
        goalPriority: 'secondary',
        semanticGoals: [{
          id: 'auto-goal-2',
          name: '次要目标：工艺',
          requiredPoints: [{ id: 'b1', label: '工艺', matchAny: ['工艺'] }],
        }],
      },
      {
        seq: 3,
        question: '走线整齐吗？',
        keyPoints: ['走线'],
        goalPriority: 'secondary',
        semanticGoals: [{
          id: 'auto-goal-3',
          name: '次要目标：走线',
          requiredPoints: [{ id: 'c1', label: '走线', matchAny: ['走线'] }],
        }],
      },
      {
        seq: 4,
        question: '有内衬吗？',
        keyPoints: ['内衬'],
        goalPriority: 'secondary',
        semanticGoals: [{
          id: 'auto-goal-4',
          name: '次要目标：内衬',
          requiredPoints: [{ id: 'd1', label: '内衬', matchAny: ['内衬'] }],
        }],
      },
      {
        seq: 5,
        question: '我再看一下别家，你们有什么优势吗？',
        keyPoints: ['优势', '保障'],
        goalPriority: 'secondary',
        semanticGoals: [{
          id: 'auto-goal-5',
          name: '次要目标：优势',
          requiredPoints: [{ id: 'e1', label: '优势', matchAny: ['优势'] }],
        }],
      },
      {
        seq: 6,
        question: '现在下单还有什么额外优惠吗？',
        keyPoints: ['优惠', '活动'],
        goalPriority: 'secondary',
        semanticGoals: [{
          id: 'auto-goal-6',
          name: '次要目标：优惠',
          requiredPoints: [{ id: 'f1', label: '优惠', matchAny: ['优惠'] }],
        }],
      },
    ];

    const normalized = normalizeLegacyQuestionSeq(legacy);
    expect(normalized[0]).toEqual(expect.objectContaining({
      sourceType: 'optional',
      requiresContext: true,
      goalPriority: 'secondary',
    }));
    expect(normalized[1]).toEqual(expect.objectContaining({
      sourceType: 'core',
      goalPriority: 'primary',
      primaryGoal: '工艺',
    }));

    const next = selectNextQuestion(normalized, 0, new Set(), [], {
      conversationStage: 'opening',
      resolutionScore: 0,
    });

    // 旧数据无需重建：开场直接跳过错误的“多久能处理好”，从真实工艺问题开始。
    expect(next.nextSeq).toBe(2);
    expect(next.skippedSeqs).toContain(1);
    expect(normalized.find((q) => q.seq === next.nextSeq)?.question).toBe('是包边还是锁边？');
  });
});
