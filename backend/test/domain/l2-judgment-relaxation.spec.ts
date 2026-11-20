/**
 * 判定放宽层回归用例（2026-11-20 业务口径调整）。
 *
 * 业务诉求：客服回复只要不是「敷衍」「等待 / 处理中」「只是复述问题并要核对」这三类，
 * 其余只要内容与客户问的问题是类似的答案，就判通过。
 *
 * 本用例守住三条底线：
 *  1. 三类硬拦截（敷衍 / 等待核对 / 复述）绝不放松；
 *  2. 语义错误类（方向错 / 自相矛盾 / 数据缺失）不放宽；
 *  3. 同话题的实质答复必须放行（这是本次放宽的目的）。
 */
import { assessAutomaticReply } from '../../src/domain/automatic-reply';
import { evaluateRelaxation } from '../../src/domain/reply-relaxation';

const assess = (reply: string, question: string, keyPoints: string[] = []) =>
  assessAutomaticReply(
    { question, keyPoints, reply, buyerText: question, buyerTexts: [question] },
    2,
  );

describe('放宽层：同话题的实质答复应通过', () => {
  it('售后类问题：给出了退换政策即通过', () => {
    const result = assess(
      '亲，收到后如果有任何质量问题，拍个照片发我，我们支持七天无理由退换，运费险也有。',
      '如果收到后发现问题，售后怎么处理呢？',
    );
    expect(result.pass).toBe(true);
    expect(result.signal).toBe('relaxed');
    expect(result.status).toBe('resolved');
  });

  it('尺码类问题：给出了尺码即通过', () => {
    const result = assess('亲，按您158/92的身材，建议穿S码哦，这款版型偏宽松。', '那我这个身材应该怎么选尺码呢？');
    expect(result.pass).toBe(true);
  });

  it('洗涤类问题：回答了洗涤方式即通过', () => {
    const result = assess('建议用30度以下冷水清洗哦，轻柔模式，反面洗更护面料。', '清洗这件衣服时，水温有什么要求呢？');
    expect(result.pass).toBe(true);
  });

  it('搭配类问题：给出了搭配建议即通过', () => {
    const result = assess('配小白鞋加一件牛仔外套就很日常哦，冷一点搭针织开衫也好看。', '这条连衣裙搭配什么外套和鞋子好看');
    expect(result.pass).toBe(true);
  });

  it('功能性服务动作（帮您改地址）通过', () => {
    const result = assess('好的亲，收货地址我这边直接帮您改，麻烦把新的详细地址发我一下就行。', '我地址填错了，能帮我改一下收货地址吗？');
    expect(result.pass).toBe(true);
  });
});

describe('放宽层底线一：三类硬拦截绝不放松', () => {
  it('敷衍：纯语气词', () => {
    expect(assess('好的呢亲', '能机洗吗').pass).toBe(false);
    expect(assess('嗯嗯', '能机洗吗').pass).toBe(false);
  });

  it('等待 / 处理中', () => {
    expect(assess('稍等一下哦', '能机洗吗').pass).toBe(false);
    expect(assess('我帮您核实一下具体的情况', '能机洗吗').pass).toBe(false);
    expect(assess('我这边帮您查一下', '能机洗吗').pass).toBe(false);
  });

  it('只复述问题并表示核对，没有实际答复', () => {
    const result = assess('能机洗吗？我这边核实一下具体情况再回复您', '能机洗吗');
    expect(result.pass).toBe(false);
    // 核对类保持原判定（hedge = 有回应但未给结论），不被放宽层改写
    expect(['perfunctory', 'hedge']).toContain(result.signal);
  });

  it('完全无关的内容不放宽', () => {
    expect(assess('亲这款裙子很好看哦，卖得特别好', '发出后多久能收到？').pass).toBe(false);
  });

  it('真正没回答的不放宽', () => {
    expect(assess('额……这个我不太清楚呢', '发出后多久能收到？').pass).toBe(false);
  });
});

describe('放宽层底线二：语义错误类不放宽', () => {
  it('发货时效不能替代到货时效（R-04 不回归）', () => {
    const result = assess('亲，现货拍下48小时内就给您发出哦，发出后会短信通知单号。', '发出后大概多久能收到呢？');
    expect(result.pass).toBe(false);
    expect(result.status).toBe('unsupported');
  });

  it('色差程度自相矛盾仍判不通过', () => {
    // 「色差特别大」命中 large，「色差基本一样」命中 small → 触发前后矛盾
    const result = assess('色差特别大哦，不过色差基本一样，颜色很接近。', '实物和详情页图片色差大吗');
    expect(result.pass).toBe(false);
    expect(result.status).toBe('unsupported');
  });

  it('只说色差小（含「基本没差别」）也判已回答', () => {
    const result = assess('实物和图片基本没差别哦，不同屏幕可能有一点点差异。', '实物和详情页图片色差大吗');
    expect(result.pass).toBe(true);
  });
});

describe('放宽层内部函数', () => {
  it('敷衍 / 等待 / 核对类一律不放宽', () => {
    expect(evaluateRelaxation('能机洗吗', '好的呢亲').relaxed).toBe(false);
    expect(evaluateRelaxation('能机洗吗', '稍等一下').relaxed).toBe(false);
    expect(evaluateRelaxation('能机洗吗', '我帮您核实一下').relaxed).toBe(false);
    expect(evaluateRelaxation('能机洗吗', '').relaxed).toBe(false);
  });

  it('同话题的实质答复放宽', () => {
    expect(evaluateRelaxation('能机洗吗', '可以机洗的亲，建议用冷水轻柔模式。').relaxed).toBe(true);
    expect(evaluateRelaxation('售后怎么处理', '支持七天无理由退换，运费险也有。').relaxed).toBe(true);
  });

  it('完全无关的话题不放宽', () => {
    expect(evaluateRelaxation('能机洗吗', '今天天气不错适合出门散步呢').relaxed).toBe(false);
  });
});
