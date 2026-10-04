import {
  Deduction,
  ScoreMessage,
  SessionScore,
  SessionScoreInput,
  SystemParams,
  ScriptQuestion,
} from './types';
import { computeResponseRounds } from './response-rounds';

const round1 = (n: number) => Math.round(n * 10) / 10;

function containsAny(text: string, words: string[]): boolean {
  if (!text) return false;
  return words.some((w) => w && text.includes(w));
}

/**
 * 维度一：响应时效（默认 40 分）。
 *
 * 指标口径按抖店官方原文改造（见 domain/response-rounds.ts）：
 * 平均响应 = Σ轮次回复时长 ÷ 轮次总数，未回复的轮次记 600 秒；
 * 首次响应 15 分、3 分钟回复率 10 分的计分规则保持不动。
 */
function scoreResponse(
  messages: ScoreMessage[],
  questions: ScriptQuestion[],
  params: SystemParams
): { score: number; metrics: SessionScore['metrics']; deductions: Deduction[] } {
  const deductions: Deduction[] = [];
  const rounds = computeResponseRounds(messages, questions, params);
  const firstResponseSec = rounds.firstResponseSec;
  const avgResponseSec = rounds.avgResponseSec;
  const timeoutCount = rounds.timeoutCount;

  // 首次响应 15 分：≤ 上限满分，每超 10 秒扣 2 分
  let firstPart = 15;
  if (firstResponseSec !== null) {
    const over = Math.max(0, firstResponseSec - params.firstResponseLimitSec);
    firstPart = Math.max(0, 15 - 2 * Math.ceil(over / 10));
    if (over > 0) deductions.push({ dimension: 'response', reason: `首次响应 ${Math.round(firstResponseSec)} 秒，超出上限 ${params.firstResponseLimitSec} 秒`, points: 15 - firstPart });
  } else {
    deductions.push({ dimension: 'response', reason: '本次接待无客服回复记录', points: 15 });
    firstPart = 0;
  }

  // 平均响应 15 分：每超 15 秒扣 2 分
  let avgPart = 15;
  if (avgResponseSec !== null) {
    const over = Math.max(0, avgResponseSec - params.avgResponseLimitSec);
    avgPart = Math.max(0, 15 - 2 * Math.ceil(over / 15));
    if (over > 0) deductions.push({ dimension: 'response', reason: `平均响应 ${Math.round(avgResponseSec)} 秒，超出上限 ${params.avgResponseLimitSec} 秒`, points: 15 - avgPart });
  } else {
    avgPart = 0;
  }

  // 3 分钟回复率 10 分：低于下限每 5 个百分点扣 2 分
  const replyRatePct = rounds.replyRatePct;
  let ratePart = 10;
  if (replyRatePct < params.replyRateLimitPct) {
    const gap = params.replyRateLimitPct - replyRatePct;
    ratePart = Math.max(0, 10 - 2 * Math.ceil(gap / 5));
    deductions.push({ dimension: 'response', reason: `3 分钟回复率 ${round1(replyRatePct)}%，低于下限 ${params.replyRateLimitPct}%`, points: 10 - ratePart });
  }

  // 未回复的轮次按官方口径记 600 秒，单独说明一句，避免客服看不懂平均响应为什么被拉高
  const unanswered = rounds.totalRounds - rounds.answeredRounds;
  if (unanswered > 0) {
    deductions.push({
      dimension: 'response',
      reason: `${unanswered} 个轮次没有有效回复，按官方口径每轮记 600 秒（轮次总数 ${rounds.totalRounds}）`,
      points: 0,
    });
  }

  let score = firstPart + avgPart + ratePart;
  if (timeoutCount > 0) {
    const penalty = timeoutCount * params.timeoutPenalty;
    const before = score;
    score = Math.max(0, score - penalty);
    deductions.push({ dimension: 'response', reason: `超时未回复 ${timeoutCount} 次，每次扣 ${params.timeoutPenalty} 分`, points: before - score });
  }

  return {
    score: round1(score),
    metrics: {
      firstResponseSec: firstResponseSec === null ? null : Math.round(firstResponseSec),
      avgResponseSec: avgResponseSec === null ? null : Math.round(avgResponseSec),
      replyRatePct: round1(replyRatePct),
      timeoutCount,
      solvedCount: 0,
      questionCount: 0,
    },
    deductions,
  };
}

/** 维度二：问题解决率（默认 35 分）。 */
function scoreSolving(input: SessionScoreInput): { score: number; solvedCount: number; deductions: Deduction[] } {
  const { questions, messages, params } = input;
  const deductions: Deduction[] = [];
  const total = questions.length;
  if (!total) return { score: 0, solvedCount: 0, deductions };

  const perQuestion = params.weights.solving / total;
  const transferred = new Set(input.transferredQuestionSeqs || []);
  let score = 0;
  let solvedCount = 0;

  for (const q of questions) {
    if (q.needTransfer && transferred.has(q.seq)) {
      score += perQuestion;
      solvedCount += 1;
      continue;
    }
    const hits = new Set<string>();
    for (const m of messages) {
      if (m.sender !== 'agent') continue;
      if (m.questionSeq !== q.seq) continue;
      (m.hitPoints || []).forEach((h) => hits.add(h));
    }
    const required = q.keyPoints.length || 1;
    const ratio = Math.min(1, hits.size / required);
    let factor = 0;
    if (ratio >= 0.8) factor = 1;
    else if (ratio >= 0.4) factor = 0.6;
    const gained = perQuestion * factor;
    score += gained;
    if (factor === 1) solvedCount += 1;
    else {
      deductions.push({
        dimension: 'solving',
        reason: `第 ${q.seq} 轮问题要点命中 ${hits.size}/${required}（命中率 ${Math.round(ratio * 100)}%），判定为${factor === 0.6 ? '部分解决' : '未解决'}`,
        points: round1(perQuestion - gained),
        questionSeq: q.seq,
      });
    }
  }
  return { score: round1(score), solvedCount, deductions };
}

/** 维度三：话术规范（默认 15 分）。 */
function scoreWording(messages: ScoreMessage[], params: SystemParams): { score: number; deductions: Deduction[] } {
  const deductions: Deduction[] = [];
  const agentMessages = messages.filter((m) => m.sender === 'agent');
  if (!agentMessages.length) {
    return { score: 0, deductions: [{ dimension: 'wording', reason: '无客服回复，话术规范不得分', points: 15 }] };
  }

  let score = 0;
  const first = agentMessages[0].content || '';
  if (containsAny(first, params.greetingWords)) score += 3;
  else deductions.push({ dimension: 'wording', reason: '开场缺少问候语', points: 3 });

  const last = agentMessages[agentMessages.length - 1].content || '';
  if (containsAny(last, params.closingWords)) score += 3;
  else deductions.push({ dimension: 'wording', reason: '结束缺少收尾用语', points: 3 });

  const banned = agentMessages.find((m) => containsAny(m.content || '', params.forbiddenWords));
  if (banned) deductions.push({ dimension: 'wording', reason: `出现禁用词：${banned.content.slice(0, 20)}`, points: 5 });
  else score += 5;

  let repeated = false;
  let streak = 1;
  for (let i = 1; i < agentMessages.length; i += 1) {
    if ((agentMessages[i].content || '').trim() === (agentMessages[i - 1].content || '').trim() && agentMessages[i].content) {
      streak += 1;
      if (streak >= 3) repeated = true;
    } else {
      streak = 1;
    }
  }
  if (repeated) deductions.push({ dimension: 'wording', reason: '存在同一话术连续发送 3 次以上', points: 4 });
  else score += 4;

  return { score, deductions };
}

/** 维度四：情绪安抚（默认 10 分）。 */
function scoreEmotion(input: SessionScoreInput): { score: number; deductions: Deduction[] } {
  const { params } = input;
  const deductions: Deduction[] = [];
  const full = params.weights.emotion;
  if (!input.hasEmotionScenario) {
    return { score: params.emotionNeutralFullScore ? full : 0, deductions: [] };
  }
  const v = input.emotionFinal;
  let score: number;
  if (v < 30) score = full;
  else if (v < 60) score = round1(full * 0.7);
  else if (v < 80) score = round1(full * 0.4);
  else score = 0;
  if (score < full) {
    deductions.push({ dimension: 'emotion', reason: `会话结束时买家情绪值为 ${v}`, points: round1(full - score) });
  }
  return { score, deductions };
}

/** 计算单个会话的四维得分。 */
export function scoreSession(input: SessionScoreInput): SessionScore {
  const { params } = input;
  const response = scoreResponse(input.messages, input.questions, params);
  const solving = scoreSolving(input);
  const wording = scoreWording(input.messages, params);
  const emotion = scoreEmotion(input);

  const total = round1(response.score + solving.score + wording.score + emotion.score);
  return {
    responseScore: response.score,
    solvingScore: solving.score,
    wordingScore: wording.score,
    emotionScore: emotion.score,
    total,
    deductions: [...response.deductions, ...solving.deductions, ...wording.deductions, ...emotion.deductions],
    metrics: {
      ...response.metrics,
      solvedCount: solving.solvedCount,
      questionCount: input.questions.length,
    },
  };
}

/** 接待任务总分：按会话问题轮数加权平均。 */
export function scoreAttempt(
  sessions: { score: number; questionCount: number }[]
): { total: number; conclusion: 'pass' | 'fail' } {
  if (!sessions.length) return { total: 0, conclusion: 'fail' };
  const weights = sessions.map((s) => Math.max(1, s.questionCount || 1));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const total = sessions.reduce((acc, s, i) => acc + s.score * weights[i], 0) / totalWeight;
  return { total: Math.round(total * 10) / 10, conclusion: total >= 0 ? 'pass' : 'fail' };
}

export function judgeConclusion(total: number, params: SystemParams): 'pass' | 'fail' {
  return total >= params.passLine ? 'pass' : 'fail';
}
