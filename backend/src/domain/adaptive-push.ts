/**
 * 自适应推送（客户 2026-10-11）：买家不再死板地按剧本顺序提问，
 * 而是根据客服对当前问题的回复质量决定「推进下一题」还是「追问」。
 *
 * 判定口径保持确定性、不接大模型：
 *  - 已完整解决当前目标，或执行过业务动作 → 推进；
 *  - 只完成部分语义目标 → 优先追问缺失信息，而不是复述原题；
 *  - 完全未答到 → 最多追问 MAX_FOLLOWUPS 次，之后推进，避免死循环。
 *
 * 纯函数实现，与框架解耦、可独立单测。
 */

/** 同一道题最多追问的次数（第三次未答到直接推进）。 */
export const MAX_FOLLOWUPS = 2;

export type PushDecision = 'advance' | 'followup';

/**
 * 决定客服回复之后买家怎么反应。
 * @param hitAnyPoint   本轮（同一题）是否命中过任意要点（任一条回复命中即算）
 * @param hasBusinessAction 本轮是否执行过业务动作（视为有效处理）
 * @param followUps     当前题已追问次数
 */
export function decidePush(
  hitAnyPoint: boolean,
  hasBusinessAction: boolean,
  followUps: number,
  maxFollowUps = MAX_FOLLOWUPS,
): PushDecision {
  if (hitAnyPoint || hasBusinessAction) return 'advance';
  return followUps < maxFollowUps ? 'followup' : 'advance';
}

/** 追问话术模板：按沟通风格两档（第 1 次温和、第 2 次加重），q 为原问题原文。 */
type Template = [string, string];

const FOLLOWUP_TEMPLATES: Record<string, Template> = {
  friendly: ['不好意思，我可能没说清楚～我是想问：{q}', '亲，我问的其实是：{q}，麻烦再看下哦～'],
  hesitant: ['嗯…我还是没太明白，就是想问问：{q}', '那个…这个对我挺重要的，能再确认下吗：{q}'],
  direct: ['这个没答到我的点，我再问下：{q}', '还是没解决我的问题：{q}'],
  impatient: ['你答非所问啊，我是问：{q}', '能不能认真点？我再问最后一次：{q}'],
  silent: ['{q}', '所以…{q}'],
};

const DEFAULT_TEMPLATE: Template = FOLLOWUP_TEMPLATES.friendly;

const MISSING_POINT_TEMPLATES: Record<string, Template> = {
  friendly: ['明白了～那我还想确认一下{point}，可以再具体说说吗？', '还有一点我没弄清楚：{point}，麻烦再说明一下哦～'],
  hesitant: ['嗯…那{point}这块我还是有点拿不准，可以再说具体一点吗？', '我主要还担心{point}，能再帮我确认一下吗？'],
  direct: ['那再确认一下{point}。', '{point}这点还没说清楚，麻烦直接说明一下。'],
  impatient: ['那{point}呢？这个还没说清楚。', '我还在问{point}，麻烦给个明确说法。'],
  silent: ['那{point}呢？', '{point}？'],
};

const DEFAULT_MISSING_POINT_TEMPLATE: Template = MISSING_POINT_TEMPLATES.friendly;

/**
 * 生成追问话术（1 条）。
 * @param styleCode 沟通风格编码
 * @param question  原问题原文
 * @param round     已追问次数（0 = 第 1 次追问，1 = 第 2 次追问）
 */
export function buildFollowUpText(styleCode: string, question: string, round: number): string {
  const tpl = FOLLOWUP_TEMPLATES[styleCode] || DEFAULT_TEMPLATE;
  const text = tpl[Math.min(Math.max(round, 0), tpl.length - 1)];
  return text.replace('{q}', String(question || '').trim());
}

/**
 * 针对“部分完成”的自然追问：只问尚未解释清楚的语义点，不复读整道题。
 */
export function buildMissingPointFollowUpText(
  styleCode: string,
  missingLabels: string[],
  round: number,
): string {
  const labels = [...new Set((missingLabels || []).map((label) => String(label || '').trim()).filter(Boolean))];
  const point = labels.slice(0, 2).join('、') || '这个细节';
  const tpl = MISSING_POINT_TEMPLATES[styleCode] || DEFAULT_MISSING_POINT_TEMPLATE;
  return tpl[Math.min(Math.max(round, 0), tpl.length - 1)].replace('{point}', point);
}

/** 追问时的情绪值变化（第 1 次 -4，第 2 次 -7，最低 0）。 */
export function followUpEmotionDelta(round: number): number {
  return -(4 + Math.min(Math.max(round, 0), 1) * 3);
}
