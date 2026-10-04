import { buildQuestionSeq, mixQuestionSeq } from '../../src/domain/question-seq';
import { ORDER_AFTERSALE_QUESTIONS, PRESALE_PRODUCT_QUESTIONS } from '../../src/db/seed-content';

/** 构造一条最小的买家咨询内容。 */
const qa = (stage: 'presale' | 'aftersale', questions: string[]) => ({
  question_list: questions,
  key_points: questions.map(() => ['要点']),
  stage,
});

describe('问题序列：问题级接待阶段（客户 2026-10-03）', () => {
  it('每个问题都带上售前/售后，追问也随内容阶段', () => {
    const presale = buildQuestionSeq(qa('presale', ['怎么下单？']), [6, 10]);
    const aftersale = buildQuestionSeq(qa('aftersale', ['怎么退货？']), [6, 10]);

    expect(presale.length).toBeGreaterThanOrEqual(6);
    expect(aftersale.length).toBeGreaterThanOrEqual(6);
    expect(presale.every((q) => q.stage === 'presale')).toBe(true);
    expect(aftersale.every((q) => q.stage === 'aftersale')).toBe(true);
  });

  it('补追问时按阶段选池子：售前不出现售后追问，反之亦然', () => {
    const presale = buildQuestionSeq(qa('presale', ['怎么下单？']), [6, 10]).map((q) => q.question);
    const aftersale = buildQuestionSeq(qa('aftersale', ['怎么退货？']), [6, 10]).map((q) => q.question);

    expect(presale).toContain('我再看一下别家，你们有什么优势吗？'); // 售前追问池
    expect(presale).not.toContain('我要投诉你们！'); // 售后追问池
    expect(aftersale).toContain('我要投诉你们！');
    expect(aftersale).not.toContain('我再看一下别家，你们有什么优势吗？');
  });

  it('问题数超过上限时按上限截断，且序号连续', () => {
    const seq = buildQuestionSeq(qa('presale', ['问一？', '问二？']), [2, 2]);
    expect(seq).toHaveLength(2);
    expect(seq.map((q) => q.seq)).toEqual([1, 2]);
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
