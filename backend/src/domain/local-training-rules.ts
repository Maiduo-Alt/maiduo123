import { assessAutomaticReply, replyIntent } from './automatic-reply';
import { stripBuyerQuestionWrapper } from './adaptive-push';
import { assessLocalWashGuidance, hasWashInformation } from './local-wash-guidance';
import { isPendingVerification, isPerfunctory } from './reply-judge';
import type { ModelReceptionInput, ModelReceptionResult } from './model-reception';

function normalizeQuestion(raw: string): string {
  return stripBuyerQuestionWrapper(raw).replace(/[？?。、，！!\s]+$/u, '');
}

function assessColorDifference(input: ModelReceptionInput): ModelReceptionResult | undefined {
  const question = normalizeQuestion(input.question);
  // Only standalone comparisons of the product color, not compound or conditional questions.
  if (input.judgmentVersion !== 2 || input.goals.length || /[？?；;\n]|以及|顺便|还有|或者|而且|尺寸|尺码|材质|发货|多久|怎么办|怎么处理|退换|退货|买家秀|视频/u.test(question) ||
      !/(?:色差|颜色差异|颜色差别).{0,10}(?:吗|嘛|么|呢|大不大|大吗|多大|明显不明显)$|颜色.{0,9}(?:差得|差别|一样|一致).{0,8}(?:吗|嘛|么|呢|多不多)$/u.test(question)) {
    return undefined;
  }
  const result = assessAutomaticReply({ question: '色差大吗', buyerText: input.question, keyPoints: [], reply: input.reply }, 2);
  const unrelatedAttribute = /聚酯|面料|材质|售后|退货|联系客服/u.test(input.reply) &&
    !/色差|颜色|显色|偏深|偏浅|偏色|光线|屏幕|主图|实物/u.test(input.reply);
  if (!result.pass && result.status !== 'unsupported' && result.status !== 'pending' &&
      result.signal !== 'perfunctory' && !unrelatedAttribute) return undefined;
  return {
    provider: 'local', decisionSource: 'color-difference', resolved: result.pass,
    reason: result.reason || '回复未说明色差程度', matchedPoints: [], buyerReply: '',
    evidence: result.evidence || [],
  };
}

function assessMediaLocation(input: ModelReceptionInput): ModelReceptionResult | undefined {
  const question = stripBuyerQuestionWrapper(input.question);
  const { reply } = input;
  if (replyIntent(question) !== 'media-location' ||
      /[\n；;]|[？?].+|还有|以及|并且|发货|尺码|面料|换货|退货|色差/u.test(question) ||
      /(?:如果|假如|要是|若).{0,9}有.{0,6}(?:买家秀|视频|实拍|照片)/u.test(reply)) return undefined;
  const assessment = assessAutomaticReply({ question, buyerText: question, keyPoints: [], reply }, 2);
  const evidence = assessment.evidence?.filter((part) =>
    !/不能|看不了|找不到|无法|暂不|没有|不在|不确定|待核实|物流|订单|售后/u.test(part) &&
    ((/买家秀|晒图|晒单/u.test(question) && /评价|评论|晒图区/u.test(part)) ||
      (/(?:视频|短片)/u.test(question) && /视频|短片/u.test(part) && /详情|主图|轮播|视频页|商品页/u.test(part)) ||
      (/图片|照片|实拍(?!视频)/u.test(question) && /图片|照片|实拍(?!视频)/u.test(part) && /详情|主图|轮播|商品页/u.test(part))));
  if (!assessment.pass || !evidence?.length) return undefined;
  return { provider: 'local', decisionSource: 'media-location', resolved: true,
    reason: '答复说明了所问资源的查看入口', evidence, matchedPoints: [], buyerReply: '' };
}

const COTTON_RATIO = /含棉量|含棉比例|棉含量|棉的比例|棉比例|棉占比|棉成分/u;
const POLYESTER = /聚酯纤维|涤纶/u;
const MATERIAL_UNCERTAINTY = /也许|或许|估计|不敢保证|不确定|说不准|(?:可能|是否|如果|不能说|不代表|没说|未说|不排除)[^。！？]*?(?:棉|聚酯纤维|涤纶)/u;
const DISCLOSURE_VERB = '(?:标注|标明|写明|注明|给出|说明|提供|显示|展示|列出|写清楚|标清楚|标出来|写出来|写|标)';
const COTTON_TARGET = '(?:含棉量|含棉比例|棉含量|棉的比例|棉比例|棉占比|具体含棉)';

function materialDisclosure(sentences: string[], cotton: boolean): string[] {
  const source = /详情|商品页|页面|商品信息|参数|资料|材质栏|标签|吊牌|洗标|水洗标|成分表|成分标/u;
  const unlistedCotton = new RegExp(
    `(?:未|没有|没|无|暂未|暂无)(?:(?:单独|明确|具体|准确)*${DISCLOSURE_VERB}|(?:单独|明确|具体|准确)+).{0,10}${COTTON_TARGET}` +
    `|(?:看不到|查不到).{0,8}${COTTON_TARGET}` +
    `|${COTTON_TARGET}.{0,14}(?:未|没有|没|无|暂未|暂无)(?:单独|明确|具体|准确)*${DISCLOSURE_VERB}` +
    `|${COTTON_TARGET}.{0,10}(?:看不到|查不到|暂无数据|无数据|暂未标注|未标注)`,
    'u',
  );
  const unlistedPolyester = new RegExp(
    `(?:未|没有|没|暂未|暂无)(?:单独|明确|具体)*${DISCLOSURE_VERB}\\s*(?:(?:是否)?(?:含有|含|是|为)?(?:聚酯纤维|涤纶)|(?:具体)?(?:面料)?(?:材质|成分))` +
    `|(?:看不到|查不到).{0,8}(?:是否)?(?:含|是)?(?:聚酯纤维|涤纶|具体成分|面料成分)` +
    `|(?:是否)?(?:含有|含|是)?(?:聚酯纤维|涤纶|具体(?:面料)?(?:材质|成分)).{0,14}(?:未|没有|没|暂未|暂无)(?:单独|明确|具体)*${DISCLOSURE_VERB}`,
    'u',
  );
  const pattern = cotton ? unlistedCotton : unlistedPolyester;
  return sentences
    .map((part) => part.replace(/[，,]\s*(?:需要我帮您.{0,12}|您看.{0,8}|可以吗|行吗|还有.{0,10})[？?]\s*$/u, '').trim())
    .filter((part) => !!part && !/[？?]/u.test(part) && source.test(part) && pattern.test(part) &&
      !/如果|假如|可能|好像|不确定|不清楚|不知道|并非|不是说|不代表|是否(?:没有|未|没)|确认(?:一下|下).{0,8}(?:没有|未|没)/u.test(part));
}

function cottonPercents(text: string, standalone = false): number[] {
  const values = [...text.matchAll(/(?:棉(?:纤维)?(?:含量|占比|比例|成分)?)(?:大约|大概|约|是|为|占|有|\s)*(\d{1,3}(?:\.\d+)?)\s*[%％]|(?<![\d.−-])(\d{1,3}(?:\.\d+)?)\s*[%％]\s*(?:的)?\s*棉/gu)]
    .map((match) => Number(match[1] ?? match[2]));
  if (/不含棉|无棉成分/u.test(text)) values.push(0);
  if (/^(?:(?:这款|面料|成分|是|为|采用)\s*)*(?:纯棉|全棉)(?:面料)?[哦哈呢的。\s]*$/u.test(text)) values.push(100);
  const bare = standalone && text.match(/^(?:大约|大概|差不多|约|有|是|为|\s)*(\d{1,3}(?:\.\d+)?)\s*[%％](?:左右|上下)?[哦哈呢的。\s]*$/u);
  if (bare) values.push(Number(bare[1]));
  return values;
}

function polyesterPercents(text: string): number[] {
  const values = [...text.matchAll(/(?:(?:聚酯纤维|涤纶)(?:含量|占比|比例|成分)?)(?:大约|大概|约|是|为|占|有|\s)*(\d{1,3}(?:\.\d+)?)\s*[%％]|(?<![\d.−-])(\d{1,3}(?:\.\d+)?)\s*[%％]\s*(?:的)?\s*(?:聚酯纤维|涤纶)/gu)]
    .map((match) => Number(match[1] ?? match[2]));
  if (/(?:100\s*[%％]\s*|全|纯)(?:聚酯纤维|涤纶)/u.test(text)) values.push(100);
  return [...new Set(values)];
}

function assessMaterialDetails(input: ModelReceptionInput): ModelReceptionResult | undefined {
  const question = normalizeQuestion(input.question);
  const cotton = /(?:含棉量|含棉比例|棉含量|棉的比例|棉比例|棉占比)(?:大概|大约|约)?(?:是|有)?(?:多少|几成|百分之几|高吗|高不高)(?:呢|啊|呀|哈|哦|吗)?(?:亲)?$|(?:含(?:有)?(?:多少|几成)棉|棉占多少|棉成分(?:有|是)?多少)(?:呢|啊|呀|哈|哦|吗)?(?:亲)?$/u.test(question);
  const polyester = /(?:是|是不是|是否是|是否为|属于|含有|有没有)(?:聚酯纤维|涤纶)(?:的面料|面料|的)?(?:吗|呢|啊|呀|哈|哦)?(?:亲)?$/u.test(question);
  if ((!cotton && !polyester) || /[\n；;？?]|(?:吗|呢|嘛|么)[，,]|还有|以及|并且|还是|注意事项|怎么洗|缩水|透气|会不会|色差|尺码|发货|退换|什么(?:面料|材质|成分)/u.test(question)) return undefined;
  const product = input.facts?.product;
  if (!product || !Array.isArray(product.attributes)) return undefined;
  const attributes = product.attributes.filter((row): row is { name: string; value: unknown } =>
    !!row && typeof row === 'object' && 'name' in row && typeof row.name === 'string' && 'value' in row);
  if (attributes.length !== product.attributes.length) return undefined;
  const material = attributes.filter((row) => /材质|面料|成分|含棉|棉含量|棉占比/u.test(row.name))
    .map((row) => ({ ...row, value: String(row.value ?? '').trim() }));
  const title = product.title || '';
  const declaredTitle = /\d\s*[%％]\s*(?:聚酯纤维|涤纶|棉(?!感))|(?:含棉量|棉含量|棉占比)\s*\d/u.test(title) ? title
    : /纯棉|全棉/u.test(title) && !/仿|棉感|手感/u.test(title) ? '纯棉' : '';
  const details = [declaredTitle, ...material.map((row) => row.value)];
  const reply = input.reply;
  const clauses = reply.split(/[，,。；;！!\n]|但是|不过|但(?=不|要|有|含|是)|且(?=不|有|含|是)/u)
    .map((part) => part.trim())
    .filter((part) => !!part && !/[？?]/u.test(part));
  // A disclosure can refer back to the source in the preceding clause of the same reply.
  const disclosure = materialDisclosure(reply.split(/[。；;！!\n]/u), cotton);
  if (!disclosure.length && MATERIAL_UNCERTAINTY.test(reply)) return undefined;
  const directClauses = clauses.filter((part) => !MATERIAL_UNCERTAINTY.test(part) &&
    !/核实|查一下|待确认|确认后|(?:未|没有|没|暂未|暂无)(?:明确|单独|具体)*(?:标注|标明|写明|注明|给出|说明|提供|显示|写|标)/u.test(part));
  let evidence: string[];
  if (cotton) {
    if (/棉[^，,。；;]*不含棉|不含棉[^，,。；;]*(?:棉.{0,4}\d|\d+\s*[%％]\s*棉)|(?:不是|并非|不等于)[^，,。；;]*(?:棉|[%％])/u.test(reply)) return undefined;
    const replies = directClauses.map((part) => ({ part, percents: cottonPercents(part, true) }))
      .filter((item) => item.percents.length);
    const known = [...cottonPercents(declaredTitle), ...material.flatMap((row) => cottonPercents(row.value, COTTON_RATIO.test(row.name)))];
    if (details.some((value) => /(?:100\s*[%％]\s*|全|纯)(?:聚酯纤维|涤纶)/u.test(value))) known.push(0);
    const stated = replies.flatMap((item) => item.percents);
    if (new Set([...known, ...stated]).size > 1 || [...known, ...stated].some((value) => value > 100) ||
        (stated.includes(0) && !known.length && details.some((value) => /棉/u.test(value) && !/棉感|仿棉|不含棉/u.test(value)))) return undefined;
    evidence = replies.map((item) => item.part);
    if (!evidence.length && !known.length) evidence = disclosure;
  } else {
    const deny = /(?:不是|不含|没有)(?:任何|用|纯|全)?(?:聚酯纤维|涤纶)/u;
    const yes = /(?:是|采用|使用|用的是|主要为|含有|含)(?:的|用的)?(?:聚酯纤维|涤纶)|(?:聚酯纤维|涤纶)(?:的)?(?:面料|材质|成分)[的哦哈呢呀\s]*$|^(?:聚酯纤维|涤纶|是的|对的)[的哦哈呢呀\s]*$/u;
    const positive = directClauses.filter((part) => yes.test(part) && !deny.test(part));
    const negative = directClauses.filter((part) => deny.test(part) || /^(?:不是的?|没有)[哦哈呢呀\s]*$/u.test(part));
    const knownPositive = details.some((value) => POLYESTER.test(value) && !deny.test(value) && !/样|仿|未标|暂无/u.test(value));
    const knownNegative = details.some((value) => deny.test(value) || cottonPercents(value).includes(100) ||
      /100\s*[%％]\s*(?:锦纶|羊毛|真丝|亚麻)/u.test(value));
    if ((knownPositive || positive.length) && (knownNegative || negative.length)) return undefined;
    if (knownPositive && directClauses.some((part) => /[%％]|百分之|全(?:聚酯纤维|涤纶)|纯(?:聚酯纤维|涤纶)/u.test(part))) {
      const knownPoly = details.flatMap((value) => polyesterPercents(value));
      const statedPoly = directClauses.flatMap((part) => polyesterPercents(part));
      if (!knownPoly.length || !statedPoly.length || new Set([...knownPoly, ...statedPoly]).size > 1) return undefined;
    }
    evidence = [...positive, ...negative];
    if (!evidence.length && !knownPositive && !knownNegative) evidence = disclosure;
  }
  if (!evidence.length) return undefined;
  return { provider: 'local', decisionSource: 'material-details', resolved: true,
    reason: '答复直接说明了买家询问的成分或资料缺项', evidence, matchedPoints: [], buyerReply: '' };
}

function assessDryCleanRequirement(input: ModelReceptionInput): ModelReceptionResult | undefined {
  const question = normalizeQuestion(input.question);
  if (!/(?:要不要|需不需要|是否需要|用不用|需要|必须)(?:专门)?干洗(?:吗|呢)?$/u.test(question) ||
      /[\n；;？?]|以及|还有|或者|并且|机洗|手洗|水洗|怎么洗/u.test(question) ||
      hasWashInformation(input) || input.history.some(({ content }) =>
        /(?:洗标|洗水标).{0,12}(?:写着|写了|显示|标明|标注了)/u.test(content)) ||
      /如果|假如|要是|可能|也许|或许|是否|不确定|未确认|说不准|没法保证/u.test(input.reply)) return undefined;

  const clauses = input.reply.split(/[，,。；;！!\n]|但是|不过/u).map((part) => part.trim());
  const notRequired = /(?:不需要|无需|不用|不必|没有必要)(?:专门|进行)?干洗|^(?:亲)?(?:不需要|不用|不必)[的哦哈呢呀啊～~\s]*$/u;
  const required = /(?:需要|必须|只能)(?:专门|进行)?干洗|^(?:亲)?(?:需要|必须)[的哦哈呢呀啊～~\s]*$/u;
  const negative = clauses.filter((part) => notRequired.test(part));
  const positive = clauses.filter((part) => required.test(part.replace(notRequired, '').trim()) &&
    !/不一定|不代表|不是|并非|不建议|没说|未说|别/u.test(part));
  if ((negative.length > 0) === (positive.length > 0)) return undefined;

  const assessment = assessAutomaticReply({ question: '要不要干洗', buyerText: input.question, keyPoints: [], reply: input.reply }, 2);
  if (!assessment.pass) return undefined;
  return { provider: 'local', decisionSource: 'dry-clean-required', resolved: true,
    reason: '答复明确说明是否需要干洗', evidence: negative.length ? negative : positive, matchedPoints: [], buyerReply: '' };
}

function assessShoeStyling(input: ModelReceptionInput): ModelReceptionResult | undefined {
  const question = normalizeQuestion(input.question);
  if (!/鞋/u.test(question) || !/休闲/u.test(question) || !/搭配|怎么搭|配(?:哪|什么)|穿(?:哪|什么)|哪种鞋|什么鞋/u.test(question) ||
      /[\n；;？?]|(?:吗|呢|嘛|么)[，,]|外套|上衣|裤子|包包|以及|还有|并且|尺码|发货|换货/u.test(question)) return undefined;

  const assessment = assessAutomaticReply({ question, buyerText: input.question, keyPoints: [], reply: input.reply }, 2);
  const footwear = /乐福鞋|帆布鞋|运动鞋|小白鞋|球鞋|板鞋|平底鞋|短靴|老爹鞋/u;
  const denial = /不建议|不推荐|不适合|不合适|不搭|不配|不想|不宜|别选|别穿|别搭|避免|不要|不能|没有|不确定|没货/u;
  const evidence = assessment.pass && assessment.acceptedGuidance ? assessment.evidence?.filter((part) => footwear.test(part) &&
    /配|搭|推荐|建议|合适|适合|可以选/u.test(part) &&
    !denial.test(part)) ?? [] : [];
  const shoe = `(?:浅色|深色|白色|黑色|尖头)?(?:${footwear.source})`;
  const direct = new RegExp(`^${shoe}(?:\\s*(?:[、，,]|或(?:者)?|和|跟)\\s*${shoe})*(?:都)?(?:可以|行|合适|不错|好看)?[的哦哈呢呀～~。！!\\s]*$`, 'u');
  const shortReply = input.reply.trim();
  if (!evidence.length && direct.test(shortReply)) evidence.push(shortReply);
  if (!evidence.length) return undefined;
  return { provider: 'local', decisionSource: 'shoe-styling', resolved: true,
    reason: '答复给出了具体的休闲鞋搭配', evidence, matchedPoints: [], buyerReply: '' };
}

function assessCareAndMaterialNotice(input: ModelReceptionInput): ModelReceptionResult | undefined {
  const question = normalizeQuestion(input.question);
  const isNoticeQuestion = /注意(?:事项|的地方|什么|的)|要注意|需要注意/u.test(question);
  const isMaterialOrCare = /面料|材质|成分|含棉|聚酯|涤纶|纤维|洗|打理|保养|穿着/u.test(question);
  if (!isNoticeQuestion || !isMaterialOrCare ||
      /[\n；;？?]|发货|物流|尺码|换货|退货|色差/u.test(question)) return undefined;

  if (isPerfunctory({ question, keyPoints: [], reply: input.reply, buyerText: input.question })) {
    return { provider: 'local', decisionSource: 'care-notice', resolved: false,
      reason: '回复过于敷衍，未说明具体注意事项', matchedPoints: [], buyerReply: '', evidence: [] };
  }
  if (isPendingVerification(input.reply)) {
    return { provider: 'local', decisionSource: 'care-notice', resolved: false,
      reason: '仅承诺核实，尚未说明注意事项', matchedPoints: [], buyerReply: '', evidence: [] };
  }

  const clauses = input.reply.split(/[，,。；;！!\n]/u).map((part) => part.trim()).filter((part) => !!part && !/[？?]/u.test(part));
  // Guardrail: when wash info is missing, do not approve unconfirmed machine-wash recommendations.
  if (!hasWashInformation(input)) {
    const unsafeMachineWash = clauses.find((part) => /机洗/u.test(part) &&
      /直接|建议|可以|允许|就能|一定能/u.test(part) &&
      !/(?:不要|不能|不可|避免|不建议).{0,8}机洗|洗标(?:明确)?允许.{0,8}才|未标注|没(?:有)?标注/u.test(part));
    if (unsafeMachineWash) {
      return { provider: 'local', decisionSource: 'care-notice', resolved: false,
        reason: '洗涤说明未确认，不应直接建议机洗', matchedPoints: [], buyerReply: '', evidence: [unsafeMachineWash] };
    }
  }

  const careAdvice = /洗标|水洗标|成分标|吊牌|手洗|轻柔|冷水|温水|30度|深浅色分开|分开洗|避免暴晒|不要暴晒|阴干|阴凉|通风|平铺|悬挂|中性洗涤|柔顺剂|漂白|烘干|低温熨烫|熨烫|缩水|起球|变形|掉色|褪色|勾丝|透气|摩擦|浸泡/u;
  const evidence = clauses.filter((part) => careAdvice.test(part) && !/不确定|不清楚|不知道|核实|查一下|待确认/u.test(part));
  if (!evidence.length) return undefined;
  return { provider: 'local', decisionSource: 'care-notice', resolved: true,
    reason: '答复给出了具体的洗护或面料注意事项', evidence: evidence.slice(0, 2), matchedPoints: [], buyerReply: '' };
}

function assessShippingDeliveryLogistics(input: ModelReceptionInput): ModelReceptionResult | undefined {
  const question = normalizeQuestion(input.question);
  const intent = replyIntent(question);
  if ((intent !== 'shipping-time' && intent !== 'delivery-time' && intent !== 'logistics-location') ||
      /[\n；;？?]|以及|顺便|还有|色差|尺码|面料|材质|洗|干洗|买家秀|视频/u.test(question)) return undefined;

  const result = assessAutomaticReply({ question, buyerText: input.question, keyPoints: [], reply: input.reply }, 2);
  if (!result.pass && result.status !== 'unsupported' && result.status !== 'pending' && result.signal !== 'perfunctory') {
    return undefined;
  }
  return {
    provider: 'local', decisionSource: 'shipping-logistics', resolved: result.pass,
    reason: result.reason || (result.pass ? '答复明确说明了时效或物流查询方式' : '未明确回答时效或物流问题'),
    matchedPoints: [], buyerReply: '', evidence: result.evidence?.slice(0, 2) || [],
  };
}

function assessExchangePolicy(input: ModelReceptionInput): ModelReceptionResult | undefined {
  const question = normalizeQuestion(input.question);
  if (replyIntent(question) !== 'exchange' ||
      /[\n；;？?]|以及|顺便|还有|发货|物流|色差|面料|材质|洗|干洗|买家秀|视频/u.test(question)) return undefined;

  const result = assessAutomaticReply({ question, buyerText: input.question, keyPoints: [], reply: input.reply }, 2);
  if (!result.pass && result.status !== 'pending' && result.signal !== 'perfunctory') return undefined;
  return {
    provider: 'local', decisionSource: 'exchange-policy', resolved: result.pass,
    reason: result.reason || (result.pass ? '答复明确说明了换货/换码政策' : '未明确说明是否支持换货'),
    matchedPoints: [], buyerReply: '', evidence: result.evidence?.slice(0, 2) || [],
  };
}

function assessFitAndSizing(input: ModelReceptionInput): ModelReceptionResult | undefined {
  const question = normalizeQuestion(input.question);
  const isPearFit = /梨形|微胖|胯宽/u.test(question) && /显瘦|遮肉|合适|适合|友好|能穿/u.test(question);
  const isSizingGuide = /怎么选尺码|如何选尺码|选(?:什么|多大|哪个)码|选码.{0,8}(?:参考|围度|注意)/u.test(question);
  if ((!isPearFit && !isSizingGuide) ||
      /[\n；;？?]|以及|顺便|还有|换货|换码|退货|发货|物流|色差|面料|材质|洗|干洗/u.test(question)) return undefined;

  const buyerContext = input.history.filter((m) => m.role === 'buyer').map((m) => m.content);
  const result = assessAutomaticReply({ question, buyerText: input.question, keyPoints: [], reply: input.reply, buyerContext }, 2);
  const clauses = input.reply.split(/[，,。；;！!\n]/u).map((part) => part.trim()).filter((part) => !!part && !/[？?]/u.test(part));
  const selfServiceSizing = isSizingGuide &&
    /尺码表|码表/u.test(input.reply) &&
    !/(?:提供|告诉|告知).{0,16}(?:身高|体重|腰围|臀围)/u.test(input.reply);
  if (result.status === 'unsupported' || (result.status === 'partial' && !selfServiceSizing) ||
      result.status === 'pending' || result.signal === 'perfunctory') {
    return {
      provider: 'local', decisionSource: 'fit-sizing', resolved: false,
      reason: result.reason || '尚未给出有效版型或选码建议',
      matchedPoints: [], buyerReply: '', evidence: result.evidence?.slice(0, 2) || [],
    };
  }
  if (isPearFit) {
    const evidence = clauses.filter((part) =>
      /(?:A字|高腰|收腰|遮胯|遮肉|藏肉|显瘦|显高|修饰|不显胯|版型.{0,6}(?:友好|宽松|修身)|梨形.{0,8}(?:友好|合适|适合|显瘦|可以穿))/u.test(part) &&
      !/不确定|不清楚|不知道|核实|查一下|不适合|不显瘦|显胖/u.test(part));
    if (!evidence.length) return undefined;
    return { provider: 'local', decisionSource: 'fit-sizing', resolved: true,
      reason: '答复结合版型特点说明了梨形身材穿着效果', evidence: evidence.slice(0, 2), matchedPoints: [], buyerReply: '' };
  }
  if (result.pass && result.evidence?.length) {
    return { provider: 'local', decisionSource: 'fit-sizing', resolved: true,
      reason: result.reason || '答复给出了具体的选码建议', evidence: result.evidence.slice(0, 2), matchedPoints: [], buyerReply: '' };
  }
  const sizingEvidence = clauses.filter((part) =>
    /(?:腰围|臀围|胸围|尺码表|码表|平时穿|偏宽松|偏修身|大一码|小一码|[SMLX]{1,4}\s*码)/iu.test(part) &&
    /(?:对照|参考|测量|量|选|建议|推荐|合身|宽松)/u.test(part) &&
    !/不确定|不清楚|不知道|核实|查一下/u.test(part));
  if (!sizingEvidence.length) return undefined;
  return { provider: 'local', decisionSource: 'fit-sizing', resolved: true,
    reason: '答复给出了具体的选码参考方法', evidence: sizingEvidence.slice(0, 2), matchedPoints: [], buyerReply: '' };
}

export function assessLocalTrainingRules(input: ModelReceptionInput): ModelReceptionResult | undefined {
  if (input.judgmentVersion !== 2 || input.goals.length) return undefined;
  return assessLocalWashGuidance(input)
    ?? assessColorDifference(input)
    ?? assessMediaLocation(input)
    ?? assessMaterialDetails(input)
    ?? assessDryCleanRequirement(input)
    ?? assessShoeStyling(input)
    ?? assessCareAndMaterialNotice(input)
    ?? assessShippingDeliveryLogistics(input)
    ?? assessExchangePolicy(input)
    ?? assessFitAndSizing(input);
}
