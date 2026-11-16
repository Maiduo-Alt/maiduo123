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
