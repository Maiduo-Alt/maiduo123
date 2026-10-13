import { evaluateSemanticReply, getGoalProgress, isNaturalClosingReply, selectNextQuestion } from '../../src/domain/semantic-goals';
import { ScriptQuestion } from '../../src/domain/types';

const questions: ScriptQuestion[] = [
  {
    seq: 1,
    question: '你们家尺码偏大吗？',
    keyPoints: ['尺码'],
    semanticGoals: [{
      id: 'size-normal',
      name: '说明尺码是否偏大',
      requiredPoints: [{ id: 'normal', label: '说明尺码正常', matchAny: ['标准尺码', '正常尺码', '不偏大'] }],
    }],
  },
  {
    seq: 2,
    question: '退货有什么限制？',
    keyPoints: ['退货'],
    semanticGoals: [{
      id: 'return-condition',
      name: '说明退货限制',
      requiredPoints: [
        { id: 'tag', label: '吊牌条件', matchAny: ['吊牌剪了可能影响退货', '吊牌拆掉会影响退货'] },
        { id: 'condition', label: '商品状态条件', matchAny: ['影响二次销售', '商品保持完好'] },
      ],
      riskRules: [{ id: 'unconditional-return', label: '无条件承诺退货', matchAny: ['申请了肯定都会给您退'], penalty: 15 }],
    }],
  },
  {
    seq: 3,
    question: '还能帮我确认什么？',
    keyPoints: ['确认'],
    semanticGoals: [{
      id: 'return-damage',
      name: '说明商品损坏限制',
      requiredPoints: [{ id: 'damage', label: '商品损坏可能影响退货', matchAny: ['商品损坏也可能影响退货'] }],
    }],
  },
];

describe('semantic goal evaluation', () => {
  it('recognizes a configured equivalent expression for the size goal', () => {
    expect(evaluateSemanticReply('我们家是标准尺码的。', questions).goalMatches).toEqual([
      { goalId: 'size-normal', pointIds: ['normal'] },
    ]);
  });

  it('supports another explicitly configured natural expression', () => {
    expect(evaluateSemanticReply('平时穿 M 的话我们家也拿 M 就可以。', [
      { ...questions[0], semanticGoals: [{ ...questions[0].semanticGoals![0], requiredPoints: [
        { id: 'normal', label: '按平时尺码选择', matchAny: ['平时穿 M', '按平时尺码'] },
      ] }] },
    ]).goalMatches).toEqual([{ goalId: 'size-normal', pointIds: ['normal'] }]);
  });

  it('uses vector matches only as candidates and still requires configured business checks', () => {
    const configured = [{
      ...questions[0],
      semanticGoals: [{ ...questions[0].semanticGoals![0], requiredPoints: [{
        id: 'normal', label: '尺码不偏大', matchAny: [],
        businessRules: { mustIncludeAny: ['尺码'], mustExclude: ['偏大很多'] },
      }] }],
    }];
    const candidates = new Set(['size-normal:normal']);
    expect(evaluateSemanticReply('这件衣服很好看。', configured, candidates).goalMatches).toEqual([]);
    expect(evaluateSemanticReply('我们家是标准尺码。', configured, candidates).goalMatches).toEqual([
      { goalId: 'size-normal', pointIds: ['normal'] },
    ]);
    expect(evaluateSemanticReply('这件尺码偏大很多。', configured, candidates).goalMatches).toEqual([]);
  });

  it('retains partial completion across replies and can update multiple goals in one reply', () => {
    const first = evaluateSemanticReply('吊牌拆掉会影响退货。', questions);
    expect(getGoalProgress(questions, [first]).find((item) => item.goal.id === 'return-condition')?.status).toBe('partial');
    const second = evaluateSemanticReply('商品损坏也可能影响退货，而且要看是否影响二次销售。', questions);
    const progress = getGoalProgress(questions, [first, second]);
    expect(progress.find((item) => item.goal.id === 'return-condition')?.status).toBe('completed');
    expect(second.goalMatches).toEqual([
      { goalId: 'return-condition', pointIds: ['condition'] },
      { goalId: 'return-damage', pointIds: ['damage'] },
    ]);
  });

  it('keeps a correct goal match while independently recording an unconditional return promise', () => {
    const result = evaluateSemanticReply(
      '吊牌拆掉会影响退货，不过申请了肯定都会给您退。',
      questions
    );
    expect(result.goalMatches).toEqual([{ goalId: 'return-condition', pointIds: ['tag'] }]);
    expect(result.riskItems).toContainEqual(expect.objectContaining({
      label: '无条件承诺退货',
      penalty: 15,
    }));
    expect(evaluateSemanticReply('肯定都会给您退。', []).riskItems).toContainEqual(
      expect.objectContaining({ ruleId: 'unconditional-return-promise' })
    );
  });

  it('skips a later question only when all of its configured goals are complete', () => {
    expect(selectNextQuestion(questions, 1, new Set(['return-condition']))).toEqual({ nextSeq: 3, skippedSeqs: [2] });
    expect(selectNextQuestion(questions, 1, new Set())).toEqual({ nextSeq: 2, skippedSeqs: [] });
  });

  it('prefers a related core question over an unrelated optional question', () => {
    const flow: ScriptQuestion[] = [
      { seq: 1, question: '是包边还是锁边？', keyPoints: ['工艺'], sourceType: 'core',
        conversationPlan: { topic: '工艺', priority: 'primary', depth: 'focused', promptTemplates: [], followUpTemplates: [], maxFollowUps: 1 } },
      { seq: 2, question: '现在有额外优惠吗？', keyPoints: ['优惠'], sourceType: 'optional', requiresContext: true,
        conversationPlan: { topic: '优惠', priority: 'secondary', depth: 'normal', promptTemplates: [], followUpTemplates: [], maxFollowUps: 1 } },
      { seq: 3, question: '走线牢不牢？', keyPoints: ['走线'], sourceType: 'core',
        conversationPlan: { topic: '工艺', priority: 'secondary', depth: 'normal', promptTemplates: [], followUpTemplates: [], maxFollowUps: 1 } },
    ];
    expect(selectNextQuestion(flow, 1, new Set())).toEqual({ nextSeq: 3, skippedSeqs: [2] });
  });

  it('naturally ends instead of forcing a context-dependent optional topic', () => {
    const flow: ScriptQuestion[] = [
      { seq: 1, question: '有内衬吗？', keyPoints: ['内衬'], sourceType: 'core',
        conversationPlan: { topic: '内衬', priority: 'primary', depth: 'focused', promptTemplates: [], followUpTemplates: [], maxFollowUps: 1 } },
      { seq: 2, question: '那大概多久能处理好呢？', keyPoints: ['发货', '时间'], sourceType: 'optional', requiresContext: true,
        conversationPlan: { topic: '发货', priority: 'secondary', depth: 'normal', promptTemplates: [], followUpTemplates: [], maxFollowUps: 1 } },
    ];
    expect(selectNextQuestion(flow, 1, new Set())).toEqual({ nextSeq: null, skippedSeqs: [2] });
  });

  it('marks a bypassed off-topic core question as skipped when a later related topic is selected', () => {
    const flow: ScriptQuestion[] = [
      { seq: 1, question: '走线整齐吗？', keyPoints: ['走线'], sourceType: 'core',
        conversationPlan: { topic: '工艺', priority: 'primary', depth: 'focused', promptTemplates: [], followUpTemplates: [], maxFollowUps: 1 } },
      { seq: 2, question: '现在有什么优惠？', keyPoints: ['优惠'], sourceType: 'core',
        conversationPlan: { topic: '优惠', priority: 'secondary', depth: 'normal', promptTemplates: [], followUpTemplates: [], maxFollowUps: 1 } },
      { seq: 3, question: '边缘容易脱线吗？', keyPoints: ['脱线'], sourceType: 'core',
        conversationPlan: { topic: '工艺', priority: 'secondary', depth: 'normal', promptTemplates: [], followUpTemplates: [], maxFollowUps: 1 } },
    ];
    expect(selectNextQuestion(flow, 1, new Set())).toEqual({ nextSeq: 3, skippedSeqs: [2] });
  });

  it('does not let an optional cross-topic question interrupt discovery', () => {
    const flow: ScriptQuestion[] = [
      { seq: 1, question: '走线整齐吗？', keyPoints: ['走线'], sourceType: 'core',
        conversationPlan: { topic: '工艺', priority: 'primary', depth: 'focused', promptTemplates: [], followUpTemplates: [], maxFollowUps: 1 } },
      { seq: 2, question: '现在有什么优惠？', keyPoints: ['优惠'], sourceType: 'optional',
        conversationPlan: { topic: '优惠', priority: 'secondary', depth: 'normal', promptTemplates: [], followUpTemplates: [], maxFollowUps: 1 } },
    ];
    expect(selectNextQuestion(flow, 1, new Set(), [], {
      conversationStage: 'discovery',
      resolutionScore: 30,
    })).toEqual({ nextSeq: null, skippedSeqs: [2] });
  });

  it('allows a non-context optional transition only after entering decision stage', () => {
    const flow: ScriptQuestion[] = [
      { seq: 1, question: '尺码怎么选？', keyPoints: ['尺码'], sourceType: 'core',
        conversationPlan: { topic: '尺码', priority: 'primary', depth: 'focused', promptTemplates: [], followUpTemplates: [], maxFollowUps: 1 } },
      { seq: 2, question: '现在有什么优惠？', keyPoints: ['优惠'], sourceType: 'optional',
        conversationPlan: { topic: '优惠', priority: 'secondary', depth: 'normal', promptTemplates: [], followUpTemplates: [], maxFollowUps: 1 } },
    ];
    expect(selectNextQuestion(flow, 1, new Set(), [], {
      conversationStage: 'decision',
      resolutionScore: 80,
    })).toEqual({ nextSeq: 2, skippedSeqs: [] });
  });

  it('recognizes a clear customer closing without treating an open follow-up as a close', () => {
    expect(isNaturalClosingReply('好的，暂时没有其他问题，谢谢您。')).toBe(true);
    expect(isNaturalClosingReply('谢谢，另外还想问一下发货时间')).toBe(false);
  });
});
