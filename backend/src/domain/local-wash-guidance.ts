import { stripBuyerQuestionWrapper } from './adaptive-push';
import type { ModelReceptionInput, ModelReceptionResult } from './model-reception';

const WASH_INFORMATION = /洗标|洗水标|洗涤|护理|机洗|手洗|干洗|水洗|不可洗/u;
const UNKNOWN_VALUE = /^(?:[-—]+|无|暂无|未知|未提供|未注明|未标注|不详)$/u;
const MISSING_DISCLOSURE = /(?:详情(?:页)?|商品页|商品资料|资料|页面).{0,16}(?:没(?:有)?|未|暂未)(?:明确|单独|具体)?(?:标明|标注|写明|注明|说明|写|标)|(?:没(?:有)?|未|暂未)(?:明确|单独|具体)?(?:标明|标注|写明|注明|说明|写|标).{0,8}机洗/u;
const HAND_WASH = /(?:确认前|未确认前|暂时|先|建议|稳妥起见).{0,12}(?:轻柔|轻轻)?手洗/u;

export function hasWashInformation(input: ModelReceptionInput): boolean {
  const product = input.facts?.product;
  if (!product || !Array.isArray(product.attributes)) return true;
  if (WASH_INFORMATION.test(product.title || '')) return true;
  return product.attributes.some((attribute) => {
    if (!attribute || typeof attribute !== 'object' || !('name' in attribute) || !('value' in attribute)) return true;
    const value = String(attribute.value ?? '').trim();
    return !!value && !UNKNOWN_VALUE.test(value) && WASH_INFORMATION.test(`${attribute.name} ${value}`);
  });
}

/** Explicit, narrow exception for machine-washing questions in local training. */
export function assessLocalWashGuidance(input: ModelReceptionInput): ModelReceptionResult | undefined {
  const question = stripBuyerQuestionWrapper(input.question);
  if (input.judgmentVersion !== 2 || input.goals.length || question.includes('\n') || !/机洗/u.test(question) ||
      !/可以|能|适合|支持/u.test(question) || /还是|怎么|如何|干洗|温度|水温|模式|不可以|不能/u.test(question) ||
      hasWashInformation(input) || !MISSING_DISCLOSURE.test(input.reply) ||
      [question, ...input.history.map((item) => item.content)]
        .some((text) => /(?:洗标|洗水标).{0,12}(?:写着|写了|显示|标明|标注了)/u.test(text))) {
    return undefined;
  }

  const clauses = input.reply.split(/[，,。；;！？!?\n]|但是|不过|但/u).map((part) => part.trim());
  const machineAdvice = clauses.find((part) => /机洗/u.test(part) &&
    /建议|(?:也|或|或者|还)可|或|可以|允许|就能|一定能|直接|洗衣袋/u.test(part) &&
    !/不确定|无法确认|不能确认|未标注|没(?:有)?(?:明确)?标注|(?:不要|不能|不可|避免|不建议).{0,8}机洗|洗标(?:明确)?允许.{0,8}才/u.test(part));
  if (machineAdvice) {
    return { provider: 'local', decisionSource: 'wash-guidance', resolved: false,
      reason: '洗涤说明未确认，回复仍建议机洗', matchedPoints: [], buyerReply: '', evidence: [machineAdvice] };
  }

  const advice = clauses.find((part) => HAND_WASH.test(part) && !/不要|不能|不建议|不可|避免|机洗|干洗/u.test(part));
  if (!advice || clauses.some((part) => /机洗/u.test(part) &&
      (!MISSING_DISCLOSURE.test(part) || (part.match(/机洗/gu)?.length ?? 0) > 1) && !/(?:不要|不能|不可|避免|不建议).{0,8}机洗/u.test(part))) {
    return undefined;
  }
  return { provider: 'local', decisionSource: 'wash-guidance', resolved: true,
    reason: '商品未标注机洗方法，客服给出了确认前可执行的手洗建议',
    matchedPoints: [], buyerReply: '', evidence: [advice] };
}
