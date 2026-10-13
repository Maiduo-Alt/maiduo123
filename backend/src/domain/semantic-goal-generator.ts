import { KEY_POINT_ALIASES } from './key-point-aliases';
import { ConversationPlan, ScriptQuestion } from './types';

/**
 * Create editable semantic goals from the question and its existing coaching key points.
 * Each generated round remains reviewable/editable in the script preview before training.
 */
export function generateSemanticGoals(
  questions: ScriptQuestion[],
  buyerContext = '',
  _random: () => number = Math.random,
): ScriptQuestion[] {
  const context = String(buyerContext || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  // 主目标必须来自原始咨询（core），不能由补位/可选问题反客为主。
  // 旧快照没有 sourceType 时按 core 兼容。
  const candidates = questions.flatMap((question, questionIndex) => {
    if ((question.sourceType || 'core') !== 'core') return [];
    return [...new Set((question.keyPoints || []).map((point) => String(point || '').trim()))]
      .filter((point) => point && point !== '有效回应')
      .map((point, pointIndex) => ({ questionIndex, pointIndex, point }));
  });
  if (!candidates.length) return questions;

  // 不再随机挑“主目标”。优先选择最早的核心问题，并把该问题第一个业务要点作为主目标。
  // 这保证剧本主题稳定、可解释，也避免“发货/优惠”之类偶然成为工艺场景的主目标。
  const primary = candidates
    .sort((a, b) => a.questionIndex - b.questionIndex || a.pointIndex - b.pointIndex)[0];

  const generated = questions.map((question) => {
    if (question.semanticGoals?.length) return { ...question, goalPriority: question.goalPriority || 'secondary' as const };
    const keyPoints = [...new Set((question.keyPoints || []).map((point) => String(point || '').trim()))]
      .filter((point) => point && point !== '有效回应');
    if (!keyPoints.length) return { ...question, goalPriority: 'secondary' as const };

    const isPrimaryRound = question === questions[primary.questionIndex];
    const orderedPoints = isPrimaryRound
      ? [primary.point, ...keyPoints.filter((point) => point !== primary.point)]
      : keyPoints;
    return {
      ...question,
      // Keep the source question as the stable fallback. Runtime uses the plan's
      // approved templates, so generated text never replaces the consultation content.
      question: question.question,
      goalPriority: isPrimaryRound ? 'primary' as const : 'secondary' as const,
      ...(isPrimaryRound ? { primaryGoal: primary.point, baseQuestion: question.question } : {}),
      conversationPlan: buildConversationPlan(question.question, isPrimaryRound ? primary.point : keyPoints[0], isPrimaryRound),
      semanticGoals: [{
        id: `auto-goal-${question.seq}`,
        name: [context ? `「${context}」场景` : '', isPrimaryRound ? `主目标：${primary.point}` : `次要目标：${keyPoints[0]}`].filter(Boolean).join(' '),
        requiredPoints: orderedPoints.map((point, index) => ({
          id: `auto-point-${question.seq}-${index + 1}`,
          label: point,
          matchMode: 'flexible' as const,
          ...(isPrimaryRound && index === 0 ? { isPrimary: true } : {}),
          matchAny: [...new Set([point, ...(KEY_POINT_ALIASES[point] || [])])],
        })),
      }],
    };
  });
  // 保留原始咨询顺序。主目标只影响权重/评分，不再通过排序强行移动到第一轮。
  return generated.map((question, index) => ({ ...question, seq: index + 1 }));
}

const TOPIC_TEMPLATES: Array<{
  pattern: RegExp;
  prompts: string[];
  followUps: string[];
}> = [
  {
    pattern: /工艺|做工|走线|缝线|包边|锁边|内衬|耐穿|开线|脱线/u,
    prompts: ['这款做工细节怎么样？', '这种做工平时穿洗会不会容易开线？'],
    followUps: ['我主要想确认做工牢不牢，走线和边缘处理能具体说一下吗？', '那内衬和容易磨损的位置是怎么处理的？'],
  },
  {
    pattern: /材质|面料|透气|厚度|透明|起球|掉色|缩水|洗涤/u,
    prompts: ['这款具体是什么面料？', '贴身穿会不会闷或者扎？'],
    followUps: ['我主要想确认面料成分和穿着感受，可以具体说一下吗？', '如果贴身穿，透气性和舒适度怎么样？'],
  },
  {
    pattern: /尺码|码数|尺寸|偏大|偏小|裙长|衣长/u,
    prompts: ['我平时穿这个尺码，这款应该怎么选？'],
    followUps: ['我主要担心版型大小，能结合身高体重帮我推荐一下吗？'],
  },
  {
    pattern: /发货|物流|快递|配送|现货|预售|加急/u,
    prompts: ['现在下单大概什么时候可以发货？'],
    followUps: ['我比较在意到货时间，能确认一下发货和物流时效吗？'],
  },
  {
    pattern: /退|换|退款|运费|售后|补发|赔偿/u,
    prompts: ['如果收到后不合适，售后应该怎么处理？'],
    followUps: ['我想确认具体的处理条件和时效，可以说明一下吗？'],
  },
];

export function buildConversationPlan(question: string, topic: string, primary: boolean): ConversationPlan {
  const catalog = TOPIC_TEMPLATES.find((item) => item.pattern.test(topic));
  const base = String(question || '').trim();
  const prompts = [base || catalog?.prompts[0] || `我想了解一下${topic}，可以介绍一下吗？`];
  // The main goal gets one approved detail prompt after its source question.
  if (primary && catalog?.prompts[1]) prompts.push(catalog.prompts[1]);
  return {
    topic,
    priority: primary ? 'primary' : 'secondary',
    depth: primary ? 'focused' : 'normal',
    promptTemplates: [...new Set(prompts)],
    followUpTemplates: catalog?.followUps || [
      `我主要想了解${topic}，可以结合这个商品再具体说明一下吗？`,
    ],
    maxFollowUps: primary ? 2 : 1,
  };
}

/** Add one focused follow-up to the chosen main target; secondary questions stay concise. */
export function derivePrimaryQuestion(question: string, goal: string): string {
  const base = String(question || '').trim().replace(/[？?。！!]+$/u, '');
  const target = String(goal || '').trim();
  let followUp = `另外我主要想了解${target}，能结合这个商品再具体说明一下吗？`;
  if (/材质|面料/u.test(target)) followUp = '另外我比较关注材质，具体是什么面料，穿起来会不会闷或扎？';
  else if (/尺码|码数|尺寸/u.test(target)) followUp = '另外想请您结合商品版型推荐一下尺码，版型偏大还是偏小？';
  else if (/发货|物流|快递|配送/u.test(target)) followUp = '另外我比较关心发货时间，大概什么时候发出，物流预计多久能到？';
  return base ? `${base} ${followUp}` : followUp;
}
