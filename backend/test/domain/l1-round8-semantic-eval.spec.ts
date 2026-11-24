import { evaluateWithModels } from '../../src/domain/model-reception';

const localConfig = { local: { url: 'http://local.test', model: 'qwen3:0.6b' } };
const noWashProduct = { product: { title: '测试服装', attributes: [{ name: '材质', value: '其他' }] } };

describe('L1 第八轮复测语义判定黄金回归集（AT20261124-9230）', () => {
  it.each([
    ['这件搭配什么外套和鞋子好看？', '外套可以搭短款西装或针织开衫，鞋子配小白鞋或乐福鞋都很百搭。', true, 'outer-shoe-styling'],
    ['亲，这件怎么搭配外套鞋子呢？', '建议配米白风衣外套，脚上搭帆布鞋或短靴很显气质。', true, 'outer-shoe-styling'],
    ['这件搭配什么外套和鞋子好看？', '我帮您查一下搭配方案。', false, 'outer-shoe-styling'],
    ['这款商品适合搭配什么颜色的外套呢？', '推荐米白色、卡其色或浅灰色外套，都很百搭显白。', true, 'outerwear-color'],
    ['这款商品适合搭配什么颜色的外套呢？', '米白、燕麦色或黑色。', true, 'outerwear-color'],
    ['这款商品适合搭配什么颜色的外套呢？', '米白色、卡其色都可以。', true, 'outerwear-color'],
    ['这款商品适合搭配什么颜色的外套呢？', '我帮您查一下什么颜色合适。', false, 'outerwear-color'],
    ['如果想穿得休闲一些，鞋子可以怎么搭配呢？', '日常穿德训鞋或小白鞋就很百搭显瘦。', true, 'shoe-styling'],
  ])('搭配建议场景（第5/9/10客户）本地准确判定：%s → %s', async (question, reply, expected, source) => {
    const mock = jest.fn();
    const verdict = await evaluateWithModels(
      { question, reply, history: [], goals: [], judgmentVersion: 2, facts: noWashProduct },
      localConfig,
      mock as any,
    );
    expect(verdict).toMatchObject({ resolved: expected, decisionSource: source });
    expect(mock).not.toHaveBeenCalled();
  });

  it('搭配外套和鞋子只答了鞋子时不直接放行', async () => {
    const mock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ resolved: false, reason: '未说明外套搭配', evidence: [] }) } }] }),
    });
    const verdict = await evaluateWithModels(
      { question: '这件搭配什么外套和鞋子？', reply: '鞋子建议选乐福鞋。', history: [], goals: [], judgmentVersion: 2, facts: noWashProduct },
      localConfig,
      mock as any,
    );
    expect(verdict.decisionSource).toBeUndefined();
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['里面是包边还是锁边？', '这款内里采用精细包边工艺处理，不易开线脱线。', true],
    ['里面是包边还是锁边？', '商品详情页暂未单独标注包边或锁边工艺，收到后可以检查细节，有做工问题联系客服处理。', true],
    ['里面是包边还是锁边？', '我帮您查一下是包边还是锁边。', false],
    ['走线整齐吗？', '这款出厂前经过严格质检，针脚细密均匀，基本没有多余线头，您可以放心。', true],
    ['如果收到后发现问题，售后怎么处理呢？', '收到有问题可以拍照联系在线客服，或在订单页面申请售后退换处理。', true],
    ['如果收到后发现问题，售后怎么处理呢？', '我帮您查一下售后政策。', false],
  ])('工艺细节场景（第3客户）本地准确判定：%s → %s', async (question, reply, expected) => {
    const mock = jest.fn();
    const verdict = await evaluateWithModels(
      { question, reply, history: [], goals: [], judgmentVersion: 2, facts: noWashProduct },
      localConfig,
      mock as any,
    );
    expect(verdict).toMatchObject({ resolved: expected, decisionSource: 'craft-aftersale' });
    expect(mock).not.toHaveBeenCalled();
  });

  it('走线整齐吗极简短答仍走本地模型以保持部署预检兼容', async () => {
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
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['有没有买家秀可以看呀？', '有的亲，在商品评价区可以看买家秀晒图哦。', true],
    ['有没有买家秀可以看呀？', '有的哦。', true],
    ['有没有买家秀可以看呀？', '这款新品刚上架，目前暂无买家秀。', true],
    ['有没有买家秀可以看呀？', '我帮您查一下有没有买家秀。', false],
  ])('买家秀可用性问题（第2客户）本地准确判定：%s → %s', async (question, reply, expected) => {
    const mock = jest.fn();
    const verdict = await evaluateWithModels(
      { question, reply, history: [], goals: [], judgmentVersion: 2, facts: noWashProduct },
      localConfig,
      mock as any,
    );
    expect(verdict).toMatchObject({ resolved: expected, decisionSource: 'media-available' });
    expect(mock).not.toHaveBeenCalled();
  });

  it.each([
    ['158/92穿什么码合适？', '158/92斤建议穿S码比较合身哦，喜欢宽松一点可以选M码。', true],
    ['M码偏大吗？', '这款是标准正码，不偏大不偏小，按平时穿的尺码拍就行。', true],
    ['M码偏大吗？', '这款版型略偏宽松，喜欢修身可以拍小一码。', true],
    ['158/92穿什么码合适？', '亲，170厘米120斤建议选L码。', false],
    ['M码偏大吗？', '我帮您查一下偏不偏大。', false],
  ])('尺码推荐与偏大偏小（第8客户）本地准确判定：%s → %s', async (question, reply, expected) => {
    const mock = jest.fn();
    const verdict = await evaluateWithModels(
      { question, reply, history: [{ role: 'buyer', content: question }], goals: [], judgmentVersion: 2, facts: noWashProduct },
      localConfig,
      mock as any,
    );
    expect(verdict).toMatchObject({ resolved: expected, decisionSource: 'fit-sizing' });
    expect(mock).not.toHaveBeenCalled();
  });
});
