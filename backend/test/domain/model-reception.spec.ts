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

it.each([
  ['详情没标注，确认前建议轻柔手洗。', ['建议轻柔手洗'], true, '建议轻柔手洗', true, 2],
  ['详情没标注，确认前建议轻柔手洗。', ['建议轻柔手洗'], true, '建议机洗', false, 2],
  ['未确认，建议手洗或用洗衣袋机洗。', ['建议手洗'], false, '', false, 2],
  ['我帮您查一下。', [], true, '我帮您查一下', false, 1],
])('本地 Qwen3 只复核有原文依据的被拒答复：%s', async (reply, evidence, safe, quote, expected, calls) => {
  const response = (value: object) => ({ ok: true, json: async () => ({
    choices: [{ message: { content: JSON.stringify(value) } }],
  }) });
  const mock = jest.fn().mockResolvedValueOnce(response({
    resolved: false, reason: '未给机洗结论', evidence,
  })).mockResolvedValueOnce(response({ safe, quote }));
  const verdict = await evaluateWithModels({ ...input, question: '可以机洗吗？', reply, goals: [], judgmentVersion: 2 },
    { local: { url: 'http://local.test', model: 'qwen3:0.6b' } }, mock as any);
  expect(verdict.resolved).toBe(expected);
  expect(mock).toHaveBeenCalledTimes(calls);
  if (calls === 2) expect(mock.mock.calls[1][1].signal).toBe(mock.mock.calls[0][1].signal);
});
