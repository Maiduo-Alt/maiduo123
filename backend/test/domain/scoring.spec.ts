import { DEFAULT_PARAMS, ScriptQuestion, ScoreMessage } from '../../src/domain/types';
import { scoreSession, scoreAttempt, judgeConclusion } from '../../src/domain/scoring';

const params = { ...DEFAULT_PARAMS };

const questions: ScriptQuestion[] = [
  { seq: 1, question: '赠品是跟商品一起发吗？', keyPoints: ['随主商品'] },
  { seq: 2, question: '大概多久能到？', keyPoints: ['时间说明'] },
];

function buildMessages(overrides: Partial<ScoreMessage>[] = []): ScoreMessage[] {
  const base: ScoreMessage[] = [
    { sender: 'buyer', content: '赠品是跟商品一起发吗？', questionSeq: 1 },
    {
      sender: 'agent',
      content: '亲您好，赠品是随主商品一起发出的哦～',
      questionSeq: 1,
      responseSec: 12,
      hitPoints: ['随主商品'],
    },
    { sender: 'buyer', content: '大概多久能到？', questionSeq: 2 },
    {
      sender: 'agent',
      content: '一般 48 小时内出库，物流 2-4 天送达，非常感谢您的咨询，祝您生活愉快～',
      questionSeq: 2,
      responseSec: 20,
      hitPoints: ['时间说明'],
    },
  ];
  return overrides.length ? (overrides as ScoreMessage[]) : base;
}

describe('评分引擎（方案 4.3）', () => {
  it('及时且完整回应时应接近满分', () => {
    const result = scoreSession({
      questions,
      messages: buildMessages(),
      emotionFinal: 10,
      hasEmotionScenario: false,
      params,
    });
    expect(result.responseScore).toBe(40);
    expect(result.solvingScore).toBe(35);
    expect(result.wordingScore).toBeGreaterThanOrEqual(11);
    expect(result.emotionScore).toBe(10);
    expect(result.total).toBeGreaterThan(90);
  });

  it('首次响应超时应按时效规则扣分', () => {
    const messages = buildMessages();
    messages[1].responseSec = 60; // 超出 30 秒上限 30 秒 → 扣 2*3=6 分
    const result = scoreSession({ questions, messages, emotionFinal: 10, hasEmotionScenario: false, params });
    expect(result.responseScore).toBeLessThan(40);
    expect(result.deductions.some((d) => d.dimension === 'response')).toBe(true);
  });

  it('每次超时未回复额外扣 3 分且维度不低于 0', () => {
    const messages = buildMessages();
    messages[3].isTimeout = true;
    messages[3].responseSec = 900;
    const result = scoreSession({ questions, messages, emotionFinal: 10, hasEmotionScenario: false, params });
    expect(result.responseScore).toBeGreaterThanOrEqual(0);
  });

  it('要点命中一半时应按部分解决计 60% 得分', () => {
    const q: ScriptQuestion[] = [{ seq: 1, question: '测试', keyPoints: ['A', 'B'] }];
    const messages: ScoreMessage[] = [
      { sender: 'buyer', content: '测试', questionSeq: 1 },
      { sender: 'agent', content: 'A 的答复', questionSeq: 1, responseSec: 10, hitPoints: ['A'] },
    ];
    const result = scoreSession({ questions: q, messages, emotionFinal: 10, hasEmotionScenario: false, params });
    expect(result.solvingScore).toBeCloseTo(35 * 0.6, 1);
  });

  it('出现禁用词应扣话术规范分', () => {
    const messages = buildMessages();
    messages[1].content = '不知道啊';
    const result = scoreSession({ questions, messages, emotionFinal: 10, hasEmotionScenario: false, params });
    expect(result.wordingScore).toBeLessThanOrEqual(10);
    expect(result.deductions.some((d) => d.dimension === 'wording')).toBe(true);
  });

  it('情绪化场景下情绪值过高应扣满情绪分', () => {
    const result = scoreSession({
      questions,
      messages: buildMessages(),
      emotionFinal: 90,
      hasEmotionScenario: true,
      params,
    });
    expect(result.emotionScore).toBe(0);
  });

  it('接待任务总分按问题轮数加权，重复内容的简单会话不应拉低总分', () => {
    const { total } = scoreAttempt([
      { score: 100, questionCount: 10 },
      { score: 50, questionCount: 2 },
    ]);
    // (100*10 + 50*2) / 12 = 91.7
    expect(total).toBeCloseTo(91.7, 1);
  });

  it('达标线判定：80 分达标', () => {
    expect(judgeConclusion(80, params)).toBe('pass');
    expect(judgeConclusion(79.9, params)).toBe('fail');
  });

  it('需转交的问题：客服点了转交即判为正确处理（方案 F1-11）', () => {
    const transferQuestions: ScriptQuestion[] = [
      { seq: 1, question: '我要投诉，让你们主管出来', keyPoints: ['主管'], needTransfer: true },
    ];
    const messages: ScoreMessage[] = [
      { sender: 'buyer', content: '我要投诉，让你们主管出来', questionSeq: 1 },
      // 一句要点都没答到，但走了「转交」
      { sender: 'agent', content: '好的，我这就帮您转接主管', questionSeq: 1, responseSec: 10, hitPoints: [] },
    ];
    const base = {
      questions: transferQuestions,
      messages,
      emotionFinal: 10,
      hasEmotionScenario: false,
      params,
    };

    // 没点转交 → 该轮不得分
    const withoutTransfer = scoreSession({ ...base, transferredQuestionSeqs: [] });
    expect(withoutTransfer.solvingScore).toBe(0);
    expect(withoutTransfer.metrics.solvedCount).toBe(0);

    // 点了转交 → 该轮按满分计入已解决
    const withTransfer = scoreSession({ ...base, transferredQuestionSeqs: [1] });
    expect(withTransfer.solvingScore).toBe(35);
    expect(withTransfer.metrics.solvedCount).toBe(1);
  });
});
