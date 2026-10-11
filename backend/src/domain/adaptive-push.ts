/**
 * 自适应推送（客户 2026-10-11）：买家不再死板地按剧本顺序提问，
 * 而是根据客服对当前问题的回复质量决定「推进下一题」还是「追问」。
 *
 * 判定口径（与评分共用 matchKeyPoints 的命中结果，保持确定性、不接模型）：
 *  - 本轮客服回复命中任意要点，或执行过业务动作（催付/改价/去发货…）→ 推进下一题；
 *  - 命中 0 要点 → 买家按自己的沟通风格追问一次，最多追问 MAX_FOLLOWUPS 次，
 *    之后无论是否答到都推进（避免训练流程卡死）。
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
export function decidePush(hitAnyPoint: boolean, hasBusinessAction: boolean, followUps: number): PushDecision {
  if (hitAnyPoint || hasBusinessAction) return 'advance';
  return followUps < MAX_FOLLOWUPS ? 'followup' : 'advance';
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

/** 追问时的情绪值变化（第 1 次 -4，第 2 次 -7，最低 0）。 */
export function followUpEmotionDelta(round: number): number {
  return -(4 + Math.min(Math.max(round, 0), 1) * 3);
}
