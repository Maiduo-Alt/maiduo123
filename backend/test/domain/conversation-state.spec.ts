import { deriveConversationState, inferCustomerGoal } from '../../src/domain/conversation-state';
import { ScriptQuestion } from '../../src/domain/types';

const questions: ScriptQuestion[] = [
  {
    seq: 1,
    question: '是包边还是锁边？',
    keyPoints: ['工艺', '走线'],
    sourceType: 'core',
    goalPriority: 'primary',
    primaryGoal: '工艺',
    conversationPlan: {
      topic: '工艺',
      priority: 'primary',
      depth: 'focused',
      promptTemplates: ['是包边还是锁边？'],
      followUpTemplates: [],
      maxFollowUps: 2,
    },
    semanticGoals: [{
      id: 'g1',
      name: '主目标：工艺',
      requiredPoints: [
        { id: 'p1', label: '包边或锁边', matchAny: ['包边', '锁边'] },
        { id: 'p2', label: '走线', matchAny: ['走线'] },
      ],
    }],
  },
  {
    seq: 2,
    question: '有内衬吗？',
    keyPoints: ['内衬'],
    sourceType: 'core',
    goalPriority: 'secondary',
    semanticGoals: [{
      id: 'g2',
      name: '次要目标：内衬',
      requiredPoints: [{ id: 'p3', label: '内衬', matchAny: ['有内衬', '没有内衬'] }],
    }],
  },
  {
    seq: 3,
    question: '现在有什么额外优惠？',
    keyPoints: ['优惠'],
    sourceType: 'optional',
    requiresContext: true,
    semanticGoals: [{
      id: 'g3',
      name: '次要目标：优惠',
      requiredPoints: [{ id: 'p4', label: '优惠', matchAny: ['优惠'] }],
    }],
  },
];

describe('conversation state', () => {
  it('infers customer goal from the core primary goal', () => {
    expect(inferCustomerGoal(questions)).toBe('确认工艺');
  });

  it('tracks partial completion and keeps optional goals out of core resolution', () => {
    const state = deriveConversationState(questions, [{
      goalMatches: [{ goalId: 'g1', pointIds: ['p1'] }],
      riskItems: [],
    }], { currentSeq: 1, emotionValue: 20 });

    expect(state.customerGoal).toBe('确认工艺');
    expect(state.partialGoalIds).toContain('g1');
    expect(state.unresolvedGoalIds).toContain('g2');
    expect(state.unresolvedGoalIds).not.toContain('g3');
    expect(state.resolutionScore).toBe(33);
    expect(state.conversationStage).toBe('clarification');
    expect(state.shouldClose).toBe(false);
  });

  it('can naturally close once the primary goal is solved and core coverage is high enough', () => {
    const state = deriveConversationState(questions, [{
      goalMatches: [
        { goalId: 'g1', pointIds: ['p1', 'p2'] },
        { goalId: 'g2', pointIds: ['p3'] },
      ],
      riskItems: [],
    }], { currentSeq: 2, emotionValue: 20 });

    expect(state.resolutionScore).toBe(100);
    expect(state.satisfaction).toBeGreaterThanOrEqual(60);
    expect(state.conversationStage).toBe('closing');
    expect(state.shouldClose).toBe(true);
  });

  it('high negative emotion can prevent an otherwise solved conversation from auto-closing', () => {
    const state = deriveConversationState(questions, [{
      goalMatches: [
        { goalId: 'g1', pointIds: ['p1', 'p2'] },
        { goalId: 'g2', pointIds: ['p3'] },
      ],
      riskItems: [],
    }], { currentSeq: 2, emotionValue: 100 });

    expect(state.resolutionScore).toBe(100);
    expect(state.satisfaction).toBeLessThan(60);
    expect(state.shouldClose).toBe(false);
  });
});
