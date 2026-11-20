/**
 * 判定放宽层（2026-11-20，业务口径调整）。
 *
 * 业务诉求：客服回复只要不是「敷衍」「等待 / 处理中」「只是复述问题并要核对」这三类，
 * 其余情况只要内容与客户问的问题是**类似的答案**，就判通过，不再因为没命中
 * 某一具体意图的严格证据格式而判「尚未回答」。
 *
 * 设计边界（重要）：
 *  - 放宽只作用于「答非所问 / 未匹配格式」这一类失败，**不放宽**语义错误类失败：
 *    方向错（发货时效替代到货时效）、自相矛盾（色差程度前后冲突）、
 *    数据缺失（引用了买家没给的身高体重）仍判不通过；
 *  - 三类硬拦截始终优先：敷衍、等待/处理中、只复述+要核对；
 *  - 「类似」用主题一致性判断（conversationTopic 已有 15 类主题分类），
 *    辅以关键词重合，不做语义模型推断，判定可复算、可回溯。
 */
import { conversationTopic, ConversationTopic } from './semantic-goals';

/** 放宽判定结果。 */
export interface RelaxationResult {
  /** 是否放行 */
  relaxed: boolean;
  /** 放行依据（用于复盘展示），未放行时为空 */
  reason?: string;
  /** 判定所用的话题 */
  topic?: ConversationTopic;
}

/** 只表示「客服有回应但没给结论」的措辞：等待、处理中、打太极。
 *  这些即便内容与问题相关，也属于业务明确要求拦截的「等待 / 核对类」。 */
const WAIT_OR_PROCESS_RE = new RegExp(
  [
    '稍等', '稍候', '等一下', '等下', '马上', '立刻', '尽快', '回头', '待会', '待一下',
    '我帮您(查|看|问|确认|核实|处理|跟进|催)', '帮您(查|看|问|确认|核实|处理|跟进|催)',
    '(这边|我)?(先)?(帮您|为您)?(核实|确认一下|查一下|查询一下|看一下|问问|处理一下)',
    '稍后(回复|答复|回您|告诉您)', '一会(就|儿)?(回复|答复)',
    '以(页面|实物|客服|仓库|系统)(为准|显示)', '页面为准', '具体看', '看情况', '看仓库',
    '到时候', '尽量', '留意', '关注', '不确定', '不太清楚', '不清楚', '没法(确定|确认|保证)',
    '不确定|无法确认|不能确定|不好说|说不好',
  ].join('|'),
  'u',
);

/** 纯敷衍：没有任何实质内容。 */
const PERFUNCTORY_RE = new RegExp(
  [
    '^(亲|亲亲|您好|你好|hi|hello|在的|在呢|嗯嗯|嗯|哦哦|哦|好的|好|行|可以的|收到|明白|了解了|感谢|谢谢)+[，,。!！~～。?？\\s]*$',
    '^(好的|收到|明白|了解|嗯|哦|好|行|可以|没问题|ok|OK)[了啦呀哈呢嘛哦]?$',
    '(有什么可以帮您|请问有什么|需要什么帮助|还有什么问题吗|还有其他问题吗)',
  ].join('|'),
  'u',
);

/** 通用兜底：常见的功能性答复，说明客服在正常提供服务。
 *  这类回复虽然不含具体要点，但明显是针对该问题的服务性回应。 */
const SERVICE_REPLY_RE = new RegExp(
  [
    '帮您(改|换|查|看|发|催|备注|处理|申请|登记|取消|改单)',
    '给您(改|换|查|看|发|催|备注|处理|申请|登记|取消|改单)',
    '(可以|能)(帮您|给您)?(改|换|发|催|备注|处理)',
    '(备注|登记|申请|反馈)好(了)?',
    '已经(帮您|给您|帮)(改|换|发|催|备注|处理|登记)',
    '这边(帮您|给您|来)?(处理|操作|安排)?(好|了)',
  ].join('|'),
  'u',
);

/** 否定式承诺：明确否认能给出结论，即便提到时长/动作也不放行。 */
const NEGATED_PROMISE_RE = /不保证|不承诺|不一定|不确定|不能保证|无法保证|不好说|说不好|可能不|发不了|不发出|不发货|没发货|不能发|无法发|没法发|不能出库/u;

/**
 * 有专属严格答案格式的意图不放宽。
 *
 * 这些意图各自对应一个具体的答案要求（晾晒方式要说到挂/阴干、换货要说到能换、
 * 物流查询要说到查看路径、发货/到货时效要说到时长），答非所问就应该判不通过。
 * 放宽只针对通用问题（intent='general'）——那类问题本来就没有唯一答案格式，
 * 只要回复与问题同话题就该放行。
 */
const STRICT_INTENTS = new Set([
  'dry-clean-required', 'dry-clean-allowed', 'exchange', 'media-location', 'media-available',
  'color-difference', 'compound', 'size-recommendation', 'delivery-time', 'logistics-location',
  'drying-method', 'shipping-time',
]);

/** 停用词：话题比较时不计入的通用词。 */
const STOPWORDS = new Set([
  '这个', '那个', '我们', '你们', '可以', '什么', '怎么', '怎样', '如何', '请问', '亲', '一下',
  '现在', '还有', '然后', '就是', '不是', '没有', '一个', '的话', '以及', '还是', '这样', '那样',
  '处理', '怎么', '什么', '事情', '情况', '问题', '一般', '如果', '或者', '并且', '而且',
]);

/**
 * 售后主题补充分类。
 *
 * conversationTopic 已有的 quality 只覆盖「质量/破损/瑕疵/损坏/坏了/有问题」，
 * 但买家问「售后怎么处理」「要退货吗」这类问法落不到任何主题 → general，
 * 放宽层就无从比较。这里按售后域补一档，与 conversationTopic 的判定结果合并使用。
 */
const AFTER_SALE_RE = /售后|退货|退换|换货|退款|质保|保修|维修|赔付|补偿|运费险|七天无理由/u;

/**
 * 领域关键词表：conversationTopic 覆盖不到的问法（搭配、水温、晾晒方式等）
 * 在这里补一档，便于「问题 ↔ 回复」按领域比较。
 *
 * 键是领域名，值是该领域的问法与答法关键词。命中同一领域即视为话题接近。
 */
const DOMAIN_WORDS: Array<{ name: string; re: RegExp }> = [
  { name: 'styling', re: /搭配|配什么|外套|鞋子|围巾|包|帽|首饰|好看|显瘦|显高|遮肉|版型|梨形|苹果型|身材/u },
  { name: 'care', re: /洗涤|清洗|机洗|手洗|干洗|晾晒|晾干|晒干|阴干|暴晒|水温|洗衣袋|柔顺剂|漂白|掉色|缩水|起球|熨烫|保养|打理|洗涤剂/u },
  { name: 'afterSale', re: /售后|退货|退换|换货|退款|质保|保修|维修|赔付|运费险|七天无理由|质量问题/u },
  { name: 'size', re: /尺码|码数|尺寸|穿什么码|选什么码|多大码|哪个码|偏大|偏小|腰围|臀围|胸围|身高|体重|围度|码表/u },
  { name: 'craft', re: /工艺|做工|走线|缝线|包边|锁边|内衬|耐穿|开线|脱线|线头|拉链|纽扣|面料纹路/u },
  { name: 'material', re: /材质|面料|成分|含棉|棉含量|聚酯|涤纶|手感|透气|厚度|真丝|羊毛|羊绒|亚麻|锦纶|氨纶/u },
  { name: 'color', re: /色差|颜色差异|颜色|实物|图片|详情页|主图|上身效果|显色/u },
  { name: 'media', re: /买家秀|实拍|视频|照片|晒图|实拍视频|主图|轮播|评价|评论/u },
  { name: 'logistics', re: /物流|快递|配送|派送|签收|单号|运费|包邮|发货|出库|多久发|到货|收到|几天到/u },
  { name: 'inventory', re: /库存|现货|缺货|预售|补货|有货|什么时候有/u },
  { name: 'promotion', re: /优惠|折扣|活动|便宜|优惠券|券|满减|赠品|包邮|立减|秒杀/u },
];

/** 文本命中的领域集合。 */
function domainsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const d of DOMAIN_WORDS) if (d.re.test(text)) out.add(d.name);
  return out;
}

/** 从文本中抽取用于话题比较的关键词（中文按 2 字滑窗，英文数字整取）。 */
function keywords(text: string): string[] {
  const out = new Set<string>();
  const zh = text.replace(/[^一-龥]+/g, ' ');
  for (const chunk of zh.split(/\s+/).filter(Boolean)) {
    if (chunk.length === 1) { out.add(chunk); continue; }
    for (let i = 0; i + 2 <= chunk.length; i += 1) {
      const bigram = chunk.slice(i, i + 2);
      if (!STOPWORDS.has(bigram)) out.add(bigram);
    }
  }
  const en = text.match(/[a-zA-Z]{2,}|\d{2,}/g);
  for (const token of en || []) out.add(token.toLowerCase());
  return [...out];
}

/** 两个文本的关键词重合比例（以较短一侧为分母，避免长回复稀释）。 */
function overlapRatio(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  const setLong = new Set(long);
  let hit = 0;
  for (const word of short) if (setLong.has(word)) hit += 1;
  return hit / short.length;
}

/** 问题 / 回复各自的话题（conversationTopic + 售后补充）。 */
function topicOf(text: string): ConversationTopic {
  const base = conversationTopic({ seq: 0, question: text, keyPoints: [] } as never);
  if (base !== 'general') return base;
  if (AFTER_SALE_RE.test(text)) return 'quality';
  return base;
}

/**
 * 主题是否算「类似」。
 *
 * 判定顺序：
 *  1. 双方主题相同且都不是 general → 类似（最强的信号）；
 *  2. 一方是 general、另一方不是 → 看关键词重合（≥ 0.34）→ 类似；
 *  3. 主题不同 → 若关键词重合足够高（≥ 0.5）也算类似（买家问法与客服用词不一致的常见情形）。
 */
function isSimilarTopic(question: string, reply: string): { similar: boolean; topic: ConversationTopic } {
  const qTopic = topicOf(question);
  const rTopic = topicOf(reply);
  const qWords = keywords(question);
  const rWords = keywords(reply);
  const ratio = overlapRatio(qWords, rWords);

  // 领域匹配优先：conversationTopic 覆盖不到的问法（搭配、水温、售后…）靠领域表比较。
  // 双方命中同一领域即视为话题接近；命中不同领域则不算接近。
  const qDomains = domainsOf(question);
  const rDomains = domainsOf(reply);
  if (qDomains.size && rDomains.size) {
    for (const d of qDomains) {
      if (rDomains.has(d)) return { similar: true, topic: qTopic };
    }
    // 领域完全不同，且关键词重合也不足 → 明显答非所问
    if (ratio < 0.5) return { similar: false, topic: qTopic };
  }

  if (qTopic !== 'general' && qTopic === rTopic) return { similar: true, topic: qTopic };
  if (qTopic !== 'general' && rTopic === 'general' && ratio >= 0.34) return { similar: true, topic: qTopic };
  if (qTopic !== rTopic && ratio >= 0.5) return { similar: true, topic: qTopic };
  if (qTopic === 'general' && rTopic !== 'general' && ratio >= 0.34) return { similar: true, topic: rTopic };
  return { similar: false, topic: qTopic };
}

/**
 * 判断一条回复是否应当被放宽放行。
 *
 * @param question 买家本轮问题
 * @param reply    客服回复原文
 * @param intent   买家问题的意图；只有通用问题（general）才放宽，
 *                 有专属答案格式的意图保持严格判定。
 */
export function evaluateRelaxation(question: string, reply: string, intent?: string): RelaxationResult {
  const text = String(reply || '').trim();
  if (!text) return { relaxed: false };

  // 0) 有专属严格答案格式的意图不放宽（晾晒问机洗、换货问尺码表、物流问发货时间等）
  if (intent && intent !== 'general' && STRICT_INTENTS.has(intent)) return { relaxed: false };

  // 1) 敷衍：永不放宽
  if (PERFUNCTORY_RE.test(text)) return { relaxed: false };

  // 2) 等待 / 处理中 / 打太极：永不放宽
  if (WAIT_OR_PROCESS_RE.test(text)) return { relaxed: false };

  // 3) 否定式承诺：明确说不能保证/不确定，即便提到时长也不放行
  if (NEGATED_PROMISE_RE.test(text)) return { relaxed: false };

  const { similar, topic } = isSimilarTopic(question, text);
  if (!similar) return { relaxed: false, topic };

  // 4) 与问题类似：放行。若回复里明确给出了服务性动作，依据更充分。
  const hasServiceAction = SERVICE_REPLY_RE.test(text);
  return {
    relaxed: true,
    topic,
    reason: hasServiceAction
      ? '回复内容与客户问题相关，且给出了具体的服务动作，判定为已回答'
      : '回复内容与客户问题属于同一话题，判定为已回答',
  };
}
