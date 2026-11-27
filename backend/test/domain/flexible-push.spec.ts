import { stripBuyerQuestionWrapper } from '../../src/domain/adaptive-push';
import {
  buildContextFollowUpQuestion,
  buildFlexibleBuyerMessages,
  buildWaitingNudge,
  computeFlexiblePushDelayMs,
  findProactivelyAnsweredSeqs,
  shuffleFlexibleQuestions,
} from '../../src/domain/flexible-push';
import { ScriptQuestion } from '../../src/domain/types';

describe('flexible-push', () => {
  it('shuffles independent questions while preserving dependent slots and derivedFromSeq pointers', () => {
    const questions: ScriptQuestion[] = [
      { seq: 1, question: '面料是什么？', keyPoints: [], sourceType: 'core' },
      { seq: 2, question: '会缩水吗？', keyPoints: [], sourceType: 'core' },
      { seq: 3, question: '什么时候发货？', keyPoints: [], sourceType: 'core' },
      { seq: 4, question: '尺码偏大吗？', keyPoints: [], sourceType: 'core' },
      { seq: 5, question: '需要转人工核实', keyPoints: [], sourceType: 'core', needTransfer: true },
    ];

    const shuffled = shuffleFlexibleQuestions(questions, 20261127);
    expect(shuffled.map((q) => q.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(shuffled[4].question).toBe('需要转人工核实');
    expect(shuffled.map((q) => q.question).sort()).toEqual(questions.map((q) => q.question).sort());
  });

  it('strips all flexible prefixes and suffixes back to the core question for judgment accuracy', () => {
    const core = '实物和详情页图片色差大吗？';
    const styles = ['friendly', 'hesitant', 'direct', 'impatient', 'silent'];
    for (const style of styles) {
      for (let seed = 1; seed <= 20; seed += 1) {
        for (const transition of [false, true]) {
          const { primary } = buildFlexibleBuyerMessages(core, style, transition, seed * 13, true);
          const stripped = stripBuyerQuestionWrapper(primary).replace(/[？?]$/u, '');
          expect(stripped).toBe(core.replace(/[？?]$/u, ''));
        }
      }
    }
  });

  it('paces impatient buyers faster than hesitant buyers within bounded range', () => {
    let impatientSum = 0;
    let hesitantSum = 0;
    for (let i = 1; i <= 20; i += 1) {
      const imp = computeFlexiblePushDelayMs([3, 7], 'impatient', i * 17);
      const hes = computeFlexiblePushDelayMs([3, 7], 'hesitant', i * 17);
      expect(imp >= 1200 && imp <= 12000).toBe(true);
      expect(hes >= 1200 && hes <= 12000).toBe(true);
      impatientSum += imp;
      hesitantSum += hes;
    }
    expect(impatientSum).toBeLessThan(hesitantSum);
  });

  it('detects proactively answered upcoming questions without skipping transfer questions', () => {
    const questions: ScriptQuestion[] = [
      { seq: 1, question: '面料是什么？', keyPoints: [] },
      { seq: 2, question: '支持七天无理由退货吗？', keyPoints: [] },
      { seq: 3, question: '尺码偏大吗？', keyPoints: [] },
      { seq: 4, question: '需要转接专员处理退货', keyPoints: [], needTransfer: true },
    ];
    const skipped = findProactivelyAnsweredSeqs(questions, 1, [], [
      '亲，这款是棉混纺面料，标准正码不偏大不偏小，支持7天无理由退换且有运费险哦。',
    ]);
    expect(skipped).toEqual([2, 3]);
  });

  it('skips redundant polyester question when agent already answered polyester and follows up contextually', () => {
    const questions: ScriptQuestion[] = [
      { seq: 1, question: '含棉量多少', keyPoints: [], automaticEvaluation: true },
      { seq: 2, question: '是聚酯纤维吗', keyPoints: [], automaticEvaluation: true },
      { seq: 3, question: '什么时候发货', keyPoints: [], automaticEvaluation: true },
    ];
    const replies = ['这款是聚酯纤维的不含棉哈'];
    const skipped = findProactivelyAnsweredSeqs(questions, 1, [], replies, {
      product: { title: '测试服装', attributes: [{ name: '材质', value: '其他' }] },
    });
    expect(skipped).toEqual([2]);

    const followUp = buildContextFollowUpQuestion(questions, replies, replies[0], questions[0], {
      product: { title: '测试服装', attributes: [{ name: '材质', value: '其他' }] },
    });
    expect(followUp?.question).toBe('聚酯纤维的话，穿起来会不会闷或不舒服呢？');

    const repliesWithBreathability = ['这款是聚酯纤维的不含棉，但面料亲肤透气不会闷热哦'];
    const nextFollowUp = buildContextFollowUpQuestion(
      questions,
      repliesWithBreathability,
      repliesWithBreathability[0],
      questions[0],
      { product: { title: '测试服装', attributes: [{ name: '材质', value: '其他' }] } },
    );
    expect(nextFollowUp?.question).toBe('聚酯纤维平时清洗和打理有什么要注意的吗？');
  });

  it('skips false-premise conditional questions and adapts contextually across all question-bank categories', () => {
    // 1. 赠品随主商品一起发 → 自动跳过「如果分开发，什么时候能到？」并顺着追问退货赠品规则
    const giftQuestions: ScriptQuestion[] = [
      { seq: 1, question: '赠品是跟商品一起发吗？', keyPoints: [], automaticEvaluation: true },
      { seq: 2, question: '如果分开发，什么时候能到？', keyPoints: [], automaticEvaluation: true },
    ];
    expect(findProactivelyAnsweredSeqs(giftQuestions, 1, [], ['赠品随主商品一起发出哦'])).toEqual([2]);
    expect(buildContextFollowUpQuestion(giftQuestions, ['赠品随主商品一起发出哦'], '赠品随主商品一起发出哦', giftQuestions[0])?.question)
      .toBe('如果后面主商品要退货的话，赠品需要一起退回吗？');

    // 2. 有现货 → 自动跳过「缺货的话什么时候补货？」并顺着追问发货时效
    const stockQuestions: ScriptQuestion[] = [
      { seq: 1, question: '这个现在还有货吗？', keyPoints: [], automaticEvaluation: true },
      { seq: 2, question: '缺货的话什么时候补货？', keyPoints: [], automaticEvaluation: true },
    ];
    expect(findProactivelyAnsweredSeqs(stockQuestions, 1, [], ['目前有现货充足，拍下就能发'])).toEqual([2]);
    expect(buildContextFollowUpQuestion(stockQuestions, ['目前有现货充足，拍下就能发'], '目前有现货充足，拍下就能发', stockQuestions[0])?.question)
      .toBe('那现在拍的话一般多久能发货呢？');

    // 3. 发票 / 优惠券 / 正品 / 售后
    const invoiceQuestions: ScriptQuestion[] = [
      { seq: 1, question: '可以开发票吗？', keyPoints: [], automaticEvaluation: true },
      { seq: 2, question: '怎么开发票？', keyPoints: [], automaticEvaluation: true },
    ];
    expect(findProactivelyAnsweredSeqs(invoiceQuestions, 1, [], ['支持开电子发票，在订单详情页申请开票即可'])).toEqual([2]);
    expect(buildContextFollowUpQuestion(invoiceQuestions, ['支持开电子发票，在订单详情页申请开票即可'], '支持开电子发票，在订单详情页申请开票即可', invoiceQuestions[0])?.question)
      .toBe('申请开票后一般多久能拿到发票呢？');

    const couponQuestions: ScriptQuestion[] = [
      { seq: 1, question: '优惠券有使用门槛吗？', keyPoints: [], automaticEvaluation: true },
      { seq: 2, question: '能和店铺活动叠加使用吗？', keyPoints: [], automaticEvaluation: true },
    ];
    expect(findProactivelyAnsweredSeqs(couponQuestions, 1, [], ['满199减20，可以叠加跨店满减使用'])).toEqual([2]);
    expect(buildContextFollowUpQuestion(couponQuestions, ['满199减20，可以叠加跨店满减使用'], '满199减20，可以叠加跨店满减使用', couponQuestions[0])?.question)
      .toBe('如果刚买完降价了，支持价保补差价吗？');
  });

  it('builds non-empty waiting nudges for all styles', () => {
    for (const style of ['friendly', 'hesitant', 'direct', 'impatient', 'silent']) {
      expect(buildWaitingNudge(style, 42).length).toBeGreaterThan(0);
    }
  });
});
