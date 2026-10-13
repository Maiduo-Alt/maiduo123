import { buildQuestionSeq, mixQuestionSeq, normalizeLegacyQuestionSeq } from '../../src/domain/question-seq';
import { ORDER_AFTERSALE_QUESTIONS, PRESALE_PRODUCT_QUESTIONS } from '../../src/db/seed-content';

/** 构造一条最小的买家咨询内容。 */
const qa = (stage: 'presale' | 'aftersale', questions: string[]) => ({
  question_list: questions,
  key_points: questions.map(() => ['要点']),
  stage,
});

describe('问题序列：问题级接待阶段（客户 2026-10-03）', () => {
  it('保留原始自然问题数，不再为了最低轮数注入跨主题追问', () => {
    const presale = buildQuestionSeq(qa('presale', ['怎么下单？']), [6, 10]);
    const aftersale = buildQuestionSeq(qa('aftersale', ['怎么退货？']), [6, 10]);

    expect(presale).toHaveLength(1);
    expect(aftersale).toHaveLength(1);
    expect(presale[0]).toEqual(expect.objectContaining({ question: '怎么下单？', stage: 'presale', sourceType: 'core' }));
    expect(aftersale[0]).toEqual(expect.objectContaining({ question: '怎么退货？', stage: 'aftersale', sourceType: 'core' }));
  });

  it('工艺类短场景不会被补入发货、竞品或优惠问题', () => {
    const seq = buildQuestionSeq({
      question_list: ['是包边还是锁边？', '走线整齐吗？', '有内衬吗？'],
      key_points: [['工艺', '走线'], ['包边', '锁边'], ['内衬']],
      stage: 'presale',
    }, [6, 10]);

    expect(seq.map((q) => q.question)).toEqual(['是包边还是锁边？', '走线整齐吗？', '有内衬吗？']);
    expect(seq.every((q) => q.sourceType === 'core')).toBe(true);
  });

  it('问题数超过上限时按上限截断，且序号连续', () => {
    const seq = buildQuestionSeq(qa('presale', ['问一？', '问二？']), [2, 2]);
    expect(seq).toHaveLength(2);
    expect(seq.map((q) => q.seq)).toEqual([1, 2]);
  });
});

describe('问题混合保留主目标', () => {
  it('混入跨阶段问题时保留主目标轮次', () => {
    const questions = [
      { seq: 1, question: '问题一', keyPoints: ['一'], stage: 'presale' as const },
      { seq: 2, question: '问题二', keyPoints: ['二'], stage: 'presale' as const },
      { seq: 3, question: '问题三', keyPoints: ['三'], stage: 'presale' as const },
      { seq: 4, question: '主目标原问题', keyPoints: ['面料'], goalPriority: 'primary' as const, primaryGoal: '面料', stage: 'presale' as const },
    ];
    const mixed = mixQuestionSeq(questions, {
      ratioPct: 25,
      pool: [{ question: '售后补充问题', keyPoints: ['时间说明'] }],
      stage: 'aftersale',
    });
    expect(mixed.find((question) => question.goalPriority === 'primary')?.question).toBe('主目标原问题');
    expect(mixed.some((question) => question.question === '售后补充问题')).toBe(true);
    expect(mixed.find((question) => question.question === '售后补充问题')).toEqual(
      expect.objectContaining({
        sourceType: 'optional',
        requiresContext: true,
        triggerConditions: expect.objectContaining({ stages: expect.any(Array) }),
      })
    );
  });
});

/**
 * 客户 2026-10-03：一次接待里的问题要按比例混合售前 / 售后——
 * 大部分是「还没有订单、只咨询商品信息」的售前问题，小部分是「买完商品后」的订单类售后问题。
 */
describe('问题序列：售前 / 售后按比例混合（客户 2026-10-03）', () => {
  const base = () => buildQuestionSeq(qa('presale', ['面料是什么？', '有优惠吗？', '尺码怎么选？', '多久能到？', '能开发票吗？', '支持退换吗？']), [6, 6]);

  it('按比例替换靠后的轮次：替换进来的问题带售后阶段与对应的订单状态', () => {
    const seq = base();
    const mixed = mixQuestionSeq(seq, { ratioPct: 33, pool: ORDER_AFTERSALE_QUESTIONS, stage: 'aftersale' });

    expect(mixed).toHaveLength(seq.length);
    // 第一轮一定是剧本自己的开场，不会一上来就跑题
    expect(mixed[0].question).toBe('面料是什么？');
    const aftersale = mixed.filter((q) => q.stage === 'aftersale');
    expect(aftersale.length).toBe(2);
    // 替换进来的都是「买完商品后」的订单类问题，且订单状态跟着问题走
    expect(aftersale.every((q) => ORDER_AFTERSALE_QUESTIONS.some((p) => p.question === q.question))).toBe(true);
    expect(aftersale.some((q) => q.orderStage === 'unshipped')).toBe(true);
    // 序号保持连续，评分与推送端都靠 seq 对齐
    expect(mixed.map((q) => q.seq)).toEqual(seq.map((q) => q.seq));
  });

  it('两轮短剧本在 50% 配比下也会混入 1 轮另一阶段问题', () => {
    const short = buildQuestionSeq(qa('presale', ['问题一？', '问题二？']), [2, 2]);
    const mixed = mixQuestionSeq(short, {
      ratioPct: 50,
      pool: ORDER_AFTERSALE_QUESTIONS,
      stage: 'aftersale',
    });
    expect(mixed).toHaveLength(2);
    expect(mixed[0].stage).toBe('presale');
    expect(mixed[1].stage).toBe('aftersale');
    expect(mixed[1]).toEqual(expect.objectContaining({
      sourceType: 'optional',
      requiresContext: true,
      triggerConditions: expect.objectContaining({ requiresOrder: true, minResolutionScore: 70 }),
    }));
  });

  it('占比 0 表示不混（整场都是剧本本身的话题）；占比有上限，最多换掉一半', () => {
    const seq = base();
    expect(mixQuestionSeq(seq, { ratioPct: 0, pool: ORDER_AFTERSALE_QUESTIONS, stage: 'aftersale' })).toEqual(seq);
    const half = mixQuestionSeq(seq, { ratioPct: 80, pool: ORDER_AFTERSALE_QUESTIONS, stage: 'aftersale' });
    expect(half.filter((q) => q.stage === 'aftersale').length).toBeLessThanOrEqual(Math.floor(seq.length / 2));
  });

  it('售后剧本反向混入售前问题：大部分仍是售后，小部分是商品咨询', () => {
    const aftersale = buildQuestionSeq(qa('aftersale', ['我要退货', '运费谁承担？', '多久能退款？', '谁来取件？', '能换个尺码吗？', '有补偿吗？']), [6, 6]);
    const mixed = mixQuestionSeq(aftersale, { ratioPct: 33, pool: PRESALE_PRODUCT_QUESTIONS, stage: 'presale' });
    const presale = mixed.filter((q) => q.stage === 'presale');
    expect(presale.length).toBe(2);
    expect(mixed.filter((q) => q.stage === 'aftersale').length).toBe(4);
    expect(presale.every((q) => PRESALE_PRODUCT_QUESTIONS.some((p) => p.question === q.question))).toBe(true);
  });
});


describe('旧剧本兼容：通用补题降级', () => {
  it('把旧版自动生成的通用补题降级为 optional，且取消错误主目标', () => {
    const normalized = normalizeLegacyQuestionSeq([
      {
        seq: 1,
        question: '那大概多久能处理好呢？',
        keyPoints: ['发货', '时间'],
        goalPriority: 'primary',
        primaryGoal: '发货',
        semanticGoals: [{ id: 'auto-goal-1', name: '主目标：发货', requiredPoints: [{ id: 'p1', label: '发货', matchAny: ['发货'] }] }],
      },
      {
        seq: 2,
        question: '是包边还是锁边？',
        keyPoints: ['工艺', '走线'],
        semanticGoals: [{ id: 'auto-goal-2', name: '次要目标：工艺', requiredPoints: [{ id: 'p2', label: '工艺', matchAny: ['工艺'] }] }],
      },
    ]);
    expect(normalized[0]).toEqual(expect.objectContaining({
      sourceType: 'optional',
      requiresContext: true,
      goalPriority: 'secondary',
      triggerConditions: expect.objectContaining({
        requiresOrder: true,
        afterBusinessAction: expect.arrayContaining(['ship_goods', 'after_sale_proxy']),
      }),
    }));
    expect(normalized[0].primaryGoal).toBeUndefined();
    expect(normalized[1].sourceType).toBe('core');
    expect(normalized[1].goalPriority).toBe('primary');
    expect(normalized[1].primaryGoal).toBe('工艺');
    expect(normalized[1].semanticGoals?.[0].requiredPoints[0].isPrimary).toBe(true);
  });

  it('没有 auto-goal 的旧关键词剧本也能识别多条通用补题', () => {
    const normalized = normalizeLegacyQuestionSeq([
      { seq: 1, question: '是包边还是锁边？', keyPoints: ['工艺'] },
      { seq: 2, question: '走线整齐吗？', keyPoints: ['走线'] },
      { seq: 3, question: '我再看一下别家，你们有什么优势吗？', keyPoints: ['优势'] },
      { seq: 4, question: '现在下单还有什么额外优惠吗？', keyPoints: ['优惠'] },
    ]);
    expect(normalized[0].sourceType).toBe('core');
    expect(normalized[2].sourceType).toBe('optional');
    expect(normalized[3].sourceType).toBe('optional');
  });

  it('人工/新结构问题不做旧版误判', () => {
    const current = [{ seq: 1, question: '现在下单还有什么额外优惠吗？', keyPoints: ['优惠'], sourceType: 'core' as const }];
    expect(normalizeLegacyQuestionSeq(current)).toEqual(current);
  });
});
