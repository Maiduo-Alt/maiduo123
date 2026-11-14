import { buildQuestionSeq, createMinimumRoundQuestion, mixQuestionSeq, normalizeLegacyQuestionSeq } from '../../src/domain/question-seq';
import { ORDER_AFTERSALE_QUESTIONS, PRESALE_PRODUCT_QUESTIONS } from '../../src/db/seed-content';

/** 构造一条最小的买家咨询内容。 */
const qa = (stage: 'presale' | 'aftersale', questions: string[]) => ({
  question_list: questions,
  key_points: questions.map(() => ['要点']),
  stage,
});

describe('问题序列：问题级接待阶段（客户 2026-10-03）', () => {
  it('为历史单题剧本生成同主题且不重复的补充问题', () => {
    const parent = { seq: 1, question: '这件衣服是什么面料？', keyPoints: ['面料'], stage: 'presale' as const };
    const first = createMinimumRoundQuestion([parent], parent);
    const second = createMinimumRoundQuestion([parent, first], parent);
    expect([first.seq, second.seq]).toEqual([2, 3]);
    expect(first.question).not.toBe(second.question);
    expect(first.derivedFromSeq).toBe(1);
    expect(second.stage).toBe('presale');
  });
  it('搭配单题的运行时补题分别询问外套配色和休闲鞋子', () => {
    const parent = { seq: 1, question: '这条连衣裙搭配什么外套和鞋子好看', keyPoints: ['搭配'], stage: 'presale' as const };
    const first = createMinimumRoundQuestion([parent], parent);
    const second = createMinimumRoundQuestion([parent, first], parent);
    expect(first.question).toMatch(/外套.*颜色|颜色.*外套/u);
    expect(second.question).toMatch(/休闲.*鞋子/u);
    expect(first.question).not.toBe(second.question);
    expect([first.derivedFromSeq, second.derivedFromSeq]).toEqual([1, 1]);
  });
  it('搭配短剧本补到六轮时使用不同的具体关注点', () => {
    const questions = buildQuestionSeq(qa('presale', ['这条连衣裙搭配什么外套和鞋子好看']), [6, 10]);
    const generated = questions.slice(1).map((question) => question.question);
    expect(generated).toHaveLength(5);
    expect(new Set(generated).size).toBe(5);
    expect(generated.every((question) => !/还有哪些需要注意|可以再帮我确认/u.test(question))).toBe(true);
    expect(generated.join(' ')).toMatch(/颜色.*休闲.*长度.*包包.*鞋跟/u);
  });
  it('手机配件搭配不会触发服饰搭配的补题', () => {
    const questions = buildQuestionSeq(qa('presale', ['这款手机搭配什么耳机比较好']), [3, 3]);
    expect(questions.slice(1).every((question) => !/外套|鞋子|鞋跟|包包/u.test(question.question))).toBe(true);
  });
  it('实拍和洗护的补题明确指出要询问的内容', () => {
    const photo = { seq: 1, question: '有没有买家秀或者实拍视频可以看', keyPoints: ['实拍'], stage: 'presale' as const };
    const wash = { seq: 1, question: '要不要干洗', keyPoints: ['干洗'], stage: 'presale' as const };
    expect(createMinimumRoundQuestion([photo], photo).question).toMatch(/实拍|买家秀/u);
    expect(createMinimumRoundQuestion([wash], wash).question).toMatch(/清洗|机洗|洗涤/u);
    const other = { seq: 1, question: '这款有没有现货', keyPoints: ['现货'], stage: 'presale' as const };
    expect(createMinimumRoundQuestion([other], other).question).toContain(other.question);
  });
  it('不足最低轮数时补充与原问题关联的衍生追问', () => {
    const presale = buildQuestionSeq(qa('presale', ['怎么下单？']), [6, 10]);
    const aftersale = buildQuestionSeq(qa('aftersale', ['怎么退货？']), [6, 10]);

    expect(presale).toHaveLength(6);
    expect(aftersale).toHaveLength(6);
    expect(presale[0]).toEqual(expect.objectContaining({ question: '怎么下单？', stage: 'presale', sourceType: 'core' }));
    expect(aftersale[0]).toEqual(expect.objectContaining({ question: '怎么退货？', stage: 'aftersale', sourceType: 'core' }));
    expect(presale.slice(1).every((question) => question.sourceType === 'derived')).toBe(true);
    expect(presale.slice(1).every((question) => question.derivedFromSeq === 1)).toBe(true);
  });

  it('工艺类短场景只补充工艺相关的衍生问题', () => {
    const seq = buildQuestionSeq({
      question_list: ['是包边还是锁边？', '走线整齐吗？', '有内衬吗？'],
      key_points: [['工艺', '走线'], ['包边', '锁边'], ['内衬']],
      stage: 'presale',
    }, [6, 10]);

    expect(seq).toHaveLength(6);
    expect(seq.slice(0, 3).every((q) => q.sourceType === 'core')).toBe(true);
    expect(seq.slice(3).every((q) => q.sourceType === 'derived')).toBe(true);
    expect(seq.slice(3).every((q) => /售后|清洗|打理|收到后|补发|退换/u.test(q.question))).toBe(true);
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
  it('只修正有父题来源且命中旧自动兜底话术的搭配补题', () => {
    const parentText = '这条连衣裙搭配什么外套和鞋子好看';
    const oldFirst = `关于“${parentText}”，还有哪些需要注意的呢？`;
    const oldSecond = `关于“${parentText}”，可以再帮我确认一下吗？`;
    const questions = normalizeLegacyQuestionSeq([
      { seq: 1, question: parentText, keyPoints: ['搭配'], sourceType: 'core' },
      { seq: 2, question: oldFirst, keyPoints: ['有效回应'], sourceType: 'derived', derivedFromSeq: 1,
        baseQuestion: oldFirst, conversationPlan: { topic: '搭配', priority: 'secondary', depth: 'normal', promptTemplates: [oldFirst], followUpTemplates: [], maxFollowUps: 1 } },
      { seq: 3, question: oldSecond, keyPoints: ['有效回应'], sourceType: 'derived', derivedFromSeq: 1 },
      { seq: 4, question: oldFirst, keyPoints: ['搭配'], sourceType: 'core' },
      { seq: 5, question: '可以推荐适合的外套吗？', keyPoints: ['外套'], sourceType: 'derived', derivedFromSeq: 1 },
      { seq: 6, question: oldSecond, keyPoints: ['有效回应'], sourceType: 'derived', derivedFromSeq: 99 },
      { seq: 7, question: oldSecond, keyPoints: ['有效回应'], sourceType: 'derived', derivedFromSeq: 1,
        baseQuestion: '人工指定的原问题', conversationPlan: { topic: '搭配', priority: 'secondary', depth: 'normal', promptTemplates: ['人工指定的提问'], followUpTemplates: [], maxFollowUps: 1 } },
    ]);
    expect(questions[1].question).toMatch(/颜色.*外套/u);
    expect(questions[1].baseQuestion).toBe(questions[1].question);
    expect(questions[1].conversationPlan?.promptTemplates[0]).toBe(questions[1].question);
    expect(questions[2].question).toMatch(/休闲.*鞋子/u);
    expect(questions[3].question).toBe(oldFirst);
    expect(questions[4].question).toBe('可以推荐适合的外套吗？');
    expect(questions[5].question).toBe(oldSecond);
    expect(questions[6].baseQuestion).toBe('人工指定的原问题');
    expect(questions[6].conversationPlan?.promptTemplates[0]).toBe('人工指定的提问');
  });

  it('未知主题的旧自动兜底题保留，避免替换成另一条空泛话术', () => {
    const parentText = '这款手机搭配什么耳机比较好';
    const oldFirst = `关于“${parentText}”，还有哪些需要注意的呢？`;
    const result = normalizeLegacyQuestionSeq([
      { seq: 1, question: parentText, keyPoints: ['搭配'], sourceType: 'core' },
      { seq: 2, question: oldFirst, keyPoints: ['有效回应'], sourceType: 'derived', derivedFromSeq: 1 },
    ]);
    expect(result[1].question).toBe(oldFirst);
  });

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
