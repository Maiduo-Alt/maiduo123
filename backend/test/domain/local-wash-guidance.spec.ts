import { evaluateWithModels, ModelReceptionInput } from '../../src/domain/model-reception';

const input: ModelReceptionInput = {
  question: '这款连衣裙可以机洗吗？',
  history: [],
  goals: [],
  judgmentVersion: 2,
  facts: { product: { title: '连衣裙', attributes: [{ name: '材质', value: '棉' }] } },
  reply: '详情页没标注，请以洗标为准，确认前建议轻柔手洗。',
};
const config = { local: { url: 'http://local.test', model: 'qwen3:0.6b' } };

it.each([
  [input.reply, true],
  ['商品页未标注洗涤方式，先轻柔手洗，暂时不要机洗。', true],
  ['没标注机洗，不过用洗衣袋就一定能机洗。', false],
  ['商品页没有明确标注是否可机洗或需干洗。稳妥起见建议轻柔手洗，或洗衣袋机洗选轻柔模式，水温30度以下。', false],
  ['详情页没明确标注是否可机洗但建议用洗衣袋机洗，确认前先轻柔手洗。', false],
])('缺洗涤资料时只放行安全建议：%s', async (reply, expected) => {
  const fetchMock = jest.fn();
  const result = await evaluateWithModels({ ...input, reply }, config, fetchMock as any);
  expect(result).toMatchObject({ resolved: expected, decisionSource: 'wash-guidance', matchedPoints: [] });
  expect(reply).toContain(result.evidence?.[0]);
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each([
  { reply: '商品页没有标注，我帮您核实一下。' },
  { question: '要不要干洗？' },
  { question: '洗标上写着不可水洗，这款可以机洗吗？', history: [] },
  { history: [{ role: 'buyer' as const, content: '洗标上写着不可水洗，这款可以机洗吗？' }] },
  { question: '可以机洗吗？\n还是应该干洗？' },
  { question: '可以机洗吗？\n大概多久发货？' },
  { question: '洗涤水温要几度？', history: [{ role: 'buyer' as const, content: '可以机洗吗？' }] },
  { facts: undefined },
  { facts: { product: { attributes: [{ name: '洗涤方式', value: '不可水洗' }] } } },
  { facts: { product: { title: '不可干洗连衣裙', attributes: [] } } },
  { goals: [{ id: 'wash', points: [{ id: 'water', label: '洗涤水温' }] }] },
])('有明确资料、没有实质建议或超出范围时仍交给模型：%j', async (patch) => {
  const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({
    choices: [{ message: { content: JSON.stringify({
      resolved: false, reason: '模型判定', matchedPoints: [], evidence: [],
    }) } }],
  }) });
  const result = await evaluateWithModels({ ...input, ...patch }, config, fetchMock as any);
  expect(result).not.toHaveProperty('decisionSource');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
