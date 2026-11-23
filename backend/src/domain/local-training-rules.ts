import { assessAutomaticReply, replyIntent } from './automatic-reply';
import { assessLocalWashGuidance } from './local-wash-guidance';
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

export function assessLocalTrainingRules(input: ModelReceptionInput): ModelReceptionResult | undefined {
  if (input.judgmentVersion !== 2 || input.goals.length) return undefined;
  return assessLocalWashGuidance(input) ?? assessColorDifference(input) ?? assessMediaLocation(input) ?? assessMaterialDetails(input);
}
