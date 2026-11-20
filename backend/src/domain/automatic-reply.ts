import { JudgeContext, JudgeResult, isHedge, isPendingVerification, isPerfunctory, judgeReply } from './reply-judge';
import { evaluateRelaxation } from './reply-relaxation';
import { conversationTopic } from './semantic-goals';

export type ReplyIntent = 'dry-clean-required' | 'dry-clean-allowed' | 'exchange' | 'media-location' | 'media-available' | 'color-difference' | 'compound' | 'size-recommendation' | 'delivery-time' | 'logistics-location' | 'drying-method' | 'shipping-time' | 'general';
export interface ReplyAssessment extends JudgeResult {
  intent?: ReplyIntent;
  status?: 'resolved' | 'partial' | 'pending' | 'unanswered' | 'unsupported';
  reason?: string;
  evidence?: string[];
  acceptedGuidance?: true;
  missing?: string[];
}

/** 意图来自买家问题，不依赖编辑剧本时维护期望要点。 */
export function replyIntent(question: string): ReplyIntent {
  if (/什么时候|多久|几天|多长时间/u.test(question) && /收到|送达|到货|送到|抵达|到达|多久到|几天到/u.test(question)) return 'delivery-time';
  if (/物流|快递/u.test(question) && /哪里|在哪|如何查看|怎么查看|怎么查|查询|查看/u.test(question)) return 'logistics-location';
  if (/什么时候|多久|几天|多长时间/u.test(question) && /发货|发出|出库/u.test(question) && !/现货/u.test(question)) return 'shipping-time';
  if (/怎么|如何|怎样|能否|可以|能.{0,4}吗/u.test(question) && /晾晒|晾干|晒干|暴晒|阴干/u.test(question)) return 'drying-method';
  if (/干洗/u.test(question)) {
    if (/要不要|需不需要|需要|必须|用不用|要干洗|需干洗/u.test(question)) return 'dry-clean-required';
    if (/能|可以|可不可以|允许|适合|支持/u.test(question)) return 'dry-clean-allowed';
  }
  if (/换货|换码|换.{0,5}(?:码|尺寸)|(?:可以|能|可不可以|能不能)换|换[吗么嘛]/u.test(question)) return 'exchange';
  if (/实拍|买家秀|视频|图片|照片|晒图/u.test(question)) {
    if (/哪里|在哪|怎么看|如何查看|怎么查看|什么位置/u.test(question)) return 'media-location';
    if (/有没有|是否有|有.{0,12}[吗么嘛]|可以看|能看/u.test(question)) return 'media-available';
  }
  if (/色差|颜色差异/u.test(question)) return 'color-difference';
  return 'general';
}

/**
 * 时长表达（BUG-L2-SEMANTIC-001）。
 *
 * 原实现只认阿拉伯数字（\d+），"两三天""三天左右""四五天"这类中文数字一律匹配不上，
 * 于是语义完全正确的到货回答被判定为「尚未说明到货时效」→ unanswered →
 * 判「未确认解决」并扣解决率分（第X轮尚未确认解决，17.5 分）。
 *
 * 这里把数字部分同时覆盖阿拉伯数字与中文数字，序号词（第一、第三）不会被误命中，
 * 因为单位必须是小时/天/日/个工作日/周/星期。
 */
const DURATION_NUM = '(?:\\d+|[一二两三四五六七八九十半百]+)';
const DURATION_UNIT = '(?:小时|天|日|个工作日|周|星期)';
const DURATION_RE = new RegExp(
  `${DURATION_NUM}\\s*(?:(?:到|至|[-~～—])\\s*${DURATION_NUM})?\\s*个?\\s*${DURATION_UNIT}`,
  'u'
);
/** "就到了""才能到""到您手上"这类简写也属于到达表态，否则「两三天就到了」仍会被漏掉。 */
const ARRIVAL_VERB = /收到|送达|到货|送到|抵达|到达|能到|可到|到(?:了|啦|哦|呢|的|手|您|你)/u;
const SHORT_DURATION_RE = new RegExp(
  `^(?:亲|一般|通常|大概|预计|约|大约|大概是|大约是|需要|可能|会|要|差不多|\\s)*` +
    `${DURATION_NUM}\\s*(?:(?:到|至|[-~～—])\\s*${DURATION_NUM})?\\s*个?\\s*${DURATION_UNIT}` +
    `(?:左右|内|吧|哦|呢|哈|呀|的|\\s)*$`,
  'u'
);
const RELATIVE_DAY = /(?:今天|明天|后天|当日|次日|隔天)/u;
const NEGATED_TIMING = /不一定|不保证|无法|不能|不确定|可能不/u;

/**
 * 发货时效（BUG-L2-SEMANTIC-002）。
 *
 * 原实现要求「时长 + 动作」首尾紧邻：`\d+\s*(?:小时|天|日)(?:内|左右)?(?:安排)?(?:发货|发出|出库)`。
 * 中间一旦插入主语或副词（"就给您""会""给您"），整条证据链断裂，
 * "现货拍下48小时内就给您发出哦"这类完全正确的答复被判「尚未明确发货时效」→ unanswered，
 * 连带扣「第 X 轮尚未确认解决」的解决率分。
 *
 * 这里允许时长与动作之间夹 0~10 个字符，但用 [^。；;！!？?\n] 阻止跨句误吞，
 * 并用非贪婪 {0,10}? 优先匹配最近的动作词，避免把后一句的"出库"抢过来。
 * 与 delivery-time 的两段式口径（时长 + 到达动词）保持一致。
 */
const SHIP_ACTION = '(?:发货|发出|出库)';
/** 发货动作的正则对象，供上限式时长的「同句绑定」校验复用。 */
const SHIP_ACTION_RE = new RegExp(SHIP_ACTION, 'u');
const SHIP_GAP = '[^。；;！!？?\\n]{0,10}?';
const SHIP_DURATION_RE = new RegExp(
  `\\d+\\s*(?:小时|天|日|个工作日)\\s*(?:内|左右|之内|以内)?${SHIP_GAP}${SHIP_ACTION}`,
  'u'
);
const SHIP_DURATION_GLOBAL_RE = new RegExp(
  `(\\d+)\\s*(小时|天|日|个工作日)\\s*(?:内|左右|之内|以内)?${SHIP_GAP}${SHIP_ACTION}`,
  'gu'
);
const SHIP_NEGATED_RE = /不确定|不保证|不承诺|不一定|不能|无法|可能|或许|不发货|不发出|不出库|不敢|没法|没保证|难以保证|说不好|不好说/u;

/**
 * BUG-L3-INFERRED-TIMING（L3 语义判定测试报告 2026-11-20 23:24 线上复现）。
 *
 * 线上误判原句：「一般当天就安排发出，最晚不超过48小时，您放心～」
 * 老实现只认「阿拉伯数字+单位+动作」，两类语义正确的推断表达都拿不到证据：
 *   1) 中文相对日 + 发货动作：「当天就安排发出」「今天给您发货」「当日出库」
 *      ——「当天」是相对日而非 \d+，SHIP_DURATION_RE 无从匹配；
 *   2) 明确上限式时长：「最晚不超过48小时」「最多3天」「至多2天」
 *      ——数字后没有紧跟发货动作词（句子到此结束），同样匹配不上。
 *
 * 因此新增两条证据通道：
 *   - 相对日类：相对日 + 发货动作（动作是核心信号，相对日替代数字时长）；
 *   - 上限式类：必须有明确的上限引导词（最晚/最多/不超过…）+ 数字时长，
 *     且句子不得指向到达（收到/送达…）——否则那是到货时效，不能冒充发货时效。
 * 两类和老正则一样都经 SHIP_EXCLUDE_RE 排除否定 / 假设 / 疑问，守住准确率底线：
 *   - 「当天不一定能发出」「最晚不超过48小时，但不敢保证」→ 否定词排除；
 *   - 「最晚不超过48小时就能收到」→ 含到达动词，不算发货证据；
 *   - 裸「48小时内」（无引导词）仍须靠发货动作作证，跨句不误吞。
 */
const SHIP_RELATIVE_DAY = '(?:今天|今日|当天|当日|明天|次日|隔天|后天|今晚)';
const SHIP_RELATIVE_DAY_RE = new RegExp(`${SHIP_RELATIVE_DAY}${SHIP_GAP}${SHIP_ACTION}`, 'u');
const SHIP_DURATION_CAP_RE = new RegExp(
  `(?:最晚|最多|至多|不超过|不晚于|最迟)\\s*\\d+\\s*(?:小时|天|日|个工作日)\\s*(?:内|左右|之内|以内)?`,
  'u'
);
/**
 * 不作为发货时效证据的句子：否定 / 不确定 / 假设 / 复述疑问。
 * 中文逗号是句内停顿，发货时效必须按「句」判断（见 shipSentences），
 * 否则「48小时内，我们会尽快安排发货」会被逗号切成两段不完整的话而判失败。
 */
const SHIP_EXCLUDE_RE = new RegExp(`${SHIP_NEGATED_RE.source}|如果|假如|倘若|是否|[？?]`, 'u');

function assessment(intent: ReplyIntent, evidence: string[], missing: string[], pending: boolean): ReplyAssessment {
  const resolved = evidence.length > 0 && missing.length === 0;
  return {
    pass: resolved,
    signal: resolved ? 'key-point' : pending ? 'hedge' : 'off-topic',
    intent,
    status: resolved ? 'resolved' : evidence.length ? 'partial' : pending ? 'pending' : 'unanswered',
    reason: resolved ? '答复提供了与本轮问题对应的说明' : missing.join('；'), evidence, missing,
  };
}

/** 新版特定意图以对应答复片段为证据；旧版本沿用原判断。 */
export function assessAutomaticReply(ctx: JudgeContext & { buyerContext?: string[]; productMaterialDetails?: string }, version: 0 | 1 | 2): ReplyAssessment {
  const strict = assessAutomaticReplyStrict(ctx, version);
  // 放宽口径（2026-11-20）：严格判定没匹配上时，若回复不是敷衍 / 等待 / 核对，
  // 且内容与问题同话题，放行。语义错误类（unsupported）与部分命中（partial）不放宽。
  return version === 2 ? relaxIfSimilar(ctx, strict) : strict;
}

/**
 * 放宽兜底（2026-11-20 业务口径）。
 *
 * 仅作用于 status='unanswered'（完全没匹配上证据）这一档：
 *  - 'partial'（部分命中，如只给了部分要点）不放宽，避免掩盖要点缺失；
 *  - 'pending'（仍在核实）不放宽 —— 核对类由业务明确要求拦截；
 *  - 'unsupported'（方向错 / 自相矛盾 / 数据缺失）不放宽 —— 那是答案错了，不是没识别出来。
 */
function relaxIfSimilar(ctx: JudgeContext, result: ReplyAssessment): ReplyAssessment {
  if (result.pass) return result;
  if (result.status !== 'unanswered') return result;
  const relaxation = evaluateRelaxation(ctx.question, ctx.reply, result.intent);
  if (!relaxation.relaxed) return result;
  return {
    ...result,
    pass: true,
    signal: 'relaxed',
    status: 'resolved',
    reason: relaxation.reason,
    evidence: [ctx.reply],
    missing: [],
  };
}

function assessAutomaticReplyStrict(ctx: JudgeContext & { buyerContext?: string[]; productMaterialDetails?: string }, version: 0 | 1 | 2): ReplyAssessment {
  const result = judgeReply(ctx);
  const pendingVerification = isPendingVerification(ctx.reply);
  if (version === 2) {
    const intent = replyIntent(ctx.question);
    const compact = ctx.reply.replace(/[\s，。！？!?～~、；;：:]/gu, '');
    const processOnly = /^(?:亲您好|您好|亲)?(?:(?:麻烦|请)?稍等(?:一下|下)?|(?:这边|我们|我)?(?:来|会|先)?(?:帮您|为您)?(?:尽快)?(?:核实|确认|查询|查|处理)(?:一下|下)?)[哦呢哈呀]*$/u.test(compact);
    if (processOnly) return { pass: false, signal: 'perfunctory', intent, status: 'unanswered', reason: '仅有等待或处理动作，没有实际回答', evidence: [], missing: [ctx.question] };
    // 仅复述买家整句问题，再加“核实具体情况”，没有真实核实对象或行动。
    const normalizedQuestion = ctx.question.replace(/[\s，。！？!?～~、；;：:]/gu, '');
    const echoRemainder = normalizedQuestion.length >= 5 && compact.includes(normalizedQuestion)
      ? compact.replace(normalizedQuestion, '').replace(/亲您好|您好|亲|我|这边|先|会|来|帮您|为您|帮你|核实|确认后|确认一下|确认|查询|一下|的|具体情况|相关情况|再|回复您|回复你|告诉您|哦|呢|哈|呀|啊|哒/gu, '')
      : null;
    if (echoRemainder === '') return { pass: false, signal: 'perfunctory', intent, status: 'unanswered', reason: '只是复述问题并表示核实，没有实际答复或具体核实对象', evidence: [], missing: [ctx.question] };
    const measurements = ctx.reply.match(/(\d{2,3})\s*(?:厘米|cm).{0,8}?(\d{2,3})\s*(斤|公斤|kg)/iu);
    if (measurements && ctx.buyerContext !== undefined) {
      const height = measurements[1];
      const weightJin = Number(measurements[2]) * (/公斤|kg/iu.test(measurements[3]) ? 2 : 1);
      const known = [ctx.question, ...ctx.buyerContext].some((text) =>
        new RegExp(`${height}\\s*[/／]\\s*${weightJin}(?!\\d)`, 'u').test(text) ||
        (new RegExp(`${height}\\s*(?:厘米|cm)`, 'iu').test(text) &&
          (new RegExp(`${weightJin}\\s*斤`, 'u').test(text) || new RegExp(`${weightJin / 2}\\s*(?:公斤|kg)`, 'iu').test(text))));
      if (!known) return { pass: false, signal: 'off-topic', intent, status: 'unsupported', reason: '该买家的对话没有提供回复使用的身高体重', evidence: [], missing: ['请核实当前买家的身高体重'] };
    }
    if (isPerfunctory(ctx)) return { ...result, intent, status: 'unanswered', reason: '回复过短、重复或没有实际答复', evidence: [], missing: [ctx.question] };
    // 索要尺码所需的身材信息是有效推进，不能视作具体尺码已经确定。
    if (!/注意|注意事项/u.test(ctx.question) && /(?:穿(?:什么|多大|哪个)码|选(?:什么|多大|哪个)码|(?:这个|我的|我这).{0,8}身材.{0,8}选尺码|(?:推荐|建议).{0,6}尺码)/u.test(ctx.question) &&
        /(?:提供|告诉|告知|测量|量一下).{0,24}(?:身高|体重|腰围|臀围|腰臀围)/u.test(ctx.reply) &&
        !/(?:推荐|建议|参考|穿|选)\s*(?:[SMLX]{1,4}|\d{2,3})\s*码/iu.test(ctx.reply)) {
      return { pass: false, signal: 'off-topic', intent: 'size-recommendation', status: 'partial',
        reason: '已请求选码所需数据，尚未给出具体尺码', evidence: [ctx.reply], missing: [] };
    }
    const subQuestions = ctx.question.split(/[，；;。？?]|另外|还想问|并且/u).map((s) => s.trim()).filter(Boolean);
    const subIntents = new Set(subQuestions.map(replyIntent).filter((value) => value !== 'general'));
    if (subIntents.size > 1) {
      const parts = subQuestions.map((question) => assessAutomaticReply({ ...ctx, question }, 2));
      return assessment('compound', parts.flatMap((part) => part.evidence || []),
        parts.filter((part) => !part.pass).flatMap((part) => part.missing || [ctx.question]), parts.some((part) => part.status === 'pending'));
    }
    // 模拟题的商品资料未给出对应成分时，按客服是否回答该问题判定。
    const cottonRatio = /含棉|棉含量|棉的比例|棉占比/u.test(ctx.question);
    const polyester = /聚酯纤维|涤纶/u.test(ctx.question);
    const asksMaterial = /什么(?:面料|材质|成分)|(?:面料|材质|成分)是什么/u.test(ctx.question);
    const cottonAnswer = /(?:棉.{0,8}\d+(?:\.\d+)?\s*[%％]|\d+(?:\.\d+)?\s*[%％].{0,4}棉|不含棉|全棉|纯棉)/u;
    const polyesterAnswer = /聚酯纤维|涤纶/u;
    const materialAnswer = /棉|聚酯纤维|涤纶|羊毛|羊绒|真丝|桑蚕丝|亚麻|锦纶|氨纶|粘纤|腈纶|莱赛尔/u;
    const materialDetails = ctx.productMaterialDetails;
    if (materialDetails !== undefined && (cottonRatio || polyester || asksMaterial)) {
      const known = cottonRatio ? cottonAnswer.test(materialDetails)
        : polyester ? polyesterAnswer.test(materialDetails) || /100\s*[%％]|全棉|纯棉/u.test(materialDetails) : materialAnswer.test(materialDetails);
      const answer = cottonRatio ? cottonAnswer : polyester ? polyesterAnswer : materialAnswer;
      const evidence = ctx.reply.split(/[，。；;！!\n]/u).filter((part) => answer.test(part) &&
        !/是否|[？?]|不确定|不清楚|不知道|无法确认|不能确认|核实|查询|待确认|可能|如果/u.test(part));
      if (!known && evidence.length) {
        return { ...assessment(intent, evidence, [], false), acceptedGuidance: true };
      }
    }
    const guidanceSource = /含棉|棉含量|棉的比例/u.test(ctx.question)
      ? /成分(?:标签|标|表)|吊牌|洗标|商品详情页/u
      : /包边|锁边|走线|缝线/u.test(ctx.question)
        ? /实拍|细节图|缝线|走线|缝边|包边|锁边|质检/u
        : intent === 'dry-clean-required' || intent === 'dry-clean-allowed' ? /洗标|洗涤标签|洗涤说明/u : null;
    const informationLimit = /未标(?:注|明)?|没有明确|没有(?:具体|完整|可确认)|资料不足|信息不全|无法确认|不能确认|暂(?:时)?不清楚|以.{0,14}(?:为准|标注为准)/u;
    const nextStep = /核对|核实|查看|查阅|确认后|参考|对照|以.{0,14}为准/u;
    if (guidanceSource?.test(ctx.reply) && informationLimit.test(ctx.reply) && nextStep.test(ctx.reply) &&
        !/(?:无法|不能|不用|不必|无需)(?:再|去|帮您)?(?:查看|核对|核实|参考)/u.test(ctx.reply)) {
      return { ...assessment(intent, [ctx.reply], [], false), acceptedGuidance: true,
        reason: '已说明资料限制并提供对应核实方式' };
    }
    const clauses = ctx.reply.split(/[，。；;！!\n]|但是|不过|但/u).map((s) => s.trim()).filter(Boolean);
    // 核实中的问题描述、引用问题和不确定断言，不作为已经给出结论的证据。
    const statements = clauses.filter((s) => !/不确定|不知道|不清楚|核实|未确认|没确认|确认一下|查一下|查询|是否|有没有|能不能|需不需要|要不要|如果|假如|倘若|[？?]/u.test(s));
    // 到货时效与物流查看路径优先于“发出后”等时间背景词。
    if (/什么时候|多久|几天|多长时间/u.test(ctx.question) && /收到|送达|到货|送到|抵达|到达|多久到|几天到/u.test(ctx.question)) {
      const evidence = statements.filter((part) => {
        const duration = DURATION_RE.test(part);
        const arrival = ARRIVAL_VERB.test(part);
        const shortDuration = SHORT_DURATION_RE.test(part);
        const relativeArrival = RELATIVE_DAY.test(part) && arrival;
        return ((duration && (arrival || shortDuration)) || relativeArrival) && !NEGATED_TIMING.test(part);
      });
      const shippingOnly = SHIP_DURATION_RE.test(ctx.reply) && !evidence.length;
      const result = assessment('delivery-time', evidence, evidence.length ? [] : ['尚未说明到货时效'], pendingVerification);
      return shippingOnly && !pendingVerification ? { ...result, status: 'unsupported', reason: '发货时间不能替代到货时间' } : result;
    }
    if (/物流|快递/u.test(ctx.question) && /哪里|在哪|如何查看|怎么查看|怎么查|查询|查看/u.test(ctx.question)) {
      const evidence = statements.filter((part) => /订单|详情页|物流页|快递单号|物流信息/u.test(part) &&
        /物流|快递|进度|查询|查看/u.test(part) && !/不能|无法|不支持|不提供/u.test(part));
      if (!evidence.length) {
        const paths = ctx.reply.split(/[。；;！？!?\n]/u);
        evidence.push(...paths.filter((part) =>
          /(?:订单(?:详情|页)?|物流页).{0,24}(?:点击|点开|选择|进入|打开).{0,8}(?:查看物流|物流详情|物流跟踪|查看快递)/u.test(part) &&
          !/不能|无法|不支持|不提供|不知道|不确定|核实|是否|能不能|如果|假如/u.test(part)));
      }
      return assessment('logistics-location', evidence, evidence.length ? [] : ['尚未说明物流查询路径'], pendingVerification);
    }
    if (intent === 'drying-method') {
      const evidence = statements.filter((part) =>
        (/悬挂晾干|挂起来晾|平铺晾(?:干|晒)|阴干|自然晾干|(?:阴凉|通风).{0,12}(?:晾|晒)/u.test(part) &&
          !/(?:不要|不能|不宜|不建议|不可|避免).{0,10}(?:悬挂|挂起来|平铺|阴干|自然晾干)/u.test(part)) ||
        /(?:避免|不要|不能|不宜|不建议)(?:阳光直射|暴晒)/u.test(part));
      return assessment(intent, evidence, evidence.length ? [] : ['尚未说明晾晒方法'], pendingVerification);
    }
    if (/选(?:什么|多大|哪个)码/u.test(ctx.question) && !/注意|注意事项/u.test(ctx.question)) {
      const evidence = statements.filter((part) => (/(?:参考|建议|推荐|适合|穿|选|可以).{0,12}(?:[SMLX]{1,4}|\d{2,3})\s*码/iu.test(part) ||
        /(?:[SMLX]{1,4}|\d{2,3})\s*码(?:比较|更)?(?:合适|适合|可以|就好|就行)/iu.test(part)) &&
        !/不建议|不适合|不合适|不能|不确定|不知道/u.test(part));
      return assessment('size-recommendation', evidence, evidence.length ? [] : ['尚未给出具体尺码建议'], pendingVerification);
    }
    if (/选.{0,8}码/u.test(ctx.question) && /注意/u.test(ctx.question)) {
      const evidence = statements.filter((part) => /腰围|臀围|尺码表|尺寸|偏好|合身|宽松/u.test(part) && /量|对照|参考|结合|根据|选择/u.test(part));
      return assessment('size-recommendation', evidence, evidence.length ? [] : ['尚未说明选码注意事项'], pendingVerification);
    }
    // 明确发货时效应独立于库存主题判断；保留不确定和矛盾的限制。
    if (/什么时候|多久|几天|多长时间/u.test(ctx.question) && /发货|发出|出库/u.test(ctx.question) && !/现货/u.test(ctx.question)) {
      // 中文逗号是句内停顿，按逗号切分会把「48小时内，我们会尽快安排发货」拆成两段不完整的话，
      // 两段都匹配不上时长+动作。发货时效按「句」判断（句号/分号/问号/感叹号/换行才断句）。
      const shipSentences = ctx.reply.split(/[。；;！!？?\n]/u).map((s) => s.trim()).filter(Boolean);
      // 发货时效证据 = 老口径（数字+单位+动作） ∪ 中文相对日+动作 ∪ 上限式时长。
      // 三类都必须先过 SHIP_EXCLUDE_RE（否定 / 假设 / 疑问 / 不确定）这道公共闸门；
      // 上限式额外要求句子不指向到达动词，避免把到货时效当成发货时效。
      const evidence = shipSentences.filter((s) => {
        if (SHIP_EXCLUDE_RE.test(s)) return false;
        if (SHIP_DURATION_RE.test(s)) return true;
        if (SHIP_RELATIVE_DAY_RE.test(s)) return true;
        // 上限式时长（如「最晚不超过48小时」）本身不含发货动作，
        // 必须与发货动作同句出现才算证据，避免「最晚不超过48小时。我们会安排发货。」
        // 这种跨句拼接被误当成一条完整时效；同时排除指向到达的到货时效。
        const hasShipAction = SHIP_ACTION_RE.test(s);
        return SHIP_DURATION_CAP_RE.test(s) && hasShipAction && !ARRIVAL_VERB.test(s);
      });
      const durations = [...ctx.reply.matchAll(SHIP_DURATION_GLOBAL_RE)]
        .map((match) => Number(match[1]) * (match[2] === '小时' ? 1 : 24));
      // 中文「当天/今天」与数字时长（48小时）视为同一时效，不算矛盾；
      // 只有多个互不相同的数字时长才算矛盾。
      const contradictory = new Set(durations).size > 1 || /(?:不能|无法|不会|不(?:能)?保证|不敢|没法).{0,12}(?:发货|发出|出库)/u.test(ctx.reply);
      return assessment(intent, contradictory ? [] : evidence, evidence.length && !contradictory ? [] : ['尚未明确发货时效'], pendingVerification);
    }
    if (intent === 'dry-clean-required' || intent === 'dry-clean-allowed') {
      const pattern = intent === 'dry-clean-required'
        ? /(?:不需要|无需|不用|不必)(?:专门|进行)?干洗|(?:需要|必须|只能|要)(?:专门|进行)?干洗|正常洗|平常.{0,5}洗|日常清洗|没必要.{0,6}(?:干洗|麻烦)|不用.{0,6}麻烦|^(?:亲)?(?:不需要|不必|不用|需要|必须|不要|要)[的哦呢哈呀啊哒~～\s]*$/u
        : /(?:可以|不能|不可以|不支持|支持|允许|禁止|适合|不适合)(?:进行)?干洗|^(?:亲)?(?:可以|不可以|不能|不支持|支持|没问题)[的哦呢哈呀啊哒~～\s]*$/u;
      const evidence = statements.filter((s) => pattern.test(s));
      return assessment(intent, evidence, evidence.length ? [] : [intent === 'dry-clean-required' ? '尚未说明是否需要干洗' : '尚未说明是否允许干洗'], pendingVerification);
    }
    if (intent === 'exchange') {
      const size = /换.{0,5}(?:码|尺寸)/u.test(ctx.question);
      const evidence = statements.filter((s) => {
        if (size && /(?:只|仅).{0,5}换颜色/u.test(s) && !/不能换(?:码|尺码|尺寸)/u.test(s)) return false;
        return /(?:可以|支持|不能|不支持|不可以|可|能).{0,18}(?:换货|换码|换尺码|换尺寸|换大|换小|换一|退换|调换|调一下)|(?:可以|不可以|不能|支持)换(?:的|哦|呢|哈|[，。]|$)/u.test(s) ||
          /(?:不合适|大小|尺码|尺寸).{0,12}(?:帮您处理|给您处理|可以处理|能处理|帮您调)/u.test(s) ||
          /^(?:亲)?(?:可以|没问题|能换|可以换|不能换)[的哦呢哈呀啊哒~～\s]*$/u.test(s);
      });
      return assessment(intent, evidence, evidence.length ? [] : ['尚未回答本次换货或换码请求'], pendingVerification);
    }
    if (intent === 'media-location' || intent === 'media-available') {
      const resources: Array<{ name: string; topic: RegExp; location: RegExp }> = [
        { name: '买家秀', topic: /买家秀|晒图|晒单/u, location: /评价|评论|晒图区/u },
        { name: '视频', topic: /视频|短片/u, location: /详情|主图|轮播|视频页|商品页/u },
        { name: '实拍图片', topic: /图片|照片|实拍(?!视频)/u, location: /详情|商品页|主图|轮播/u },
      ];
      const requested = resources.filter((r) => r.topic.test(ctx.question));
      const evidence: string[] = []; const missing: string[] = [];
      let alternativeSatisfied = false;
      for (const resource of requested) {
        const matches = statements.filter((s) => {
          const absent = resource.topic.test(s) && /没有|暂无|未提供|不提供/u.test(s);
          if (absent) return true;
          if (intent === 'media-location') return resource.location.test(s) &&
            (resource.topic.test(s) || (requested.length === 1 && !resources.some((other) => other !== resource && other.topic.test(s))) || (resource.name === '买家秀' && /晒图|评价|评论/u.test(s)));
          if (!resource.topic.test(s)) return requested.length === 1 && /^(?:亲)?(?:有的|有哦|有呢|没有|暂无)[哦呢哈\s]*$/u.test(s);
          return /有|提供|查看|(?:可以|能).{0,16}(?:看|找|翻)|(?:在|去|到).{0,16}(?:看|找|翻)/u.test(s) && !/不能|无法|不可(?:以)?|看不了|找不到/u.test(s);
        });
        const isAbsent = (s: string) => /没有|暂无|未提供|不提供/u.test(s);
        if (matches.some(isAbsent) && matches.some((s) => !isAbsent(s))) {
          missing.push(`${resource.name}的可用性说明前后矛盾`);
          continue;
        }
        if (matches.length) {
          evidence.push(...matches);
          if (matches.some((s) => !/没有|暂无|未提供|不提供/u.test(s))) alternativeSatisfied = true;
        } else missing.push(`尚未说明${resource.name}${intent === 'media-location' ? '的查看路径' : '是否可用'}`);
      }
      const alternatives = /或者|或是|或/u.test(ctx.question);
      return assessment(intent, [...new Set(evidence)], alternatives && alternativeSatisfied && !missing.some((text) => text.includes('前后矛盾')) ? [] : missing.length ? missing : requested.length ? [] : ['未识别要查看的资源'], pendingVerification);
    }
    if (intent === 'color-difference') {
      // “细微”等与“轻微”同样表示程度；价格、尺码等其他差异不能冒充色差。
      const colorStatements = statements.filter((part) => !/价格|运费|尺码|发货/u.test(part) || /颜色|色差|光线|屏幕/u.test(part));
      const small = /(?:轻微|细微|略微|些微|微小)(?:的)?(?:色差|差异|差别)|(?:色差|颜色差异)(?:是|很|较|比较)?(?:轻微|细微|些微|微小|不大|很小|较小)|没有(?:明显)?色差|基本一样|基本没差别|差别不大|差不多|不明显|有(?:一点|一点点|点区别)|多少.{0,5}一点/u;
      const large = /(?:色差|颜色差异|颜色差别|(?:实物|颜色).{0,12}(?:差异|差别)).{0,5}(?:非常大|特别大|很大|较大|严重|很明显)|(?:非常大|特别大|很大|严重)(?:的)?色差/u;
      const hasSmall = colorStatements.some((part) => small.test(part) && !/(?:没有|并无|并非|不是|不算|不存在)(?:任何|所谓的?)?(?:轻微|细微|略微|些微|微小)(?:的)?(?:色差|差异|差别)/u.test(part));
      const hasLarge = colorStatements.some((part) => large.test(part) && !/(?:没有|并无|不存在)(?:任何|明显的?|严重的?)?(?:色差|颜色差异|颜色差别)/u.test(part));
      if (hasSmall && hasLarge) return { pass: false, signal: 'off-topic', intent, status: 'unsupported', reason: '对色差程度的描述存在冲突，需结合商品和具体情况核对', evidence: [], missing: ['请核对色差程度'] };
      const evidence = colorStatements.filter((part) => {
        if (/(?:没有|并无|并非|不是|不算|不存在)(?:任何|所谓的?)?(?:轻微|细微|略微|些微|微小)(?:的)?(?:色差|差异|差别)/u.test(part)) return false;
        return /色差(?:并)?(?:不大|很小|较小|明显|较大|很大|非常大|特别大)|(?:轻微|细微|略微|些微|微小|明显|严重)(?:的)?色差|没有(?:明显)?色差|颜色.{0,8}(?:接近|一致|差别不大)|(?:只有|会有|有)(?:轻微|细微|略微|些微|微小|较小)(?:的)?(?:差异|差别)|基本一样|差不多|不明显|有(?:一点|一点点|点区别)|多少.{0,5}一点/u.test(part);
      });
      return assessment(intent, evidence, evidence.length ? [] : ['尚未说明颜色差异的程度'], pendingVerification);
    }
  }
  const judged = legacyAutomaticReply(ctx, version, result, pendingVerification);
  return version === 2 ? { ...judged, intent: 'general', status: judged.pass ? 'resolved' : pendingVerification ? 'pending' : 'unanswered',
    reason: judged.pass ? '答复与当前问题对应' : pendingVerification ? '仍在核实，尚未给出结论' : '尚未找到对应答复', evidence: judged.pass ? [ctx.reply] : [], missing: judged.pass ? [] : [ctx.question] } : judged;
}

function legacyAutomaticReply(ctx: JudgeContext, version: number, result: JudgeResult, pendingVerification: boolean): JudgeResult {
  const questionTopic = conversationTopic({ seq: 0, question: ctx.question, keyPoints: [] });
  const replyTopic = conversationTopic({ seq: 0, question: ctx.reply, keyPoints: [] });
  if (version >= 1 && !pendingVerification && result.signal !== 'perfunctory') {
    const q = ctx.question;
    if (/偏大|偏小/u.test(q) && !/偏大|偏小|不偏|不大|不小|正常|标准|偏宽松|偏紧/u.test(ctx.reply)) {
      return { pass: false, signal: 'off-topic' as const };
    }
    const uncertain = /不知道|不清楚|不确定|无法(?:判断|确认|推荐)/u.test(ctx.reply);
    const outerSuggestion = /西装|开衫|夹克|针织衫|风衣|衬衫|(?:米白|白色|黑色|浅色|深色|短款)外套/u.test(ctx.reply);
    const shoeSuggestion = /乐福鞋|小白鞋|运动鞋|高跟鞋|平底鞋|凉鞋|短靴|长靴|(?:白色|黑色|浅色|休闲)鞋/u.test(ctx.reply);
    const stylingAnswer = /搭配|外套|鞋子/u.test(q) && (outerSuggestion || shoeSuggestion) &&
      (!/外套/u.test(q) || outerSuggestion) && (!/鞋子/u.test(q) || shoeSuggestion);
    const sizeAnswer = /穿(?:什么|多大|哪个)码/u.test(q) && /(?:[SMLX]{1,4}|\d{2,3})\s*码/iu.test(ctx.reply);
    const saleAnswer = /售后/u.test(q) && /售后|退换|退货|换货/u.test(ctx.reply) && /订单|申请|联系/u.test(ctx.reply);
    const shippingAnswer = !/可能|或许|不一定/u.test(ctx.reply) && /现货/u.test(q) && /发货|发出/u.test(q) &&
      /现货|有货|缺货|无货/u.test(ctx.reply) && /\d+\s*(?:小时|天|日)/u.test(ctx.reply) && /发货|发出|出库/u.test(ctx.reply);
    if (!uncertain && (stylingAnswer || sizeAnswer || saleAnswer || shippingAnswer)) return { pass: true, signal: 'key-point' as const };
    if ((/外套/u.test(q) && /鞋子/u.test(q)) || (/现货/u.test(q) && /发货|发出/u.test(q))) {
      return { pass: false, signal: 'off-topic' as const };
    }
  }
  if (result.signal === 'stance' && questionTopic !== 'general' &&
    replyTopic !== 'general' && questionTopic !== replyTopic) return { pass: false, signal: 'off-topic' as const };
  return result.signal === 'off-topic' && !isHedge(ctx.reply) &&
    !/不知道|不清楚|不确定/u.test(ctx.reply) && questionTopic !== 'general' && questionTopic === replyTopic
    ? { pass: true, signal: 'key-point' as const } : result;
}
