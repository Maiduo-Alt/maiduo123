/**
 * 商品与问题的「品类一致性」守卫（客户 2026-10-03）：
 * **不可出现商品问题和实际商品需求不一致的情况**——
 * 例如给充电器推「均码我能穿吗」、给零食推「面料会不会起球」。
 *
 * 做法很直白：给一批「只在某些品类下才成立」的词表，问题里出现这些词时，
 * 它关联的商品必须属于允许的品类；否则视为不一致。
 *
 * 这个模块被三处使用：
 * 1）`seed.ts` 生成剧本时挑商品——只从与该内容兼容的品类里轮转；
 * 2）`reception.service.ts` 抽剧本时兜底过滤——不一致的剧本不进候选（防止历史数据或人工导入的脏数据）；
 * 3）测试里的不变量扫描——遍历全量内容 × 商品，锁住「一条不一致都不许有」。
 */

/** 一个品类敏感词对应的「允许出现的商品分类」。 */
interface CategoryRule {
  /** 触发词（出现在问题文本里即命中） */
  pattern: RegExp;
  /** 允许的商品分类；空数组表示「与品类无关，任何商品都能问」 */
  categories: string[];
  /** 给报错/日志用的说明 */
  label: string;
}

/** 服装类商品的分类（男女装之外，鞋靴/内衣/童装也算服饰大类）。 */
export const APPAREL_CATEGORIES = ['女装', '男装', '童装', '内衣', '配饰', '鞋靴'];

/**
 * 品类敏感词表：只有写进这里的词才会被判定为「挑品类」；
 * 其余问题（价格、优惠、物流、订单、会员、发票、退换政策…）任何品类都成立。
 */
const CATEGORY_RULES: CategoryRule[] = [
  // 注意：这里只放「只在服饰语境下成立」的词。像「材质」「多久发货」这种任何品类都可能问到的，
  // 一旦写进来就会把正常剧本误判成不一致，所以不收。
  {
    pattern: /尺码|均码|码数|几码|什么码|能穿|上脚|版型|修身|宽松|面料|布料|起球|掉色|缩水|透气|贴肤|洗后|熨烫|袖长|领口/,
    categories: APPAREL_CATEGORIES,
    label: '服饰专属',
  },
  { pattern: /鞋码|鞋垫|鞋底|磨脚|开胶/, categories: ['鞋靴'], label: '鞋靴专属' },
  // 同理：「过敏」在食品、配饰、美妆里都会问，不能算某个品类专属，否则会误伤
  { pattern: /保质期|生产日期|口味|好吃|配料|添加剂|食用|怎么吃|辣不辣/, categories: ['食品'], label: '食品专属' },
  { pattern: /保修|参数|配置|接口|充电|续航|内存|屏幕|像素/, categories: ['数码', '家电'], label: '数码/家电专属' },
  { pattern: /孕期|宝宝|婴儿|儿童|哺乳/, categories: ['母婴', '童装'], label: '母婴专属' },
  // 注意：「过敏」在配饰/服饰语境也常用，不能算美妆专属，否则会把配饰内容误判成不一致
  { pattern: /肤质|上脸|成分|刺激/, categories: ['美妆'], label: '美妆专属' },
];

/** 这条问题有没有「挑品类」；挑的话返回规则，不挑返回 null。 */
export function questionCategoryRule(question: string): CategoryRule | null {
  const text = String(question || '');
  return CATEGORY_RULES.find((rule) => rule.pattern.test(text)) || null;
}

/** 单条问题与某个商品分类是否一致（问题不挑品类时永远一致）。 */
export function isQuestionCompatibleWithCategory(question: string, category: string | null | undefined): boolean {
  const rule = questionCategoryRule(question);
  if (!rule) return true;
  return rule.categories.includes(String(category || ''));
}

/** 一组问题与某个商品分类是否全部一致。 */
export function isProductCompatibleWithQuestions(
  category: string | null | undefined,
  questions: string[]
): boolean {
  return (questions || []).every((q) => isQuestionCompatibleWithCategory(q, category));
}

/** 某条问题被哪些「品类专属」规则命中（给测试与日志用，便于说清到底哪里不一致）。 */
export function describeQuestionRule(question: string): string | null {
  return questionCategoryRule(question)?.label || null;
}
