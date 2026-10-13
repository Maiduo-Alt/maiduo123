/**
 * 回复判定器（2026-10-11）：判定客服回复是否算「答到」，驱动自适应推送。
 *
 * 背景：关键词匹配对「是非题 + 极简表态回复」有结构盲区（问「胯宽能穿吗」回
 * 「可以的哈」是满分回答，但不含任何要点词）。本模块用三个独立信号组合判定：
 *
 *  1. 敷衍识别 —— 纯语气词 / 过短 / 复读买家原话 / 与上一条客服回复重复 → 不通过；
 *  2. 表态检测 —— 是非题（吗/能不能/会不会…）+ 回复含表态词 → 通过（表态即内容）；
 *  3. 搪塞放行 —— 打太极式回复（以页面为准/看仓库安排/尽快核实…）→ 通过（客户口径）。
 *
 * 另有要点命中（含同义词表）与兜底「有效回应」两个既有宽松通道。
 *
 * 接口形态：JudgeProvider 抽象 + RuleJudgeProvider 实现，AI 判定器后续接入同一接口，
 * 系统参数配置 API key 后自动切换，规则版永远作为降级兜底。
 */
import { KEY_POINT_ALIASES } from './key-point-aliases';

/** 判定结论。signal 记录通过/不通过的依据，便于复盘展示与测试断言。 */
export interface JudgeResult {
  pass: boolean;
  signal:
    | 'perfunctory' // 敷衍 → 不通过
    | 'key-point' // 要点命中（含同义词）→ 通过
    | 'stance' // 是非题 + 表态词 → 通过
    | 'hedge' // 仅表示已回应但未解决，不应直接推进下一题
    | 'fallback' // 兜底要点「有效回应」→ 通过
    | 'opener' // 开场白阶段（问候/链接）的回应 → 通过，不参与要点判定
    | 'off-topic'; // 答非所问的实质内容 → 不通过
}

export interface JudgeContext {
  question: string;
  keyPoints: string[];
  reply: string;
  /** 本轮买家问题原文（识别复读） */
  buyerText: string;
  /** 本轮买家全部消息原文（风格化买家一题多发，如题干+顾虑；复读判定对任意一条生效） */
  buyerTexts?: string[];
  /** 上一条客服回复原文（识别复制粘贴重复） */
  prevAgentText?: string | null;
}

/** 表态词：肯定 / 否定两类。「你/您可以~」是踢皮球句式，不计表态。
 *  含存在式表态（有/没有家族）：「有运费险吗→有的哈」是满分回答，必须覆盖。 */
const STANCE_POSITIVE = [
  '没问题', '放心', '可以', '能的', '能穿', '能退', '能换', '能发', '支持', '行的', '当然', '好呢', 'ok',
  '有的', '有哦', '有呀', '有哈', '有哒', '有呢', '有货', '是的', '对的', '没错', '包的', '包邮',
  // 保障/退换家族：买家追问「不合适怎么办」类，答「7天无理由/支持退换」是实质表态（2026-10-11 线上案例）
  '无理由', '退换', '包退', '包换', '可退', '可换', '运费险', '能保', '保障',
];
const STANCE_NEGATIVE = ['不行', '不能', '不支持', '没办法', '不可以', '没货', '发不了', '退不了', '没有', '木有', '暂时没有'];

/** 纯存在式表态：整句就是「有/没有/没/木有」加语气词（只用于是非题兜底表态，
 *  如「有运费险吗→有哦」。单字「有」仍走敷衍判定中的过短规则，不在此放行）。 */
const BARE_EXISTENTIAL = /^(有|没有|没|木有)[哒呢哦呀哈嘛啊呐~～\s!！。.]*$/;
/** 踢皮球前缀：表态词跟在其后时不算表态（「你可以看看详情页」）。 */
const DEFLECT_PREFIX = /[您你](是)?(可以|能)/;

/** 打太极 / 搪塞话术：只表示“客服有回应”，不能代表买家问题已经解决。 */
const HEDGE_PHRASES = [
  '为准', '以页面', '页面为准', '看情况', '具体看', '尽量', '尽快', '安排', '核实', '确认一下',
  '到时候', '仓库那边', '页面显示', '以实际', '帮您看看', '帮您确认', '帮您核实', '留意', '关注',
];

/** 纯语气词开头即敷衍的短回复（识别「亲在的」「稍等哦」这类）。 */
const PERFUNCTORY_PHRASES = [
  '亲在的', '在的亲', '在的', '稍等', '等一下', '嗯嗯', '哦哦', '好的好的', '您好亲', '你好亲',
  '亲您好', '有什么可以帮您', '请问有什么', '看到了', '在呢', '在的哦', '好的亲', '好哦',
];

/** 是否是非题（「胯宽能穿吗」「能不能指定顺丰」「会不会缩水」）。 */
export function isYesNoQuestion(question: string): boolean {
  const q = String(question || '').trim();
  if (!q) return false;
  return /(吗|嘛|么)[？?!！.\s]*$/.test(q) || /(能不能|可不可以|是不是|会不会|有没有|行不行|能否|可不可以|适不适合|支不支持)/.test(q);
}

/** 去掉标点空白后的净文本长度。 */
function strippedLen(text: string): number {
  return String(text || '').replace(/[\s~～!！?？。，,、.…—\-_=+*#@$%^&()（）\[\]【】"'’“”：:;；]/g, '').length;
}

/** 回复中是否出现表态（排除「你/您可以」踢皮球句式）。 */
export function hasStance(reply: string): boolean {
  const text = String(reply || '');
  if (!text.trim()) return false;
  const all = [...STANCE_POSITIVE, ...STANCE_NEGATIVE];
  for (const word of all) {
    const idx = text.indexOf(word);
    if (idx < 0) continue;
    const before = text.slice(Math.max(0, idx - 2), idx);
    if (DEFLECT_PREFIX.test(before + word.slice(0, 1)) || /[您你]$/.test(before)) continue;
    return true;
  }
  return false;
}

/** 敷衍判定：语气词模板 / 净长度过短 / 复读买家原话 / 同一道题内与上一条回复重复
 *  （调用方契约：prevAgentText 只传同一 seq 内的上一条；跨题重复是正常短答复，不算敷衍）。 */
export function isPerfunctory(ctx: JudgeContext): boolean {
  const reply = String(ctx.reply || '').trim();
  if (!reply) return true;
  const stripped = reply.replace(/[\s~～!！?？。，,、.…—\-_=+*#@$%^&()（）\[\]【】"'’“”：:;；]/g, '');
  if (stripped.length <= 1) return true;
  for (const p of PERFUNCTORY_PHRASES) {
    if (stripped.startsWith(p.replace(/[\s~～!！?？。，,、.…—\-_=+*#@$%^&()（）\[\]【】"'’“”：:;；]/g, ''))) return true;
  }
  // 复读买家原话（把问题复制一遍当回复）；风格化买家一题多发，复读任意一条都算
  const allBuyer = (ctx.buyerTexts && ctx.buyerTexts.length ? ctx.buyerTexts : [ctx.buyerText]).filter(Boolean);
  for (const t of allBuyer) {
    const buyer = String(t).replace(/[\s~～!！?？。，,、.…—\-_=+*#@$%^&()（）\[\]【】"'’“”：:;；]/g, '');
    if (buyer && stripped === buyer) return true;
  }
  // 与上一条客服回复完全重复（复制粘贴刷屏）
  const prev = String(ctx.prevAgentText || '').replace(/[\s~～!！?？。，,、.…—\-_=+*#@$%^&()（）\[\]【】"'’“”：:;；]/g, '');
  if (prev && stripped === prev) return true;
  return false;
}

/** 打太极判定：含搪塞话术即视为正常服务性回应（客户口径：放行）。 */
export function isHedge(reply: string): boolean {
  const text = String(reply || '');
  return HEDGE_PHRASES.some((p) => text.includes(p));
}

/** 要点命中（与同义词表，和 reception.service 的 matchKeyPoints 同口径）。 */
export function matchPoints(reply: string, keyPoints: string[]): string[] {
  const normalized = String(reply || '').replace(/\s/g, '');
  return keyPoints.filter((point) => {
    const key = String(point || '').replace(/\s/g, '');
    if (!key) return false;
    if (key === '有效回应') return normalized.length > 0;
    if (normalized.includes(key)) return true;
    return (KEY_POINT_ALIASES[key] || []).some((alias) => normalized.includes(alias));
  });
}

/**
 * 是非题中的“表态”必须和问题类型兼容。
 * 例如“会缩水吗？”回复“可以的”虽然包含肯定词，但并没有回答“会/不会缩水”，不能推进下一题。
 */
export function hasCompatibleStance(question: string, reply: string): boolean {
  const q = String(question || '');
  const r = String(reply || '').trim();
  if (!isYesNoQuestion(q)) return false;

  // 发生性/属性类问题需要“会/不会/容易/不容易”一类对应表态。
  if (/(会不会|会.{0,10}[吗嘛么][？?!！.\s]*$)/u.test(q) && !/(能不能|能否)/u.test(q)) {
    return /(不会|会的|会哦|会呀|会哈|会呢|容易|不容易|可能会|一般会|一般不会)/u.test(r);
  }

  // 存在类问题需要明确“有/没有”。
  if (/(有没有|有.{0,10}[吗嘛么][？?!！.\s]*$)/u.test(q)) {
    return BARE_EXISTENTIAL.test(r) || /(?:^|[，。！？!\s])(有的|有哦|有呀|有哈|有呢|没有|没|暂时没有)/u.test(r);
  }

  return hasStance(r) || BARE_EXISTENTIAL.test(r);
}

/** 综合判定（见模块头注释的优先级）。 */
export function judgeReply(ctx: JudgeContext): JudgeResult {
  const reply = String(ctx.reply || '');
  if (isPerfunctory(ctx)) return { pass: false, signal: 'perfunctory' };
  const hits = matchPoints(reply, ctx.keyPoints || []);
  if (hits.length > 0) return { pass: true, signal: hits.includes('有效回应') ? 'fallback' : 'key-point' };
  if (hasCompatibleStance(ctx.question, reply)) {
    return { pass: true, signal: 'stance' };
  }
  if (isHedge(reply)) return { pass: false, signal: 'hedge' };
  return { pass: false, signal: 'off-topic' };
}

/** 判定器接口：AI 判定器（语义理解）后续接入，未配置时永远使用规则版。 */
export interface JudgeProvider {
  readonly kind: 'rule' | 'ai';
  judge(ctx: JudgeContext): Promise<JudgeResult>;
}

export class RuleJudgeProvider implements JudgeProvider {
  readonly kind = 'rule' as const;
  async judge(ctx: JudgeContext): Promise<JudgeResult> {
    return judgeReply(ctx);
  }
}
