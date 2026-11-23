import { DEFAULT_PARAMS, ScoreMessage, ScriptQuestion } from '../../src/domain/types';
import { judgeValidReplies, resolveValidityParams } from '../../src/domain/reply-validity';

const questions: ScriptQuestion[] = [1, 2, 3, 4].map((seq) => ({ seq, question: `第 ${seq} 问`, keyPoints: ['要点'] }));

const on = (patch: Partial<typeof DEFAULT_PARAMS> = {}) => ({
  ...DEFAULT_PARAMS,
  invalidReplyEnabled: true,
  ...patch,
});

const buyer = (seq: number): ScoreMessage => ({ sender: 'buyer', content: `第 ${seq} 问`, questionSeq: seq });
const agent = (seq: number, content: string, hitPoints: string[] = ['要点']): ScoreMessage => ({
  sender: 'agent',
  content,
  questionSeq: seq,
  hitPoints,
});

const roundOf = (result: ReturnType<typeof judgeValidReplies>, seq: number) => result.find((r) => r.seq === seq)!;

describe('无效 / 敷衍回复判定（客户新增需求 C6）', () => {
  it('有效模板允许在新买家消息后复用，同一次买家消息下的连发仍判无效', () => {
    const reply: ScoreMessage = { ...agent(1, '亲，鞋子配乐福鞋或短靴都很搭', []), judgeSignal: 'key-point' };
    const repeated = [buyer(1), reply, buyer(1), reply, reply];
    const params = on({ replyJudgmentVersion: 2, invalidReplyDuplicateMode: 'identical', banalWords: ['亲'] });
    expect(roundOf(judgeValidReplies(repeated, questions, params), 1).invalidReplyIndexes).toEqual([4]);
    const hollow: ScoreMessage = { ...reply, content: '亲，我帮您确认一下', judgeSignal: 'hedge' };
    expect(roundOf(judgeValidReplies([buyer(1), hollow, buyer(1), hollow], questions, params), 1).invalidReplyIndexes).toEqual([1, 3]);
  });

  it('自动判断命中可重置未解决计数，未提问的轮次不累计', () => {
    const auto = [1, 2, 3, 4].map((seq) => ({ seq, question: `第 ${seq} 问`, keyPoints: [], automaticEvaluation: true }));
    const params = on({ replyJudgmentVersion: 1, invalidReplyUnresolvedEnabled: true, invalidReplyUnresolvedStreak: 2 });
    const messages: ScoreMessage[] = [buyer(1), { ...agent(1, '已答', []), judgeSignal: 'key-point' }, buyer(3), { ...agent(3, '另一条合理答复', []), judgeSignal: 'stance' }];
    expect(roundOf(judgeValidReplies(messages, auto, params), 3).invalidReplyIndexes).toEqual([]);
    const unanswered: ScoreMessage[] = [buyer(1), agent(1, '未答一', []), buyer(3), agent(3, '未答二', [])];
    expect(roundOf(judgeValidReplies(unanswered, auto, params), 3).invalidReplyIndexes).toEqual([3]);
  });
  it('总开关关闭时一律视为有效（改造前行为不变）', () => {
    const messages = [buyer(1), agent(1, '亲，您好'), agent(1, '亲，您好'), agent(1, '亲，您好')];
    const result = judgeValidReplies(messages, questions, DEFAULT_PARAMS);
    expect(roundOf(result, 1).invalidReplyIndexes).toHaveLength(0);
    expect(roundOf(result, 1).validReplyIndex).toBe(1);
  });

  it('语义轮次按语义结论统计，收尾不参与旧的判零与重复校验', () => {
    const params = on({ invalidReplyUnresolvedEnabled: true, invalidReplyUnresolvedStreak: 3, banalWords: ['祝购物愉快'] });
    const closing: ScoreMessage = { ...agent(3, '感谢咨询，祝购物愉快', []), judgeSignal: 'closing' };
    const semantic: ScoreMessage[] = [1, 2, 3].map((seq) => ({
      ...agent(seq, `本轮答复 ${seq}`, []), semanticOnly: true, judgeSignal: seq === 2 ? 'key-point' : 'hedge',
    }));
    const result = judgeValidReplies([...semantic, closing], questions, params);
    expect(roundOf(result, 3)).toMatchObject({ validReplyIndex: 2, invalidReplyIndexes: [] });
  });

  it('「完全相同」模式：与上一条客服回复一模一样即判无效', () => {
    const messages = [buyer(1), agent(1, '亲，您好'), agent(1, '亲，您好')];
    const result = judgeValidReplies(messages, questions, on({ invalidReplyDuplicateMode: 'identical' }));
    expect(roundOf(result, 1).invalidReplyIndexes).toEqual([2]);
    expect(roundOf(result, 1).reasons[0].reason).toContain('完全相同');
    expect(roundOf(result, 1).validReplyIndex).toBe(1);
  });

  it('「连续 N 次」模式：连续 3 次相同才判无效，前两条仍算有效', () => {
    const messages = [buyer(1), agent(1, '稍等'), agent(1, '稍等'), agent(1, '稍等')];
    const result = judgeValidReplies(
      messages,
      questions,
      on({ invalidReplyDuplicateMode: 'streak', invalidReplyDuplicateStreak: 3 })
    );
    expect(roundOf(result, 1).invalidReplyIndexes).toEqual([3]);
    expect(roundOf(result, 1).reasons[0].reason).toContain('连续发送 3 次');
  });

  it('自定义敷衍词表命中即无效，且与禁用词库分离', () => {
    const messages = [buyer(1), agent(1, '不知道呢')];
    const params = on({ banalWords: ['不知道'] });
    expect(roundOf(judgeValidReplies(messages, questions, params), 1).invalidReplyIndexes).toEqual([1]);
    // 未配置词表时不判（forbiddenWords 里同样有「不知道」，但那是话术扣分口径，不参与无效判定）
    expect(roundOf(judgeValidReplies(messages, questions, on()), 1).invalidReplyIndexes).toEqual([]);
  });

  it('连续 N 轮命中要点为 0：达到阈值的那一轮判无效（近似官方第 3 条）', () => {
    const params = on({ invalidReplyUnresolvedEnabled: true, invalidReplyUnresolvedStreak: 2 });
    const messages = [
      buyer(1),
      agent(1, '随便说点什么', []),
      buyer(2),
      agent(2, '还是没答到点上', []),
    ];
    const result = judgeValidReplies(messages, questions, params);
    expect(roundOf(result, 1).invalidReplyIndexes).toEqual([]);
    expect(roundOf(result, 2).invalidReplyIndexes).toEqual([3]);
    expect(roundOf(result, 2).reasons[0].reason).toContain('近似官方');
  });

  it('首条被判无效后，该轮的有效回复下标指向后面那条（回退口径的基础）', () => {
    const messages = [buyer(1), agent(1, '不知道'), agent(1, '不知道'), agent(1, '您好，您的订单我马上帮您查一下')];
    const result = judgeValidReplies(messages, questions, on({ banalWords: ['不知道'] }));
    expect(roundOf(result, 1).validReplyIndex).toBe(3);
    expect(roundOf(result, 1).invalidReplyIndexes).toEqual([1, 2]);
  });

  it('规则参数会做范围兜底（连续次数 2～10）', () => {
    expect(resolveValidityParams(on({ invalidReplyDuplicateStreak: 99 })).duplicateStreak).toBe(10);
    expect(resolveValidityParams(on({ invalidReplyDuplicateStreak: 1 })).duplicateStreak).toBe(2);
    // 没配（0 / null）时回落到默认 3
    expect(resolveValidityParams(on({ invalidReplyDuplicateStreak: 0 })).duplicateStreak).toBe(3);
  });
});
