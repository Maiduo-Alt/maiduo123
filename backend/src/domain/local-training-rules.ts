import { assessAutomaticReply, replyIntent } from './automatic-reply';
import { stripTopicTransitionText } from './adaptive-push';
import { assessLocalWashGuidance, hasWashInformation } from './local-wash-guidance';
import type { ModelReceptionInput, ModelReceptionResult } from './model-reception';

function assessColorDifference(input: ModelReceptionInput): ModelReceptionResult | undefined {
  const question = input.question.replace(/[？?]麻烦直接说一下。?$/u, '').replace(/[？?。、，！!\s]+$/u, '');
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
  const { question, reply } = input;
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

const COTTON_RATIO = /含棉量|棉含量|棉的比例|棉占比|棉成分/u;
const POLYESTER = /聚酯纤维|涤纶/u;
const MATERIAL_UNCERTAINTY = /也许|或许|估计|不敢保证|不确定|说不准|(?:可能|是否|如果|不能说|不代表|没说|未说|不排除)[^。！？]*?(?:棉|聚酯纤维|涤纶)/u;

function materialDisclosure(clauses: string[], cotton: boolean): string[] {
  const source = /详情|商品页|资料|材质栏|标签|吊牌|洗标/u;
  const unlistedCotton = /(?:未|没有|没|无)(?:(?:单独|明确|具体|准确)*(?:标注|写明|注明|给出|说明)|(?:单独|明确|具体|准确)+).{0,8}(?:含棉量|棉含量|棉的比例|棉占比)/u;
  const unlistedPolyester = /(?:未|没有|没)(?:单独|明确|具体)*(?:标注|写明|注明|给出|说明)\s*(?:(?:是否)?(?:含有|含|是|为)?(?:聚酯纤维|涤纶)|(?:具体)?(?:面料)?(?:材质|成分))/u;
  const pattern = cotton ? unlistedCotton : unlistedPolyester;
  return clauses.filter((part) => source.test(part) && pattern.test(part) &&
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

function assessMaterialDetails(input: ModelReceptionInput): ModelReceptionResult | undefined {
  const question = stripTopicTransitionText(input.question.trim()).replace(/[？?]麻烦直接说一下。?$/u, '').replace(/[？?。\s]+$/u, '');
  const cotton = /(?:含棉量|棉含量|棉的比例|棉占比)(?:大概|大约|约)?(?:是|有)?(?:多少|几成|百分之几|高吗)(?:呢|啊|呀)?$|(?:含(?:有)?(?:多少|几成)棉|棉占多少|棉成分(?:有|是)?多少)(?:呢|啊|呀)?$/u.test(question);
  const polyester = /(?:是|是不是|是否是|是否为|属于|含有|有没有)(?:聚酯纤维|涤纶)(?:的面料|面料|的)?(?:吗|呢|啊)?$/u.test(question);
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
  if (/[？?]/u.test(reply)) return undefined;
  const clauses = reply.split(/[，,。；;！!\n]|但是|不过|但(?=不|要|有|含|是)|且(?=不|有|含|是)/u).map((part) => part.trim()).filter(Boolean);
  // A disclosure can refer back to the source in the preceding clause of the same reply.
  const disclosure = materialDisclosure(reply.split(/[。；;！!\n]/u), cotton);
  if (!disclosure.length && MATERIAL_UNCERTAINTY.test(reply)) return undefined;
  const directClauses = clauses.filter((part) => !MATERIAL_UNCERTAINTY.test(part) &&
    !/核实|查一下|待确认|确认后|(?:未|没有|没)(?:明确|单独|具体)*(?:标注|写明|注明|给出|说明)/u.test(part));
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
    const deny = /(?:不是|不含|没有)(?:任何|用)?(?:聚酯纤维|涤纶)/u;
    const yes = /(?:是|采用|使用|用的是|主要为|含有|含)(?:的|用的)?(?:聚酯纤维|涤纶)|(?:聚酯纤维|涤纶)(?:的)?(?:面料|材质|成分)[的哦哈呢呀\s]*$|^(?:聚酯纤维|涤纶|是的|对的)[的哦哈呢呀\s]*$/u;
    const positive = directClauses.filter((part) => yes.test(part) && !deny.test(part));
    const negative = directClauses.filter((part) => deny.test(part) || /^(?:不是的?|没有)[哦哈呢呀\s]*$/u.test(part));
    const knownPositive = details.some((value) => POLYESTER.test(value) && !deny.test(value) && !/样|仿|未标|暂无/u.test(value));
    const knownNegative = details.some((value) => deny.test(value) || cottonPercents(value).includes(100) ||
      /100\s*[%％]\s*(?:锦纶|羊毛|真丝|亚麻)/u.test(value));
    if ((knownPositive || positive.length) && (knownNegative || negative.length)) return undefined;
    if (knownPositive && positive.some((part) => /[%％]|百分之|全(?:聚酯纤维|涤纶)|纯(?:聚酯纤维|涤纶)/u.test(part))) return undefined;
    evidence = [...positive, ...negative];
    if (!evidence.length && !knownPositive && !knownNegative) evidence = disclosure;
  }
  if (!evidence.length) return undefined;
  return { provider: 'local', decisionSource: 'material-details', resolved: true,
    reason: '答复直接说明了买家询问的成分或资料缺项', evidence, matchedPoints: [], buyerReply: '' };
}

function assessDryCleanRequirement(input: ModelReceptionInput): ModelReceptionResult | undefined {
  const question = input.question.replace(/[？?]麻烦直接说一下。?$/u, '').replace(/[？?。\s]+$/u, '');
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
  const question = input.question.replace(/[？?]麻烦直接说一下。?$/u, '').replace(/[？?。\s]+$/u, '');
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

export function assessLocalTrainingRules(input: ModelReceptionInput): ModelReceptionResult | undefined {
  if (input.judgmentVersion !== 2 || input.goals.length) return undefined;
  return assessLocalWashGuidance(input) ?? assessColorDifference(input) ?? assessMediaLocation(input) ??
    assessMaterialDetails(input) ?? assessDryCleanRequirement(input) ?? assessShoeStyling(input);
}
