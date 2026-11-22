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
  }) }).mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: '{"answered":true}' } }] }) });
  const judged = await evaluateWithModels({ ...input, judgmentVersion: 2 },
    { local: { url: 'http://local.test/v1/chat/completions', model: 'qwen' } }, fetchMock as any);
  expect(judged).toMatchObject({ provider: 'local', resolved: true, evidence: [input.reply] });
  expect(judged.reason).toContain('客服整句原文');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('本地判定仅发送系统口径和本次输入，不把示例当成历史对话', async () => {
  const current = { ...input, judgmentVersion: 2 as const, reply: '我帮您查一下。' };
  const mock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({
    choices: [{ message: { content: JSON.stringify({
      resolved: false, reason: '只承诺查询', evidence: [], matchedPoints: [],
    }) } }],
  }) });
  const verdict = await evaluateWithModels(current, { local: { url: 'http://local.test', model: 'qwen' } }, mock as any);
  const sent = JSON.parse(mock.mock.calls[0][1].body);
  expect(sent.messages.map((message: { role: string }) => message.role)).toEqual(['system', 'user']);
  expect(JSON.parse(sent.messages[1].content)).toEqual(current);
  expect(verdict).toMatchObject({ resolved: false, evidence: [] });
});

it('本地复核可以否决错误放行，且不继承首判理由', async () => {
  const current = { ...input, judgmentVersion: 2 as const, reply: '我帮您查一下。' };
  const response = (value: unknown) => ({ ok: true, json: async () => ({
    choices: [{ message: { content: JSON.stringify(value) } }],
  }) });
  const mock = jest.fn()
    .mockResolvedValueOnce(response({ ...result, reason: '错误的首判理由', evidence: [] }))
    .mockResolvedValueOnce(response({ answered: false }));
  expect(await evaluateWithModels(current, { local: { url: 'http://local.test', model: 'qwen' } }, mock as any))
    .toMatchObject({ resolved: false, matchedPoints: [], evidence: [] });
  expect(mock.mock.calls[1][1].body).not.toContain('错误的首判理由');
  expect(mock.mock.calls[1][1].signal).toBe(mock.mock.calls[0][1].signal);
});
