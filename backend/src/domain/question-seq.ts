import { ScriptQuestion } from './types';
import { orderStageForQuestion } from './order';
import { conversationTopic } from './semantic-goals';

/** 构建剧本所需的内容切片（买家咨询内容的最小输入）。 */
export interface QuestionSeqSource {
  question_list: string[];
  key_points: string[][];
  stage?: string | null;
  /** 必须转接主管才算处理好的问题序号（0 基），越界项会被忽略。 */
  transferIdxs?: number[];
}

function derivedQuestionFor(question: string, index: number, used: Set<string>, onExhausted?: () => string): string {
  const text = String(question || '');
  const topicTemplates: Array<[RegExp, string[]]> = [
    [/发货|出库|多久发/u, ['那一般什么时候可以发出呢？', '发出后大概多久能收到呢？']],
    [/物流|快递|配送|到货|签收/u, ['那物流大概几天能到呢？', '如果物流停滞，可以帮我跟进吗？']],
    [/^(?=[\s\S]*(?:搭配|怎么配|配什么|配哪|好搭))(?=[\s\S]*(?:衣服|上衣|裙|裤|外套|服饰|服装|大衣|西装|风衣|夹克|开衫|毛衣|卫衣|T恤|鞋|靴))[\s\S]*$/u, [
      '这款商品适合搭配什么颜色的外套呢？',
      '如果想穿得休闲一些，鞋子可以怎么搭配呢？',
      '通勤时搭配这款商品，外套长度怎么选比较合适？',
      '想让整体搭配更协调，包包可以选什么风格呢？',
      '搭配这款商品时，鞋跟高度怎么选更合适呢？',
    ]],
    [/尺码|尺寸|身高|体重|版型|穿.{0,8}码|偏大|偏小/u, ['那我这个身材应该怎么选尺码呢？', '如果尺码不合适，可以换吗？']],
    [/买家秀|实拍|实物图|视频/u, ['这款商品的买家秀或实拍视频在哪里可以看呢？', '实拍图片能看清这款商品的颜色和细节吗？']],
    [/洗涤|干洗|机洗|水洗|手洗|清洗|洗标/u, ['清洗这件衣服时有哪些需要注意的地方呢？', '如果不适合机洗，这件衣服应该怎么清洗呢？']],
    [/材质|面料|透气|厚度|成分|含棉|聚酯|涤纶|纤维/u, ['那穿起来会不会闷或不舒服呢？', '平时清洗和打理有什么要注意的吗？']],
    [/做工|走线|质量|瑕疵|损坏/u, ['如果收到后发现问题，售后怎么处理呢？', '这种情况可以退换或补发吗？']],
    [/工艺|包边|锁边|内衬|领口|袖口|针脚|细节|耐穿/u, ['这种工艺日常耐穿吗，清洗打理要注意什么？', '如果做工细节有问题，售后可以处理吗？']],
    [/优惠|折扣|活动|便宜|优惠券/u, ['那现在下单能享受什么优惠呢？', '优惠可以和其他活动一起使用吗？']],
    [/退款|退货|换货|售后/u, ['那具体需要怎么提交售后申请呢？', '处理结果一般什么时候能出来呢？']],
    [/地址|订单|下单|支付|付款/u, ['那下单后还能修改订单信息吗？', '付款后大概什么时候可以安排发货呢？']],
  ];
  const matched = topicTemplates.find(([pattern]) => pattern.test(text))?.[1];
  const candidates = matched?.length
    ? matched
    : [`关于“${text.replace(/[？?！!。\s]+$/u, '')}”，还有哪些需要注意的呢？`];
  // 从 index 对应位置起找本轮还没用过的问法，避免多个不同父题兜底到同一句。
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[(index + i) % candidates.length];
    if (!used.has(candidate)) return candidate;
  }
  if (onExhausted) return onExhausted();
  // 旧版序列保留原有兜底行为。
  const topic = text.replace(/[？?！!。\s]+$/u, '');
  return `关于“${topic}”，可以再帮我确认一下吗？`;
}

/** 只有当前主题的补题耗尽才会从其他咨询方向中选题。问题只询问信息，不预设商品事实。 */
const CROSS_TOPIC_QUESTIONS: Array<{ topic: string; question: string }> = [
  { topic: 'shipping', question: '请问下单后一般多久发货呢？' },
  { topic: 'delivery', question: '请问在哪里可以查看物流进度呢？' },
  { topic: 'exchange', question: '如果收到的商品不合适，可以申请换货吗？' },
  { topic: 'refund', question: '如果商品不合适，如何申请退货呢？' },
  { topic: 'promotion', question: '请问这件商品目前有什么优惠活动吗？' },
  { topic: 'payment', question: '付款时可以使用哪些支付方式呢？' },
  { topic: 'order', question: '下单后在哪里可以查看订单进度呢？' },
  { topic: 'inventory', question: '请问这件商品现在有现货吗？' },
  { topic: 'fit', question: '请问尺码表在哪里可以查看呢？' },
  { topic: 'material', question: '请问在哪里可以查看商品的面料成分呢？' },
  { topic: 'care', question: '请问商品的洗护说明在哪里查看呢？' },
  { topic: 'craft', question: '请问在哪里可以查看商品做工的细节图呢？' },
  { topic: 'shipping', question: '订单的出库时间在哪里查看呢？' },
  { topic: 'delivery', question: '请问物流进度在哪里查询呢？' },
  { topic: 'exchange', question: '需要换货的话，应该怎样申请呢？' },
  { topic: 'refund', question: '请问退货申请应该在哪里提交呢？' },
  { topic: 'promotion', question: '请问购买时可以使用优惠券吗？' },
  { topic: 'payment', question: '下单后在哪里可以完成付款呢？' },
  { topic: 'order', question: '请问如何查看自己下的订单呢？' },
  { topic: 'inventory', question: '请问怎样查看商品是否有现货呢？' },
  { topic: 'fit', question: '请问选尺码时应该参考哪里的信息呢？' },
  { topic: 'material', question: '请问商品详情里的材质信息在哪里看呢？' },
  { topic: 'care', question: '请问洗涤方法可以在哪查看呢？' },
  { topic: 'craft', question: '请问可以在哪里看做工细节呢？' },
  { topic: 'contact', question: '请问有问题时可以通过什么方式联系商家呢？' },
  { topic: 'packaging', question: '请问商品一般会怎样包装呢？' },
  { topic: 'invoice', question: '请问购买后如何申请发票呢？' },
  { topic: 'freight', question: '请问运费是怎么计算的呢？' },
];

function crossTopicQuestion(questions: ScriptQuestion[], parent: ScriptQuestion, currentSeq: number, skippedSeqs: number[]): string {
  const used = new Set(questions.map((q) => q.question.trim()));
  const skipped = new Set(skippedSeqs);
  const asked = questions.filter((q) => q.seq <= currentSeq && !skipped.has(q.seq));
  const topics = new Set<string>(asked.map((q) => conversationTopic(q)));
  topics.add(conversationTopic(parent));
  // 一个问题可能同时提到多个主题，不能只靠单一主题分类器去重。
  const mentioned: Array<[string, RegExp]> = [
    ['shipping', /发货|发出|出库/u], ['delivery', /物流|快递|配送|到货|签收/u],
    ['exchange', /换货|换码|退换/u], ['refund', /退款|退货|退钱|退换/u],
    ['promotion', /优惠|活动|折扣|优惠券/u], ['payment', /付款|支付|催付/u],
    ['order', /订单|下单/u], ['inventory', /现货|预售|库存|缺货/u],
    ['fit', /尺码|码数|尺寸|身高|体重|版型/u], ['material', /面料|材质|成分|含棉|纤维/u],
    ['care', /洗涤|洗护|清洗|机洗|水洗|手洗/u], ['craft', /做工|工艺|走线|包边|锁边/u],
    ['contact', /联系.{0,6}(?:商家|客服)|(?:商家|客服).{0,6}联系/u], ['packaging', /包装|包裹怎么包/u],
    ['invoice', /发票|开票/u], ['freight', /运费/u],
  ];
  for (const question of [...asked, parent]) {
    for (const [topic, pattern] of mentioned) if (pattern.test(question.question)) topics.add(topic);
  }
  const available = CROSS_TOPIC_QUESTIONS.find((candidate) => !topics.has(candidate.topic) && !used.has(candidate.question));
  if (!available) throw new Error('没有可用于补足最低轮次的跨话题问题');
  return available.question;
}

/** 为短剧本补充同主题问题，供会话在不足最低轮次时使用。 */
export function createMinimumRoundQuestion(questions: ScriptQuestion[], parent: ScriptQuestion,
  context?: { pending: boolean; agentReplies: string[]; shippingAnswered?: boolean; currentSeq?: number; skippedSeqs?: number[] }): ScriptQuestion {
  const used = new Set(questions.map((question) => question.question));
  const count = questions.filter((question) => question.derivedFromSeq === parent.seq).length;
  let contextual: string | undefined;
  let triedContextualCandidates = false;
  if (context?.pending) {
    triedContextualCandidates = true;
    // 缺少资料时转向可执行的信息补充，不再次催问尚未核实的结论。
    const material = /材质|面料|成分|含棉|聚酯|纤维/u.test(parent.question);
    const choices = material
      ? ['我收到衣服后，应该在哪里查看面料成分标识呢？', '成分标签看不清时，我怎么提供信息方便您核实呢？']
      : ['我需要提供哪些信息，方便您核实这个问题呢？', '我应该在哪里找到您核实需要的商品信息呢？'];
    contextual = choices.find((text) => !used.has(text));
  } else if (context && /发货|发出|出库/u.test(parent.question) && (context.shippingAnswered ?? context.agentReplies.some((reply) =>
    /\d+\s*(?:小时|天|日)(?:内|左右)?(?:安排)?(?:发货|发出|出库)/u.test(reply) &&
    !/不确定|不知道|不清楚|无法|不能|不保证|不承诺|不一定|可能|或许/u.test(reply)))) {
    triedContextualCandidates = true;
    contextual = ['发出后大概多久能收到呢？', '发出后在哪里查看物流进度呢？', '如果物流停滞，可以帮我跟进吗？']
      .find((text) => !used.has(text));
  } else if (context && /尺码|尺寸|穿.{0,8}码|偏大|偏小/u.test(parent.question)) {
    triedContextualCandidates = true;
    const replies = context.agentReplies.join(' ');
    const choices: Array<[RegExp, string]> = [
      [/腰围|臀围|腰臀围/u, '挑选尺码时，需要对照尺码表上的哪些围度呢？'],
      [/换货|换码|退换|调换/u, '如果尺码不合适，可以换吗？'],
      [/合身|宽松|松紧/u, '喜欢穿得宽松一些时，应该怎么参考尺码表呢？'],
    ];
    contextual = choices.find(([answered, text]) => !answered.test(replies) && !used.has(text))?.[1];
  } else if (context && /洗涤|干洗|机洗|水洗|清洗/u.test(parent.question)) {
    triedContextualCandidates = true;
    const replies = context.agentReplies.join(' ');
    const choices: Array<[RegExp, string]> = [
      [/水温|温水|冷水|度/u, '清洗这件衣服时，水温有什么要求呢？'],
      [/晾晒|暴晒|阴干|晾干/u, '清洗后应该怎么晾晒这件衣服呢？'],
      [/洗衣袋/u, '清洗这件衣服需要使用洗衣袋吗？'],
    ];
    contextual = choices.find(([answered, text]) => !answered.test(replies) && !used.has(text))?.[1];
  }
  let switchedTopic = false;
  const chooseOtherTopic = () => {
    switchedTopic = true;
    return crossTopicQuestion(questions, parent, context?.currentSeq ?? Math.max(0, ...questions.map((q) => q.seq)), context?.skippedSeqs ?? []);
  };
  const text = contextual || (context && triedContextualCandidates
    ? chooseOtherTopic()
    : derivedQuestionFor(parent.question, count, used, context ? chooseOtherTopic : undefined));
  return {
    seq: Math.max(0, ...questions.map((question) => question.seq)) + 1,
    question: text,
    ...(switchedTopic ? { topicTransition: true } : {}),
    keyPoints: parent.automaticEvaluation ? [] : ['有效回应'],
    ...(parent.automaticEvaluation ? { automaticEvaluation: true } : {}),
    sourceType: 'derived',
    requiresContext: true,
    derivedFromSeq: parent.seq,
    goalPriority: 'secondary',
    stage: parent.stage,
    orderStage: switchedTopic ? orderStageForQuestion({ stage: parent.stage, question: text }) : orderStageForQuestion(parent),
  };
}

/**
 * 由一条买家咨询内容构建剧本题干序列（方案 4.5 兜底规则）。
 *
 * 规则：
 * 1. 问题按 question_list 顺序展开，要点与问题一一对应；
 *    缺失要点时退化为「有效回应」，避免该轮无法得分。
 * 2. transferIdxs 标记的问题需要转接主管才算处理好（判定见 domain/scoring.ts）。
 * 3. 原始咨询问题不足最低轮数时，只围绕已有问题补充带来源标记的衍生追问；
 *    不注入跨主题通用问题。超过上限仍截断。
 *
 * 这样可以避免“工艺细节”场景被自动插入“发货/优惠/竞品比较”等无关问题。
 */
export function buildQuestionSeq(qa: QuestionSeqSource, rounds: [number, number]): ScriptQuestion[] {
  const [, maxRounds] = rounds;
  const transferIdxs = new Set(qa.transferIdxs || []);
  const list = Array.isArray(qa.question_list) ? qa.question_list : [];
  const points = Array.isArray(qa.key_points) ? qa.key_points : [];

  // 问题级接待阶段：目前整条内容共用一个阶段，追问也随它（字段留在这里，
  // 是为了将来出现「售前内容夹带售后问题」时，推送端能按问题决定要不要生成订单）
  const questionStage: 'presale' | 'aftersale' = qa.stage === 'aftersale' ? 'aftersale' : 'presale';
  const seq: ScriptQuestion[] = list.map((question, i) => ({
    seq: i + 1,
    question,
    keyPoints: points[i] && points[i].length ? points[i] : ['有效回应'],
    sourceType: 'core',
    needTransfer: transferIdxs.has(i),
    stage: questionStage,
  }));
  const limited = seq.slice(0, maxRounds);
  const minRounds = Math.min(Math.max(1, rounds[0] || limited.length), maxRounds);
  const derived: ScriptQuestion[] = [];
  let derivedIndex = 0;
  const usedQuestions = new Set(limited.map((q) => q.question));
  while (limited.length + derived.length < minRounds && limited.length) {
    const parent = limited[derivedIndex % limited.length];
    const duplicateIndex = derived.filter((item) => item.derivedFromSeq === parent.seq).length;
    const derivedText = derivedQuestionFor(parent.question, duplicateIndex, usedQuestions);
    usedQuestions.add(derivedText);
    derived.push({
      seq: limited.length + derived.length + 1,
      question: derivedText,
      keyPoints: ['有效回应'],
      sourceType: 'derived',
      requiresContext: true,
      derivedFromSeq: parent.seq,
      goalPriority: 'secondary',
      stage: parent.stage,
      orderStage: orderStageForQuestion(parent),
    });
    derivedIndex += 1;
  }
  // 原始问题保持顺序，衍生问题追加在后面，并带上来源轮次供运行时保持关联主题。
  return [...limited, ...derived].map((item) => ({ ...item, orderStage: orderStageForQuestion(item) }));
}


function triggerConditionsForOptionalQuestion(question: string): ScriptQuestion['triggerConditions'] {
  const text = String(question || '').trim();
  if (/优惠|活动|优势|别家|考虑一下/u.test(text)) {
    return { stages: ['decision'], minResolutionScore: 70, minPurchaseIntent: 45 };
  }
  if (/地址|快递|催.*发货|订单|收货人|电话|备注/u.test(text)) {
    return { stages: ['decision'], minResolutionScore: 70, requiresOrder: true };
  }
  if (/多久能处理好|什么时候能给我结果|等了好几天/u.test(text)) {
    return {
      stages: ['clarification', 'decision'],
      afterBusinessAction: ['ship_goods', 'ship_negotiate', 'after_sale_proxy'],
      requiresOrder: true,
    };
  }
  if (/投诉|质量也太差/u.test(text)) {
    return { stages: ['clarification', 'decision'], minResolutionScore: 0 };
  }
  if (/退货|退款|补偿|售后/u.test(text)) {
    return { stages: ['clarification', 'decision'], requiresOrder: true };
  }
  return { stages: ['clarification', 'decision'] };
}

const LEGACY_GENERIC_FILLERS = new Set([
  '那大概多久能处理好呢？',
  '我再看一下别家，你们有什么优势吗？',
  '现在下单还有什么额外优惠吗？',
  '这个和详情页写的不太一样啊',
  '你能帮我确认一下吗？',
  '那我再考虑一下吧',
  '如果不行的话我该怎么办？',
  '什么时候能给我结果？',
  '我要投诉你们！',
  '你们这个质量也太差了吧',
  '我不要补偿，我就要退货',
  '已经等了好几天了，还没人处理',
]);

/**
 * 兼容已经落库的旧剧本：
 * 旧版会为凑最低轮数注入通用问题，并且这些问题可能被随机提升为主目标。
 * 新生成剧本已不再这么做；这里仅识别“自动语义目标 + 无 sourceType”的旧快照，
 * 将已知通用补题降级为 optional/context-dependent，运行时即可跳过不合逻辑的旧题，
 * 无需立即改数据库历史数据。
 */
export function normalizeLegacyQuestionSeq(questions: ScriptQuestion[]): ScriptQuestion[] {
  // 只修正带明确来源标记、且与旧版自动兜底话术完全一致的题目。
  // 人工题目及无法生成更具体补题的未知主题保留原样。
  const usedQuestions = new Set(questions.map((question) => question.question));
  const sourceQuestions = questions.map((question, index) => {
    if (question.sourceType !== 'derived' || question.derivedFromSeq === undefined) return question;
    const parent = questions.find((candidate) => candidate.seq === question.derivedFromSeq);
    if (!parent) return question;
    const topic = String(parent.question || '').replace(/[？?！!。\s]+$/u, '');
    const generic = [
      `关于“${topic}”，还有哪些需要注意的呢？`,
      `关于“${topic}”，可以再帮我确认一下吗？`,
    ];
    if (!generic.includes(question.question)) return question;
    const derivedIndex = questions.slice(0, index)
      .filter((candidate) => candidate.sourceType === 'derived' && candidate.derivedFromSeq === parent.seq).length;
    const replacement = derivedQuestionFor(parent.question, derivedIndex, usedQuestions);
    if (generic.includes(replacement)) return question;
    usedQuestions.add(replacement);
    return {
      ...question,
      question: replacement,
      ...(question.baseQuestion === question.question ? { baseQuestion: replacement } : {}),
      ...(question.conversationPlan?.promptTemplates?.[0] === question.question ? {
        conversationPlan: {
          ...question.conversationPlan,
          promptTemplates: question.conversationPlan.promptTemplates.map((text) => text === question.question ? replacement : text),
        },
      } : {}),
    };
  });
  const legacyAutoGenerated = sourceQuestions.some((question) =>
    question.sourceType === undefined &&
    (question.semanticGoals || []).some((goal) => String(goal.id || '').startsWith('auto-goal-'))
  );
  const legacyGenericCount = sourceQuestions.filter(
    (question) =>
      question.sourceType === undefined &&
      LEGACY_GENERIC_FILLERS.has(String(question.question || '').trim()),
  ).length;
  // 旧关键词剧本没有 auto-goal 标记；出现 2 条以上已知“补轮数”话术时，也可高置信识别为旧填充结构。
  const legacyPaddedKeywordScript =
    sourceQuestions.length >= 4 &&
    legacyGenericCount >= 2 &&
    sourceQuestions.every((question) => question.sourceType === undefined);
  if (!legacyAutoGenerated && !legacyPaddedKeywordScript) return sourceQuestions;

  const normalized = sourceQuestions.map((question) => {
    if (!LEGACY_GENERIC_FILLERS.has(String(question.question || '').trim())) {
      return { ...question, sourceType: question.sourceType || 'core' };
    }
    const nextQuestion: ScriptQuestion = {
      ...question,
      sourceType: 'optional',
      requiresContext: true,
      goalPriority: 'secondary',
      triggerConditions: question.triggerConditions || triggerConditionsForOptionalQuestion(question.question),
      semanticGoals: (question.semanticGoals || []).map((goal) => ({
        ...goal,
        requiredPoints: (goal.requiredPoints || []).map((point) => {
          const normalizedPoint = { ...point };
          delete normalizedPoint.isPrimary;
          return normalizedPoint;
        }),
      })),
    };
    delete nextQuestion.primaryGoal;
    delete nextQuestion.customerGoal;
    return nextQuestion;
  });

  // 如果旧版随机主目标正好落在通用补题上，降级后要把第一个真实 core 问题补成主目标。
  if (!normalized.some((question) => (question.sourceType || 'core') === 'core' && question.goalPriority === 'primary')) {
    const index = normalized.findIndex((question) =>
      (question.sourceType || 'core') === 'core' &&
      (question.keyPoints || []).some((point) => String(point || '').trim() && point !== '有效回应')
    );
    if (index >= 0) {
      const primaryPoint = (normalized[index].keyPoints || []).find((point) => String(point || '').trim() && point !== '有效回应');
      normalized[index] = {
        ...normalized[index],
        goalPriority: 'primary',
        primaryGoal: primaryPoint,
        baseQuestion: normalized[index].baseQuestion || normalized[index].question,
        semanticGoals: (normalized[index].semanticGoals || []).map((goal, goalIndex) => ({
          ...goal,
          requiredPoints: (goal.requiredPoints || []).map((point, pointIndex) => ({
            ...point,
            ...(goalIndex === 0 && pointIndex === 0 ? { isPrimary: true } : {}),
          })),
        })),
      };
    }
  }

  return normalized;
}

/**
 * 客户 2026-10-03：一次接待里的问题要**按比例混合售前 / 售后**——
 * 大部分是「还没有订单、只咨询商品信息」的售前问题，小部分是「买完商品后」的订单类售后问题。
 *
 * 做法：保留剧本本身的话题作为主体（开头几轮不动），把**靠后的若干轮**替换成另一阶段的问题，
 * 这样既不会让开场就跑题，也能保证「大部分 + 小部分」的比例。
 *
 * @param seq       剧本原有的问题序列（已经带上 stage / orderStage）
 * @param ratioPct  另一阶段问题的占比（0～80，来自系统参数 aftersaleQuestionRatio）
 * @param pool      用来替换的题库（见 db/seed-content.ts 的 ORDER_AFTERSALE_QUESTIONS / PRESALE_PRODUCT_QUESTIONS）
 * @param stage     被替换进来的问题属于哪个阶段（售前 / 售后）
 * @param offset    从题库第几条开始取（同一局内不同会话错开，避免千篇一律）
 */
export function mixQuestionSeq(
  seq: ScriptQuestion[],
  options: { ratioPct: number; pool: { question: string; keyPoints: string[] }[]; stage: 'presale' | 'aftersale'; offset?: number }
): ScriptQuestion[] {
  const { pool, stage } = options;
  const ratio = Math.max(0, Math.min(80, Math.round(Number(options.ratioPct) || 0)));
  if (!pool.length || ratio <= 0 || seq.length < 2) return seq;

  // 「小部分」：最多替换掉一半；第一轮永远保留为剧本自己的开场。
  // 2 轮短剧本在 50% 配比下允许替换第 2 轮，否则 C14 永远无法满足配置比例。
  const count = Math.min(
    Math.max(1, Math.round((seq.length * ratio) / 100)),
    Math.floor(seq.length / 2),
    seq.length - 1,
  );
  if (count <= 0) return seq;

  const offset = Math.max(0, Math.round(Number(options.offset) || 0));
  const next = [...seq];
  // Preserve a generated primary-goal question so the session still exercises its detailed ask.
  // Replace the latest eligible questions first, then fall back to earlier non-opening rounds.
  const replacementIndexes = seq
    .map((item, index) => index)
    .filter((index) => index > 0 && seq[index].goalPriority !== 'primary')
    .slice(-count);
  for (let i = 0; i < replacementIndexes.length; i += 1) {
    const source = pool[(offset + i) % pool.length];
    const index = replacementIndexes[i];
    next[index] = {
      ...next[index],
      question: source.question,
      keyPoints: source.keyPoints && source.keyPoints.length ? source.keyPoints : ['有效回应'],
      sourceType: 'optional',
      requiresContext: true,
      triggerConditions: triggerConditionsForOptionalQuestion(source.question),
      needTransfer: false,
      stage,
    };
    // A replacement question must not inherit semantic goals authored for the old text.
    delete next[index].semanticGoals;
    delete next[index].primaryGoal;
    if (next[index].goalPriority) next[index].goalPriority = 'secondary';
  }
  // 替换后重新算订单状态：售后里的「催发货 / 改地址 / 改快递」发生在发货前 → 待发货
  return next.map((item) => ({ ...item, orderStage: orderStageForQuestion(item) }));
}
