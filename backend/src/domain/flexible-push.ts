import { createRng } from './rng';
import { ScriptQuestion } from './types';

/**
 * 灵活问题推送领域纯函数：
 * 1. 非依赖题顺序随机化（同一剧本每次不再死板按 1→2→3 提问）；
 * 2. 多套自然转场词与风格口吻（并导出前缀/后缀供 stripBuyerQuestionWrapper 完整剥离，确保判定不受影响）；
 * 3. 真实买家推送节奏（按风格快慢不一 + 偶发补充气泡 + 未回时温和催促）；
 * 4. 跨题提前答到自动跳过（客服提前说清楚后，买家不再机械追问同一话题）。
 */

export const FLEXIBLE_TRANSITION_PREFIXES: Record<string, string[]> = {
  friendly: [
    '对了，我还想顺便问一下：',
    '明白了～那顺便再问下，',
    '好的呢，还有个小问题想确认下：',
    '了解啦～另外想问一下，',
  ],
  hesitant: [
    '另外我还想确认一下：',
    '嗯…那再多问一句，',
    '不好意思再确认个事，',
    '还有一点我有点拿不准，',
  ],
  direct: [
    '另外一个问题：',
    '再问一下，',
    '还有个问题，',
    '顺便确认下，',
  ],
  impatient: [
    '还有个问题，麻烦直接说下：',
    '行，那再问一句，',
    '顺便一起说了吧，',
    '快点帮我再看下，',
  ],
  silent: [
    '还有，',
    '另外，',
    '再问下，',
    '',
  ],
};

export const FLEXIBLE_STYLE_WRAPPERS: Record<string, Array<{ prefix: string; suffix: string }>> = {
  friendly: [
    { prefix: '', suffix: '' },
    { prefix: '亲，', suffix: '' },
    { prefix: '你好呀，请问', suffix: '' },
    { prefix: '麻烦问一下，', suffix: '' },
  ],
  hesitant: [
    { prefix: '我想确认一下，', suffix: '' },
    { prefix: '不好意思问一下，', suffix: '' },
    { prefix: '有点拿不准，', suffix: '' },
    { prefix: '', suffix: '' },
  ],
  direct: [
    { prefix: '', suffix: '' },
    { prefix: '请问', suffix: '' },
    { prefix: '直接问下，', suffix: '' },
  ],
  impatient: [
    { prefix: '', suffix: '？麻烦直接说一下。' },
    { prefix: '赶时间，', suffix: '' },
    { prefix: '快点问下，', suffix: '' },
    { prefix: '', suffix: '' },
  ],
  silent: [
    { prefix: '', suffix: '' },
    { prefix: '问下，', suffix: '' },
  ],
};

export const ALL_FLEXIBLE_PREFIXES: string[] = [
  ...new Set([
    ...Object.values(FLEXIBLE_TRANSITION_PREFIXES).flat(),
    ...Object.values(FLEXIBLE_STYLE_WRAPPERS).flat().map((item) => item.prefix),
  ].filter(Boolean)),
].sort((a, b) => b.length - a.length);

export const ALL_FLEXIBLE_SUFFIXES: string[] = [
  ...new Set(
    Object.values(FLEXIBLE_STYLE_WRAPPERS).flat().map((item) => item.suffix).filter(Boolean),
  ),
].sort((a, b) => b.length - a.length);

/** 随机打乱同一会话里互不依赖的题目顺序，同时保持衍生/条件/转接题的相对位置。 */
export function shuffleFlexibleQuestions(questions: ScriptQuestion[], seed: number): ScriptQuestion[] {
  if (questions.length <= 2) return questions;
  const rng = createRng(seed);
  const movableIndexes: number[] = [];
  for (let index = 0; index < questions.length; index += 1) {
    const q = questions[index];
    const isDependent = q.sourceType === 'derived'
      || q.requiresContext === true
      || q.derivedFromSeq !== undefined
      || q.needTransfer === true
      || Boolean(q.triggerConditions);
    if (!isDependent) movableIndexes.push(index);
  }
  if (movableIndexes.length < 2) return questions;

  const shuffledItems = movableIndexes.map((index) => questions[index]);
  for (let i = shuffledItems.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [shuffledItems[i], shuffledItems[j]] = [shuffledItems[j], shuffledItems[i]];
  }

  const next = [...questions];
  movableIndexes.forEach((slot, idx) => {
    next[slot] = shuffledItems[idx];
  });

  const seqMap = new Map<number, number>();
  next.forEach((q, idx) => seqMap.set(q.seq, idx + 1));
  return next.map((q, idx) => ({
    ...q,
    seq: idx + 1,
    ...(q.derivedFromSeq !== undefined && seqMap.has(q.derivedFromSeq)
      ? { derivedFromSeq: seqMap.get(q.derivedFromSeq) }
      : {}),
  }));
}

const SUPPLEMENT_POOLS: Array<{ match: RegExp; lines: string[] }> = [
  {
    match: /尺码|码数|偏大|偏小|显瘦|版型|穿多大|穿什么码/u,
    lines: ['怕买回去不合适来回退挺麻烦的', '我平时一般穿常规码，想拿准一点', '想挑个合身舒服点的'],
  },
  {
    match: /材质|面料|成分|含棉|聚酯|涤纶|透气|舒服/u,
    lines: ['我皮肤比较敏感，穿贴身的比较在意面料', '想买个舒服耐穿一点的'],
  },
  {
    match: /洗|干洗|机洗|缩水|掉色|起球/u,
    lines: ['平时工作忙，想提前了解下好不好打理', '怕洗一次就变形缩水了'],
  },
  {
    match: /发货|多久|物流|快递|几天|到货/u,
    lines: ['过两天出门想穿，有点着急', '怕太慢赶不上用'],
  },
  {
    match: /色差|颜色|实拍|买家秀|视频/u,
    lines: ['怕实物跟图片差太多踩雷', '想心里先有个底'],
  },
  {
    match: /退货|换货|换码|运费险|售后/u,
    lines: ['网购衣服还是先问清楚售后比较放心', '提前确认好省得后面麻烦'],
  },
];

const GENERAL_SUPPLEMENTS: Record<string, string[]> = {
  friendly: ['麻烦帮我看下哦～', '谢谢亲啦～'],
  hesitant: ['麻烦帮我确认清楚一点哈', '谢谢啦，比较纠结这个'],
  direct: ['麻烦准确说下', '看下回复我'],
  impatient: ['在线等，快点回我', '抓紧看下哈'],
  silent: ['麻烦看下'],
};

/** 生成本轮买家提问主消息与偶发补充气泡（主消息仍保持单句核心问题，避免干扰规则判定）。 */
export function buildFlexibleBuyerMessages(
  rawPrompt: string,
  styleCode: string,
  isTopicTransition: boolean,
  seed: number,
  allowSupplement: boolean,
): { primary: string; supplement?: string } {
  const text = String(rawPrompt || '').trim();
  if (!text) return { primary: '请问一下这个商品的情况？' };
  const rng = createRng(seed);

  let primary = text;
  if (isTopicTransition) {
    const prefixes = FLEXIBLE_TRANSITION_PREFIXES[styleCode] || FLEXIBLE_TRANSITION_PREFIXES.friendly;
    const prefix = prefixes[Math.floor(rng() * prefixes.length)] || '';
    primary = prefix ? `${prefix}${text}` : text;
  } else {
    const wrappers = FLEXIBLE_STYLE_WRAPPERS[styleCode] || FLEXIBLE_STYLE_WRAPPERS.friendly;
    const wrapper = wrappers[Math.floor(rng() * wrappers.length)] || { prefix: '', suffix: '' };
    if (wrapper.suffix) {
      primary = `${wrapper.prefix}${text.replace(/[？?]$/u, '')}${wrapper.suffix}`;
    } else {
      primary = `${wrapper.prefix}${text}`;
    }
  }

  let supplement: string | undefined;
  // 约 30% 概率附带一条简短的真实买家补充顾虑（沉默寡言风格概率更低）
  const supplementProb = styleCode === 'silent' ? 0.1 : styleCode === 'hesitant' ? 0.4 : 0.3;
  if (allowSupplement && rng() < supplementProb) {
    const matchedPool = SUPPLEMENT_POOLS.find((pool) => pool.match.test(text));
    const candidates = matchedPool
      ? matchedPool.lines
      : (GENERAL_SUPPLEMENTS[styleCode] || GENERAL_SUPPLEMENTS.friendly);
    supplement = candidates[Math.floor(rng() * candidates.length)];
  }

  return { primary, ...(supplement ? { supplement } : {}) };
}

/** 按买家风格与随机节奏计算下一题推送延迟（毫秒），告别千篇一律的机械间隔。 */
export function computeFlexiblePushDelayMs(
  baseRange: [number, number] | undefined,
  styleCode: string,
  seed: number,
): number {
  const [rawMin, rawMax] = baseRange ?? [3, 7];
  const minSec = Math.max(1, Number(rawMin) || 3);
  const maxSec = Math.max(minSec, Number(rawMax) || 7);
  const rng = createRng(seed);

  let scaleMin = 0.7;
  let scaleMax = 1.15;
  if (styleCode === 'impatient') {
    scaleMin = 0.4;
    scaleMax = 0.8;
  } else if (styleCode === 'direct') {
    scaleMin = 0.5;
    scaleMax = 0.9;
  } else if (styleCode === 'hesitant' || styleCode === 'silent') {
    scaleMin = 0.9;
    scaleMax = 1.5;
  }

  const low = Math.max(1.2, minSec * scaleMin);
  const high = Math.min(12, Math.max(low + 0.8, maxSec * scaleMax));
  return Math.round((low + rng() * (high - low)) * 1000);
}

const WAITING_NUDGES: Record<string, string[]> = {
  friendly: ['亲，在吗？刚才的问题麻烦看下呀～', '亲还在忙吗？方便帮我看一下吗～'],
  hesitant: ['不好意思，刚才发的消息您看到了吗？', '亲，我还在等您回复呢，麻烦帮我确认下呀'],
  direct: ['在吗？麻烦回复一下刚才的问题。', '请问看到了吗，麻烦尽快回复下。'],
  impatient: ['有人在吗？等半天了麻烦回复一下！', '怎么还没回呀，快点看下消息。'],
  silent: ['在吗？', '还在吗'],
};

/** 客服迟迟未回复时，买家发出一条风格匹配的温和催促（不重置响应计时）。 */
export function buildWaitingNudge(styleCode: string, seed: number): string {
  const pool = WAITING_NUDGES[styleCode] || WAITING_NUDGES.friendly;
  const rng = createRng(seed);
  return pool[Math.floor(rng() * pool.length)];
}

const PROACTIVE_TOPIC_CHECKS: Array<{ question: RegExp; answer: RegExp; reject?: RegExp }> = [
  {
    question: /退货|退款|七天无理由|7天无理由|运费险/u,
    answer: /(?:支持|可以).{0,6}(?:7天|七天)无理由|有运费险|赠送运费险|包退/u,
    reject: /不确定|不清楚|核实|查一下/u,
  },
  {
    question: /换货|换码|尺码不合适.{0,6}换/u,
    answer: /(?:支持|可以).{0,6}(?:换货|换码|退换)/u,
    reject: /不确定|不清楚|核实|查一下/u,
  },
  {
    question: /什么时候发货|多久发货|几天发货|何时发货/u,
    answer: /\d+\s*(?:小时|天|日)(?:内|左右)?(?:安排)?(?:发货|发出|出库)|当天发货|现货秒发/u,
    reject: /不确定|不清楚|核实|查一下|无法保证/u,
  },
  {
    question: /包邮|运费多少|要运费吗/u,
    answer: /包邮|免运费|免邮/u,
    reject: /不确定|不清楚|核实|查一下/u,
  },
  {
    question: /偏大|偏小|尺码.{0,4}(?:正|标准)/u,
    answer: /标准正码|正码|不偏大不偏小|按平时.{0,4}码(?:拍|选)/u,
    reject: /不确定|不清楚|核实|查一下/u,
  },
  {
    question: /缩水|掉色|褪色|起球/u,
    answer: /不会缩水|不易缩水|不会掉色|不易掉色|不易起球|不会起球/u,
    reject: /不确定|不清楚|核实|查一下/u,
  },
  {
    question: /色差/u,
    answer: /轻微色差|细微色差|色差不大|基本无色差|实物为准/u,
    reject: /不确定|不清楚|核实|查一下/u,
  },
];

/** 检测客服前面的回复是否已经主动答到了后续某道独立问题，避免买家机械重复提问。 */
export function findProactivelyAnsweredSeqs(
  questions: ScriptQuestion[],
  currentSeq: number,
  alreadySkipped: number[],
  agentReplies: string[],
): number[] {
  if (!agentReplies.length) return [];
  const skipped = new Set(alreadySkipped);
  const combined = agentReplies.filter(Boolean);
  const hits: number[] = [];

  for (const question of questions) {
    if (question.seq <= currentSeq) continue;
    if (skipped.has(question.seq)) continue;
    if (question.needTransfer || (question.semanticGoals && question.semanticGoals.length > 0)) continue;

    const text = String(question.question || '').trim();
    const matched = PROACTIVE_TOPIC_CHECKS.some((rule) =>
      rule.question.test(text) &&
      combined.some((reply) => rule.answer.test(reply) && (!rule.reject || !rule.reject.test(reply))),
    );
    if (matched) hits.push(question.seq);
  }
  return hits;
}
