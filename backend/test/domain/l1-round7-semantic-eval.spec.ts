import { evaluateWithModels } from '../../src/domain/model-reception';
import { buildFollowUpText, stripBuyerQuestionWrapper } from '../../src/domain/adaptive-push';
import { buildQuestionSeq } from '../../src/domain/question-seq';

const localConfig = { local: { url: 'http://local.test', model: 'qwen3:0.6b' } };
const partlyDeclaredMaterial = { product: { title: '棉感衬衫', attributes: [{ name: '材质', value: '其他纤维22%' }] } };
const declaredBlend = { product: { title: '棉感衬衫', attributes: [{ name: '成分', value: '65%棉，35%聚酯纤维' }] } };
const declaredFullPolyester = { product: { title: '垂感西裤', attributes: [{ name: '面料', value: '100%聚酯纤维' }] } };
const noWashProduct = { product: { title: '测试服装', attributes: [{ name: '材质', value: '其他' }] } };

describe('L1 第七轮复测语义判定黄金回归集（AT20261124-9202）', () => {
  it('能剥离全部沟通风格的追问外框，还原核心问题', () => {
    for (const style of ['friendly', 'hesitant', 'direct', 'impatient', 'silent']) {
      for (const round of [0, 1]) {
        const wrapped = buildFollowUpText(style, '含棉量多少？', round);
        expect(stripBuyerQuestionWrapper(wrapped)).toBe('含棉量多少？');
      }
    }
  });

  it('短面料剧本补题衍生自然面料/洗护问题，而非僵硬通用兜底', () => {
    const seq = buildQuestionSeq(
      { question_list: ['含棉量多少？', '是聚酯纤维吗？'], key_points: [['含棉量'], ['聚酯纤维']] },
      [3, 3],
    );
    expect(seq).toHaveLength(3);
    expect(seq[2].question).toMatch(/闷|不舒服|清洗|打理/u);
  });

  it.each([
    ['亲，我问的其实是：含棉量多少？，麻烦再看下哦～', '商品页没有写具体含棉比例，收到可以看下水洗标。', partlyDeclaredMaterial],
    ['能不能认真点？我再问最后一次：是聚酯纤维吗？', '详情页没标是否含聚酯纤维，建议收到看洗标确认。', partlyDeclaredMaterial],
    ['不好意思，我可能没说清楚～我是想问：含棉量多少？', '含棉量详情页暂未标注，您可以收到后核对成分标。', partlyDeclaredMaterial],
    ['含棉量多少呀？', '商品详情页未标注具体含棉量，需要我帮您核实吗？', partlyDeclaredMaterial],
    ['是聚酯纤维的呀？', '页面没有显示具体面料成分，收到可以看吊牌。', partlyDeclaredMaterial],
    ['是聚酯纤维吗？', '是的，100%聚酯纤维面料。', declaredFullPolyester],
  ])('面料场景自然缺项说明、追问轮次与符合商品资料的答复直接通过：%s', async (question, reply, facts) => {
    const mock = jest.fn();
    const verdict = await evaluateWithModels(
      { question, reply, history: [], goals: [], judgmentVersion: 2, facts },
      localConfig,
      mock as any,
    );
    expect(verdict).toMatchObject({ resolved: true, decisionSource: 'material-details' });
    expect(mock).not.toHaveBeenCalled();
  });

  it.each([
    ['是聚酯纤维吗？', '是的，100%聚酯纤维。', declaredBlend],
    ['含棉量多少？', '我帮您查一下含棉量。', partlyDeclaredMaterial],
    ['是聚酯纤维吗？', '详情页没有写含棉量。', partlyDeclaredMaterial],
    ['含棉量多少？', '商品页未标注含棉量吗？', partlyDeclaredMaterial],
  ])('面料场景冲突数据、纯承诺核实与答非所问不直接放行：%s %s', async (question, reply, facts) => {
    const mock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ resolved: false, reason: '模型判未通过', evidence: [] }) } }] }),
    });
    const verdict = await evaluateWithModels(
      { question, reply, history: [], goals: [], judgmentVersion: 2, facts },
      localConfig,
      mock as any,
    );
    expect(verdict.decisionSource).toBeUndefined();
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['关于“含棉量多少”，还有哪些需要注意的呢？', '建议收到后先核对水洗标成分，平时冷水轻柔手洗、深浅色分开，避免暴晒。', true],
    ['平时清洗和打理有什么要注意的吗？', '建议按洗标说明轻柔手洗，阴凉通风处晾干，避免暴晒和高温熨烫。', true],
    ['清洗这件衣服时有哪些需要注意的地方呢？', '建议轻柔手洗、不要漂白，洗后平铺阴干不易变形。', true],
    ['平时清洗和打理有什么要注意的吗？', '我帮您查一下清洗注意事项。', false],
    ['平时清洗和打理有什么要注意的吗？', '亲在的哦。', false],
    ['清洗这件衣服时有哪些需要注意的地方呢？', '直接机洗就行，很耐洗。', false],
  ])('面料/洗护注意事项衍生题本地准确判定：%s → %s', async (question, reply, expected) => {
    const mock = jest.fn();
    const verdict = await evaluateWithModels(
      { question, reply, history: [], goals: [], judgmentVersion: 2, facts: noWashProduct },
      localConfig,
      mock as any,
    );
    expect(verdict).toMatchObject({ resolved: expected, decisionSource: 'care-notice' });
    expect(mock).not.toHaveBeenCalled();
  });

  it.each([
    ['梨形身材显瘦吗？', '这款是A字高腰版型，收腰遮胯很显瘦，对梨形身材很友好哦。', true, 'fit-sizing'],
    ['那我这个身材应该怎么选尺码呢？', '建议量一下腰围和臀围，对照商品尺码表选择，喜欢宽松可以选大一码。', true, 'fit-sizing'],
    ['那我这个身材应该怎么选尺码呢？', '亲，请告诉我您的身高体重，我再帮您推荐尺码。', false, 'fit-sizing'],
    ['如果尺码不合适，可以换吗？', '支持的亲，7天无理由退换，尺码不合适可以联系客服换码。', true, 'exchange-policy'],
    ['如果尺码不合适，可以换吗？', '我先帮您查一下能不能换。', false, 'exchange-policy'],
  ])('版型与尺码场景（第6客户）本地准确判定：%s → %s', async (question, reply, expected, source) => {
    const mock = jest.fn();
    const verdict = await evaluateWithModels(
      { question, reply, history: [], goals: [], judgmentVersion: 2, facts: noWashProduct },
      localConfig,
      mock as any,
    );
    expect(verdict).toMatchObject({ resolved: expected, decisionSource: source });
    expect(mock).not.toHaveBeenCalled();
  });

  it.each([
    ['请问下单后一般多久发货呢？', '一般当天就安排发出，最晚不超过48小时。', true],
    ['发出后大概多久能收到呢？', '一般两三天就能到您手上哦。', true],
    ['发出后大概多久能收到呢？', '拍下48小时内发货。', false],
    ['请问在哪里可以查看物流进度呢？', '在订单详情页点击查看物流就可以实时跟踪进度哦。', true],
    ['请问在哪里可以查看物流进度呢？', '我帮您查一下物流。', false],
  ])('发货/到货时效与物流查询（第2/5/9/10客户）本地准确判定：%s → %s', async (question, reply, expected) => {
    const mock = jest.fn();
    const verdict = await evaluateWithModels(
      { question, reply, history: [], goals: [], judgmentVersion: 2, facts: noWashProduct },
      localConfig,
      mock as any,
    );
    expect(verdict).toMatchObject({ resolved: expected, decisionSource: 'shipping-logistics' });
    expect(mock).not.toHaveBeenCalled();
  });

  it('保留“走线整齐吗？”由本地模型判定以兼容部署预检脚本', async () => {
    const mock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ resolved: true, reason: '实质短答', evidence: ['整齐的哦'] }) } }] }),
    });
    const verdict = await evaluateWithModels(
      { question: '走线整齐吗？', reply: '整齐的哦', history: [], goals: [], judgmentVersion: 2 },
      localConfig,
      mock as any,
    );
    expect(verdict.decisionSource).toBeUndefined();
    expect(verdict.resolved).toBe(true);
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
