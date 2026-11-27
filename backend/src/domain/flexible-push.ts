import { assessLocalTrainingRules } from './local-training-rules';
import type { ModelReceptionInput } from './model-reception';
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
  // ---- 商品咨询：材质 / 洗护 / 尺码 / 厚薄 / 正品 / 库存 / 实拍 ----
  {
    question: /(?:是|是不是|含有|有没有).{0,4}(?:聚酯纤维|涤纶)/u,
    answer: /(?:聚酯纤维|涤纶|纯棉|全棉|100\s*[%％]\s*棉|不含(?:聚酯纤维|涤纶))/u,
    reject: /不确定|不清楚|核实|查一下/u,
  },
  {
    question: /含棉|纯棉|全棉|什么面料|什么材质|什么成分/u,
    answer: /(?:不含棉|无棉|纯棉|全棉|\d+\s*[%％]\s*棉|含棉|聚酯纤维|涤纶|棉麻|真丝|莫代尔|氨纶|羊毛|混纺)/u,
    reject: /不确定|不清楚|核实|查一下/u,
  },
  {
    question: /机洗|水洗/u,
    answer: /(?:支持机洗|可以机洗|不可机洗|不能机洗|不建议机洗|建议手洗|轻柔手洗)/u,
    reject: /不确定|不清楚|核实|查一下/u,
  },
  {
    question: /干洗/u,
    answer: /(?:不需要干洗|不用干洗|无需干洗|需要干洗|必须干洗|建议干洗)/u,
    reject: /不确定|不清楚|核实|查一下/u,
  },
  {
    question: /偏大|偏小|尺码.{0,4}(?:正|标准)|推荐.{0,4}码|选(?:哪个|什么)码/u,
    answer: /标准正码|正码|不偏大不偏小|偏大|偏小|按平时.{0,4}码(?:拍|选)|建议(?:选|拍|穿)\s*[SMLX]{1,3}码/iu,
    reject: /不确定|不清楚|核实|查一下/u,
  },
  {
    question: /缩水|掉色|褪色|起球|起皱|变形/u,
    answer: /不会缩水|不易缩水|不会掉色|不易掉色|不易起球|不会起球|不易起皱|不易变形/u,
    reject: /不确定|不清楚|核实|查一下/u,
  },
  {
    question: /透气|会不会闷|不舒服|扎人|敏感肌/u,
    answer: /透气|不闷|不会闷|亲肤|不扎|舒适|舒服|敏感肌(?:也)?(?:可以|放心|适合)/u,
    reject: /不确定|不清楚|核实|查一下/u,
  },
  {
    question: /厚薄|厚度|加绒|透不透|透吗|内衬|里衬|什么季节/u,
    answer: /偏薄|偏厚|常规厚度|适中|加绒|不加绒|不透|不会透|微透|有内衬|无内衬|没有内衬|春夏|秋冬|春秋|四季/u,
    reject: /不确定|不清楚|核实|查一下/u,
  },
  {
    question: /色差/u,
    answer: /轻微色差|细微色差|色差不大|基本无色差|实物为准/u,
    reject: /不确定|不清楚|核实|查一下/u,
  },
  {
    question: /实拍|买家秀|商品视频|细节视频/u,
    answer: /评价区|晒图|主图视频|详情页.{0,6}(?:实拍|视频)|没有视频|暂无视频/u,
    reject: /不确定|不清楚|核实|查一下/u,
  },
  {
    question: /正品|真伪|防伪|品牌授权|质检报告/u,
    answer: /(?:官方)?正品|品牌授权|防伪码|扫码验真|支持专柜验货|质检报告|符合国家标准/u,
    reject: /不确定|不清楚|核实|查一下/u,
  },
  {
    question: /还有货|有货吗|现货吗|缺货.{0,6}补货/u,
    answer: /有现货|现货充足|都有货|拍下.{0,4}发|暂时缺货|预计.{0,6}补货/u,
    reject: /不确定|不清楚|核实|查一下/u,
  },
  // ---- 价格活动 / 优惠券 / 价保 / 赠品 ----
  {
    question: /优惠券.{0,6}(?:门槛|满减)|怎么领(?:取)?优惠券|有(?:没有)?优惠券/u,
    answer: /满\d+减\d+|无门槛|商品页.{0,6}领|店铺首页.{0,6}领|暂无优惠券|没有优惠券/u,
    reject: /不确定|不清楚|核实|查一下/u,
  },
  {
    question: /叠加|一起用|满减.{0,4}冲突/u,
    answer: /可以叠加|支持叠加|不可叠加|不能叠加|不能同时使用|只能用一张/u,
    reject: /不确定|不清楚|核实|查一下/u,
  },
  {
    question: /价保|保价|补差价|降价了怎么办/u,
    answer: /(?:支持|有)\s*\d*\s*天?价保|支持保价|申请价保|退差价|补差价|不支持价保|没有价保/u,
    reject: /不确定|不清楚|核实|查一下/u,
  },
  {
    question: /赠品(?:是|有|怎么|一起发|分开发|随机|自选)/u,
    answer: /随主商品一起发|一起发出|一起寄出|分开发出|没有赠品|暂无赠品|赠品(?:是|为|随机|不支持自选|可以自选)/u,
    reject: /不确定|不清楚|核实|查一下/u,
  },
  // ---- 物流快递 / 发货 / 运费 ----
  {
    question: /什么时候发货|多久发货|几天发货|何时发货|截单/u,
    answer: /\d+\s*(?:小时|天|日)(?:内|左右)?(?:安排)?(?:发货|发出|出库)|当天发货|现货秒发/u,
    reject: /不确定|不清楚|核实|查一下|无法保证/u,
  },
  {
    question: /发什么快递|哪家快递|指定快递/u,
    answer: /(?:发|默认)(?:顺丰|中通|圆通|申通|韵达|极兔|京东|邮政|EMS)|支持指定|不支持指定/iu,
    reject: /不确定|不清楚|核实|查一下/u,
  },
  {
    question: /多久能到|几天能到|几天送到|什么时候能到/u,
    answer: /\d+\s*[-~到至]\s*\d+\s*天(?:左右)?(?:到达|送达|收到|到货)|次日达|隔日达|3天左右/u,
    reject: /不确定|不清楚|核实|查一下/u,
  },
  {
    question: /包邮|运费多少|要运费吗|运费怎么算/u,
    answer: /包邮|免运费|免邮|不包邮|偏远地区.{0,6}运费/u,
    reject: /不确定|不清楚|核实|查一下/u,
  },
  // ---- 退换货 / 运费险 / 退款 ----
  {
    question: /退货|退款|七天无理由|7天无理由|运费险/u,
    answer: /(?:支持|可以).{0,6}(?:7天|七天)无理由|有运费险|赠送运费险|包退|不含运费险/u,
    reject: /不确定|不清楚|核实|查一下/u,
  },
  {
    question: /退货怎么操作|如何申请退货|退货流程|在哪里提交退货/u,
    answer: /订单详情.{0,8}申请(?:退货|售后)|我的订单.{0,8}退货|点击申请售后/u,
    reject: /不确定|不清楚|核实|查一下/u,
  },
  {
    question: /换货|换码|尺码不合适.{0,6}换/u,
    answer: /(?:支持|可以).{0,6}(?:换货|换码|退换)|订单.{0,6}申请换货/u,
    reject: /不确定|不清楚|核实|查一下/u,
  },
  {
    question: /退货运费谁承担|运费谁出/u,
    answer: /运费险(?:赔付|承担|抵扣)|质量问题.{0,6}商家承担|非质量问题.{0,6}买家承担/u,
    reject: /不确定|不清楚|核实|查一下/u,
  },
  // ---- 发票 / 订单服务 / 会员 / 售后 ----
  {
    question: /开发票|电子发票|专票|发票怎么开|多久拿到发票/u,
    answer: /(?:支持|可以)开(?:具)?(?:电子|纸质|增值税)?发票|订单.{0,6}申请开票|\d+个工作日内.{0,6}发|不支持开票|暂不能开票/u,
    reject: /不确定|不清楚|核实|查一下/u,
  },
  {
    question: /改地址|修改.{0,4}地址|改电话|修改.{0,4}电话|改规格|改尺码|改颜色/u,
    answer: /未发货.{0,6}(?:可以|支持)改|帮您(?:修改|备注)|已发货.{0,6}无法修改|重新拍/u,
    reject: /不确定|不清楚|核实|查一下/u,
  },
  {
    question: /支付方式|怎么付款|分期|免息|货到付款/u,
    answer: /微信|支付宝|银行卡|花呗|信用卡|分期免息|不支持货到付款|支持货到付款/u,
    reject: /不确定|不清楚|核实|查一下/u,
  },
  {
    question: /成为.{0,4}会员|怎么入会|会员.{0,4}(?:福利|权益|折扣)|积分/u,
    answer: /店铺首页.{0,6}(?:加入|注册)会员|入会.{0,6}(?:礼|券|积分|折扣)|积分(?:抵扣|兑换)/u,
    reject: /不确定|不清楚|核实|查一下/u,
  },
  {
    question: /保修|保修卡|维修/u,
    answer: /保修\d+|质保\d+|凭订单.{0,6}保修|支持维修|返厂检测/u,
    reject: /不确定|不清楚|核实|查一下/u,
  },
  // ---- 前提已被客服否定的条件追问（避免出现「有现货→还问缺货什么时候补货」等逻辑违和） ----
  {
    question: /如果分开发|分开发的话/u,
    answer: /一起发|随主商品|同一包裹|不会分开/u,
  },
  {
    question: /缺货的话|断货.{0,4}补货/u,
    answer: /有现货|现货充足|目前有货|不缺货/u,
  },
  {
    question: /价保怎么申请|怎么申请价保/u,
    answer: /不支持价保|没有价保|暂无价保/u,
  },
  {
    question: /怎么开发票|多久能拿到发票|发票怎么下载/u,
    answer: /不支持开票|不能开发票|暂不支持开票/u,
  },
];

const HIGH_PRECISION_PROACTIVE_SOURCES = new Set([
  'material-details',
  'wash-guidance',
  'dry-clean-required',
  'color-difference',
  'media-location',
  'media-available',
  'shipping-logistics',
  'exchange-policy',
  'fit-sizing',
  'comfort-breathability',
  'shoe-styling',
  'outer-shoe-styling',
  'outerwear-color',
  'craft-aftersale',
]);

function isQuestionAnsweredByReplies(
  questionText: string,
  agentReplies: string[],
  facts?: ModelReceptionInput['facts'],
): boolean {
  const text = String(questionText || '').trim();
  if (!text || !agentReplies.length) return false;
  const effectiveFacts = facts ?? { product: { title: '', attributes: [] } };

  for (const reply of agentReplies) {
    const trimmed = String(reply || '').trim();
    if (!trimmed) continue;
    const ruleHit = assessLocalTrainingRules({
      question: text,
      reply: trimmed,
      history: [],
      goals: [],
      judgmentVersion: 2,
      facts: effectiveFacts,
    });
    if (ruleHit?.resolved === true && ruleHit.decisionSource && HIGH_PRECISION_PROACTIVE_SOURCES.has(ruleHit.decisionSource)) {
      return true;
    }
  }

  return PROACTIVE_TOPIC_CHECKS.some((rule) =>
    rule.question.test(text) &&
    agentReplies.some((reply) => rule.answer.test(reply) && (!rule.reject || !rule.reject.test(reply))),
  );
}

/** 检测客服前面的回复是否已经主动答到了后续某道独立问题，避免买家机械重复提问。 */
export function findProactivelyAnsweredSeqs(
  questions: ScriptQuestion[],
  currentSeq: number,
  alreadySkipped: number[],
  agentReplies: string[],
  facts?: ModelReceptionInput['facts'],
): number[] {
  const combined = agentReplies.map((r) => String(r || '').trim()).filter(Boolean);
  if (!combined.length) return [];
  const skipped = new Set(alreadySkipped);
  const hits: number[] = [];

  for (const question of questions) {
    if (question.seq <= currentSeq) continue;
    if (skipped.has(question.seq)) continue;
    if (question.needTransfer || (question.semanticGoals && question.semanticGoals.length > 0)) continue;

    if (isQuestionAnsweredByReplies(question.question, combined, facts)) {
      hits.push(question.seq);
    }
  }
  return hits;
}

const CONTEXT_FOLLOWUPS: Array<{
  trigger: RegExp;
  exclude?: RegExp;
  candidates: string[];
}> = [
  // ---- 材质 / 成分 ----
  {
    trigger: /聚酯纤维|涤纶|化纤|不含棉|无棉/u,
    exclude: /不确定|不清楚|核实|查一下/u,
    candidates: [
      '聚酯纤维的话，穿起来会不会闷或不舒服呢？',
      '聚酯纤维平时清洗和打理有什么要注意的吗？',
      '这种面料容易起球或者变形吗？',
    ],
  },
  {
    trigger: /纯棉|全棉|含棉|棉麻|棉混纺|\d+\s*[%％]\s*棉/u,
    exclude: /不含棉|无棉|不确定|不清楚|核实|查一下/u,
    candidates: [
      '含棉的话，洗完容易缩水或者掉色吗？',
      '平时清洗和打理有什么要注意的吗？',
    ],
  },
  // ---- 洗护 / 干洗 ----
  {
    trigger: /不建议机洗|不可机洗|不能机洗|建议手洗|轻柔手洗/u,
    exclude: /不确定|不清楚|核实|查一下/u,
    candidates: [
      '平时手洗和晾晒有什么要注意的吗？',
      '要不要干洗呢？',
    ],
  },
  {
    trigger: /需要干洗|必须干洗|建议干洗/u,
    exclude: /不需要干洗|不用干洗|无需干洗/u,
    candidates: [
      '平时穿着和打理有什么要注意的吗？',
    ],
  },
  // ---- 尺码 / 版型 ----
  {
    trigger: /偏小|偏大|修身|宽松|标准正码|正码|不偏大|不偏小/u,
    exclude: /不确定|不清楚|核实|查一下/u,
    candidates: [
      '如果尺码不合适，可以换吗？',
      '那平时穿M码的话，这款建议怎么选尺码呢？',
    ],
  },
  // ---- 色差 / 实拍 ----
  {
    trigger: /轻微色差|细微色差|光线|屏幕|色差/u,
    exclude: /不确定|不清楚|核实|查一下/u,
    candidates: [
      '有没有买家秀可以看呀？',
      '买家秀在哪里看？',
    ],
  },
  // ---- 现货 / 库存 / 补货 ----
  {
    trigger: /有现货|现货充足|都有货|拍下.{0,4}发/u,
    exclude: /缺货|没货|不确定|不清楚|核实|查一下/u,
    candidates: [
      '那现在拍的话一般多久能发货呢？',
      '这款包邮吗，默认发什么快递呀？',
    ],
  },
  {
    trigger: /缺货|暂时无货|断货|补货/u,
    exclude: /有现货|不缺货/u,
    candidates: [
      '大概什么时候能补货呢，有没有其他类似款推荐？',
    ],
  },
  // ---- 正品 / 质检 ----
  {
    trigger: /官方正品|品牌授权|防伪码|扫码验真|质检报告/u,
    exclude: /不确定|不清楚|核实|查一下/u,
    candidates: [
      '收到后如果觉得不合适，支持七天无理由退换吗？',
      '现在下单一般多久能发货呢？',
    ],
  },
  // ---- 优惠券 / 满减 / 价保 / 赠品 ----
  {
    trigger: /优惠券|满\d+减\d+|满减|折扣|活动价|券后/u,
    exclude: /没有优惠|暂无优惠|不确定|不清楚/u,
    candidates: [
      '这个优惠能和店铺其他活动或者满减叠加使用吗？',
      '如果刚买完降价了，支持价保补差价吗？',
    ],
  },
  {
    trigger: /价保|保价|补差价/u,
    exclude: /不支持价保|没有价保/u,
    candidates: [
      '如果后面需要申请价保，具体在哪里操作呢？',
      '现在下单一般多久能发货呢？',
    ],
  },
  {
    trigger: /赠品|随主商品一起发|一起寄出/u,
    exclude: /没有赠品|无赠品|暂无赠品/u,
    candidates: [
      '如果后面主商品要退货的话，赠品需要一起退回吗？',
      '现在下单一般多久能发货呢？',
    ],
  },
  // ---- 发货 / 快递 / 物流 ----
  {
    trigger: /\d+\s*(?:小时|天|日)(?:内|左右)?(?:安排)?(?:发货|发出|出库)|当天发货|现货秒发/u,
    exclude: /不确定|不清楚|核实|查一下|无法保证/u,
    candidates: [
      '发出后大概几天能送到呢？',
      '这款包邮吗，默认发什么快递呀？',
    ],
  },
  {
    trigger: /顺丰|中通|圆通|申通|韵达|极兔|京东|邮政|EMS/iu,
    exclude: /不确定|不清楚/u,
    candidates: [
      '发出后大概几天能送到呢？',
      '如果发货前想改收货地址，可以联系你们修改吗？',
    ],
  },
  // ---- 退换货 / 运费险 / 退款 ----
  {
    trigger: /7天无理由|七天无理由|支持退换|支持退货|有运费险/u,
    exclude: /不确定|不清楚|核实|查一下/u,
    candidates: [
      '退货的话运费是怎么算的，有运费险吗？',
      '如果尺码不合适，换货流程怎么操作呢？',
    ],
  },
  // ---- 发票 ----
  {
    trigger: /电子发票|纸质发票|增值税|支持开票|可以开发票/u,
    exclude: /不支持开票|不能开发票/u,
    candidates: [
      '申请开票后一般多久能拿到发票呢？',
      '如果开票后又退货了，发票需要怎么处理呀？',
    ],
  },
  // ---- 订单修改 / 支付 ----
  {
    trigger: /未发货.{0,6}(?:可以|支持)改|帮您修改|帮您备注/u,
    exclude: /无法修改|不能改/u,
    candidates: [
      '好的，那修改完大概什么时候能发出呢？',
    ],
  },
  {
    trigger: /花呗|信用卡|分期|微信|支付宝/u,
    exclude: /不确定|不清楚/u,
    candidates: [
      '下单付款后一般多久能发货呢？',
    ],
  },
  // ---- 会员 / 积分 ----
  {
    trigger: /加入会员|注册会员|会员折扣|积分兑换|积分抵扣/u,
    exclude: /不确定|不清楚/u,
    candidates: [
      '会员折扣可以和店铺优惠券一起叠加用吗？',
    ],
  },
  // ---- 售后处理 / 补发 / 维修 ----
  {
    trigger: /补发|核实物流|联系快递|处理售后|返厂检测|保修/u,
    exclude: /不能处理|无法处理/u,
    candidates: [
      '大概多久能处理好并给我答复呢？',
      '退回或者换货的运费是商家承担吗？',
    ],
  },
];

/** 根据客服最新一轮回复的具体内容，顺着上下文生成一条自然、未问过且尚未被答到的追问。 */
export function buildContextFollowUpQuestion(
  questions: ScriptQuestion[],
  agentReplies: string[],
  latestAgentReply: string,
  parent: ScriptQuestion,
  facts?: ModelReceptionInput['facts'],
): ScriptQuestion | null {
  const latest = String(latestAgentReply || '').trim();
  if (!latest) return null;
  const usedQuestions = new Set(questions.map((q) => String(q.question || '').trim()));

  for (const rule of CONTEXT_FOLLOWUPS) {
    if (!rule.trigger.test(latest)) continue;
    if (rule.exclude?.test(latest)) continue;
    for (const candidate of rule.candidates) {
      if (usedQuestions.has(candidate)) continue;
      if (isQuestionAnsweredByReplies(candidate, agentReplies, facts)) continue;
      return {
        seq: Math.max(0, ...questions.map((q) => q.seq)) + 1,
        question: candidate,
        keyPoints: parent.automaticEvaluation ? [] : ['有效回应'],
        ...(parent.automaticEvaluation ? { automaticEvaluation: true } : {}),
        sourceType: 'derived',
        requiresContext: true,
        derivedFromSeq: parent.seq,
        goalPriority: 'secondary',
        needTransfer: false,
        stage: parent.stage || 'presale',
        orderStage: parent.orderStage,
      };
    }
  }
  return null;
}

