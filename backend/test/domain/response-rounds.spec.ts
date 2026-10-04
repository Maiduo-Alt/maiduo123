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
});

describe('会话级平均响应（写库用）与轮次口径一致', () => {
  it('已回复轮次补齐 600 秒后再平均', () => {
    expect(weightedAvgResponseSec([20, 40], 4)).toBe(315);
  });

  it('轮次总数缺失时退化为已回复值的算术平均', () => {
    expect(weightedAvgResponseSec([20, 40], 0)).toBe(30);
  });
});
