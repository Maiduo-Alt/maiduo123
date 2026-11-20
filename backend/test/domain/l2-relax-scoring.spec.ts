/**
 * B-03 / B-04 回归用例（2026-11-20 继续放宽避免误判）。
 *
 * 守住两条链：
 *  1. B-04：放宽信号 'relaxed' 必须同时被计分（scoreSolving）与无效判定（judgeValidReplies）认可，
 *     否则「判定通过」与「得分扣分」不一致；
 *  2. B-03：同题内重复实质答复、以及带追问前缀的时效答复不应判敷衍/拦截，
 *     但纯语气词复读、复述买家原话、否定承诺、方向错仍要拦住。
 */
import { DEFAULT_PARAMS, ScoreMessage, ScriptQuestion } from '../../src/domain/types';
import { scoreSession } from '../../src/domain/scoring';
import { judgeValidReplies } from '../../src/domain/reply-validity';
import { isPerfunctory, JudgeContext } from '../../src/domain/reply-judge';
import { evaluateRelaxation } from '../../src/domain/reply-relaxation';

const params = { ...DEFAULT_PARAMS };

describe('B-04：放宽信号接入计分与有效性判定', () => {
  const autoQuestion: ScriptQuestion = {
    seq: 1,
    question: '一般多久能发货？',
    keyPoints: [],
    automaticEvaluation: true,
  };
  const messages: ScoreMessage[] = [
    { sender: 'buyer', content: '一般多久能发货？', questionSeq: 1 },
    {
      sender: 'agent',
      content: '亲，48小时内发货哦',
      questionSeq: 1,
      judgeSignal: 'relaxed',
      responseSec: 6,
    },
  ];
  const base = { questions: [autoQuestion], emotionFinal: 10, hasEmotionScenario: false, params };

  it('B04-1 relaxed 轮次计入 solvedCount 且计满分', () => {
    const result = scoreSession({ ...base, messages });
    expect(result.metrics.solvedCount).toBe(1);
    expect(result.solvingScore).toBe(params.weights.solving);
  });

  it('B04-2 relaxed 轮次不产生「尚未确认解决」扣分', () => {
    const result = scoreSession({ ...base, messages });
    expect(result.deductions.some((d) => d.dimension === 'solving' && d.reason.includes('尚未确认解决'))).toBe(false);
  });

  it('B04-3 relaxed 计入 hitAny，不触发连续未解决无效', () => {
    const strict = {
      ...params,
      invalidReplyEnabled: true,
      replyJudgmentVersion: 1 as const,
      invalidReplyUnresolvedEnabled: true,
      invalidReplyUnresolvedStreak: 1,
    };
    const result = judgeValidReplies(messages, [autoQuestion], strict);
    expect(result[0].invalidReplyIndexes).toEqual([]);
  });
});

describe('B-03：同题实质复读与追问不应误判', () => {
  const ctx = (reply: string, prevAgentText: string, buyerText = '那一般什么时候能发货呢？'): JudgeContext => ({
    question: buyerText,
    keyPoints: [],
    reply,
    buyerText,
    buyerTexts: [buyerText],
    prevAgentText,
  });

  it('B03-1 同题内重复「48小时内发货」实质答复不算敷衍', () => {
    expect(isPerfunctory(ctx('亲，48小时内发货哦', '亲，48小时内发货哦'))).toBe(false);
  });

  it('B03-2 同题内重复「好的呢亲」纯语气词仍判敷衍', () => {
    expect(isPerfunctory(ctx('好的呢亲', '好的呢亲'))).toBe(true);
  });

  it('B03-3 复读买家原话仍判敷衍', () => {
    const q = '那一般什么时候能发货呢？';
    expect(isPerfunctory(ctx(q, '客服的另外一句实质答复哦', q))).toBe(true);
  });

  it('B03-4 追问句 + 时长答复放宽通过', () => {
    const r = evaluateRelaxation(
      '我可能没说清楚，那一般什么时候可以发出呢？',
      '亲，一般48小时内就发货了哦',
      'shipping-time',
    );
    expect(r.relaxed).toBe(true);
    expect(r.topic).toBe('shipping');
  });

  it('B03-5 否定承诺「48小时内不能保证发货哦」仍不通过', () => {
    const r = evaluateRelaxation('一般多久能发出？', '48小时内不能保证发货哦', 'shipping-time');
    expect(r.relaxed).toBe(false);
  });

  it('守住 B-01：问到货答发货的方向错不放宽', () => {
    const r = evaluateRelaxation('大概几天能到？', '48小时内发货', 'delivery-time');
    expect(r.relaxed).toBe(false);
  });

  it('实质时效兜底：问发货答发货时长（无追问前缀）也放行', () => {
    const r = evaluateRelaxation('几天能发货？', '一般48小时内发出的哦', 'shipping-time');
    expect(r.relaxed).toBe(true);
  });
});
