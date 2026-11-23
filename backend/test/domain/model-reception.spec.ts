import { evaluateWithModels, ModelReceptionInput } from '../../src/domain/model-reception';

const input: ModelReceptionInput = {
  question: '可以机洗吗？', goals: [{ id: 'wash', points: [{ id: 'label', label: '以洗标为准' }] }],
  history: [{ role: 'buyer', content: '可以机洗吗？' }], reply: '请以洗标为准',
};
const result = { resolved: true, reason: '已说明依据', matchedPoints: [{ goalId: 'wash', pointIds: ['label'] }], buyerReply: '好的，谢谢。' };

it('优先使用 GLM，并核验目标编号', async () => {
  const mock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(result) } }] }) });
  expect(await evaluateWithModels(input, { glmKey: 'test', deepseekKey: 'test' }, mock as any)).toMatchObject({ provider: 'glm', ...result });
  expect(mock).toHaveBeenCalledTimes(1);
});

it('GLM 失败时使用 DeepSeek，两个服务都失败时返回明确错误', async () => {
  const mock = jest.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(result) } }] }) });
  expect((await evaluateWithModels(input, { glmKey: 'test', deepseekKey: 'test' }, mock as any)).provider).toBe('deepseek');
  expect(mock.mock.calls[1][0]).toContain('api.deepseek.com');
  await expect(evaluateWithModels(input, { glmKey: 'test' }, jest.fn().mockResolvedValue({ ok: false }) as any)).rejects.toThrow('模型服务不可用');
});

it('拒绝模型编造的目标编号', async () => {
  const invalid = { ...result, matchedPoints: [{ goalId: 'unknown', pointIds: ['label'] }] };
  const mock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(invalid) } }] }) });
  await expect(evaluateWithModels(input, { glmKey: 'test' }, mock as any)).rejects.toThrow('模型服务不可用');
});

it('新版模型判定必须引用真实答复证据，缺证据时切换备用提供方', async () => {
  const modern = { ...input, judgmentVersion: 2 as const, reply: '不需要专门干洗' };
  const valid = { ...result, evidence: ['不需要专门干洗'] };
  const mock = jest.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ ...valid, evidence: ['可以机洗'] }) } }] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(valid) } }] }) });
  expect(await evaluateWithModels(modern, { glmKey: 'test', deepseekKey: 'test' }, mock as any)).toMatchObject({ provider: 'deepseek', evidence: ['不需要专门干洗'] });
});

it.each([[[]], [['不是客服原话']]])('本地模型无法引用有效片段时显示完整答复原文：%j', async (evidence) => {
  const fetchMock = jest.fn().mockResolvedValueOnce({ ok: true, json: async () => ({
    choices: [{ message: { content: JSON.stringify({ ...result, evidence }) } }],
  }) });
  const judged = await evaluateWithModels({ ...input, judgmentVersion: 2 },
    { local: { url: 'http://local.test/v1/chat/completions', model: 'qwen' } }, fetchMock as any);
  expect(judged).toMatchObject({ provider: 'local', resolved: true, evidence: [input.reply] });
  expect(judged.reason).toContain('客服整句原文');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('本地判定示例和本次会话输入保持分离', async () => {
  const current = { ...input, judgmentVersion: 2 as const, reply: '我帮您查一下。' };
  const mock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({
    choices: [{ message: { content: JSON.stringify({
      resolved: false, reason: '只承诺查询', evidence: [], matchedPoints: [],
    }) } }],
  }) });
  const verdict = await evaluateWithModels(current, { local: { url: 'http://local.test', model: 'qwen' } }, mock as any);
  const sent = JSON.parse(mock.mock.calls[0][1].body);
  const latest = sent.messages.at(-1);
  expect(latest.role).toBe('user');
  expect(JSON.parse(latest.content)).toEqual({ question: current.question, reply: current.reply, goals: current.goals });
  expect(sent.messages).toHaveLength(2);
  expect(verdict).toMatchObject({ resolved: false, evidence: [] });
});

it('本地判定使用固定采样设置，单次请求保留模型的未解决结论', async () => {
  const current = { ...input, goals: [], judgmentVersion: 2 as const, reply: '我帮您查一下。' };
  const mock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({
    choices: [{ message: { content: JSON.stringify({
      resolved: false, reason: '只承诺查询', evidence: [], matchedPoints: [],
    }) } }],
  }) });
  const verdict = await evaluateWithModels(current, { local: { url: 'http://local.test', model: 'qwen' } }, mock as any);
  expect(verdict).toMatchObject({ resolved: false, matchedPoints: [], evidence: [] });
  expect(mock).toHaveBeenCalledTimes(1);
  const sent = JSON.parse(mock.mock.calls[0][1].body);
  expect(sent).toMatchObject({ temperature: 0, seed: 42, max_tokens: 192 });
  expect(sent.messages[0].content).toContain('确认前轻柔手洗');
  expect(sent.response_format).toMatchObject({
    type: 'json_schema',
    json_schema: { schema: { required: ['resolved', 'reason', 'evidence'], additionalProperties: false } },
  });
});

it.each([[undefined], [[{ goalId: 'invented', pointIds: ['invented'] }]]])(
  '本地无目标题忽略多余目标输出：%j', async (matchedPoints) => {
    const mock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({
      choices: [{ message: { content: JSON.stringify({
        resolved: true, reason: '有实质答复', evidence: [input.reply], matchedPoints,
      }) } }],
    }) });
    const parsed = await evaluateWithModels({ ...input, goals: [], judgmentVersion: 2 },
      { local: { url: 'http://local.test', model: 'qwen' } }, mock as any);
    expect(parsed).toMatchObject({ resolved: true, matchedPoints: [], evidence: [input.reply] });
    expect(JSON.parse(mock.mock.calls[0][1].body).messages[0].content).not.toContain('matchedPoints');
  }
);

it('本地有目标的题仍拒绝未知目标', async () => {
  const mock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({
    choices: [{ message: { content: JSON.stringify({
      ...result, matchedPoints: [{ goalId: 'unknown', pointIds: ['label'] }],
    }) } }],
  }) });
  await expect(evaluateWithModels({ ...input, judgmentVersion: 2 },
    { local: { url: 'http://local.test', model: 'qwen' } }, mock as any)).rejects.toThrow('模型服务不可用');
});

it('本地 JSON 生成被截断时保留具体失败原因', async () => {
  const mock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({
    choices: [{ finish_reason: 'length', message: { content: '{"resolved":false' } }],
  }) });
  const onFailure = jest.fn();
  await expect(evaluateWithModels({ ...input, goals: [], judgmentVersion: 2 },
    { local: { url: 'http://local.test', model: 'qwen', onFailure } }, mock as any)).rejects.toThrow('模型服务不可用');
  expect(onFailure).toHaveBeenCalledWith(expect.stringContaining('达到长度上限'));
});

it.each([
  ['我帮您查一下。', true, false],
  ['整齐的哦', false, true],
])('0.5B 首判通过后独立核对空泛承诺：%s', async (reply, onlyPromise, resolved) => {
  const response = (content: object) => ({ ok: true, json: async () => ({
    choices: [{ message: { content: JSON.stringify(content) } }],
  }) });
  const mock = jest.fn().mockResolvedValueOnce(response({
    resolved: true, reason: '首判通过', evidence: [reply], matchedPoints: [],
  })).mockResolvedValueOnce(response({ onlyPromise }));
  const verdict = await evaluateWithModels({ ...input, reply, goals: [], judgmentVersion: 2 },
    { local: { url: 'http://local.test', model: 'qwen2.5:0.5b' } }, mock as any);
  expect(verdict).toMatchObject({ resolved, evidence: resolved ? [reply] : [] });
  expect(mock).toHaveBeenCalledTimes(2);
  expect(mock.mock.calls[1][1].signal).toBe(mock.mock.calls[0][1].signal);
  const review = JSON.parse(mock.mock.calls[1][1].body);
  expect(review.messages[1].content).toBe(reply);
  expect(review.messages[0].content).not.toContain('首判通过');
});

it('本地 Qwen3 关闭思考模式，使用单次结构化判定', async () => {
  const mock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({
    choices: [{ message: { content: JSON.stringify({
      resolved: true, reason: '已回答', evidence: [input.reply],
    }) } }],
  }) });
  const judged = await evaluateWithModels({ ...input, goals: [], judgmentVersion: 2 },
    { local: { url: 'http://local.test', model: 'qwen3:0.6b' } }, mock as any);
  expect(judged.resolved).toBe(true);
  expect(mock).toHaveBeenCalledTimes(1);
  expect(JSON.parse(mock.mock.calls[0][1].body)).toMatchObject({
    reasoning_effort: 'none', response_format: { type: 'json_schema' },
  });
});

it('本地 Qwen3 保留开放题首判，不再自动翻转有引文的拒答', async () => {
  const reply = '我帮您查一下';
  const mock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({
    choices: [{ message: { content: JSON.stringify({ resolved: false, reason: '仅承诺核实', evidence: [reply] }) } }],
  }) });
  const verdict = await evaluateWithModels({ ...input, question: '走线整齐吗？', reply, history: [], goals: [], judgmentVersion: 2 },
    { local: { url: 'http://local.test', model: 'qwen3:0.6b' } }, mock as any);
  expect(verdict).toMatchObject({ resolved: false, evidence: [reply] });
  expect(mock).toHaveBeenCalledTimes(1);
});

it.each([
  ['实物和详情页图片色差大吗？', '图片光线和屏幕可能产生细微色差，如果收到不合适可以联系客服。', true],
  ['实物和详情页图片色差大吗？', '这款用的是聚酯纤维，收到不合适可以联系客服。', false],
  ['实物跟主图颜色差得多吗？', '看着基本一样，手机上显示可能略深一点。', true],
  ['这件有明显色差吗？', '色差这块我帮您查一下，您先等等。', false],
  ['这件实物色差明显吗？', '看起来几乎一样，同一件在同样光线下和主图差得特别多。', false],
  ['实物和详情页图片色差大吗？', '面料跟上款基本一样。', false],
])('单一色差问题按固定规则判断：%s %s', async (question, reply, expected) => {
  const mock = jest.fn();
  const verdict = await evaluateWithModels({ question, reply, history: [], goals: [], judgmentVersion: 2 },
    { local: { url: 'http://local.test', model: 'qwen3:0.6b' } }, mock as any);
  expect(verdict).toMatchObject({ resolved: expected, decisionSource: 'color-difference' });
  expect(mock).not.toHaveBeenCalled();
});

it.each([
  ['实物和详情页图片色差大吗？', '肉眼看上去还原得挺到位。'],
  ['色差大吗？还有多久发货？', '基本一样。'],
])('未覆盖的色差表达或复合问题仍交给模型：%s', async (question, reply) => {
  const mock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({
    choices: [{ message: { content: JSON.stringify({ resolved: false, reason: '模型判定', evidence: [] }) } }],
  }) });
  const verdict = await evaluateWithModels({ question, reply, history: [], goals: [], judgmentVersion: 2 },
    { local: { url: 'http://local.test', model: 'qwen3:0.6b' } }, mock as any);
  expect(verdict.decisionSource).toBeUndefined();
  expect(mock).toHaveBeenCalledTimes(1);
});

const trainingProduct = { product: { title: '测试服装', attributes: [{ name: '材质', value: '其他' }] } };

it.each([
  ['买家秀在哪里看？', '在评价区选择晒图就能看。', 'media-location'],
  ['实拍视频在哪里看？', '商品详情页的主图轮播里可以看实拍视频。', 'media-location'],
  ['买家秀或实拍视频在哪里看？', '详情页下滑看实拍，评价区选晒图；视频以实际页面为准。', 'media-location'],
  ['是聚酯纤维吗？', '是的哈，聚酯纤维的面料。', 'material-details'],
  ['含棉量多少？', '这款用的是聚酯纤维，不含棉。', 'material-details'],
])('明确的查看路径或成分回答直接通过：%s %s', async (question, reply, decisionSource) => {
  const mock = jest.fn();
  const verdict = await evaluateWithModels({ question, reply, history: [], goals: [], judgmentVersion: 2, facts: trainingProduct },
    { local: { url: 'http://local.test', model: 'qwen3:0.6b' } }, mock as any);
  expect(verdict).toMatchObject({ resolved: true, decisionSource });
  expect(mock).not.toHaveBeenCalled();
});

it.each([
  ['要不要干洗？', '不需要专门干洗，可以按洗标要求轻柔清洗。', 'dry-clean-required'],
  ['这款需要干洗吗？', '需要干洗。', 'dry-clean-required'],
  ['如果想穿得休闲一些，鞋子可以怎么搭配呢？', '鞋子配乐福鞋、尖头平底鞋或短靴都很搭。', 'shoe-styling'],
  ['想穿得休闲点，鞋子怎么搭配？', '浅色帆布鞋就很合适。', 'shoe-styling'],
  ['想穿得休闲点，鞋子怎么搭配？', '乐福鞋、尖头平底鞋或短靴都可以。', 'shoe-styling'],
  ['休闲一点配哪种鞋呢？', '小白鞋或帆布鞋。', 'shoe-styling'],
])('正面回答干洗要求或休闲鞋搭配时直接判定：%s %s', async (question, reply, decisionSource) => {
  const mock = jest.fn();
  const verdict = await evaluateWithModels({ question, reply, history: [], goals: [], judgmentVersion: 2, facts: trainingProduct },
    { local: { url: 'http://local.test', model: 'qwen3:0.6b' } }, mock as any);
  expect(verdict).toMatchObject({ resolved: true, decisionSource });
  expect(verdict.evidence?.some((fragment) => reply.includes(fragment))).toBe(true);
  expect(mock).not.toHaveBeenCalled();
});

it.each([
  ['要不要干洗？', '可以干洗。', trainingProduct],
  ['可以干洗吗？', '不用专门干洗。', trainingProduct],
  ['要不要干洗？', '我先查一下洗标。', trainingProduct],
  ['要不要干洗？', '不需要干洗但必须干洗。', trainingProduct],
  ['要不要干洗？', '不用专门干洗。', { product: { attributes: [{ name: '洗涤说明', value: '只能干洗' }] } }],
  ['要不要干洗，还是可以机洗？', '不用干洗。', trainingProduct],
  ['休闲风格的鞋子怎么搭配？', '短款针织开衫更合适。', trainingProduct],
  ['休闲风格的鞋子怎么搭配？', '不推荐搭乐福鞋。', trainingProduct],
  ['休闲风格的鞋子怎么搭配？', '乐福鞋就不合适。', trainingProduct],
  ['休闲一点配哪种鞋呢？', '店里也有乐福鞋，今天缺货。', trainingProduct],
  ['休闲一点配哪种鞋呢？', '乐福鞋多少钱？', trainingProduct],
  ['休闲一点，外套和鞋子怎么搭配？', '鞋子建议选乐福鞋。', trainingProduct],
])('缺少结论、相互矛盾或只答部分时不直接放行：%s %s', async (question, reply, facts) => {
  const mock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({
    choices: [{ message: { content: JSON.stringify({ resolved: false, reason: '模拟模型未判通过', evidence: [] }) } }],
  }) });
  const verdict = await evaluateWithModels({ question, reply, history: [], goals: [], judgmentVersion: 2, facts },
    { local: { url: 'http://local.test', model: 'qwen3:0.6b' } }, mock as any);
  expect(verdict.decisionSource).toBeUndefined();
  expect(mock).toHaveBeenCalledTimes(1);
});

const declaredBlend = { product: { title: '棉感衬衫', attributes: [{ name: '成分', value: '65%棉，35%聚酯纤维' }] } };

it.each([
  ['这款含多少棉呢？', '大约65%。', declaredBlend],
  ['这款是聚酯纤维的吗？', '是的，含有聚酯纤维。', declaredBlend],
  ['这款含多少棉？', '详情页没有单独标注含棉量。', { product: { title: '棉感衬衫', attributes: [{ name: '面料', value: '混纺' }] } }],
  ['这款是不是涤纶？', '对的哈。', { product: { title: '棉感衬衫', attributes: [] } }],
  ['含棉量是多少？', '有55%的棉。', { product: { attributes: [{ name: '棉含量', value: '55%' }] } }],
  ['是聚酯纤维吗？', '不是哦，这款是纯棉。', { product: { attributes: [{ name: '面料', value: '纯棉' }] } }],
])('成分规则接受符合商品资料或明确说明缺项的回答：%s %s', async (question, reply, facts) => {
  const mock = jest.fn();
  const verdict = await evaluateWithModels({ question, reply, history: [], goals: [], judgmentVersion: 2, facts },
    { local: { url: 'http://local.test', model: 'qwen3:0.6b' } }, mock as any);
  expect(verdict).toMatchObject({ resolved: true, decisionSource: 'material-details' });
  expect(mock).not.toHaveBeenCalled();
});

it.each([
  ['这款含多少棉？', '差不多80%。'],
  ['这款含多少棉？', '不含棉。'],
  ['这款含多少棉？', '65%棉，不过实际是80%棉。'],
  ['这款含多少棉？', '65%棉或80%棉。'],
  ['这款透气吗，含多少棉？', '65%。'],
  ['这款含多少棉？', '详情页没有标注含棉量。'],
  ['是聚酯纤维吗？', '不是聚酯纤维。'],
  ['是聚酯纤维吗？', '是100%聚酯纤维。'],
])('与商品标注冲突的成分答复不由规则放行：%s %s', async (question, reply) => {
  const mock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({
    choices: [{ message: { content: JSON.stringify({ resolved: false, reason: '模拟模型判定', evidence: [] }) } }],
  }) });
  const verdict = await evaluateWithModels({ question, reply, history: [], goals: [], judgmentVersion: 2, facts: declaredBlend },
    { local: { url: 'http://local.test', model: 'qwen3:0.6b' } }, mock as any);
  expect(verdict.decisionSource).toBeUndefined();
  expect(mock).toHaveBeenCalledTimes(1);
});

it.each([
  ['买家秀在哪里看？', '有的哦。', trainingProduct],
  ['实拍视频在哪里看？', '主图里有几张实拍照片。', trainingProduct],
  ['实拍视频在哪里看？', '物流信息在订单详情页看。', trainingProduct],
  ['实拍视频在哪里看？', '如果有实拍视频，可以在商品详情页看视频。', trainingProduct],
  ['买家秀以及实拍视频分别在哪里看？', '买家秀在评价区找晒图。', trainingProduct],
  ['是聚酯纤维吗？', '聚酯纤维的价格更贵。', trainingProduct],
  ['是聚酯纤维吗？', '我查一下是否是聚酯纤维。', trainingProduct],
  ['是聚酯纤维吗？', '是聚酯纤维的面料。', { product: { attributes: [{ name: '面料', value: '100%棉' }] } }],
])('缺少针对性证据、复合问题或有明确材质资料时不直接放行：%s %s', async (question, reply, facts) => {
  const mock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({
    choices: [{ message: { content: JSON.stringify({ resolved: false, reason: '模型判定', evidence: [] }) } }],
  }) });
  const verdict = await evaluateWithModels({ question, reply, history: [], goals: [], judgmentVersion: 2, facts },
    { local: { url: 'http://local.test', model: 'qwen3:0.6b' } }, mock as any);
  expect(verdict).toMatchObject({ resolved: false });
  expect(verdict.decisionSource).toBeUndefined();
  expect(mock).toHaveBeenCalledTimes(1);
});
