import { assessAutomaticReply } from '../../src/domain/automatic-reply';
const assess = (question: string, reply: string) => assessAutomaticReply({ question, reply, keyPoints: [], buyerText: question }, 2);

describe('自动问答的意图与证据判断', () => {
  it('只在商品缺少对应资料时，将明确说明缺失作为有效答复', () => {
    const ctx = { question: '含棉量多少', reply: '商品详情未单独标注含棉量，可帮您确认', keyPoints: [], buyerText: '含棉量多少' };
    expect(assessAutomaticReply({ ...ctx, productMaterialDetails: '其他22%' }, 2).acceptedGuidance).toBe(true);
    expect(assessAutomaticReply({ ...ctx, productMaterialDetails: '棉100%' }, 2).acceptedGuidance).toBeUndefined();
    expect(assessAutomaticReply({ ...ctx, reply: '我核实一下', productMaterialDetails: '其他22%' }, 2).pass).toBe(false);
    expect(assess('适合搭配什么颜色的外套', '米色、卡其色、浅灰都很搭哦').pass).toBe(true);
    expect(assess('适合搭配什么颜色的外套', '我先核实一下').pass).toBe(false);
  });

  it.each([
    ['如果想穿得休闲一些，鞋子可以怎么搭配呢？', '鞋子配乐福鞋、尖头平底鞋或短靴都很搭。', true],
    ['在哪里可以查看物流进度呢？', '发货后会有物流单号，随时可以查进度。', true],
    ['在哪里可以查看物流进度呢？', '发货后会有物流单号，但无法查询进度。', false],
  ])('L1 补充报告：%s → %s', (question, reply, pass) => {
    expect(assess(question, reply).pass).toBe(pass);
  });

  it.each([
    ['走线整齐吗？', '走线是整齐的哈', true],
    ['走线整齐吗？', '整齐的哦', true],
    ['走线整齐吗？', '整齐的亲亲', true],
    ['走线整齐吗？', '是整齐的呢', true],
    ['走线整齐吗？', '您不用担心，整齐的哈', true],
    ['走线整齐吗？', '您好亲亲 这款商品是整齐的呢', true],
    ['走线整齐吗？', '出厂前都有质检 整齐的', true],
    ['走线整齐吗？', '质量请您放心，出厂前都有质检', false],
    ['质量有保障吗？', '亲，质量请您放心哈，我们所有商品出厂前都经过严格质检的。', true],
    ['发货后多久可以收到？', '亲，中小件商品发货后同城的一般隔天可以收到，省外的一般2-4天左右。', true],
    ['发货后多久可以收到？', '亲，48小时内发货。', false],
    ['色差大吗？', '亲，图片光线和屏幕可能产生细微色差，我们家支持7天无理由的。', true],
  ])('报告证据回归：%s → %s', (question, reply, pass) => {
    const actual = assess(question, reply);
    expect(actual.pass).toBe(pass);
    expect(assess(question, reply)).toEqual(actual);
  });

  it('商品未标注聚酯成分时接受如实说明', () => {
    const ctx = { question: '是聚酯纤维吗？', reply: '商品页未明确标注成分，请以洗水标为准。', keyPoints: [], buyerText: '是聚酯纤维吗？' };
    expect(assessAutomaticReply({ ...ctx, productMaterialDetails: '其他22%' }, 2).acceptedGuidance).toBe(true);
    expect(assessAutomaticReply({ ...ctx, productMaterialDetails: '聚酯纤维100%' }, 2).acceptedGuidance).toBeUndefined();
  });

  it.each([
    ['如果想穿得休闲一些，鞋子可以怎么搭配呢？', '浅色帆布鞋就很合适。', true],
    ['买家秀或者实拍视频在哪里可以看？', '买家秀和实拍视频都没有。', true],
    ['有没有买家秀或者实拍视频可以看', '买家秀和实拍视频都没有。', true],
    ['实拍视频在哪里看？', '主图里有几张实拍图片。', false],
    ['挑选尺码时，需要对照尺码表上的哪些围度呢？', '量腰和胯这两个地方就行。', true],
    ['走线整齐吗？', '针脚挺均匀的。', true],
    ['如果收到后发现问题，售后怎么处理呢？', '拍张照片发给我们客服。', true],
    ['如果收到后发现问题，售后怎么处理呢？', '稍等，我帮您核实一下。', false],
  ])('R1 口语答复：%s → %s', (question, answer, pass) => {
    expect(assess(question, answer).pass).toBe(pass);
  });

  it.each([
    ['发出后多久能收到？', '如果在省内，预计两三天就能收到。', true],
    ['什么时候能发货？', '如果有现货，通常24小时内就给您发出。', true],
    ['我应该怎么选尺码？', '如果喜欢宽松一点，建议选M码。', true],
    ['发出后多久能收到？', '如果有现货，24小时内发货。', false],
    ['发出后多久能收到？', '如果在省内，不能保证两天收到。', false],
    ['发出后多久能收到？', '如果在省内，先帮您核实一下。', false],
  ])('模拟场景答复：%s → %s', (question, reply, pass) => {
    expect(assess(question, reply).pass).toBe(pass);
  });

  it.each([
    ['含棉量多少', '含棉量约70%。', '其他22%', true],
    ['是聚酯纤维吗？', '是聚酯纤维。', '', true],
    ['是什么材质？', '这款是亚麻面料。', '', true],
    ['含棉量多少', '含棉量约70%。', '棉100%', false],
    ['含棉量多少', '含棉量约70%。', undefined, false],
    ['含棉量多少', '我先核实含棉量是不是70%。', '', false],
    ['含棉量多少', '48小时发货。', '', false],
  ])('缺少材质信息时按是否作答放行：%s → %s', (question, reply, productMaterialDetails, accepted) => {
    const result = assessAutomaticReply({ question, reply, productMaterialDetails, keyPoints: [], buyerText: question }, 2);
    expect(result.acceptedGuidance === true).toBe(accepted);
  });

  it.each([
    ['含棉量多少', '详情页没有明确含棉量，我可以核对成分标签后回复您。', true],
    ['是包边还是锁边？', '资料没有明确标注，我可以核对商品缝边实拍。', true],
    ['走线整齐吗？', '现有资料无法确认，我帮您核对细节图上的缝线。', true],
    ['要不要干洗', '以衣服洗标为准，您可以查看上面的干洗符号。', true],
    ['含棉量多少', '稍等，我核实一下。', false],
    ['走线整齐吗？', '现有资料无法确认，我帮您核对发货时间。', false],
    ['什么时候发货？', '目前资料不全，我会核对商品详情页。', false],
  ])('资料不足时的通用说明：%s → %s', (question, answer, pass) => {
    expect(assess(question, answer).pass).toBe(pass);
  });

  it.each([
    ['清洗后应该怎么晾晒这件衣服呢？', '洗后轻轻压出水分，整理裙型后在阴凉通风处悬挂晾干，尽量避免暴晒和用力拧干。', true],
    ['清洗后应该怎么晾晒这件衣服呢？', '我先帮您核实洗标', false],
    ['清洗后应该怎么晾晒这件衣服呢？', '支持冷水机洗', false],
    ['清洗后应该怎么晾晒这件衣服呢？', '不建议悬挂晾干', false],
    ['发出后在哪里查看物流进度呢？', '在我的订单打开这笔订单，点击查看物流，就能看到运单号和最新运输进度。', true],
    ['发出后在哪里查看物流进度呢？', '打开订单，无法点击查看物流', false],
    ['发出后在哪里查看物流进度呢？', '打开订单，点击申请退款', false],
  ])('L2 证据回归：%s → %s', (question, answer, pass) => {
    expect(assess(question, answer).pass).toBe(pass);
  });

  it.each([
    ['要不要干洗', '不需要专门干洗，可以按洗标要求轻柔清洗', true],
    ['需不需要干洗', '需要干洗，洗标是这样要求的', true],
    ['能不能干洗', '不需要干洗', false],
    ['能不能干洗', '不能干洗，建议手洗', true],
    ['要不要干洗', '可以退货', false],
    ['如果尺码不合适，可以换吗', '可以在订单申请换货，保持商品吊牌完好', true],
    ['小了能换大一码吗', '只能换颜色，不能换尺码', true],
    ['小了能换大一码吗', '可以换颜色', false],
    ['如果尺码不合适，可以换吗', '可以查看尺码表', false],
    ['买家秀或实拍视频在哪里看', '详情页下滑看实拍，评价区选晒图；视频以实际页面为准', true],
    ['买家秀在哪里看', '在评价区选择晒图就能查看', true],
    ['实拍视频在哪里看', '在详情页查看实拍图片', false],
    ['买家秀在哪里看', '有的哦', false],
    ['有实拍视频吗', '有实拍图片', false],
    ['有实拍视频吗', '暂无实拍视频，可以先看实拍图片', true],
    ['色差大吗', '实物和图片可能有轻微色差，与光线和屏幕显示有关', true],
    ['色差大吗', '色差不大，您可以参考实拍', true],
    ['色差大吗', '可以退货', false],
    ['色差大吗', '您可以看一下图片', false],
  ])('%s → %s', (question, reply, resolved) => {
    const result = assess(question, reply);
    expect(result.pass).toBe(resolved);
    expect(result.reason).toBeTruthy();
    if (resolved) expect(result.evidence?.length).toBeGreaterThan(0);
  });

  it.each([
    ['要不要干洗', '我先核实洗标，确认后回复您'],
    ['色差大吗', '我不确定色差大不大，先帮您确认一下'],
    ['能换大一码吗', '我查一下能不能换大一码'],
  ])('待核实不凭问题词提前放行：%s', (question, reply) => {
    const result = assess(question, reply);
    expect(result.pass).toBe(false);
    expect(result.status).toBe('pending');
  });
});

it.each([
  ['要不要干洗', '不用那么麻烦，按平常洗衣方式轻柔洗就行', true],
  ['不合适可以换吗', '可以的，留好吊牌就好', true],
  ['尺码不合适能换吗', '大小不对可以给您处理，东西保持原样就好', true],
  ['买家秀在哪里看', '往评价区翻翻，选晒图就能看大家发的图', true],
  ['色差大吗', '差不多的，手机屏幕看多少会有一点区别', true],
  ['色差大吗', '稍等', false],
  ['要不要干洗', '我核实一下', false],
  ['不合适可以换吗', '我来处理', false],
  ['色差大吗', '如果色差很大，可以申请退货', false],
])('口语模糊答复仍须有实质内容：%s → %s', (question, reply, pass) => {
  expect(assess(question, reply).pass).toBe(pass);
});

it('多个独立资源只回答一部分时保留部分回答状态', () => {
  const result = assess('买家秀和实拍视频分别在哪里看', '买家秀在评价区看晒图');
  expect(result.pass).toBe(false);
  expect(result.status).toBe('partial');
  expect(result.missing).toEqual(['尚未说明视频的查看路径']);
});

it('不能把其他会话的身高体重当成本买家事实', () => {
  const ctx = { question: '梨形身材怎么选尺码', keyPoints: [], buyerText: '梨形身材怎么选尺码', reply: '亲，158厘米92斤可以参考M码' };
  expect(assessAutomaticReply({ ...ctx, buyerContext: ['我是梨形身材'] }, 2).status).toBe('unsupported');
  expect(assessAutomaticReply({ ...ctx, buyerContext: ['我158/92'] }, 2).status).not.toBe('unsupported');
});

it.each(['稍等', '核实', '我核实一下', '我先帮您核实一下', '亲，这边先帮您确认一下', '我来处理'])('无对象的处理话术不获待核实部分分：%s', (reply) => {
  const result = assess('要不要干洗', reply);
  expect(result.pass).toBe(false);
  expect(result.status).toBe('unanswered');
  expect(result.signal).toBe('perfunctory');
});

it('说明具体核实对象的回应可以待核实，但仍不是已经解决', () => {
  expect(assess('要不要干洗', '我先帮您核实洗标要求，确认后回复您').status).toBe('pending');
});

it('或选资源只否定其中一种时，另一种仍待回答', () => {
  const result = assess('买家秀或者实拍视频在哪里看', '暂时没有实拍视频');
  expect(result.pass).toBe(false);
  expect(result.status).toBe('partial');
  expect(result.missing).toContain('尚未说明买家秀的查看路径');
});

it('不同意图组成的复合问题不能只回答一半就通过', () => {
  const question = '要不要干洗，尺码不合适可以换吗？';
  expect(assess(question, '不用干洗').status).toBe('partial');
  expect(assess(question, '不用干洗，可以申请换货').pass).toBe(true);
});

it('色差问题不能用价格差不多替代回答', () => { expect(assess('色差大吗', '价格差不多的').pass).toBe(false); });

it.each([
  ['要不要干洗', '不用啊', true],
  ['能干洗吗', '可以的', true],
  ['能干洗吗', '不需要的', false],
  ['不合适可以换吗', '没问题的', true],
])('自然短答按当前问题理解：%s → %s', (question, reply, pass) => {
  expect(assess(question, reply).pass).toBe(pass);
});


it.each([
  ['有没有买家秀或者实拍视频可以看', '亲，有的，详情里能看实拍图片，买家秀也可以在评价区找晒图看；视频请以实际页面为准。', true],
  ['有没有买家秀', '买家秀可以在评价区找晒图看', true],
  ['有没有买家秀', '去评论区翻翻买家秀就能看到', true],
  ['有没有实拍视频', '实拍视频可以在详情页往下翻着看', true],
  ['有没有买家秀和实拍视频', '买家秀可以在评价区找晒图看', false],
  ['有没有买家秀或者实拍视频', '有的', false],
  ['有没有买家秀', '买家秀需要核实后才能确认', false],
  ['有没有买家秀', '如果有买家秀可以去评价区看', false],
  ['有没有买家秀', '买家秀不能在评价区看', false],
  ['有没有实拍视频', '实拍图片可以在详情页看', false],
  ['有没有买家秀', '有买家秀，但暂时没有买家秀', false],
])('线上269媒体可用性口语回归：%s → %s', (question, reply, pass) => {
  expect(assess(question, reply).pass).toBe(pass);
});

it('买家秀已答、视频未知时只保留缺失的视频信息', () => {
  const result = assess('有没有买家秀和实拍视频', '买家秀也可以在评价区找晒图看，视频请以实际页面为准');
  expect(result.status).toBe('partial');
  expect(result.evidence).toContain('买家秀也可以在评价区找晒图看');
  expect(result.missing).toEqual(['尚未说明视频是否可用']);
});

it.each([
  ['亲，有现货，拍下后通常48小时内发货，具体也看订单显示的时效。', true],
  ['亲，尽快安排发货。', false],
  ['亲，我先核实是否能在48小时内发货。', false],
  ['亲，48小时内发货，但不能保证48小时内发货。', false],
  ['亲，48小时内发货，但72小时内发货。', false],
])('单独询问发货时间时识别有效时效：%s', (reply, pass) => {
  expect(assess('那一般什么时候可以发出呢？', reply).pass).toBe(pass);
});

it('请求具体尺码时索要身材数据只算部分推进', () => {
  const result = assess('那我这个身材应该怎么选尺码呢？', '请告诉我身高体重，我再帮您参考尺码。');
  expect(result.status).toBe('partial');
  expect(result.pass).toBe(false);
  expect(assess('尺码表怎么看？', '请告诉我身高体重，我帮您对照尺码表。').intent).not.toBe('size-recommendation');
});

describe('线上 L1 271 回归', () => {
  it('到货问题按送达时效而非发货时间判断', () => {
    const q = '发出后大概多久能收到呢？';
    const delivery = assess(q, '亲，发出后一般2到4天送达，偏远地区可能久一些。');
    expect(delivery.pass).toBe(true);
    expect(delivery.intent).toBe('delivery-time');
    expect(delivery.evidence?.join('')).toContain('2到4天送达');
    const onlyShipping = assess(q, '亲，付款后通常48小时内发货。');
    expect(onlyShipping.pass).toBe(false);
    expect(onlyShipping.status).toBe('unsupported');
    const both = assess(q, '付款后48小时内发货，发出后一般2到4天送达。');
    expect(both.pass).toBe(true);
    expect(both.evidence?.join('')).toContain('2到4天送达');
    expect(both.evidence?.join('')).not.toContain('48小时内发货');
  });
  it.each(['发出后在哪里查看物流进度呢？', '请问在哪里可以查看物流进度呢？'])(
    '物流查询不因发出前缀改变主题：%s', (q) => {
      for (const reply of ['亲，在订单详情里选择查看物流，就可以看到物流进度和快递信息。', '亲，商品发出后在订单详情选择查看物流，即可看到物流进度和快递信息。']) {
        expect(assess(q, reply).pass).toBe(true);
      }
      expect(assess(q, '亲，48小时内发货。').pass).toBe(false);
    },
  );
  it('选哪个码的明确建议和注意事项分别判定', () => {
    expect(assess('梨形身材选哪个码', '亲，可以先参考M码，建议对照尺码表。').pass).toBe(true);
    expect(assess('梨形身材选哪个码', 'M码可以。').pass).toBe(true);
    expect(assess('梨形身材选哪个码', 'M码不合适。').pass).toBe(false);
    expect(assess('梨形身材选哪个码', '亲，请告诉我身高体重，我再帮您推荐尺码。').status).toBe('partial');
    expect(assess('关于“梨形身材选哪个码”，还有哪些需要注意的呢？', '选码时量一下腰围和臀围，对照商品尺码表。').pass).toBe(true);
  });
  it('复述问题说核实不算合理待核实；具体核实洗标仍获部分分', () => {
    const question = '这条连衣裙搭配什么外套和鞋子好看';
    const empty = assess(question, `亲您好，我先帮您核实${question}的具体情况，确认后再回复您。`);
    expect(empty.status).toBe('unanswered');
    expect(empty.signal).toBe('perfunctory');
    expect(assess('要不要干洗', '我先帮您核实洗标要求，确认后回复您').status).toBe('pending');
  });
});

it('泛化核实若仅复述整句补充问题，仍不获得待核实部分分', () => {
  const question = '我需要提供哪些信息，方便您核实这个问题呢？';
  const reply = '亲，我先帮您核实我需要提供哪些信息，方便您核实这个问题呢的具体情况，确认后再回复您。';
  expect(assess(question, reply).status).toBe('unanswered');
  expect(assess(question, reply).signal).toBe('perfunctory');
});

it('合并询问发货和到货时分别回答，不能只答其中一项', () => {
  const question = '什么时候发货，发出后多久能收到？';
  expect(assess(question, '付款后48小时内发货。').pass).toBe(false);
  expect(assess(question, '付款后48小时内发货，发出后2到4天送达。').pass).toBe(true);
});
it('到货问题可理解上下文中的自然短答，但不把发货时间当到货时间', () => {
  expect(assess('发出后多久能收到？', '一般2到4天左右。').pass).toBe(true);
  expect(assess('发出后多久能收到？', '预计明天可以收到。').pass).toBe(true);
  expect(assess('发出后多久能收到？', '预计明天发货。').pass).toBe(false);
  expect(assess('发出后多久能收到？', '48小时内发货。').pass).toBe(false);
});


describe('色差口语判定和误放边界', () => {
  const question = '实物和详情页图片色差大吗';
  const reply = '亲，图片光线和屏幕可能产生细微色差，一般情况是不影响日常使用的，如果您收到货后感觉不合适可以随时联系我们哈，我们家支持7天无理由的。';
  it('识别截图中“细微色差”和等价的轻微表达', () => {
    for (const word of ['细微', '轻微', '些微', '微小']) {
      const result = assess(question, reply.replace('细微', word));
      expect(result.pass).toBe(true);
      expect(result.evidence?.join('')).toContain(`${word}色差`);
    }
  });
  it('没有实质程度、仅售后承诺、待核实或无关差异不放行', () => {
    for (const text of ['亲，可能会有色差。', '亲，支持七天无理由退换。', '先帮您核实是否存在细微色差。', '尺码有细微差异。', '没有细微色差。', '不存在轻微色差。']) {
      expect(assess(question, text).pass).toBe(false);
    }
  });
  it('同一色差同时描述轻微与非常大时不直接放行', () => {
    const result = assess(question, '亲，可能有细微色差，但实物和图片颜色差异非常大。');
    expect(result.pass).toBe(false);
    expect(result.status).toBe('unsupported');
  });
  it('小色差及价格差异大的描述不构成色差矛盾', () => {
    expect(assess(question, '亲，图片可能有细微色差，价格差异很大。').pass).toBe(true);
  });
});
