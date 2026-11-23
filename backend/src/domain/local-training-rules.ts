import { assessAutomaticReply, replyIntent } from './automatic-reply';
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

function assessMaterialDetails(input: ModelReceptionInput): ModelReceptionResult | undefined {
  const question = input.question.replace(/[？?]麻烦直接说一下。?$/u, '').replace(/[？?。\s]+$/u, '');
  if (!/(?:含棉量|棉含量|棉的比例|棉占比)(?:是)?(?:多少|有多少|高吗|多少呢)$|(?:是|是不是|是否是)(?:聚酯纤维|涤纶)(?:的面料|面料|吗|呢)?$/u.test(question) ||
      /[\n；;？?]|还有|以及|并且|注意事项|怎么洗|缩水|会不会/u.test(question)) return undefined;
  const product = input.facts?.product;
  if (!product || !Array.isArray(product.attributes)) return undefined;
  const attributes = product.attributes.filter((row): row is { name: string; value: unknown } =>
    !!row && typeof row === 'object' && 'name' in row && typeof row.name === 'string' && 'value' in row);
  if (attributes.length !== product.attributes.length) return undefined;
  const productMaterialDetails = [product.title, ...attributes
    .filter((row) => /材质|面料|成分|含棉/u.test(row.name))
    .map((row) => String(row.value ?? ''))].join('；');
  if (/棉|聚酯|涤纶|羊毛|羊绒|丝|麻|锦纶|氨纶|人造纤维|纤维素|[%％]/u.test(productMaterialDetails)) return undefined;
  // Conflicting or uncertain descriptions need the normal contextual judgment.
  if (/也许|或许|估计|不敢保证|不确定|说不准|不是.{0,8}(?:聚酯纤维|涤纶).{0,20}是.{0,8}(?:聚酯纤维|涤纶)|不含棉.{0,16}含棉/u.test(input.reply)) return undefined;
  const assessment = assessAutomaticReply({ question, buyerText: input.question, keyPoints: [], reply: input.reply, productMaterialDetails }, 2);
  if (!assessment.pass || !assessment.acceptedGuidance) return undefined;
  if (/(?:聚酯纤维|涤纶)/u.test(question) && !assessment.evidence?.some((part) =>
    /(?:是|采用|使用|用的是|主要为|含)(?:的|用的|含)?(?:聚酯纤维|涤纶)|(?:聚酯纤维|涤纶)(?:的)?(?:面料|材质|成分)|^(?:聚酯纤维|涤纶)[的哦哈呢\s]*$|(?:未|没|没有)(?:单独|明确)?(?:标注|注明|说明|写明)/u.test(part))) return undefined;
  return { provider: 'local', decisionSource: 'material-details', resolved: true,
    reason: '答复直接说明了买家询问的成分或资料缺项', evidence: assessment.evidence || [], matchedPoints: [], buyerReply: '' };
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
  if (!/鞋/u.test(question) || !/休闲/u.test(question) || !/搭配|怎么搭|配什么|穿什么/u.test(question) ||
      /[\n；;？?]|外套|上衣|裤子|包包|以及|还有|并且|尺码|发货|换货/u.test(question)) return undefined;

  const assessment = assessAutomaticReply({ question, buyerText: input.question, keyPoints: [], reply: input.reply }, 2);
  const footwear = /乐福鞋|帆布鞋|运动鞋|小白鞋|球鞋|板鞋|平底鞋|短靴|老爹鞋/u;
  const evidence = assessment.evidence?.filter((part) => footwear.test(part) &&
    /配|搭|推荐|建议|合适|适合|可以选/u.test(part) &&
    !/不建议|不推荐|不适合|不合适|不搭|不配|不想|不宜|别选|别穿|别搭|避免|不要|不能|没有|不确定|没货/u.test(part));
  if (!assessment.pass || !assessment.acceptedGuidance || !evidence?.length) return undefined;
  return { provider: 'local', decisionSource: 'shoe-styling', resolved: true,
    reason: '答复给出了具体的休闲鞋搭配', evidence, matchedPoints: [], buyerReply: '' };
}

export function assessLocalTrainingRules(input: ModelReceptionInput): ModelReceptionResult | undefined {
  if (input.judgmentVersion !== 2 || input.goals.length) return undefined;
  return assessLocalWashGuidance(input) ?? assessColorDifference(input) ?? assessMediaLocation(input) ??
    assessMaterialDetails(input) ?? assessDryCleanRequirement(input) ?? assessShoeStyling(input);
}
