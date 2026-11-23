import { assessAutomaticReply } from './automatic-reply';
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

export function assessLocalTrainingRules(input: ModelReceptionInput): ModelReceptionResult | undefined {
  return assessLocalWashGuidance(input) ?? assessColorDifference(input);
}
