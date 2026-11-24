import { evaluateWithModels } from '../../src/domain/model-reception';

const localConfig = { local: { url: 'http://local.test', model: 'qwen3:0.6b' } };
const noWashProduct = { product: { title: '测试服装', attributes: [{ name: '材质', value: '其他' }] } };
const undeclaredCottonProduct = { product: { title: '休闲衬衫', attributes: [{ name: '材质', value: '混纺' }] } };

describe('L2 第三轮复测语义判定黄金回归集（AT20261124-1336）', () => {
  it.each([
    ['含棉量多少？', '这款含棉量约60%左右，亲肤透气。'],
    ['含棉量多少？', '含棉量60%，手感柔软舒适。'],
    ['含棉量大概多少？', '含棉量在60%左右哦。'],
    ['含棉量多少？', '这款含棉约60%。'],
  ])('含棉量具体百分比自然表达直接通过（第3客户第1轮）：%s → %s', async (question, reply) => {
    const mock = jest.fn();
    const verdict = await evaluateWithModels(
      { question, reply, history: [], goals: [], judgmentVersion: 2, facts: undeclaredCottonProduct },
      localConfig,
      mock as any,
    );
    expect(verdict).toMatchObject({ resolved: true, decisionSource: 'material-details' });
    expect(mock).not.toHaveBeenCalled();
  });

  it.each([
    ['那穿起来会不会闷或不舒服呢？', '这款面料亲肤透气，上身清爽不会闷热，穿着很舒服。', true],
    ['穿起来透气吗？', '透气性很好，轻薄柔软不扎人。', true],
    ['那穿起来会不会闷或不舒服呢？', '我帮您查一下透气性。', false],
    ['那穿起来会不会闷或不舒服呢？', '亲在的哦。', false],
  ])('穿着舒适度与透气性衍生题（第3客户第4轮）：%s → %s', async (question, reply, expected) => {
    const mock = jest.fn();
    const verdict = await evaluateWithModels(
      { question, reply, history: [], goals: [], judgmentVersion: 2, facts: noWashProduct },
      localConfig,
      mock as any,
    );
    expect(verdict).toMatchObject({ resolved: expected, decisionSource: 'comfort-breathability' });
    expect(mock).not.toHaveBeenCalled();
  });

  it.each([
    ['能机洗吗？', '不建议机洗，建议冷水轻柔手洗，收到以水洗标为准。', true],
    ['这款可以机洗吗？', '不要机洗哦，稳妥起见建议轻柔手洗。', true],
    ['能机洗吗？', '详情页没标注机洗，用洗衣袋就能机洗。', false],
  ])('未标注洗涤时的稳妥手洗建议（第2/7/9客户）：%s → %s', async (question, reply, expected) => {
    const mock = jest.fn();
    const verdict = await evaluateWithModels(
      { question, reply, history: [{ role: 'buyer', content: question }], goals: [], judgmentVersion: 2, facts: noWashProduct },
      localConfig,
      mock as any,
    );
    expect(verdict).toMatchObject({ resolved: expected, decisionSource: 'wash-guidance' });
    expect(mock).not.toHaveBeenCalled();
  });

  it.each([
    ['要不要干洗呀？', '不需要的亲，日常轻柔手洗就行。'],
    ['需要专门干洗吗？', '没必要干洗，冷水轻柔手洗即可。'],
    ['这款要干洗吗？', '不用送干洗，按水洗标正常清洗就行。'],
  ])('干洗要求自然否定表达（第7/9客户第2轮）：%s → %s', async (question, reply) => {
    const mock = jest.fn();
    const verdict = await evaluateWithModels(
      { question, reply, history: [], goals: [], judgmentVersion: 2, facts: noWashProduct },
      localConfig,
      mock as any,
    );
    expect(verdict).toMatchObject({ resolved: true, decisionSource: 'dry-clean-required' });
    expect(mock).not.toHaveBeenCalled();
  });
});
