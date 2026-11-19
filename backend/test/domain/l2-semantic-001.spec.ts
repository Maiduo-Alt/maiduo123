/**
 * BUG-L2-SEMANTIC-001 回归用例（对应《L2语义判定误判_修复建议》第四节 R-01 ~ R-10）。
 *
 * 缺陷定位：`automatic-reply.ts` 的「到货时效」证据判定只认阿拉伯数字（\d+），
 * 中文数字（两三天 / 三天左右 / 四五天）一律匹配不上，导致语义完全正确的回答被判
 * 「尚未说明到货时效」→ status = unanswered → 「第X轮尚未确认解决」扣分。
 *
 * 本用例同时守住两个方向：
 *  - 语义正确 → resolved（R-01 ~ R-06）
 *  - 敷衍 / 答非所问 / 复读 → 仍拦得住（R-07 ~ R-10）
 */
import { assessAutomaticReply } from '../../src/domain/automatic-reply';
import { judgeReply } from '../../src/domain/reply-judge';

const DELIVERY_Q = '发出后多久能收到？';

/** 按线上口径（replyJudgmentVersion = 2）判定一条回复。 */
const assess = (reply: string, question: string = DELIVERY_Q) =>
  assessAutomaticReply(
    {
      question,
      keyPoints: ['现货', '发货'],
      reply,
      buyerText: question,
      buyerTexts: [question],
    },
    2,
  );

describe('BUG-L2-SEMANTIC-001 正例：到货时效应判「已回答」', () => {
  it('R-01 原误判用例：中文数字 + 例外说明 + 依据说明', () => {
    const result = assess('一般发出后两三天就到了，偏远地区会慢一点，具体以物流为准哦～');
    expect(result.status).toBe('resolved');
    expect(result.pass).toBe(true);
    expect(result.evidence).toEqual(expect.arrayContaining(['一般发出后两三天就到了']));
  });

  it('R-02 同义族-阿拉伯数字写法（防回归）', () => {
    const result = assess('预计2-3天送达，以实际物流为准');
    expect(result.status).toBe('resolved');
    expect(result.pass).toBe(true);
  });

  it('R-03 同义族-口语：通常三天左右能收到', () => {
    const result = assess('通常三天左右能收到', '几天能到货？');
    expect(result.status).toBe('resolved');
    expect(result.pass).toBe(true);
  });

  it('覆盖中文数字的其他常见写法', () => {
    for (const reply of [
      '四五天左右能到',
      '一般两到三天送达',
      '大概要五天',
      '三天内送到',
    ]) {
      expect(assess(reply).status).toBe('resolved');
    }
  });

  it('相对日期到货承诺仍然有效', () => {
    expect(assess('明天就能送到您手上').status).toBe('resolved');
  });
});

describe('BUG-L2-SEMANTIC-001 防回归：原有判定不能被改坏', () => {
  it('R-04 只答发货时效，不能替代到货时效', () => {
    const result = assess('现货，48小时发货');
    expect(result.pass).toBe(false);
    expect(result.status).toBe('unsupported');
    expect(result.reason).toContain('发货时间不能替代到货时间');
  });

  it('R-05 版型显瘦回答不受影响', () => {
    const result = assess('A字版型，高腰收腰，梨形身材显瘦', '版型/梨形显瘦吗？');
    expect(result.pass).toBe(true);
  });

  it('R-06 尺码推荐不受影响', () => {
    const result = assess('建议L码，版型偏宽松', '我158/92穿什么码？');
    expect(result.pass).toBe(true);
  });
});

describe('BUG-L2-SEMANTIC-001 负例：放宽后仍要拦得住', () => {
  it('R-07 真没回答：不含量词也不含依据', () => {
    const result = assess('额……这个我不太清楚呢');
    expect(result.pass).toBe(false);
    expect(result.status).toBe('unanswered');
  });

  it('R-08 纯语气词：不通过（当前落 off-topic，见遗留项）', () => {
    const judge = judgeReply({
      question: DELIVERY_Q,
      keyPoints: ['现货', '发货'],
      reply: '好的呢亲～',
      buyerText: DELIVERY_Q,
    });
    expect(judge.pass).toBe(false);
    // 修复建议期望 signal = 'perfunctory'，但 PERFUNCTORY_PHRASES 里只有「好的亲」「好的好的」，
    // 没有「好的呢亲」，因此被判为答非所问。两者都不通过，拦截效果等价。
    // 是否把「好的呢亲」补进敷衍词表属于独立的判定口径调整，需产品/测试确认后单独改。
    expect(judge.signal).toBe('off-topic');
  });

  it('R-09 答非所问：夸商品但不答时效', () => {
    const result = assess('亲这款裙子很好看哦，卖得特别好');
    expect(result.pass).toBe(false);
  });

  it('R-10 复读：同一句连发判无效', () => {
    const judge = judgeReply({
      question: DELIVERY_Q,
      keyPoints: ['现货', '发货'],
      reply: '48小时发货',
      buyerText: DELIVERY_Q,
      prevAgentText: '48小时发货',
    });
    expect(judge.pass).toBe(false);
    expect(judge.signal).toBe('perfunctory');
  });

  it('否认式时效（不保证/不一定）不算给出结论', () => {
    const result = assess('两三天到，但不保证哦');
    expect(result.pass).toBe(false);
  });

  it('序数词不会被误当成时长', () => {
    // 「第一」「第三」后不接时间单位，不应命中
    const result = assess('这是第一批货，第三个问题稍后回复');
    expect(result.pass).toBe(false);
  });

  it('非到货时效的提问不启用这套证据判定', () => {
    const result = assess('两三天就到了', '这款是纯棉的吗？');
    expect(result.pass).toBe(false);
  });
});
