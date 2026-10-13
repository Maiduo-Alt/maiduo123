import { judgeReply, isYesNoQuestion, hasStance, hasCompatibleStance, isPerfunctory, isHedge } from '../../src/domain/reply-judge';

/**
 * 语义判定器（2026-10-11 客户口径）：
 *  - 符合语义（表态 / 要点 / 兜底）→ 通过；
 *  - 打太极只算“有回应但未解决”，与敷衍/答非所问一样不能直接推进。
 */
const base = { question: '胯宽能穿吗', keyPoints: ['胯宽', '遮胯', '显瘦'], buyerText: '胯宽能穿吗', prevAgentText: null };

describe('是非题识别', () => {
  it('以「吗/能不能/会不会」结尾或包含的都是是非题', () => {
    expect(isYesNoQuestion('胯宽能穿吗')).toBe(true);
    expect(isYesNoQuestion('能指定顺丰吗？')).toBe(true);
    expect(isYesNoQuestion('能不能便宜一点')).toBe(true);
    expect(isYesNoQuestion('会不会缩水')).toBe(true);
    expect(isYesNoQuestion('是不是正品')).toBe(true);
  });
  it('信息题不是是非题', () => {
    expect(isYesNoQuestion('发什么快递')).toBe(false);
    expect(isYesNoQuestion('含棉量多少')).toBe(false);
  });
});

describe('表态词检测', () => {
  it('直接表态算表态', () => {
    expect(hasStance('可以的哈')).toBe(true);
    expect(hasStance('没问题的，放心机洗')).toBe(true);
    expect(hasStance('不支持指定快递哦')).toBe(true);
  });
  it('「你/您可以」踢皮球句式不算表态', () => {
    expect(hasStance('你可以看看店铺优惠券')).toBe(false);
    expect(hasStance('您可以点详情页看一下')).toBe(false);
  });
});

describe('敷衍识别', () => {
  it('纯语气词 / 过短回复是敷衍', () => {
    expect(isPerfunctory({ ...base, reply: '亲在的' })).toBe(true);
    expect(isPerfunctory({ ...base, reply: '稍等哦' })).toBe(true);
    expect(isPerfunctory({ ...base, reply: '嗯嗯' })).toBe(true);
    expect(isPerfunctory({ ...base, reply: '。' })).toBe(true);
  });
  it('复读买家原话 / 与上一条客服回复重复是敷衍', () => {
    expect(isPerfunctory({ ...base, reply: '胯宽能穿吗？' })).toBe(true);
    expect(isPerfunctory({ ...base, reply: '可以机洗，放心', prevAgentText: '可以机洗，放心' })).toBe(true);
  });
  it('与上一道题回复相同不算敷衍（调用方只传同一 seq 内的上一条）', () => {
    // 上一题也回了「可以的哈」，本题再回一次是正常短答复，不能算复制粘贴敷衍
    expect(isPerfunctory({ ...base, reply: '可以的哈', prevAgentText: null })).toBe(false);
  });
  it('正常回复不是敷衍', () => {
    expect(isPerfunctory({ ...base, reply: '可以的哈，A 字版型很遮胯哦' })).toBe(false);
  });
});

describe('打太极放行', () => {
  it('搪塞话术算打太极', () => {
    expect(isHedge('这个要看仓库安排哦')).toBe(true);
    expect(isHedge('价格以页面为准呢')).toBe(true);
    expect(isHedge('我们尽快帮您核实')).toBe(true);
  });
});

describe('表态与问题类型兼容', () => {
  it('“会不会”问题不能用泛化“可以的”糊弄过去', () => {
    expect(hasCompatibleStance('这款会缩水吗？', '可以的哈')).toBe(false);
    expect(hasCompatibleStance('这款会缩水吗？', '一般不会的')).toBe(true);
    expect(judgeReply({ question: '这款会缩水吗？', keyPoints: ['缩水'], buyerText: '这款会缩水吗？', reply: '可以的哈' }).pass).toBe(false);
  });

  it('能力类问题仍允许自然短答', () => {
    expect(hasCompatibleStance('胯宽能穿吗？', '可以的哈')).toBe(true);
  });
});

describe('综合判定（客户口径决策表）', () => {
  it('是非题 + 极简表态 → 通过（截图案例）', () => {
    const r = judgeReply({ ...base, reply: '可以的哈' });
    expect(r).toEqual({ pass: true, signal: 'stance' });
  });
  it('表态 + 实质内容 → 通过', () => {
    const r = judgeReply({ question: '能机洗吗', keyPoints: ['洗涤', '机洗'], buyerText: '能机洗吗', reply: '没问题，放心机洗，建议套洗衣袋哦' });
    expect(r.pass).toBe(true);
  });
  it('打太极 → 已回应但未解决，不能直接推进', () => {
    const r = judgeReply({ question: '能指定顺丰吗', keyPoints: ['快递', '指定', '顺丰'], buyerText: '能指定顺丰吗', reply: '这个要看仓库那边的安排哦' });
    expect(r).toEqual({ pass: false, signal: 'hedge' });
  });
  it('踩中要点/同义词 → 通过', () => {
    const r = judgeReply({ question: '发什么快递', keyPoints: ['快递', '顺丰', '中通'], buyerText: '发什么快递', reply: '亲我们默认发中通和韵达哦' });
    expect(r).toEqual({ pass: true, signal: 'key-point' });
  });
  it('敷衍（语气词）→ 不通过', () => {
    const r = judgeReply({ ...base, reply: '亲在的，稍等' });
    expect(r).toEqual({ pass: false, signal: 'perfunctory' });
  });
  it('答非所问的实质内容 → 不通过', () => {
    const r = judgeReply({ question: '显瘦吗', keyPoints: ['显瘦', '版型'], buyerText: '显瘦吗', reply: '亲这款是今年的新款，很多顾客都在买呢' });
    expect(r).toEqual({ pass: false, signal: 'off-topic' });
  });
  it('兜底要点「有效回应」→ 任何非空回复都通过', () => {
    const r = judgeReply({ question: '随便问问', keyPoints: ['有效回应'], buyerText: '随便问问', reply: '好的呢' });
    expect(r).toEqual({ pass: true, signal: 'fallback' });
  });
  it('信息题没踩中关键词也没表态 → 不通过', () => {
    const r = judgeReply({ question: '裙长到哪个位置', keyPoints: ['裙长', '长度'], buyerText: '裙长到哪个位置', reply: '大概到小腿中间的位置哦' });
    expect(r.pass).toBe(false);
  });
  it('存在式表态：「有运费险吗→有的哈」→ 通过（2026-10-11 线上误杀案例）', () => {
    const ctx = { question: '有运费险吗', keyPoints: ['运费险', '退货运费险'], buyerText: '有运费险吗', prevAgentText: null };
    expect(judgeReply({ ...ctx, reply: '有的哈' })).toEqual({ pass: true, signal: 'stance' });
    expect(judgeReply({ ...ctx, reply: '有哦' })).toEqual({ pass: true, signal: 'stance' });
    expect(judgeReply({ ...ctx, reply: '没有哦' })).toEqual({ pass: true, signal: 'stance' });
    expect(judgeReply({ ...ctx, reply: '暂时没有呢' })).toEqual({ pass: true, signal: 'stance' });
  });
  it('存在式表态只用于是非题：信息题回「有的哈」仍不通过', () => {
    const r = judgeReply({ question: '什么时候发货', keyPoints: ['发货时间', '时效'], buyerText: '什么时候发货', reply: '有的哈' });
    expect(r.pass).toBe(false);
  });
  it('「包邮吗→包的哈」等常见变体 → 通过', () => {
    expect(judgeReply({ question: '包邮吗', keyPoints: ['运费'], buyerText: '包邮吗', reply: '包的哈' }).pass).toBe(true);
    expect(judgeReply({ question: '是不是正品', keyPoints: ['正品'], buyerText: '是不是正品', reply: '是的呢' }).pass).toBe(true);
  });
  it('保障/退换家族表态 → 通过（2026-10-11 线上案例：答买家顾虑句被判答非所问）', () => {
    // 买家同轮发「是聚酯纤维吗」+「我怕不合适，能保证吗？」，客服答 7 天无理由 = 实质表态
    const ctx = {
      question: '是聚酯纤维吗',
      keyPoints: ['聚酯', '材质', '面料'],
      buyerText: '我怕不合适，能保证吗？',
      buyerTexts: ['是聚酯纤维吗', '我怕不合适，能保证吗？'],
    };
    expect(judgeReply({ ...ctx, reply: '我们家有7天无理由的' })).toEqual({ pass: true, signal: 'stance' });
    expect(judgeReply({ ...ctx, reply: '亲，不合适支持退换的哦' }).pass).toBe(true);
  });
  it('复读本轮任意一条买家消息都是敷衍（含风格化的顾虑句）', () => {
    const ctx = {
      ...base,
      buyerText: '我怕不合适，能保证吗？',
      buyerTexts: ['胯宽能穿吗', '我怕不合适，能保证吗？'],
    };
    expect(isPerfunctory({ ...ctx, reply: '胯宽能穿吗？' })).toBe(true);
    expect(isPerfunctory({ ...ctx, reply: '我怕不合适，能保证吗？' })).toBe(true);
  });
});
