import { DEFAULT_PARAMS, ScoreMessage, ScriptQuestion } from '../../src/domain/types';
import { computeResponseRounds, UNREPLIED_SECONDS, weightedAvgResponseSec } from '../../src/domain/response-rounds';

const params = { ...DEFAULT_PARAMS };

const questions: ScriptQuestion[] = [1, 2, 3, 4].map((seq) => ({
  seq,
  question: `第 ${seq} 问`,
  keyPoints: ['要点'],
}));

const buyer = (seq: number): ScoreMessage => ({ sender: 'buyer', content: `第 ${seq} 问`, questionSeq: seq });
const reply = (seq: number, responseSec: number | null): ScoreMessage => ({
  sender: 'agent',
  content: `回复 ${seq}`,
  questionSeq: seq,
  responseSec,
});

describe('响应时长按轮次建模（抖店官方口径）', () => {
  it('首响包含开场回应，但平均时长使用正式问题的回复', () => {
    const opening = { ...reply(1, 4), openerTiming: true };
    const result = computeResponseRounds([buyer(1), opening, buyer(1), reply(1, 20)], [questions[0]], params);
    expect(result.firstResponseSec).toBe(4);
    expect(result.avgResponseSec).toBe(20);
    expect(result.answeredRounds).toBe(1);
  });

  it('未回复的轮次记 600 秒并计入分母', () => {
    const result = computeResponseRounds(
      [buyer(1), reply(1, 20), buyer(2), reply(2, 40), buyer(3), buyer(4)],
      questions,
      params
    );
    expect(result.totalRounds).toBe(4);
    expect(result.answeredRounds).toBe(2);
    // (20 + 40 + 600 + 600) / 4 = 315
    expect(result.avgResponseSec).toBe(315);
    expect(result.rounds.map((r) => r.countedSec)).toEqual([20, 40, UNREPLIED_SECONDS, UNREPLIED_SECONDS]);
  });

  it('同一轮客服连发多条只计首条（不会重复计入平均）', () => {
    // 服务端只在首条有效回复上写 responseSec，这里再等一条 null 的第二条回复
    const result = computeResponseRounds([buyer(1), reply(1, 12), reply(1, null)], [questions[0]], params);
    expect(result.totalRounds).toBe(1);
    expect(result.avgResponseSec).toBe(12);
  });

  it('首条回复无效、第二条才有有效时长时，本轮按第二条计（回退到首条有效回复）', () => {
    const result = computeResponseRounds([buyer(1), reply(1, null), reply(1, 55)], [questions[0]], params);
    expect(result.avgResponseSec).toBe(55);
    expect(result.firstResponseSec).toBe(55);
  });

  it('完全没有有效回复时平均响应为 600 秒（不是 0）', () => {
    const result = computeResponseRounds([buyer(1), reply(1, null)], [questions[0]], params);
    expect(result.answeredRounds).toBe(0);
    expect(result.avgResponseSec).toBe(UNREPLIED_SECONDS);
    expect(result.firstResponseSec).toBeNull();
  });

  it('单问题买家离场时不把未回复轮次按 600 秒计入', () => {
    const result = computeResponseRounds([buyer(1)], [questions[0]], params, [], { buyerLeftAfterSingleQuestion: true });
    expect(result.totalRounds).toBe(0);
    expect(result.avgResponseSec).toBeNull();
  });

  it('多题剧本第一题离场时不计未出现的轮次', () => {
    const result = computeResponseRounds([buyer(1)], questions, params, [], { buyerLeftAfterSingleQuestion: true });
    expect(result.totalRounds).toBe(0);
    expect(result.avgResponseSec).toBeNull();
  });

  it('正常未回复的多题会话仍按 600 秒计算', () => {
    const result = computeResponseRounds([buyer(1)], questions, params);
    expect(result.totalRounds).toBe(4);
    expect(result.avgResponseSec).toBe(600);
  });

  it('没有提问序列时退化为消息里出现过的轮次号', () => {
    const result = computeResponseRounds([buyer(1), reply(1, 30), buyer(2), reply(2, 30)], [], params);
    expect(result.totalRounds).toBe(2);
    expect(result.avgResponseSec).toBe(30);
  });

  it('首次响应仍取第一条有效回复，不受轮次补 600 秒影响', () => {
    const result = computeResponseRounds([buyer(1), reply(1, 18), buyer(2)], questions.slice(0, 2), params);
    expect(result.firstResponseSec).toBe(18);
    expect(result.avgResponseSec).toBe((18 + UNREPLIED_SECONDS) / 2);
  });

  it('提前覆盖的语义目标轮次不作为未回复轮次扣响应分', () => {
    const result = computeResponseRounds(
      [buyer(1), reply(1, 18), buyer(3), reply(3, 24)],
      questions.slice(0, 3),
      params,
      [2]
    );
    expect(result.totalRounds).toBe(2);
    expect(result.avgResponseSec).toBe(21);
  });

  it('系统超时提示和同一次迟到回复只计一次', () => {
    const result = computeResponseRounds([
      buyer(1),
      { sender: 'system', content: '等待超时', questionSeq: 1, isTimeout: true },
      { ...reply(1, 43), isTimeout: true },
    ], [questions[0]], params);
    expect(result.timeoutCount).toBe(1);
  });

  it('未回复的超时和没有系统提示的迟到回复都能计数', () => {
    const unanswered = computeResponseRounds([
      buyer(1),
      { sender: 'system', content: '等待超时', questionSeq: 1, isTimeout: true },
    ], [questions[0]], params);
    const lateReply = computeResponseRounds([buyer(1), { ...reply(1, 43), isTimeout: true }], [questions[0]], params);
    expect(unanswered.timeoutCount).toBe(1);
    expect(lateReply.timeoutCount).toBe(1);
    expect(computeResponseRounds([buyer(1), reply(1, 10)], [questions[0]], params).timeoutCount).toBe(0);
  });

  it('开场和首题共用序号时，各自超时仍分别计数', () => {
    const result = computeResponseRounds([
      buyer(1),
      { sender: 'system', content: '开场等待超时', questionSeq: 0, isTimeout: true },
      { ...reply(1, 43), openerTiming: true, isTimeout: true },
      buyer(1),
      { sender: 'system', content: '首题等待超时', questionSeq: 1, isTimeout: true },
      { ...reply(1, 45), isTimeout: true },
    ], [questions[0]], params);
    expect(result.timeoutCount).toBe(2);
  });
});

describe('会话级平均响应（写库用）与轮次口径一致', () => {
  it('已回复轮次补齐 600 秒后再平均', () => {
    expect(weightedAvgResponseSec([20, 40], 4)).toBe(315);
  });

  it('轮次总数缺失时退化为已回复值的算术平均', () => {
    expect(weightedAvgResponseSec([20, 40], 0)).toBe(30);
  });
});

describe('新版响应计时按买家问题和追问划分', () => {
  const start = (seq: number, responseRoundType: 'opener' | 'question' = 'question'): ScoreMessage => ({
    ...buyer(seq), responseRoundStart: true, responseRoundType,
  });
  const options = { responseTimingVersion: 2 };

  it('开场只计首次响应，同一问题的追问分别计入平均值', () => {
    const result = computeResponseRounds([
      start(1, 'opener'), buyer(1), { ...reply(1, 4), openerTiming: true },
      start(1), buyer(1), reply(1, 20), reply(1, null),
      start(1), reply(1, 40),
    ], [questions[0]], params, [], options);
    expect(result.firstResponseSec).toBe(4);
    expect(result.rounds).toEqual([
      { seq: 1, answered: true, countedSec: 20 },
      { seq: 1, answered: true, countedSec: 40 },
    ]);
    expect(result.avgResponseSec).toBe(30);
  });

  it('未有效回复的追问记 600 秒，连续买家消息和结束语不额外计轮次', () => {
    const result = computeResponseRounds([
      start(1), buyer(1), reply(1, 10),
      start(1), buyer(1), reply(1, null),
      { sender: 'buyer', content: '好的，谢谢', questionSeq: 1 },
    ], [questions[0]], params, [], options);
    expect(result.totalRounds).toBe(2);
    expect(result.answeredRounds).toBe(1);
    expect(result.avgResponseSec).toBe(305);
  });

  it('无效回复之后的首条有效回复计时，同一事件客服连发不重复计数', () => {
    const result = computeResponseRounds([
      start(1), reply(1, null), reply(1, 50), reply(1, 80),
    ], [questions[0]], params, [], options);
    expect(result.rounds).toEqual([{ seq: 1, answered: true, countedSec: 50 }]);
    expect(result.replyRatePct).toBe(100);
  });

  it('单问题买家离场且无回复时仍不计平均响应', () => {
    const result = computeResponseRounds([start(1)], [questions[0]], params, [], {
      ...options, buyerLeftAfterSingleQuestion: true,
    });
    expect(result.totalRounds).toBe(0);
    expect(result.avgResponseSec).toBeNull();
  });

  it('无新版选项时沿用旧轮次口径', () => {
    const result = computeResponseRounds([
      start(1), reply(1, 20), start(1), reply(1, 40),
    ], [questions[0]], params);
    expect(result.totalRounds).toBe(1);
    expect(result.avgResponseSec).toBe(20);
  });
});
