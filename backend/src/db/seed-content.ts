/**
 * 内置训练内容库：买家咨询背景（素材）、买家咨询内容、商品、快捷短语、沟通风格、追问。
 *
 * 本文件是系统"内容"的唯一来源。新增培训素材、客户问题、商品或话术模板时，
 * 只需在这里补数据，seed 会自动同步进数据库，并按「背景 × 内容」交叉生成剧本。
 *
 * 写作约定
 * 1. 后端按「短词子串」判定回复是否命中要点，见
 *    modules/reception/reception.service.ts 的 matchKeyPoints。
 * 2. key_points 是「每个问题一组」，组的顺序与 question_list 一一对应，
 *    两者长度必须相等，否则多出来的问题会退化成几乎不可能命中的兜底要点。
 * 3. 同一组内的多个词是「同时需要命中」而不是备选，且命中率 ≥80% 才算解决，
 *    因此每组固定 2 个词，并保证这两个词会同时出现在一句正常回复里。
 *    例：「这款偏大，建议选小一码」同时命中 偏大 / 建议。
 * 4. 要点写成客服真会打出来的短词；抽象说法（如「时间说明」「处理时效」）
 *    需同时登记到 domain/key-point-aliases.ts 的同义词表。
 * 5. transferIdxs 标记该组问题必须转接主管才算处理好的序号（0 基，可选项）。
 */

/** 买家咨询背景（素材库）：描述买家是谁、处在什么处境、在意什么。 */
export interface SeedBackground {
  name: string;
  description: string;
  category: string;
}

/** 买家咨询内容（客户问题剧本）：一条内容 = 一串问题 + 对应的应答要点。 */
export interface SeedQa {
  template_name: string;
  question: string;
  question_list: string[];
  key_points: string[][];
  accepted_answer: string;
  stage: 'presale' | 'aftersale';
  category: string;
  /** 必须转接主管才算处理好的问题序号（0 基）。 */
  transferIdxs?: number[];
}

export interface SeedProduct {
  product_no: string;
  title: string;
  price: number;
  stock: number;
  category: string;
  scenes: string[];
  services: string[];
  skus: { name: string; price: number; stock: number }[];
}

export interface SeedPhrase {
  category: string;
  title: string;
  content: string;
}

export interface SeedStyle {
  code: string;
  name: string;
  description: string;
  tone: string;
  emotion: number;
  /** 占比；null 表示不参与默认分配（可在《沟通风格》页自行填写） */
  ratio: number | null;
  emotional: boolean;
}

/** 追问库：剧本轮数不足 6 轮时，按阶段追加的自然追问。 */
export interface SeedFollowUp {
  question: string;
  keyPoints: string[];
}

/** 分类字典：各内容类型在筛选器中可选的分类。 */
export const CATEGORY_SETS: Record<'bg' | 'qa' | 'script' | 'product', string[]> = {
  bg: ['通用', '价格活动相关', '物流快递相关', '退换货相关', '商品咨询相关', '售后反馈相关', '案例回流'],
  qa: [
    '通用',
    '价格活动相关',
    '物流快递相关',
    '退换货相关',
    '发票服务相关',
    '售后反馈相关',
    '商品咨询相关',
    '订单服务相关',
    '会员服务相关',
    '账号相关',
    '案例回流',
  ],
  /**
   * 剧本分类：**必须是剧本实际在用的分类**。
   * 之前这里抄了一份背景分类列表，而 seed 生成剧本时 category 写死 '培训'，
   * 结果字典里 6 项全是"被引用 0"，真正在用的「培训」反而不在字典里——
   * 带教在《回复模拟任务》里按「剧本分类」限定范围时会选到空分类、圈不到任何剧本。
   */
  script: ['培训', '案例回流'],
  product: ['女装', '男装', '童装', '内衣', '鞋靴', '箱包', '配饰', '美妆', '家居', '数码', '家电', '食品', '母婴'],
};

/**
 * 剧本生成范围：为哪些商品类目生成剧本。
 *
 * 客户 2026-10-03：任务要能**按商品种类**（男装 / 女装 / 鞋靴 / 食品 …）圈定训练内容，
 * 所以剧本不再只做服装类，而是覆盖商品库的全部类目；**具体配哪个商品由一致性规则决定**
 * （见 domain/product-consistency.ts）：
 *   - 内容里出现尺码/面料这类服饰词 → 只能配服饰类商品；
 *   - 鞋码 → 鞋靴；保质期/口味 → 食品；保修/续航 → 数码、家电；孕期/宝宝 → 母婴、童装；肤质/成分 → 美妆；
 *   - 其余通用内容（价格、优惠、物流、订单、会员、发票、退换…）任何品类都可以配。
 * 配不到任何兼容商品的内容会被跳过并打日志，绝不把不匹配的商品配给内容。
 */
export const SCRIPT_SCOPE_CATEGORIES: string[] = [
  '女装',
  '男装',
  '童装',
  '内衣',
  '鞋靴',
  '箱包',
  '配饰',
  '美妆',
  '家居',
  '数码',
  '家电',
  '食品',
  '母婴',
];

/** 商品类目是否在当前剧本生成范围内。 */
export function isScriptInScope(category: string | null | undefined): boolean {
  return SCRIPT_SCOPE_CATEGORIES.includes(String(category || ''));
}

/**
 * 每条咨询内容生成几个剧本。
 *
 * 剧本总数 = 咨询内容数 × 本值（上限为范围内商品数），商品与买家背景都按序号轮转挑选。
 * 这样剧本量只随内容量线性增长，扩商品库（含增加服装类 SKU）不会让剧本数量失控；
 * 需要更多重复训练变体时，直接调大这个值即可。
 */
export const SCRIPT_VARIANTS_PER_CONTENT = 3;

/** 买家咨询背景：8 条基础场景 + 16 条人群/性格/情境场景。 */
export const BACKGROUNDS: SeedBackground[] = [
  { name: '使用场景：出差/旅行/外出', description: '需求：便携小巧、轻便易携、不占行李', category: '通用' },
  { name: '品牌偏好：知名品牌', description: '需求：品质稳定、售后完善、有品牌背书', category: '通用' },
  { name: '消费能力：平价亲民', description: '需求：价格实惠、性价比高、经济实用', category: '价格活动相关' },
  { name: '使用场景：节日送礼', description: '需求：包装精致、体面大气、品牌可靠', category: '通用' },
  { name: '时间要求：急需使用', description: '需求：发货快、物流快、能尽快收到', category: '物流快递相关' },
  { name: '品质要求：挑剔型买家', description: '需求：细节完美、无瑕疵、支持退换', category: '退换货相关' },
  { name: '售后场景：已收到货不满意', description: '背景：对商品实物不满意，情绪较急躁', category: '售后反馈相关' },
  { name: '价格敏感：等优惠再买', description: '背景：关注价格波动，期待活动与优惠券', category: '价格活动相关' },
  { name: '使用场景：日常通勤', description: '需求：百搭耐穿、好打理、款式不夸张', category: '通用' },
  { name: '使用场景：居家日用', description: '需求：实用省空间、安全耐用、好清洗', category: '通用' },
  { name: '使用场景：运动健身', description: '需求：透气轻便、支撑性好、不闷汗', category: '通用' },
  { name: '送礼对象：长辈/父母', description: '需求：体面实用、操作简单、包装大方', category: '通用' },
  { name: '送礼对象：恋人/闺蜜', description: '需求：颜值高、包装精致、有仪式感', category: '通用' },
  { name: '人群特征：学生党', description: '需求：预算有限、看重性价比与颜值', category: '价格活动相关' },
  { name: '人群特征：宝妈带娃', description: '需求：材质安全、好清洗、省时省事', category: '通用' },
  { name: '人群特征：办公族', description: '需求：通勤效率、久坐舒适、外观得体', category: '通用' },
  { name: '购买经验：第一次网购', description: '需求：不熟悉下单与售后流程，需要逐步引导', category: '通用' },
  { name: '购买经验：老买家/熟客', description: '需求：流程熟悉、追求效率、不喜欢被重复询问', category: '通用' },
  { name: '决策方式：反复比价', description: '需求：横向对比、要依据与凭证、要额外优惠', category: '价格活动相关' },
  { name: '性格特征：爽快直接', description: '需求：不寒暄，要明确结论与可执行方案', category: '通用' },
  { name: '性格特征：谨慎多疑', description: '需求：反复确认细节、索要截图与承诺', category: '售后反馈相关' },
  { name: '性格特征：急躁易怒', description: '背景：情绪先行，沟通不当容易升级为投诉', category: '售后反馈相关' },
  { name: '时间要求：节前赶时间', description: '需求：必须在节日前收到，可接受补运费', category: '物流快递相关' },
  { name: '售后场景：包裹破损或少件', description: '背景：收到的包裹有破损或缺件，要求尽快补偿', category: '售后反馈相关' },
  { name: '使用场景：换季添衣', description: '需求：应季、好搭配、能穿几个季节', category: '通用' },
  { name: '使用场景：面试与正式场合', description: '需求：得体显气质、不过分张扬、版型利落', category: '通用' },
  { name: '使用场景：周末休闲出行', description: '需求：舒适好活动、耐脏、随手一穿就好看', category: '通用' },
  { name: '人群特征：微胖与梨形身材', description: '需求：显瘦遮肉、版型友好、不勒不紧', category: '商品咨询相关' },
  { name: '人群特征：高个子或娇小身材', description: '需求：裤长裙长合适、比例好看、避免拖地或过短', category: '商品咨询相关' },
  { name: '使用场景：约会与朋友聚会', description: '需求：有设计感、上镜显气色、不撞款', category: '通用' },
  { name: '关注点：面料舒适度', description: '需求：亲肤不扎、透气不闷、贴身穿也舒服', category: '商品咨询相关' },
  { name: '关注点：耐穿与打理成本', description: '需求：不起球不缩水、好洗好打理、能穿得久', category: '商品咨询相关' },
];

/**
 * 买家咨询内容：14 条基础内容 + 35 条扩展内容 = 49 条，覆盖
 * 商品咨询、价格活动、物流快递、订单服务、会员服务、退换货、售后反馈七类。
 */
export const QAS: SeedQa[] = [
  // ---------- 基础内容（沿用以保证既有口径不变） ----------
  { template_name: '咨询会员积分权益', question: '怎么成为店铺会员；会员有什么福利', question_list: ['怎么成为店铺会员？', '会员有什么福利？'], key_points: [['加入会员', '注册'], ['积分', '折扣', '专属价']], accepted_answer: '告知入会方式与会员权益，主动邀请入会', stage: 'presale', category: '通用' },
  { template_name: '咨询赠品发货安排', question: '赠品发货时间，是跟所购商品一起发吗；如果分开发，什么时候能到', question_list: ['赠品是跟商品一起发吗？', '如果分开发，什么时候能到？'], key_points: [['随主商品', '一起发'], ['时间说明', '48 小时', '物流时效']], accepted_answer: '明确告知赠品随主商品一起发出，并给出出库时效', stage: 'presale', category: '物流快递相关' },
  { template_name: '咨询商品赠品信息', question: '赠品是什么；是随机发还是自选，有什么规格', question_list: ['赠品是什么？', '赠品是随机发还是可以自选？'], key_points: [['赠品名称'], ['自选', '随机', '规格']], accepted_answer: '说明赠品种类与发放规则', stage: 'presale', category: '通用' },
  { template_name: '咨询优惠券使用方法', question: '已领取的优惠券有使用门槛吗；能和店铺活动叠加吗；在哪使用', question_list: ['优惠券有使用门槛吗？', '能和店铺活动叠加使用吗？', '优惠券在哪里使用？'], key_points: [['使用门槛', '满减条件'], ['叠加规则'], ['使用入口', '下单页']], accepted_answer: '说明门槛、叠加规则与使用路径', stage: 'presale', category: '价格活动相关' },
  { template_name: '咨询店铺有无优惠券', question: '店铺当前有无优惠券；如何领取', question_list: ['店铺现在有优惠券吗？', '怎么领取优惠券？'], key_points: [['优惠券名称', '面额'], ['领取入口']], accepted_answer: '主动告知可领取的优惠券并给出领取路径', stage: 'presale', category: '价格活动相关' },
  { template_name: '咨询店铺优惠活动', question: '店铺现在有什么活动；怎么参与活动', question_list: ['店铺现在有什么活动？', '怎么参与活动？'], key_points: [['活动名称'], ['参与方式']], accepted_answer: '说明当前活动内容与参与方式', stage: 'presale', category: '价格活动相关' },
  { template_name: '咨询价保服务规则', question: '有没有价保服务；如果可以价保怎么申请', question_list: ['有价保服务吗？', '价保怎么申请？'], key_points: [['价保', '保价'], ['申请入口', '客服处理']], accepted_answer: '说明价保条件与申请流程', stage: 'presale', category: '价格活动相关' },
  { template_name: '申请按原价价格购买', question: '商品涨价了，还能按之前的价格买吗', question_list: ['商品涨价了还能按之前价格买吗？', '可以帮我申请一下吗？'], key_points: [['价格说明', '以页面为准'], ['申请', '协助处理']], accepted_answer: '说明价格以页面为准，必要时协助申请', stage: 'presale', category: '价格活动相关' },
  { template_name: '咨询商品降价问题', question: '如果刚买完就降价了怎么办；能不能补差价', question_list: ['刚买完就降价了怎么办？', '可以补差价吗？'], key_points: [['降价', '价保'], ['补差流程']], accepted_answer: '告知价保流程与时效', stage: 'presale', category: '价格活动相关' },
  { template_name: '咨询商品到手价', question: '这款商品最终到手多少钱；价格是怎么算出来的', question_list: ['最终到手多少钱？', '价格是怎么算的？'], key_points: [['到手价', '实付'], ['计算方式', '优惠明细']], accepted_answer: '给出到手价构成说明', stage: 'presale', category: '价格活动相关' },
  { template_name: '咨询发票开具', question: '可以开发票吗；怎么开；多久能拿到', question_list: ['可以开发票吗？', '怎么开发票？', '多久能拿到发票？'], key_points: [['支持开票', '发票类型'], ['开票方式', '提交信息'], ['开票时效']], accepted_answer: '说明发票类型、开票流程与时效', stage: 'presale', category: '发票服务相关' },
  { template_name: '售后退换货流程', question: '收到货不合适想退货；要怎么操作；运费谁承担', question_list: ['不合适可以退货吗？', '退货怎么操作？', '退货运费谁承担？'], key_points: [['七天无理由', '支持退货'], ['申请入口', '操作步骤'], ['运费承担', '运费险']], accepted_answer: '说明退货条件、操作路径与运费规则', stage: 'aftersale', category: '退换货相关' },
  { template_name: '售后物流未更新', question: '快递三天没有更新了；是不是丢件了；你们帮我查一下', question_list: ['快递三天没更新了！', '是不是丢件了？', '你们帮我查一下！'], key_points: [['安抚', '理解'], ['物流查询', '核实'], ['处理方案', '补发', '退款']], accepted_answer: '先安抚再核实物流，给出补发或退款方案', stage: 'aftersale', category: '物流快递相关' },
  { template_name: '售后商品与描述不符', question: '实物和详情页不一样；我很不满意；要求赔偿', question_list: ['实物和详情页不一样！', '我很不满意！', '要求赔偿'], key_points: [['致歉', '抱歉'], ['差异核实', '确认'], ['解决方案', '退换', '补偿']], accepted_answer: '致歉 + 核实 + 给出退换或补偿方案', stage: 'aftersale', category: '售后反馈相关' },

  // ---------- 商品咨询（售前） ----------
  { template_name: '咨询商品尺码选择', question: '不知道该选哪个尺码；码数偏大还是偏小；希望客服帮忙推荐', question_list: ['我身高 165 体重 110 斤，选哪个码合适？', '这款尺码偏大还是偏小？', '能帮我推荐一个码数吗？'], key_points: [['尺码', '建议'], ['偏大', '建议'], ['推荐', '尺码']], accepted_answer: '结合身高体重给出尺码建议，并引导对照尺码表', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询商品材质成分', question: '面料材质和成分是什么；会不会起球；敏感肌能不能穿', question_list: ['这件是什么材质的？', '成分含量是多少，会不会起球？', '敏感肌可以穿吗？'], key_points: [['材质', '面料'], ['成分', '起球'], ['亲肤', '透气']], accepted_answer: '说明主材与含量，主动补充亲肤透气的体感说明', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询颜色色差', question: '实物颜色和图片是否一致；会不会有色差；有没有实拍图', question_list: ['实物颜色和图片一样吗？', '会不会有色差？', '有实拍图吗？'], key_points: [['颜色', '一致'], ['色差', '光线'], ['实拍', '买家秀']], accepted_answer: '如实说明色差可能性，提供实拍或买家秀参考', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询库存与补货', question: '当前是否有货；缺货多久补货；能不能先留一件', question_list: ['这个现在还有货吗？', '缺货的话什么时候补货？', '能不能帮我留一件？'], key_points: [['现货', '库存'], ['补货', '到货'], ['留货', '下单']], accepted_answer: '告知库存状态与补货节奏，说明无法口头留货但可先下单锁定', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询商品规格参数', question: '尺寸容量重量等参数是多少；能不能发一下具体规格', question_list: ['这个尺寸是多少？', '容量和重量是多少？', '能发一下具体参数吗？'], key_points: [['尺寸', '规格'], ['容量', '重量'], ['参数', '详情页']], accepted_answer: '给出关键参数，并引导以详情页标注为准', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询正品与防伪', question: '是不是正品；怎么验证真伪；有没有品牌授权', question_list: ['这个是正品吗？', '怎么验证真伪？', '有品牌授权吗？'], key_points: [['正品', '官方'], ['防伪', '查询'], ['授权', '店铺']], accepted_answer: '说明官方授权与防伪查询方式，打消买家疑虑', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询适用人群与禁忌', question: '适合什么年龄使用；孕妇儿童能不能用；有没有注意事项', question_list: ['这个适合多大年龄用？', '孕妇可以使用吗？', '小孩可以用吗？'], key_points: [['适用', '年龄'], ['孕妇', '建议'], ['儿童', '大人']], accepted_answer: '说明适用人群与禁忌，不确定的引导咨询医生或官方', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询配件清单', question: '包装里包含什么；有没有说明书和保修卡；赠品算不算在内', question_list: ['里面都包含什么？', '有说明书和保修卡吗？', '赠品算不算在内？'], key_points: [['包含', '配件'], ['说明书', '保修卡'], ['赠品', '一起']], accepted_answer: '逐项说明包装清单与赠品归属', stage: 'presale', category: '商品咨询相关' },

  // ---------- 价格活动（售前） ----------
  { template_name: '咨询直播间下单优惠', question: '直播间价格和店铺是否一致；直播间优惠券怎么领；是不是更便宜', question_list: ['直播间价格和店铺一样吗？', '直播间的优惠券怎么领？', '在直播间下单会更便宜吗？'], key_points: [['直播', '价格'], ['优惠券', '领取'], ['专享', '下单']], accepted_answer: '说明直播间专享价与领券路径，避免与店铺价混淆', stage: 'presale', category: '价格活动相关' },
  { template_name: '咨询优惠券能否叠加', question: '优惠券能不能叠加使用；一次能用几张；和满减是否冲突', question_list: ['优惠券可以叠加吗？', '一次最多能用几张？', '能和满减一起用吗？'], key_points: [['叠加', '同时'], ['一张', '叠加'], ['满减', '优惠券']], accepted_answer: '说明叠加规则与不可叠加的情形', stage: 'presale', category: '价格活动相关' },
  { template_name: '咨询跨店满减参与', question: '跨店满减怎么算；凑单能不能参加；本商品是否参与', question_list: ['跨店满减怎么算？', '我凑单能参加吗？', '这款参与活动吗？'], key_points: [['满减', '每满'], ['凑单', '一起'], ['参与', '活动']], accepted_answer: '说明满减门槛与凑单规则，明确本商品是否参与', stage: 'presale', category: '价格活动相关' },
  { template_name: '咨询限时活动开抢时间', question: '什么时候开始抢购；数量够不够；能不能预留名额', question_list: ['这个什么时候开抢？', '秒杀价还能抢到吗？', '能帮我留一个名额吗？'], key_points: [['开抢', '时间'], ['库存', '数量'], ['名额', '预留']], accepted_answer: '告知开抢时间与限购规则，说明无法预留名额', stage: 'presale', category: '价格活动相关' },
  { template_name: '要求抹零还价', question: '希望再便宜一点；能不能抹零；觉得价格偏高', question_list: ['能便宜一点吗？', '99 就卖给我行不行？', '这个价格有点贵了'], key_points: [['优惠', '活动'], ['抱歉', '统一'], ['优惠券', '帮您']], accepted_answer: '礼貌说明价格统一，转向用活动与优惠券帮买家省钱', stage: 'presale', category: '价格活动相关' },

  // ---------- 物流快递（售前） ----------
  { template_name: '咨询发货时间与截单', question: '什么时候发货；几点前下单当天发；一般多久出库', question_list: ['今天下单今天能发吗？', '几点前下单可以当天发？', '一般多久发货？'], key_points: [['当天', '发货'], ['截单', '当天'], ['48 小时', '发货']], accepted_answer: '明确出库时效与当日截单时间', stage: 'presale', category: '物流快递相关' },
  { template_name: '咨询能否指定快递', question: '能不能指定快递公司；当地快递到不了怎么办', question_list: ['可以发顺丰吗？', '能指定快递公司吗？', '我们这边韵达到不了，能换吗？'], key_points: [['顺丰', '快递'], ['指定', '备注'], ['仓库', '备注']], accepted_answer: '说明默认快递与备注可行性，不承诺一定满足', stage: 'presale', category: '物流快递相关' },
  { template_name: '咨询偏远地区配送', question: '新疆西藏能不能发；偏远地区要不要补运费；港澳台是否配送', question_list: ['新疆发货吗？', '西藏可以送到吗？', '港澳台能发吗？'], key_points: [['新疆', '运费'], ['西藏', '发货'], ['港澳台', '不发货']], accepted_answer: '如实告知配送范围与补运费规则', stage: 'presale', category: '物流快递相关' },
  { template_name: '咨询加急发货', question: '着急用能不能加急；能不能优先发货；加钱能否插队', question_list: ['我着急用，能加急吗？', '能不能优先给我发？', '加钱可以插队吗？'], key_points: [['加急', '备注'], ['优先', '发货'], ['抱歉', '不能']], accepted_answer: '协助备注加急，同时管理好买家的时效预期', stage: 'presale', category: '物流快递相关' },

  // ---------- 订单服务（售前） ----------
  { template_name: '修改收货地址', question: '地址填错了能不能改；还没发货怎么改；改了会不会影响发货', question_list: ['地址填错了还能改吗？', '还没发货，帮我改一下地址', '改地址会影响发货吗？'], key_points: [['地址', '修改'], ['未发货', '帮您'], ['仓库', '尽快']], accepted_answer: '确认未发货后立即协助修改，并同步处理时效', stage: 'presale', category: '订单服务相关' },
  { template_name: '取消订单与退款到账', question: '不想要了怎么取消；刚下单能不能退；退款多久到账', question_list: ['我不想要了，怎么取消订单？', '刚下单可以退吗？', '退款多久能到账？'], key_points: [['取消', '退款'], ['未发货', '拦截'], ['原路', '到账']], accepted_answer: '说明取消路径与退款到账时效', stage: 'presale', category: '订单服务相关' },
  { template_name: '修改订单商品规格', question: '颜色尺码选错了能不能换；想加一件能不能一起发', question_list: ['颜色选错了能换吗？', '想再加一件，能一起发吗？', '能帮我改一下尺码吗？'], key_points: [['重新下单', '重拍'], ['一起发', '合并'], ['发货前', '备注']], accepted_answer: '引导取消重拍或备注，说明价格可能变化', stage: 'presale', category: '订单服务相关' },
  { template_name: '咨询支付方式与分期', question: '支持哪些支付方式；能不能用花呗；能不能分期免息', question_list: ['支持花呗吗？', '可以分期吗？', '能用微信支付吗？'], key_points: [['花呗', '支持'], ['分期', '免息'], ['微信', '支付宝']], accepted_answer: '说明可用支付方式与分期免息条件', stage: 'presale', category: '订单服务相关' },

  // ---------- 会员服务（售前） ----------
  { template_name: '咨询关注店铺权益', question: '关注店铺有什么好处；关注能不能领券；新人礼怎么领', question_list: ['关注店铺有什么好处？', '关注能领优惠券吗？', '新人礼怎么领？'], key_points: [['关注', '优惠券'], ['领券', '店铺首页'], ['新人礼', '领取']], accepted_answer: '说明关注权益并引导立即关注领券', stage: 'presale', category: '会员服务相关' },
  { template_name: '咨询积分兑换规则', question: '积分怎么用；能兑换什么；积分会不会过期', question_list: ['积分怎么用？', '积分能兑换什么？', '积分会过期吗？'], key_points: [['积分', '兑换'], ['抵现', '礼品'], ['有效期', '过期']], accepted_answer: '说明积分用途、兑换入口与有效期', stage: 'presale', category: '会员服务相关' },

  // ---------- 退换货（售后） ----------
  { template_name: '咨询换货流程', question: '不合适能不能换；换货怎么操作；换货运费谁出', question_list: ['不合适可以换货吗？', '换货怎么操作？', '换货运费谁承担？'], key_points: [['换货', '支持'], ['申请售后', '换货'], ['运费', '运费险']], accepted_answer: '说明换货条件、操作路径与运费规则', stage: 'aftersale', category: '退换货相关' },
  { template_name: '咨询仅退款流程', question: '没收到货能不能直接退款；不退货能不能退钱；退款多久到账', question_list: ['东西没收到，能直接退款吗？', '不退货可以退钱吗？', '退款要多久到账？'], key_points: [['仅退款', '申请'], ['审核', '处理'], ['原路', '到账']], accepted_answer: '说明仅退款适用情形、审核时效与到账时间', stage: 'aftersale', category: '退换货相关' },
  { template_name: '咨询退货单号填写', question: '退货单号填在哪里；寄回后怎么填；多久之内要寄回', question_list: ['退货单号填在哪里？', '寄回之后怎么填单号？', '多久之内要寄回？'], key_points: [['单号', '申请页面'], ['填写', '物流'], ['7 天', '寄回']], accepted_answer: '指引填写入口并强调寄回时效', stage: 'aftersale', category: '退换货相关' },
  { template_name: '咨询运费险赔付', question: '有没有运费险；能赔多少；怎么申请理赔', question_list: ['有运费险吗？', '运费险能赔多少？', '运费险怎么用？'], key_points: [['运费险', '支持'], ['赔付', '金额'], ['理赔', '自动']], accepted_answer: '说明运费险赔付方式与自动理赔流程', stage: 'aftersale', category: '退换货相关' },

  // ---------- 物流快递（售后） ----------
  { template_name: '售后快递放驿站未上门', question: '快递直接放驿站了；没有送货上门；能不能重新派送', question_list: ['快递直接放驿站了，我没收到', '为什么没有送货上门？', '能重新派送一下吗？'], key_points: [['驿站', '派送'], ['送货上门', '核实'], ['重新派送', '联系快递']], accepted_answer: '致歉并协助联系快递重新派送，说明后续处理时效', stage: 'aftersale', category: '物流快递相关' },
  { template_name: '售后签收未收到', question: '物流显示已签收但没收到货；快递说放门口；怀疑丢失', question_list: ['显示签收了，但我没收到！', '快递说放门口了，东西不见了', '是不是被偷了？'], key_points: [['签收', '核实'], ['快递', '核实'], ['补发', '退款']], accepted_answer: '先安抚，再核实签收凭证并给出补发或退款方案', stage: 'aftersale', category: '物流快递相关' },
  { template_name: '售后错发漏发', question: '收到的商品和下单的不一样；少发了一件；要求补发', question_list: ['我买的是 A，发成了 B', '少发了一件', '可以补发给我吗？'], key_points: [['错发', '核实'], ['少发', '补发'], ['补发', '运费']], accepted_answer: '致歉并核实后安排补发或换货，运费由商家承担', stage: 'aftersale', category: '物流快递相关' },
  { template_name: '售后延迟发货', question: '超过承诺时间还没发货；能不能赔付；要求尽快处理', question_list: ['都超过承诺时间了还不发货', '这种情况不是应该赔付吗？', '能不能优先给我发？'], key_points: [['延迟', '发货'], ['赔付', '补偿'], ['优先', '安排']], accepted_answer: '致歉并说明赔付规则，同步安排优先发货', stage: 'aftersale', category: '物流快递相关' },

  // ---------- 售后反馈（含转接题） ----------
  { template_name: '售后做工瑕疵', question: '商品有开线掉漆等做工问题；刚用就坏；怀疑是次品', question_list: ['有开线，这也太差了', '刚用一次就坏了', '这不会是次品吧？'], key_points: [['抱歉', '核实'], ['退换', '补发'], ['质量', '抱歉']], accepted_answer: '致歉并索取凭证，给出退换或补发方案', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '售后异味与使用不适', question: '商品气味很大；使用后过敏不适；材质扎人', question_list: ['味道特别大，还能用吗？', '用完过敏了', '材质有点扎人'], key_points: [['异味', '抱歉'], ['过敏', '抱歉'], ['退换', '处理']], accepted_answer: '致歉并了解使用情况，优先按退换处理并登记问题', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '售后要求赔偿', question: '要求经济赔偿；提出多倍赔付；认为耽误了自己的事', question_list: ['你们得赔偿我的损失', '我要申请多倍赔偿', '耽误我事了，怎么赔？'], key_points: [['抱歉', '赔偿'], ['主管', '上报'], ['协商', '方案']], accepted_answer: '先致歉共情，明确个人权限边界并上报主管协商', stage: 'aftersale', category: '售后反馈相关', transferIdxs: [1] },
  { template_name: '售后投诉威胁', question: '威胁要投诉举报；要去平台投诉；要给差评', question_list: ['我要投诉你们！', '我要去平台举报', '处理不好我就给差评'], key_points: [['抱歉', '主管'], ['升级', '主管'], ['差评', '抱歉']], accepted_answer: '安抚情绪并主动升级主管处理，避免对抗性表达', stage: 'aftersale', category: '售后反馈相关', transferIdxs: [0] },

  // ---------- 服装专项：版型与面料（售前） 7 条 ----------
  { template_name: '咨询版型与显瘦效果', question: '版型偏宽松还是修身；穿上是否显瘦；微胖身材能不能驾驭', question_list: ['这款版型偏宽松还是修身？', '穿起来显瘦吗？', '我微胖能穿吗？'], key_points: [['版型', '宽松'], ['显瘦', '效果'], ['建议', '尺码']], accepted_answer: '说明版型特征与适合身材，结合尺码给出建议，不夸大显瘦效果', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询面料厚薄与透光', question: '面料厚薄如何；浅色会不会透光；夏天穿会不会闷', question_list: ['面料厚不厚？', '会不会透光？', '夏天穿会不会闷？'], key_points: [['面料', '厚薄'], ['透光', '浅色'], ['透气', '夏天']], accepted_answer: '如实说明厚薄与透光情况，必要时建议内搭或选深色', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询缩水与能否机洗', question: '洗后会不会缩水；会不会变形；能不能机洗', question_list: ['洗了会缩水吗？', '会不会变形？', '能机洗吗？'], key_points: [['缩水', '不会'], ['变形', '机洗'], ['建议', '手洗']], accepted_answer: '给出洗涤方式建议，说明缩水变形风险并把预期讲清楚', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询面料是否起球', question: '会不会起球；摩擦后会不会起毛；面料质量如何', question_list: ['会不会起球？', '摩擦多了会不会起毛？', '面料质量怎么样？'], key_points: [['起球', '面料'], ['起毛', '摩擦'], ['质量', '放心']], accepted_answer: '说明面料特性与起球概率，不做绝对承诺', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询是否掉色', question: '会不会掉色；深色会不会染到其他衣服；第一次洗要注意什么', question_list: ['会不会掉色？', '深色会染到别的衣服吗？', '第一次洗要注意什么？'], key_points: [['掉色', '浮色'], ['分开洗', '浅色'], ['建议', '第一次']], accepted_answer: '说明浮色与掉色的区别，给出分开洗、冷水洗的建议', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询洗涤标识与保养', question: '洗标怎么写的；能不能烘干；平时怎么保养', question_list: ['洗标上怎么写的？', '能烘干吗？', '平时怎么保养？'], key_points: [['机洗', '手洗'], ['烘干', '阴干'], ['保养', '建议']], accepted_answer: '按洗标说明洗涤方式与保养要点，避免买家洗坏', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询是否易皱好打理', question: '是否容易皱；要不要经常熨烫；出差携带方不方便', question_list: ['容易皱吗？', '需要经常熨烫吗？', '出差带着方便吗？'], key_points: [['皱', '打理'], ['熨烫', '方便'], ['面料', '抗皱']], accepted_answer: '说明抗皱表现与打理成本，出差场景给出携带建议', stage: 'presale', category: '商品咨询相关' },

  // ---------- 服装专项：尺码与款式（售前） 5 条 ----------
  { template_name: '咨询裤长与腰围', question: '裤长多少；腰围有没有弹性；按腰围该选哪个码', question_list: ['裤长是多少？', '腰围有弹性吗？', '我腰围 70 选哪个码？'], key_points: [['裤长', '厘米'], ['腰围', '弹性'], ['尺码', '建议']], accepted_answer: '给出裤长与腰围数据，结合买家数据推荐尺码', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询均码是否合身', question: '均码能不能穿；均码大概多大；会不会偏大', question_list: ['均码我能穿吗？', '均码大概多大？', '均码会不会太大？'], key_points: [['均码', '适合'], ['体重', '身高'], ['建议', '尺码']], accepted_answer: '说明均码的适配区间，超出区间要如实提示', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询裙长与开衩', question: '裙长到哪个位置；开衩高不高；会不会走光', question_list: ['裙长到哪个位置？', '开衩高不高？', '会不会走光？'], key_points: [['裙长', '厘米'], ['开衩', '位置'], ['放心', '打底']], accepted_answer: '给出裙长与开衩位置，必要时建议搭配打底裤', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询穿搭场景是否合适', question: '配什么下装好看；适合什么场合穿；有没有搭配推荐', question_list: ['这件配什么下装好看？', '适合什么场合穿？', '有搭配推荐吗？'], key_points: [['搭配', '建议'], ['下装', '风格'], ['场合', '适合']], accepted_answer: '给出两到三种搭配思路，并结合买家场景推荐', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询颜色选择建议', question: '肤色偏黄适合什么颜色；哪个颜色更百搭；有没有推荐色', question_list: ['我肤色偏黄选哪个颜色？', '哪个颜色更百搭？', '有推荐的色号吗？'], key_points: [['颜色', '显白'], ['百搭', '推荐'], ['肤色', '建议']], accepted_answer: '结合肤色与穿着场景推荐颜色，说明各色搭配难度', stage: 'presale', category: '商品咨询相关' },

  // ---------- 服装专项：季节与款式组合（售前） 4 条 ----------
  { template_name: '咨询季节适用性', question: '什么季节穿合适；冬天能不能穿；秋天单穿行不行', question_list: ['什么季节穿合适？', '冬天能穿吗？', '秋天单穿可以吗？'], key_points: [['季节', '适合'], ['春秋', '单穿'], ['冬天', '内搭']], accepted_answer: '说明适用季节与穿法，冬天场景说明内搭可行性', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询情侣与亲子款', question: '有没有对应男款；能不能配情侣装；尺码怎么对应', question_list: ['有对应的男款吗？', '能配成情侣装吗？', '尺码怎么对应？'], key_points: [['情侣', '亲子'], ['对应', '尺码'], ['链接', '推荐']], accepted_answer: '提供对应款链接与尺码对应关系，说明色差与批次差异', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询细节设计', question: '有没有口袋；腰带能不能拆；内衬是什么材质', question_list: ['有口袋吗？', '腰带可以拆下来吗？', '内衬是什么材质？'], key_points: [['口袋', '设计'], ['腰带', '可拆'], ['内衬', '材质']], accepted_answer: '逐项说明细节设计，避免买家收货后与预期不符', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询断码与调货', question: '想买的码是否断码；能不能调货；什么时候补码', question_list: ['这个码是不是断了？', '能不能调货？', '什么时候补码？'], key_points: [['断码', '缺货'], ['补货', '时间'], ['调货', '申请']], accepted_answer: '如实告知断码状态，说明补货节奏并帮买家登记提醒', stage: 'presale', category: '商品咨询相关' },

  // ---------- 服装专项：价格与活动（售前） 3 条 ----------
  { template_name: '咨询预售与上架时间', question: '什么时候上架；现在能不能预售；预售多久发货', question_list: ['什么时候上架？', '现在能预售吗？', '预售多久发货？'], key_points: [['上架', '时间'], ['预售', '发货'], ['提醒', '关注']], accepted_answer: '明确上架与预售发货时间，接收发货周期差异', stage: 'presale', category: '价格活动相关' },
  { template_name: '咨询尾货或瑕疵特价', question: '特价的是不是瑕疵品；瑕疵在哪个位置；还能不能退换', question_list: ['特价的是瑕疵品吗？', '瑕疵在什么位置？', '还能退换吗？'], key_points: [['瑕疵', '说明'], ['不影响', '穿着'], ['退换', '支持']], accepted_answer: '主动说明瑕疵位置与程度，明确退换政策再引导下单', stage: 'presale', category: '价格活动相关' },
  { template_name: '咨询吊牌剪了能否退换', question: '吊牌剪了还能退吗；洗过一次还能退吗；试穿后不合适怎么办', question_list: ['吊牌剪了还能退吗？', '洗过一次还能退吗？', '试穿后不合适怎么办？'], key_points: [['吊牌', '完整'], ['影响', '二次销售'], ['退换', '沟通']], accepted_answer: '说明退换需不影响二次销售，特殊情况引导走售后沟通', stage: 'presale', category: '退换货相关' },

  // ---------- 服装专项：洗护类售后 6 条 ----------
  { template_name: '售后缩水变形', question: '洗一次就缩水；衣服变形不能穿；质疑质量', question_list: ['洗了一次就缩水了', '衣服变形没法穿了', '这质量也太差了'], key_points: [['抱歉', '缩水'], ['变形', '核实'], ['退换', '处理']], accepted_answer: '致歉并索取洗标与实物照片，按退换处理并登记问题', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '售后掉色染色', question: '掉色染到其他衣服；洗出很多浮色；询问怎么处理', question_list: ['掉色把我的白衣服染了', '洗完全是浮色', '这个怎么处理？'], key_points: [['抱歉', '掉色'], ['核实', '照片'], ['退换', '补偿']], accepted_answer: '先致歉安抚，核实照片后给出退换或补偿方案', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '售后起球勾丝', question: '穿两次就起球；面料被勾丝；质疑面料质量', question_list: ['穿两次就起球了', '被勾丝了', '这面料不行吧'], key_points: [['抱歉', '起球'], ['核实', '照片'], ['退换', '补发']], accepted_answer: '致歉并核实起球范围，按退换或补发处理', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '售后拉链纽扣损坏', question: '拉链拉不上；扣子掉了；能不能寄配件', question_list: ['拉链拉不上了', '扣子掉了', '能寄配件过来吗？'], key_points: [['抱歉', '拉链'], ['配件', '补寄'], ['退换', '处理']], accepted_answer: '致歉并优先补寄配件，无法解决时走退换流程', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '售后版型与描述不符', question: '实物版型和图片不一样；说修身实际很宽松；认为描述不符', question_list: ['和图片版型不一样', '说是修身结果很宽松', '这不是描述不符吗？'], key_points: [['抱歉', '版型'], ['核实', '详情页'], ['退换', '处理']], accepted_answer: '致歉并核对详情页标注，给出退换或协商方案', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '售后发错尺码或颜色', question: '买的码发错；颜色发错；询问怎么换', question_list: ['我买的 M 发成了 L', '颜色发错了', '怎么换回来？'], key_points: [['抱歉', '发错'], ['换货', '补发'], ['运费', '承担']], accepted_answer: '致歉并立即安排换货，明确运费由商家承担', stage: 'aftersale', category: '物流快递相关' },
  { template_name: '售后洗涤后才发现问题', question: '洗过之后才发现开线；下水后才发现破洞；询问还能不能处理', question_list: ['洗过之后才发现开线', '下水后才发现有破洞', '这样还能处理吗？'], key_points: [['抱歉', '核实'], ['照片', '凭证'], ['退换', '处理']], accepted_answer: '不以洗过为由直接拒绝，先核实凭证再给出处理方案', stage: 'aftersale', category: '售后反馈相关' },

  // ---------- 物流与配送 ----------
  { template_name: '咨询节假日是否发货', question: '节假日能不能正常发货；节前下单能不能赶上；放假期间物流是否延迟', question_list: ['国庆期间还发货吗？', '节前下单来得及吗？', '放假物流会不会停？'], key_points: [['节假日', '发货'], ['顺延', '节后'], ['物流', '正常']], accepted_answer: '说明节假日发货安排与物流顺延情况，给出可到货的截单时间', stage: 'presale', category: '物流快递相关' },
  { template_name: '咨询发货仓库与就近发货', question: '从哪个仓发货；能不能安排就近仓；远近会不会影响时效', question_list: ['你们从哪个仓发货？', '能安排就近仓吗？', '离得远会不会慢？'], key_points: [['仓库', '发货'], ['就近', '安排'], ['时效', '影响']], accepted_answer: '说明发货仓与就近发货规则，管理好买家对时效的预期', stage: 'presale', category: '物流快递相关' },
  { template_name: '咨询能否拆单发货', question: '能不能先把有货的发出来；剩下的到货再发；拆单会不会多收运费', question_list: ['能先把有货的发出来吗？', '剩下的到货再发可以吗？', '拆单会多收运费吗？'], key_points: [['拆单', '发出'], ['到货', '再发'], ['运费', '不额外']], accepted_answer: '说明拆单规则与运费承担，不额外收取拆单运费', stage: 'presale', category: '物流快递相关' },
  { template_name: '咨询合并订单发货', question: '两个订单能不能一起发；合并发货怎么操作；合并后时效怎么算', question_list: ['两单能一起发吗？', '怎么合并发货？', '合并后多久发？'], key_points: [['合并', '发货'], ['备注', '订单号'], ['时效', '正常']], accepted_answer: '协助备注合并发货，说明合并后的出库安排', stage: 'presale', category: '物流快递相关' },
  { template_name: '咨询订单备注要求', question: '能不能备注不要放驿站；能不能备注放门卫；备注一定生效吗', question_list: ['能备注不放驿站吗？', '可以备注放门卫吗？', '备注一定能生效吗？'], key_points: [['备注', '登记'], ['尽量', '以实际'], ['快递', '派送']], accepted_answer: '协助备注并说明备注以快递实际派送为准，不承诺绝对生效', stage: 'presale', category: '物流快递相关' },
  { template_name: '咨询快递丢件如何理赔', question: '快递丢了怎么办；能不能全额赔；理赔要多久', question_list: ['快递丢了怎么办？', '能全额赔付吗？', '理赔要多久？'], key_points: [['丢件', '核实'], ['赔付', '补发'], ['时效', '尽快']], accepted_answer: '先安抚并核实物流，给出补发或赔付方案与时效', stage: 'aftersale', category: '物流快递相关' },
  { template_name: '咨询拒收包裹如何处理', question: '不想要了能不能拒收；拒收后退款怎么算；拒收运费谁承担', question_list: ['可以直接拒收吗？', '拒收后怎么退款？', '拒收运费谁承担？'], key_points: [['拒收', '退款'], ['运费', '承担'], ['拦截', '仓库']], accepted_answer: '说明拒收条件、退款处理与运费承担规则', stage: 'aftersale', category: '物流快递相关' },
  { template_name: '咨询物流延误补偿', question: '物流延误了有没有补偿；能不能给优惠券；延误多久算超时', question_list: ['物流延误有补偿吗？', '能给张优惠券吗？', '延误多久算超时？'], key_points: [['延误', '超时'], ['补偿', '优惠券'], ['抱歉', '理解']], accepted_answer: '致歉并说明延误判定与补偿口径，按规则给出补偿', stage: 'aftersale', category: '物流快递相关' },
  { template_name: '咨询快递保价服务', question: '能不能保价；保价费怎么收；保价后破损怎么赔', question_list: ['可以保价吗？', '保价费怎么收？', '保价后破损怎么赔？'], key_points: [['保价', '支持'], ['费用', '收取'], ['破损', '赔付']], accepted_answer: '说明保价费用、适用商品与赔付流程', stage: 'presale', category: '物流快递相关' },
  { template_name: '售后外包装破损', question: '外包装破了能不能拒收；里面商品有没有影响；破了怎么处理', question_list: ['外包装破了能拒收吗？', '里面商品有影响吗？', '这个怎么处理？'], key_points: [['破损', '抱歉'], ['拍照', '核实'], ['拒收', '补发']], accepted_answer: '致歉并引导拍照取证，建议拒收或按补发处理', stage: 'aftersale', category: '物流快递相关' },
  { template_name: '咨询同城与次日达', question: '能不能同城配送；有没有次日达；偏远区域能不能加急', question_list: ['支持同城配送吗？', '有次日达吗？', '加急能次日到吗？'], key_points: [['同城', '配送'], ['次日达', '支持'], ['时效', '区域']], accepted_answer: '如实告知可选配送方式与覆盖区域，不承诺无法保障的时效', stage: 'presale', category: '物流快递相关' },
  { template_name: '咨询海外与港澳台配送', question: '能不能发到境外；港澳台怎么发；转运地址能不能收', question_list: ['能发到国外吗？', '港澳台怎么发货？', '转运仓地址可以吗？'], key_points: [['境外', '不发货'], ['港澳台', '转运'], ['地址', '填写']], accepted_answer: '说明境外配送限制与转运方式的注意事项', stage: 'presale', category: '物流快递相关' },
  { template_name: '咨询快递服务态度问题', question: '快递员态度不好；能不能换快递；要投诉快递怎么弄', question_list: ['快递员态度很差', '能换个快递吗？', '我要投诉这个快递'], key_points: [['抱歉', '快递'], ['反馈', '网点'], ['协调', '处理']], accepted_answer: '致歉并代为向网点反馈，说明后续派送协调方案', stage: 'aftersale', category: '物流快递相关' },
  { template_name: '咨询修改收货人电话', question: '收货电话写错了能不能改；能不能改成家人电话；改了会不会影响派送', question_list: ['电话写错了能改吗？', '能改成家人的电话吗？', '改了影响派送吗？'], key_points: [['电话', '修改'], ['未发货', '尽快'], ['快递', '同步']], accepted_answer: '未发货时立即协助修改，已发货时联系快递同步信息', stage: 'presale', category: '订单服务相关' },
  { template_name: '咨询催发货与超时赔付', question: '催一下什么时候发；超过承诺时效有没有赔付；能不能优先安排', question_list: ['能帮我催一下吗？', '超出时效有赔付吗？', '能优先安排吗？'], key_points: [['催单', '安排'], ['赔付', '规则'], ['优先', '出库']], accepted_answer: '致歉并协助催单，说明超时赔付规则与优先发货安排', stage: 'aftersale', category: '物流快递相关' },

  // ---------- 价格、优惠与结算 ----------
  { template_name: '咨询会员价与专享折扣', question: '会员有没有专属价；怎么享受会员折扣；会员价能和其他优惠叠加吗', question_list: ['会员有专属价吗？', '怎么享受会员折扣？', '能和优惠券叠加吗？'], key_points: [['会员价', '专享'], ['开通', '领取'], ['叠加', '规则']], accepted_answer: '说明会员权益获取方式与叠加规则', stage: 'presale', category: '会员服务相关' },
  { template_name: '咨询优惠券过期能否补发', question: '优惠券过期了能不能补；过期没来得及用怎么办；能不能重新发一张', question_list: ['券过期了能补吗？', '没来得及用怎么办？', '能重新发一张吗？'], key_points: [['过期', '抱歉'], ['补发', '申请'], ['下单', '留意']], accepted_answer: '说明券的有效期规则，可协助申请补发但不承诺', stage: 'presale', category: '价格活动相关' },
  { template_name: '咨询下单忘记用券', question: '下单忘记用优惠券了；能不能补差；能不能取消重下', question_list: ['忘记用券了怎么办？', '能补差价吗？', '取消重下可以吗？'], key_points: [['未发货', '取消'], ['重新下单', '用券'], ['差价', '核实']], accepted_answer: '未发货时引导取消重下；已发货按价保或协商处理', stage: 'presale', category: '价格活动相关' },
  { template_name: '咨询满赠活动规则', question: '满多少有赠品；赠品怎么选；赠品送完怎么办', question_list: ['满多少有赠品？', '赠品可以选吗？', '赠品送完了怎么办？'], key_points: [['满', '赠品'], ['选择', '随机'], ['送完', '替换']], accepted_answer: '说明满赠门槛、赠品发放与送完后的替换规则', stage: 'presale', category: '价格活动相关' },
  { template_name: '咨询秒杀价与日常价', question: '秒杀价和平时差多少；没抢到还能按秒杀价买吗；下次活动什么时候', question_list: ['秒杀便宜多少？', '没抢到还能按秒杀价买吗？', '下次活动什么时候？'], key_points: [['秒杀', '价格'], ['活动价', '结束'], ['下次', '关注']], accepted_answer: '说明活动价时效，不承诺活动价延续，引导关注下次活动', stage: 'presale', category: '价格活动相关' },
  { template_name: '咨询定金预售规则', question: '定金能不能退；尾款什么时候付；不付尾款会怎样', question_list: ['定金可以退吗？', '尾款什么时候付？', '不付尾款会怎样？'], key_points: [['定金', '规则'], ['尾款', '时间'], ['不退', '说明']], accepted_answer: '说明定金与尾款规则，明确定金不退的情形', stage: 'presale', category: '价格活动相关' },
  { template_name: '咨询组合购是否更便宜', question: '组合购买便宜多少；能不能自己搭配；组合商品能不能单独退', question_list: ['组合买便宜多少？', '能自己搭配吗？', '组合能单独退一件吗？'], key_points: [['组合', '优惠'], ['搭配', '推荐'], ['退换', '整单']], accepted_answer: '说明组合优惠幅度与退换规则，避免拆单争议', stage: 'presale', category: '价格活动相关' },
  { template_name: '咨询价保申请条件', question: '什么时候能申请价保；价保要满足什么条件；价保能退多少', question_list: ['什么情况能价保？', '价保有什么条件？', '价保能退多少？'], key_points: [['价保', '条件'], ['降价', '范围内'], ['申请', '处理']], accepted_answer: '说明价保天数、适用条件与补差方式', stage: 'presale', category: '价格活动相关' },
  { template_name: '咨询比价要求降价', question: '别家更便宜；能不能按别家价格卖；有没有其他优惠', question_list: ['别家比你们便宜', '能按别家价格卖吗？', '还有什么优惠吗？'], key_points: [['价格', '统一'], ['抱歉', '不能'], ['优惠', '活动']], accepted_answer: '礼貌说明价格统一，转向用活动与权益帮买家省钱', stage: 'presale', category: '价格活动相关' },
  { template_name: '咨询运费能否退还', question: '退货后运费能退吗；运费能不能一起退；包邮商品退货运费谁出', question_list: ['退货运费能退吗？', '运费能一起退回来吗？', '包邮商品退货运费谁出？'], key_points: [['运费险', '赔付'], ['质量问题', '承担'], ['规则', '说明']], accepted_answer: '区分质量问题与无理由退货，说明运费承担规则', stage: 'aftersale', category: '退换货相关' },
  { template_name: '咨询红包与积分抵扣', question: '红包能不能用；积分能抵多少；红包和积分能不能一起用', question_list: ['红包可以用吗？', '积分能抵多少钱？', '红包和积分能一起用吗？'], key_points: [['红包', '抵扣'], ['积分', '抵现'], ['叠加', '规则']], accepted_answer: '说明红包与积分的抵扣范围与叠加限制', stage: 'presale', category: '价格活动相关' },
  { template_name: '咨询分期免息期数', question: '能分几期；免息是不是真的免；分期要不要手续费', question_list: ['最多能分几期？', '免息是真的不用利息吗？', '分期有手续费吗？'], key_points: [['分期', '期数'], ['免息', '无手续费'], ['银行', '政策']], accepted_answer: '说明分期期数与免息范围，提示以支付渠道为准', stage: 'presale', category: '订单服务相关' },
  { template_name: '咨询直播间专享券使用', question: '直播间领的券怎么用；能不能和店铺券一起用；不用会不会过期', question_list: ['直播间券怎么用？', '能和店铺券一起用吗？', '会不会过期？'], key_points: [['直播间', '优惠券'], ['使用', '入口'], ['有效期', '过期']], accepted_answer: '说明直播间券的使用入口、叠加与有效期', stage: 'presale', category: '价格活动相关' },
  { template_name: '咨询新人首单优惠', question: '新人有没有优惠；首单立减怎么领；新人券在哪领', question_list: ['新人有优惠吗？', '首单立减怎么领？', '新人券在哪里领？'], key_points: [['新人', '首单'], ['优惠券', '领取'], ['入口', '首页']], accepted_answer: '主动告知新人权益与领取入口，引导完成首单', stage: 'presale', category: '价格活动相关' },
  { template_name: '咨询大促价与平时价差异', question: '大促真的更便宜吗；平时买会不会亏；大促能便宜多少', question_list: ['大促真的更便宜吗？', '现在买会不会亏？', '大促能便宜多少？'], key_points: [['大促', '活动价'], ['价保', '保障'], ['对比', '如实']], accepted_answer: '如实说明活动力度与价保机制，不做无依据的比价承诺', stage: 'presale', category: '价格活动相关' },

  // ---------- 订单与账号操作 ----------
  { template_name: '咨询如何查询订单', question: '订单在哪里查看；怎么看物流进度；找不到订单了', question_list: ['订单在哪里看？', '怎么看物流进度？', '我找不到订单了'], key_points: [['订单', '页面'], ['物流', '查询'], ['帮您', '查一下']], accepted_answer: '给出订单与物流的查询路径，必要时代为查询', stage: 'presale', category: '订单服务相关' },
  { template_name: '咨询订单状态异常', question: '订单状态一直不变；显示待付款但已扣款；怀疑系统出错', question_list: ['订单一直显示待付款', '钱扣了但订单没变', '是不是系统出错了？'], key_points: [['订单', '异常'], ['支付', '核实'], ['同步', '处理']], accepted_answer: '致歉并核实支付与订单状态，说明同步时效', stage: 'presale', category: '订单服务相关' },
  { template_name: '咨询重复下单处理', question: '不小心下了两单；重复下单怎么办；能不能取消其中一单', question_list: ['我不小心下了两单', '重复下单了怎么办？', '能取消其中一个吗？'], key_points: [['重复', '订单'], ['取消', '一单'], ['未发货', '拦截']], accepted_answer: '协助取消其中一单，未发货时同步仓库拦截', stage: 'presale', category: '订单服务相关' },
  { template_name: '咨询下单后能否加购', question: '下单后能不能再加一件；加购能不能一起发；要不要重新下单', question_list: ['下单后还能加一件吗？', '加购能一起发吗？', '需要重新下单吗？'], key_points: [['加购', '下单'], ['一起发', '合并'], ['重新下单', '说明']], accepted_answer: '说明加购方式与合并发货的可行性', stage: 'presale', category: '订单服务相关' },
  { template_name: '咨询收货信息填写错误', question: '手机号写错；地址漏填门牌；询问还能不能修改', question_list: ['手机号写错了', '地址少写了门牌号', '还能修改吗？'], key_points: [['信息', '修改'], ['未发货', '尽快'], ['快递', '同步']], accepted_answer: '未发货时立即协助修改，已发货时联系快递同步', stage: 'presale', category: '订单服务相关' },
  { template_name: '咨询开票信息修改', question: '发票抬头写错；税号填错；能不能重新开一张', question_list: ['发票抬头写错了能改吗？', '税号填错了怎么办？', '能重新开一张吗？'], key_points: [['发票', '修改'], ['重新开', '申请'], ['信息', '核对']], accepted_answer: '核对信息后协助作废重开，说明重开时效', stage: 'presale', category: '发票服务相关' },
  { template_name: '咨询能否指定送达时间', question: '能不能约周末送；能不能指定晚上送；能不能约时间', question_list: ['能约周末送吗？', '可以指定晚上送吗？', '能约时间送货吗？'], key_points: [['送达', '时间'], ['备注', '协调'], ['快递', '为准']], accepted_answer: '协助备注并说明以快递实际派送为准，不承诺具体时段', stage: 'presale', category: '物流快递相关' },
  { template_name: '咨询账号登录异常', question: '登录不上；忘记密码；提示账号异常', question_list: ['我登录不上去了', '密码忘了怎么办？', '提示账号异常'], key_points: [['登录', '异常'], ['密码', '重置'], ['客服', '协助']], accepted_answer: '引导密码重置流程，无法自助时转人工协助', stage: 'presale', category: '账号相关' },
  { template_name: '咨询更换绑定手机号', question: '想换绑手机号；原手机号不用了；换号要不要验证', question_list: ['想换绑手机号', '原手机号不用了怎么改？', '换号要验证吗？'], key_points: [['手机号', '更换'], ['验证', '身份'], ['提交', '申请']], accepted_answer: '说明换绑所需验证材料与提交路径', stage: 'presale', category: '账号相关' },
  { template_name: '咨询查看历史订单', question: '能不能查很久以前的订单；历史订单在哪看；旧订单还能售后吗', question_list: ['能查半年前的订单吗？', '历史订单在哪里看？', '旧订单还能售后吗？'], key_points: [['历史订单', '查询'], ['订单', '记录'], ['售后', '期限内']], accepted_answer: '给出历史订单查询路径，说明售后有效期限制', stage: 'presale', category: '账号相关' },
  { template_name: '咨询取消关注与退订消息', question: '怎么取消关注店铺；不想再收消息；能不能退订短信', question_list: ['怎么取消关注？', '不想再收消息了', '能退订短信吗？'], key_points: [['取消关注', '设置'], ['消息', '退订'], ['帮您', '关闭']], accepted_answer: '告知取消关注与退订路径，尊重买家选择', stage: 'presale', category: '会员服务相关' },
  { template_name: '咨询企业采购与批量下单', question: '能不能批量采购；企业采购有没有优惠；能不能开对公发票', question_list: ['可以批量采购吗？', '企业采购有优惠吗？', '能开对公发票吗？'], key_points: [['批量', '采购'], ['优惠', '申请'], ['对公', '发票']], accepted_answer: '说明批量采购流程、优惠申请与对公开票方式', stage: 'presale', category: '订单服务相关' },

  // ---------- 退换货与售后流程 ----------
  { template_name: '咨询七天无理由起算时间', question: '七天从什么时候开始算；按发货还是签收；超过七天还能退吗', question_list: ['七天从什么时候算？', '是按发货还是签收时间？', '超过七天还能退吗？'], key_points: [['七天', '签收'], ['起算', '时间'], ['超期', '沟通']], accepted_answer: '明确七天从签收次日算起，超期情况引导沟通', stage: 'aftersale', category: '退换货相关' },
  { template_name: '咨询退货需保留哪些包装', question: '退货要不要原包装；吊牌要不要留；包装丢了还能退吗', question_list: ['退货要原包装吗？', '吊牌要留着吗？', '包装扔了还能退吗？'], key_points: [['包装', '完整'], ['吊牌', '保留'], ['影响', '二次销售']], accepted_answer: '说明退货对包装与吊牌的要求及例外处理', stage: 'aftersale', category: '退换货相关' },
  { template_name: '咨询退货寄回后多久退款', question: '寄回后多久退款；签收了怎么还没退；退款要几天', question_list: ['寄回后多久退款？', '签收了怎么还没退？', '退款要几天？'], key_points: [['寄回', '签收'], ['退款', '时效'], ['原路', '到账']], accepted_answer: '说明签收后验货与退款时效，给出明确时间预期', stage: 'aftersale', category: '退换货相关' },
  { template_name: '咨询换货能否更换款式', question: '能不能换成别的款式；换货能换颜色吗；能换别的码吗', question_list: ['能换成别的款式吗？', '换货能换颜色吗？', '能换成别的码吗？'], key_points: [['换货', '款式'], ['差价', '补'], ['重新下单', '说明']], accepted_answer: '同价可换；有差价时说明补差或重新下单流程', stage: 'aftersale', category: '退换货相关' },
  { template_name: '咨询换货是否重新计算七天', question: '换回来的还能再退吗；换货后七天重新算吗；换过的商品能退吗', question_list: ['换回来的还能再退吗？', '换货后七天重新算吗？', '换过的商品还能退吗？'], key_points: [['换货', '重新计算'], ['七天', '规则'], ['退换', '支持']], accepted_answer: '说明换货后七天重新计算的口径与适用条件', stage: 'aftersale', category: '退换货相关' },
  { template_name: '咨询退款被拒如何申诉', question: '退款被拒了怎么办；为什么不给退；能不能再申请一次', question_list: ['退款被拒了怎么办？', '为什么不给我退？', '能再申请一次吗？'], key_points: [['退款', '拒绝'], ['原因', '核实'], ['申诉', '再次申请']], accepted_answer: '核实拒绝原因并说明申诉路径，必要时协助升级处理', stage: 'aftersale', category: '退换货相关' },
  { template_name: '咨询售后超时未处理', question: '好几天没人处理；能不能催一下；多久能给结果', question_list: ['都两天没处理了', '能帮我催一下吗？', '多久能给结果？'], key_points: [['催办', '加急'], ['时效', '尽快'], ['抱歉', '反馈']], accepted_answer: '致歉并加急催办，给出明确的反馈时间点', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '咨询二次售后受理', question: '之前退过一次又想退；二次售后能不能受理；还能再申请吗', question_list: ['之前退过一次又想退', '二次售后能受理吗？', '还能再申请吗？'], key_points: [['二次售后', '受理'], ['情况', '核实'], ['方案', '沟通']], accepted_answer: '不以二次为由直接拒绝，先核实情况再给出处理方案', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '咨询寄回途中破损', question: '寄回路上坏了算谁的责任；快递弄坏了怎么办；还能退款吗', question_list: ['寄回路上坏了算谁的？', '快递弄坏了怎么办？', '这样还能退款吗？'], key_points: [['寄回', '破损'], ['凭证', '核实'], ['协商', '处理']], accepted_answer: '引导保留物流凭证，按责任归属协商处理，不直接拒绝退款', stage: 'aftersale', category: '退换货相关' },
  { template_name: '咨询退货地址与联系人', question: '退货寄到什么地址；收件人电话是多少；怎么获取退货地址', question_list: ['退货寄到什么地址？', '收件人电话是多少？', '退货地址在哪里看？'], key_points: [['退货地址', '提供'], ['收件人', '电话'], ['申请页面', '查看']], accepted_answer: '提供准确的退货地址与联系人，并提示按申请页面为准', stage: 'aftersale', category: '退换货相关' },
  { template_name: '咨询退货能否上门取件', question: '能不能上门取件；取件要不要加钱；怎么预约上门', question_list: ['能上门取件吗？', '上门取件要加钱吗？', '怎么预约上门？'], key_points: [['上门取件', '支持'], ['预约', '申请售后'], ['费用', '运费险']], accepted_answer: '说明上门取件的预约路径与费用承担', stage: 'aftersale', category: '退换货相关' },
  { template_name: '咨询部分退货是否受理', question: '只想退其中一件；能不能部分退货；套装能退一半吗', question_list: ['只想退其中一件', '可以部分退货吗？', '套装能退一半吗？'], key_points: [['部分', '退货'], ['商品', '选择'], ['金额', '按件']], accepted_answer: '说明部分退货的受理范围与退款金额计算方式', stage: 'aftersale', category: '退换货相关' },
  { template_name: '咨询赠品是否需要退回', question: '退货时赠品要不要退；赠品用掉了还能退吗；赠品丢了怎么办', question_list: ['退货时赠品要退吗？', '赠品用掉了还能退吗？', '赠品丢了怎么办？'], key_points: [['赠品', '退回'], ['影响', '退款'], ['协商', '处理']], accepted_answer: '说明赠品退回要求与缺失时的扣减或协商方式', stage: 'aftersale', category: '退换货相关' },
  { template_name: '咨询售后申请撤销', question: '申请错了能不能撤销；选错原因怎么办；撤销后还能再申请吗', question_list: ['申请错了能撤销吗？', '选错原因了怎么办？', '撤销后还能再申请吗？'], key_points: [['撤销', '申请'], ['重新', '提交'], ['帮您', '处理']], accepted_answer: '协助撤销错误申请并引导重新提交正确类型', stage: 'aftersale', category: '退换货相关' },
  { template_name: '咨询退款账户变更', question: '能不能退到别的账户；原卡注销了怎么办；钱退到哪里了', question_list: ['能退到别的账户吗？', '原来的卡注销了', '退款退到哪里了？'], key_points: [['原路退回', '账户'], ['变更', '不支持'], ['核实', '到账']], accepted_answer: '说明退款原路退回规则，账户异常时引导核实处理', stage: 'aftersale', category: '退换货相关' },
  { template_name: '咨询售后处理时效', question: '售后多久处理完；有没有明确时效；能不能加急处理', question_list: ['售后多久处理完？', '有明确时效吗？', '能加急处理吗？'], key_points: [['处理', '时效'], ['加急', '申请'], ['尽快', '反馈']], accepted_answer: '给出各环节处理时效，可加急的说明申请方式', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '咨询售后需要哪些凭证', question: '要提供什么材料；要拍几张照片；需不需要开箱视频', question_list: ['需要提供什么材料？', '要拍几张照片？', '需要开箱视频吗？'], key_points: [['凭证', '照片'], ['开箱', '视频'], ['核实', '需要']], accepted_answer: '一次性说清所需凭证，避免买家反复补材料', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '咨询售后进度查询', question: '售后进度在哪看；怎么查处理到哪一步；有结果会通知吗', question_list: ['售后进度在哪看？', '怎么查处理到哪一步了？', '有结果会通知我吗？'], key_points: [['售后', '进度'], ['页面', '查询'], ['通知', '回复']], accepted_answer: '告知进度查询入口并承诺结果主动同步', stage: 'aftersale', category: '售后反馈相关' },

  // ---------- 商品质量与使用 ----------
  { template_name: '售后商品有污渍', question: '收到的商品有污渍；刚拆开就有脏点；质疑发货检查', question_list: ['衣服上有污渍', '刚拆开就有脏点', '这怎么能发出来？'], key_points: [['抱歉', '污渍'], ['照片', '核实'], ['退换', '补发']], accepted_answer: '致歉并索取照片，优先按退换或补发处理', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '售后五金件生锈', question: '金属配件生锈；怀疑是旧货；要求更换', question_list: ['拉链头生锈了', '五金件颜色发黑', '这不会是旧货吧？'], key_points: [['抱歉', '生锈'], ['照片', '核实'], ['退换', '处理']], accepted_answer: '致歉并核实情况，按退换处理并反馈品控', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '售后拉链卡顿', question: '拉链很卡；拉不上也拉不下；询问能否维修', question_list: ['拉链特别卡', '拉上去就下不来', '能不能修一下？'], key_points: [['抱歉', '拉链'], ['上蜡', '处理'], ['补寄', '退换']], accepted_answer: '先给出可自行处理的方法，无法解决则补寄或退换', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '售后鞋底开胶', question: '鞋底开胶；穿两次就开胶；要求换新', question_list: ['鞋底开胶了', '才穿两次就开胶', '能换新的吗？'], key_points: [['抱歉', '开胶'], ['照片', '核实'], ['退换', '处理']], accepted_answer: '致歉并核实，按退换或维修处理并说明时效', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '售后鞋面磨损', question: '鞋面磨损；颜色磨掉；质疑质量', question_list: ['鞋面磨破了', '颜色都磨掉了', '这质量太差了吧'], key_points: [['抱歉', '磨损'], ['照片', '核实'], ['退换', '处理']], accepted_answer: '区分正常磨损与质量问题，属实即按退换处理', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '售后电器无法开机', question: '通电无反应；按开关没反应；怀疑是坏的', question_list: ['插上电没反应', '按开关没反应', '是不是坏的？'], key_points: [['抱歉', '无法开机'], ['排查', '操作'], ['换新', '处理']], accepted_answer: '先引导排查供电与操作，确认故障后换新或退款', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '售后电器噪音偏大', question: '运行声音很大；比页面演示大；询问能否退', question_list: ['声音特别大', '比视频里吵多了', '这种情况能退吗？'], key_points: [['抱歉', '噪音'], ['排查', '使用'], ['退换', '处理']], accepted_answer: '说明正常噪音范围，异常时按退换处理', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '售后功能与说明不符', question: '宣传的功能没有；与详情页不符；质疑宣传', question_list: ['宣传的功能没有', '和详情页写的不一样', '这算虚假宣传吗？'], key_points: [['抱歉', '功能'], ['核实', '详情页'], ['退换', '处理']], accepted_answer: '致歉并核对详情页标注，属实的先退换再反馈优化', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '售后电池续航不符', question: '续航远低于宣传；用不到一天；要求退货', question_list: ['用不到一天就没电', '和宣传差太多', '能退货吗？'], key_points: [['抱歉', '续航'], ['使用', '说明'], ['检测', '退换']], accepted_answer: '说明续航受使用场景影响，异常时检测后按退换处理', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '售后摩擦掉色', question: '轻轻一擦就掉色；摸一下手就染色；问是否质量问题', question_list: ['一擦就掉色', '用手一摸就染色', '这算质量问题吗？'], key_points: [['抱歉', '掉色'], ['照片', '核实'], ['退换', '处理']], accepted_answer: '区分浮色与掉色，属实按退换处理', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '售后面料勾丝', question: '面料勾丝；询问能不能修；是否算质量问题', question_list: ['面料勾丝了', '这种能修吗？', '算质量问题吗？'], key_points: [['抱歉', '勾丝'], ['照片', '核实'], ['补发', '退换']], accepted_answer: '区分佩戴剐蹭与面料问题，按情况补发或退换', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '售后羽绒跑绒', question: '羽绒一直往外钻；到处都是毛；问是否正常', question_list: ['一直往外钻绒', '到处都是毛毛', '这样正常吗？'], key_points: [['抱歉', '跑绒'], ['说明', '正常范围'], ['退换', '处理']], accepted_answer: '说明轻微跑绒属正常，超出范围按退换处理', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '售后填充物结块', question: '填充物跑偏结块；一坨一坨的；要求更换', question_list: ['里面棉跑偏了', '一坨一坨的', '能换一件吗？'], key_points: [['抱歉', '结块'], ['拍打', '晾晒'], ['退换', '处理']], accepted_answer: '先给出恢复方法，无法恢复按退换处理', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '售后配件缺失', question: '配件少了一件；少了说明书；能不能补寄', question_list: ['配件少了一个', '没有说明书', '能补寄吗？'], key_points: [['抱歉', '缺少'], ['补寄', '安排'], ['运费', '承担']], accepted_answer: '致歉并立即补寄缺失配件，运费由商家承担', stage: 'aftersale', category: '物流快递相关' },
  { template_name: '咨询安装与使用指导', question: '没有安装说明；不知道怎么装；能不能发安装视频', question_list: ['没有安装图', '不知道怎么装', '能发个安装视频吗？'], key_points: [['抱歉', '说明'], ['视频', '发送'], ['指导', '帮您']], accepted_answer: '主动发送安装视频或图文指导，必要时远程协助', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '售后实物色差明显', question: '实物颜色差很多；几乎是另一个色；问是否描述不符', question_list: ['颜色差太多了', '完全是另一个色', '这算描述不符吗？'], key_points: [['抱歉', '色差'], ['照片', '核实'], ['退换', '处理']], accepted_answer: '致歉并核实，差异超出常规范围按退换处理', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '售后尺寸与标注不符', question: '实测与标注差距大；短了好几厘米；怎么处理', question_list: ['量出来和标注不一样', '短了好几厘米', '这个怎么处理？'], key_points: [['抱歉', '尺寸'], ['测量', '核实'], ['退换', '处理']], accepted_answer: '引导提供实测照片，确认偏差后按退换处理', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '售后使用中损坏', question: '使用中突然损坏；一周就坏；询问保修', question_list: ['用着突然就坏了', '才一周就坏了', '能保修吗？'], key_points: [['抱歉', '损坏'], ['质保', '核实'], ['换新', '维修']], accepted_answer: '说明质保范围，按检测结果安排换新或维修', stage: 'aftersale', category: '售后反馈相关' },

  // ---------- 情绪安抚与投诉升级（含需转接主管的场景） ----------
  { template_name: '投诉至平台', question: '表示要去平台投诉；追问投诉渠道；情绪激动', question_list: ['我要去平台投诉你们', '你们再不管我就投诉', '投诉电话是多少？'], key_points: [['抱歉', '理解'], ['主管', '升级'], ['尽快', '处理']], accepted_answer: '先共情降温，立即升级主管介入，不与买家对抗', stage: 'aftersale', category: '售后反馈相关', transferIdxs: [0] },
  { template_name: '要求多倍赔偿', question: '要求按倍数赔偿；引用法规施压；询问赔不赔', question_list: ['我要三倍赔偿', '按法规你们得赔', '到底赔不赔？'], key_points: [['抱歉', '赔偿'], ['主管', '上报'], ['协商', '方案']], accepted_answer: '共情并说明权限边界，上报主管协商处理', stage: 'aftersale', category: '售后反馈相关', transferIdxs: [1] },
  { template_name: '以差评施压', question: '以差评要挟；要求满足诉求；情绪对立', question_list: ['不处理我就给差评', '一星差评等着', '你们看着办'], key_points: [['抱歉', '理解'], ['方案', '处理'], ['争取', '满意']], accepted_answer: '不被要挟带节奏，聚焦解决问题并主动争取满意度', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '要求公开道歉', question: '要求公开道歉；要求书面道歉；扬言曝光', question_list: ['要给我公开道歉', '必须书面道歉', '不然我就曝光'], key_points: [['抱歉', '歉意'], ['主管', '上报'], ['协商', '沟通']], accepted_answer: '诚恳致歉并说明处理路径，超出权限部分上报主管', stage: 'aftersale', category: '售后反馈相关', transferIdxs: [1] },
  { template_name: '要求书面承诺', question: '要求书面保证；认为口头承诺无效；追问责任归属', question_list: ['能给我书面保证吗？', '口说无凭，能写下来吗？', '出问题你们负责吗？'], key_points: [['承诺', '答复'], ['记录', '留档'], ['保障', '放心']], accepted_answer: '在权限内给出明确承诺并留档，不做超范围保证', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '质疑虚假宣传', question: '认为宣传与实物不符；要求解释；扬言举报', question_list: ['你们这是虚假宣传', '和广告完全不一样', '我要去举报'], key_points: [['抱歉', '核实'], ['详情页', '说明'], ['主管', '上报']], accepted_answer: '核对宣传口径并如实说明，涉及合规问题上报主管', stage: 'aftersale', category: '售后反馈相关', transferIdxs: [2] },
  { template_name: '要求出具质量证明', question: '要求质量证明；要求盖章说明；询问检测报告', question_list: ['能开质量证明吗？', '需要盖章的说明', '能提供检测报告吗？'], key_points: [['证明', '申请'], ['报告', '提供'], ['时效', '说明']], accepted_answer: '说明可提供的证明材料与获取时效，不承诺无法出具的证明', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '反复催问无人正面回应', question: '每次都被敷衍；没人正面回答；追问谁负责', question_list: ['每次都说在处理', '一直没人正面回答我', '到底谁负责？'], key_points: [['抱歉', '负责'], ['专人', '对接'], ['时间', '答复']], accepted_answer: '致歉并指定专人对接，给出明确的答复时间点', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '要求更换主管沟通', question: '要求找主管；认为客服处理不了；要求升级', question_list: ['我要找你们主管', '让你们负责人来', '和你沟通没用'], key_points: [['理解', '帮您'], ['主管', '升级'], ['对接', '安排']], accepted_answer: '不与买家争辩，立即升级主管并同步对接安排', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '要求补偿时间损失', question: '要求补偿耽误的时间；认为造成损失；要求表示', question_list: ['耽误我时间要补偿', '给我造成了损失', '你们得表示表示'], key_points: [['抱歉', '理解'], ['补偿', '申请'], ['主管', '上报']], accepted_answer: '共情并说明可申请的补偿范围，超出权限上报主管', stage: 'aftersale', category: '售后反馈相关', transferIdxs: [2] },
  { template_name: '质疑价格欺诈', question: '怀疑先涨价再打折；质疑活动价真实性；扬言举报', question_list: ['你们是不是先涨价再打折？', '这个活动价是真的吗？', '我要举报价格欺诈'], key_points: [['价格', '核实'], ['活动', '说明'], ['主管', '反馈']], accepted_answer: '如实说明价格与活动口径，涉及质疑上报主管核查', stage: 'aftersale', category: '价格活动相关' },
  { template_name: '声称走法律途径', question: '声称要起诉；要走法律程序；拒绝继续沟通', question_list: ['我要走法律程序', '准备起诉你们', '法庭上见'], key_points: [['理解', '抱歉'], ['主管', '升级'], ['协商', '处理']], accepted_answer: '保持克制不激化，立即升级主管并按流程留档', stage: 'aftersale', category: '售后反馈相关', transferIdxs: [2] },

  // ---------- 发票与合规 ----------
  { template_name: '咨询开具增值税专用发票', question: '能不能开专票；专票要提供什么资料；开专票要不要加钱', question_list: ['可以开专票吗？', '开专票要提供什么？', '开专票要加钱吗？'], key_points: [['专票', '支持'], ['资料', '提供'], ['税点', '说明']], accepted_answer: '说明专票开具条件、所需资料与税费口径', stage: 'presale', category: '发票服务相关' },
  { template_name: '咨询电子发票下载', question: '电子发票在哪里下载；没收到发票邮件；能不能重发', question_list: ['电子发票在哪里下载？', '没收到发票邮件', '能重新发一次吗？'], key_points: [['电子发票', '下载'], ['邮箱', '发送'], ['重新发', '安排']], accepted_answer: '给出下载入口，未收到的核实后重新发送', stage: 'presale', category: '发票服务相关' },
  { template_name: '咨询发票丢失补开', question: '发票丢了能不能补；能不能重开一张；需要什么手续', question_list: ['发票丢了能补吗？', '能重新开一张吗？', '需要什么手续？'], key_points: [['发票', '补开'], ['申请', '提交'], ['时效', '说明']], accepted_answer: '说明补开流程与时效，提示发票类型差异', stage: 'presale', category: '发票服务相关' },
  { template_name: '咨询开票金额与实付不一致', question: '发票金额比实付少；为什么不一致；能不能按实付开', question_list: ['发票金额不对', '为什么比我付的少？', '能按实付开吗？'], key_points: [['金额', '核实'], ['优惠', '扣除'], ['重开', '处理']], accepted_answer: '解释开票金额按实际支付计算的口径，需要时协助重开', stage: 'presale', category: '发票服务相关' },
  { template_name: '咨询开具公司抬头', question: '能不能开公司抬头；需要提供什么信息；能开对公的吗', question_list: ['能开公司抬头吗？', '需要提供什么信息？', '能开对公发票吗？'], key_points: [['抬头', '公司'], ['税号', '填写'], ['信息', '提供']], accepted_answer: '说明公司抬头所需信息与提交方式', stage: 'presale', category: '发票服务相关' },
  { template_name: '咨询纸质发票邮寄', question: '纸质发票能不能寄；邮寄要多久；运费谁出', question_list: ['纸质发票能寄吗？', '邮寄要多久？', '运费谁承担？'], key_points: [['纸质', '邮寄'], ['运费', '承担'], ['时效', '安排']], accepted_answer: '说明纸质发票邮寄条件、时效与运费承担', stage: 'presale', category: '发票服务相关' },

  // ---------- 会员与复购 ----------
  { template_name: '咨询会员等级升级', question: '会员怎么升级；等级有什么用；消费多少能升级', question_list: ['会员怎么升级？', '等级有什么用？', '消费多少能升级？'], key_points: [['等级', '升级'], ['消费', '累计'], ['权益', '对应']], accepted_answer: '说明等级规则、升级门槛与对应权益', stage: 'presale', category: '会员服务相关' },
  { template_name: '咨询会员专属客服', question: '会员有没有专属客服；能不能优先处理；入口在哪里', question_list: ['会员有专属客服吗？', '能优先处理吗？', '入口在哪里？'], key_points: [['专属', '客服'], ['优先', '处理'], ['通道', '入口']], accepted_answer: '说明会员专属服务通道与优先处理范围', stage: 'presale', category: '会员服务相关' },
  { template_name: '咨询积分过期规则', question: '积分快过期了怎么办；能不能延期；过期还能用吗', question_list: ['积分快过期了怎么办？', '能延长有效期吗？', '过期的还能用吗？'], key_points: [['积分', '过期'], ['有效期', '查询'], ['兑换', '尽快']], accepted_answer: '提示有效期查询路径并引导尽快兑换，不承诺延期', stage: 'presale', category: '会员服务相关' },
  { template_name: '咨询老客专属优惠', question: '老客户有没有优惠；有没有专属券；回购能不能打折', question_list: ['老客户有优惠吗？', '有专属优惠券吗？', '回购能打折吗？'], key_points: [['老客', '优惠'], ['专属', '领取'], ['复购', '折扣']], accepted_answer: '主动告知老客权益并给出领取路径', stage: 'presale', category: '会员服务相关' },
  { template_name: '咨询复购搭配推荐', question: '想再买一件搭配的；有推荐吗；之前买的能配什么', question_list: ['想再买一件搭配的', '有什么推荐吗？', '之前买的能配什么？'], key_points: [['搭配', '推荐'], ['同款', '风格'], ['链接', '发送']], accepted_answer: '结合已购商品给出搭配建议并发送商品链接', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询关注店铺抽奖活动', question: '关注能不能抽奖；活动怎么参加；中奖怎么领', question_list: ['关注能抽奖吗？', '活动怎么参加？', '中奖了怎么领？'], key_points: [['关注', '抽奖'], ['参与', '方式'], ['中奖', '领取']], accepted_answer: '说明抽奖参与方式与中奖领取路径', stage: 'presale', category: '会员服务相关' },
  { template_name: '咨询邀请好友奖励', question: '邀请好友有没有奖励；怎么邀请；奖励什么时候发', question_list: ['邀请好友有奖励吗？', '怎么邀请好友？', '奖励什么时候到？'], key_points: [['邀请', '好友'], ['奖励', '发放'], ['到账', '时间']], accepted_answer: '说明邀请奖励规则与发放时效', stage: 'presale', category: '会员服务相关' },
  { template_name: '咨询会员生日礼遇', question: '生日有没有礼物；生日券怎么领；什么时候发', question_list: ['生日有礼物吗？', '生日券怎么领？', '什么时候发放？'], key_points: [['生日', '礼遇'], ['优惠券', '发放'], ['当月', '领取']], accepted_answer: '说明生日礼遇内容与领取时间', stage: 'presale', category: '会员服务相关' },

  // ---------- 服装专项深挖 ----------
  { template_name: '咨询袖长与肩宽', question: '袖长多少；肩宽多少；按肩宽该怎么选码', question_list: ['袖长是多少？', '肩宽是多少？', '我肩宽 40 能穿吗？'], key_points: [['袖长', '厘米'], ['肩宽', '数据'], ['尺码', '建议']], accepted_answer: '给出袖长肩宽实测数据并据此推荐尺码', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询领口设计与走光风险', question: '领口会不会太大；V 领会不会走光；能不能改小', question_list: ['领口会不会太大？', 'V 领会走光吗？', '能改小一点吗？'], key_points: [['领口', '设计'], ['走光', '打底'], ['修改', '不支持']], accepted_answer: '说明领口尺寸与穿着建议，明确不支持成衣修改', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询口袋位置与容量', question: '口袋能不能装手机；口袋深不深；有几个口袋', question_list: ['口袋能装手机吗？', '口袋深不深？', '有几个口袋？'], key_points: [['口袋', '容量'], ['手机', '尺寸'], ['位置', '数量']], accepted_answer: '给出口袋尺寸与可容纳物品，避免买家预期偏差', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询里布与透气性', question: '有没有里布；里布会不会闷；内衬是什么材质', question_list: ['有里布吗？', '里布会不会闷？', '内衬是什么材质？'], key_points: [['里布', '材质'], ['透气', '闷'], ['内衬', '说明']], accepted_answer: '说明里布材质与透气表现，适合场景一并告知', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询拉链与纽扣材质', question: '拉链什么材质；纽扣会不会掉色；是不是金属的', question_list: ['拉链是什么材质？', '纽扣会掉色吗？', '是金属纽扣吗？'], key_points: [['拉链', '材质'], ['纽扣', '金属'], ['掉色', '不易']], accepted_answer: '说明五金材质与电镀工艺，提示长期摩擦的正常变化', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询印花与刺绣牢固度', question: '印花会不会掉；洗几次会不会开裂；刺绣会不会脱线', question_list: ['印花会掉吗？', '洗几次会不会裂开？', '刺绣会不会脱线？'], key_points: [['印花', '牢固'], ['水洗', '不易掉'], ['刺绣', '工艺']], accepted_answer: '说明印花与刺绣工艺及洗涤注意事项', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询不同批次色差', question: '补货和之前颜色一样吗；不同批次会不会有色差；能不能保证一致', question_list: ['补货颜色和之前一样吗？', '不同批次会有色差吗？', '能保证完全一样吗？'], key_points: [['批次', '色差'], ['轻微', '差异'], ['说明', '如实']], accepted_answer: '如实说明批次差异可能性，不承诺绝对无色差', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询大码尺码范围', question: '有没有大码；最大能穿到多少；有没有 4XL', question_list: ['有大码吗？', '最大能穿到多少斤？', '有 4XL 吗？'], key_points: [['大码', '范围'], ['体重', '适合'], ['尺码', '建议']], accepted_answer: '给出最大尺码与适配范围，超出范围如实告知', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询同类商品版型对比', question: '两款哪个更修身；版型有什么区别；哪款更显瘦', question_list: ['这款和另一款哪个更修身？', '版型有什么区别？', '哪款更显瘦？'], key_points: [['版型', '区别'], ['修身', '宽松'], ['推荐', '对比']], accepted_answer: '横向对比两款版型差异并给出选择建议', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询孕妇装适用阶段', question: '怀孕几个月能穿；产后还能不能穿；肚子大了能不能穿', question_list: ['怀孕几个月能穿？', '产后还能穿吗？', '肚子大了能穿吗？'], key_points: [['孕周', '适合'], ['产后', '可穿'], ['弹性', '设计']], accepted_answer: '说明适用孕周与产后穿着可行性', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询童装安全标准', question: '童装符不符合标准；面料安不安全；有没有检测报告', question_list: ['童装符合标准吗？', '面料安全吗？', '有检测报告吗？'], key_points: [['标准', '符合'], ['面料', '安全'], ['报告', '提供']], accepted_answer: '说明执行标准与安全类别，可提供检测报告', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询鞋码偏大偏小', question: '鞋码偏大还是偏小；平时 37 选几码；脚宽能不能穿', question_list: ['鞋码偏大还是偏小？', '我平时 37 选几码？', '脚宽能穿吗？'], key_points: [['鞋码', '偏'], ['建议', '尺码'], ['脚宽', '选大']], accepted_answer: '给出鞋码偏度与脚型适配建议', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询真皮与 PU 区别', question: '是不是真皮；真皮和 PU 有什么区别；哪种更耐穿', question_list: ['这是真皮吗？', '真皮和 PU 有什么区别？', '哪种更耐穿？'], key_points: [['真皮', '材质'], ['PU', '区别'], ['耐用', '说明']], accepted_answer: '如实说明材质并对比耐用性与打理成本', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询鞋跟高度与舒适度', question: '鞋跟多高；穿久会不会累；有没有低跟款', question_list: ['鞋跟多高？', '穿久了会累吗？', '有低跟的吗？'], key_points: [['跟高', '厘米'], ['舒适', '设计'], ['低跟', '推荐']], accepted_answer: '给出跟高数据与穿着舒适度说明，可推荐低跟替代款', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询包内容量与电脑适配', question: '能不能放 14 寸电脑；容量大不大；能不能装 A4 文件', question_list: ['能放 14 寸电脑吗？', '容量大不大？', '能装下 A4 文件吗？'], key_points: [['容量', '尺寸'], ['电脑', '适配'], ['放入', '建议']], accepted_answer: '给出内部尺寸与可容纳物品清单', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询配饰是否过敏掉色', question: '戴了会不会过敏；会不会掉色；是不是纯银', question_list: ['戴了会过敏吗？', '会不会掉色？', '是纯银的吗？'], key_points: [['过敏', '材质'], ['掉色', '不易'], ['材质', '说明']], accepted_answer: '说明材质与佩戴注意，过敏体质建议谨慎选择', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询内衣尺码测量方法', question: '尺码怎么量；75B 该选什么码；下胸围怎么量', question_list: ['尺码怎么量？', '我是 75B 选什么码？', '下胸围怎么量？'], key_points: [['测量', '方法'], ['尺码', '对应'], ['建议', '试穿']], accepted_answer: '给出测量方法与尺码对照，建议结合实际体验选择', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询家居服厚薄与季节', question: '家居服厚不厚；夏天穿会不会热；冬天能不能穿', question_list: ['家居服厚不厚？', '夏天穿会热吗？', '冬天能穿吗？'], key_points: [['厚薄', '季节'], ['夏天', '透气'], ['冬天', '加厚']], accepted_answer: '说明厚薄与适用季节，按季节推荐对应款', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询防晒衣防晒等级', question: '防晒指数多少；真的能防晒吗；洗过还防晒吗', question_list: ['防晒指数是多少？', '真的能防晒吗？', '洗过还防晒吗？'], key_points: [['UPF', '等级'], ['防晒', '效果'], ['水洗', '影响']], accepted_answer: '说明防晒等级与实际防护效果，提示水洗后的影响', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询羽绒服含绒量', question: '含绒量多少；充绒量多少克；够不够暖和', question_list: ['含绒量是多少？', '充绒量是多少克？', '够不够暖和？'], key_points: [['含绒量', '充绒量'], ['克', '数据'], ['保暖', '效果']], accepted_answer: '给出含绒量与充绒量数据，结合实际场景说明保暖性', stage: 'presale', category: '商品咨询相关' },

  // ---------- 商品与包装细节 ----------
  { template_name: '咨询面料支数与手感', question: '面料支数多少；手感怎么样；会不会很粗糙', question_list: ['面料支数是多少？', '手感怎么样？', '会不会很粗糙？'], key_points: [['支数', '面料'], ['手感', '柔软'], ['亲肤', '说明']], accepted_answer: '说明面料支数与手感表现，不做超出实际的描述', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询新衣气味', question: '新衣服有没有味道；气味刺不刺鼻；需要晾多久', question_list: ['新衣服有味道吗？', '有刺鼻气味吗？', '需要晾多久？'], key_points: [['气味', '新衣'], ['通风', '晾晒'], ['正常', '消失']], accepted_answer: '说明新衣气味属正常现象并给出通风晾晒建议', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询工艺细节', question: '是包边还是锁边；走线整齐吗；有没有内衬', question_list: ['是包边还是锁边？', '走线整齐吗？', '有内衬吗？'], key_points: [['工艺', '走线'], ['包边', '锁边'], ['整齐', '说明']], accepted_answer: '说明工艺做法与走线水平，可提供细节实拍', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询实拍与色卡', question: '有没有色卡；能不能发实拍；光线不同颜色会不会变', question_list: ['有色卡吗？', '能发实拍吗？', '光线不同颜色会变吗？'], key_points: [['实拍', '提供'], ['色卡', '参考'], ['光线', '差异']], accepted_answer: '主动提供实拍或色卡，说明光线与屏幕带来的差异', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询包装是否环保', question: '包装是不是环保材质；有没有过度包装；能不能简包装', question_list: ['包装是环保材质吗？', '有没有过度包装？', '能简包装吗？'], key_points: [['包装', '材质'], ['环保', '说明'], ['简包装', '备注']], accepted_answer: '说明包装材质与减量化做法，可按需备注简包装', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询吊牌信息', question: '吊牌上有没有成分标注；吊牌是不是正品标识；吊牌能不能不剪', question_list: ['吊牌上有成分吗？', '吊牌是正品标识吗？', '吊牌可以不剪吗？'], key_points: [['吊牌', '信息'], ['成分', '标注'], ['保留', '完整']], accepted_answer: '说明吊牌信息与保留要求（影响退换）', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询生产日期与批次', question: '是什么时候生产的；批次号多少；库存存放多久了', question_list: ['是哪天生产的？', '批次号是多少？', '库存放多久了？'], key_points: [['生产日期', '批次'], ['库存', '周转'], ['新鲜', '说明']], accepted_answer: '如实说明生产批次与库存周转情况', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询配件能否单独购买', question: '配件能不能单买；扣子掉了能不能买；有没有备用扣', question_list: ['配件能单买吗？', '扣子掉了能买吗？', '有备用扣吗？'], key_points: [['配件', '单独购买'], ['备用', '提供'], ['补寄', '申请']], accepted_answer: '说明配件购买或补寄方式，尽量协助买家解决', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询同类商品如何选择', question: '两款有什么区别；哪款更适合我；推荐哪一款', question_list: ['这两款有什么区别？', '哪款更适合我？', '你推荐哪个？'], key_points: [['区别', '对比'], ['推荐', '建议'], ['需求', '适合']], accepted_answer: '对比两款差异并结合买家需求给出明确建议', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询能否改长短或改腰围', question: '裤子能不能改短；能不能改腰围；能不能定制尺寸', question_list: ['裤子能改短吗？', '能改腰围吗？', '能定制尺寸吗？'], key_points: [['修改', '不支持'], ['裁缝', '自行'], ['定制', '服务']], accepted_answer: '如实告知成衣不支持修改，可引导找裁缝或走定制', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询适用温度', question: '多少度能穿；零下能不能穿；南方冬天够不够', question_list: ['多少度能穿？', '零下能穿吗？', '南方冬天够吗？'], key_points: [['温度', '适合'], ['零下', '保暖'], ['地区', '参考']], accepted_answer: '给出适用温度区间，说明因地区与体感差异会有不同', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询同系列其他颜色', question: '还有没有其他颜色；会不会补其他色；哪个颜色卖得好', question_list: ['还有其他颜色吗？', '会补其他颜色吗？', '哪个颜色卖得好？'], key_points: [['颜色', '其他'], ['补色', '时间'], ['热销', '推荐']], accepted_answer: '告知在售颜色与补色计划，给出热销色参考', stage: 'presale', category: '商品咨询相关' },

  // ---------- 售前服务与购买渠道 ----------
  { template_name: '咨询门店自提', question: '能不能到店自提；门店在哪里；自提要预约吗', question_list: ['能到店自提吗？', '门店在哪里？', '自提要预约吗？'], key_points: [['自提', '支持'], ['门店', '地址'], ['预约', '说明']], accepted_answer: '说明自提条件、门店信息与预约方式', stage: 'presale', category: '订单服务相关' },
  { template_name: '咨询客服工作时间', question: '客服几点上班；能不能电话沟通；周末有没有人', question_list: ['客服几点上班？', '能打电话沟通吗？', '周末有人吗？'], key_points: [['客服', '时间'], ['电话', '沟通'], ['在线', '随时']], accepted_answer: '告知服务时间与联系方式，说明非工作时间的处理方式', stage: 'presale', category: '通用' },
  { template_name: '咨询货到付款', question: '支不支持货到付款；能不能先货后款；到付要不要加钱', question_list: ['支持货到付款吗？', '能先货后款吗？', '到付要加钱吗？'], key_points: [['货到付款', '支持'], ['支付', '方式'], ['费用', '说明']], accepted_answer: '说明货到付款的适用范围与费用情况', stage: 'presale', category: '订单服务相关' },
  { template_name: '咨询对公转账下单', question: '能不能对公转账；怎么获取账户信息；转账后怎么下单', question_list: ['能对公转账吗？', '能提供账户信息吗？', '转账后怎么下单？'], key_points: [['对公', '转账'], ['账户', '提供'], ['下单', '流程']], accepted_answer: '说明对公转账流程与下单对接方式', stage: 'presale', category: '订单服务相关' },
  { template_name: '咨询团购优惠', question: '团购有没有优惠；多少件起批；能不能开团购发票', question_list: ['团购有优惠吗？', '多少件起批？', '能开团购发票吗？'], key_points: [['团购', '优惠'], ['起批', '数量'], ['发票', '开具']], accepted_answer: '说明团购门槛、优惠幅度与开票方式', stage: 'presale', category: '价格活动相关' },
  { template_name: '咨询定制与印制服务', question: '能不能印 logo；能不能定制尺寸；定制要多久', question_list: ['能印 logo 吗？', '能定制尺寸吗？', '定制要多久？'], key_points: [['定制', '服务'], ['印字', 'logo'], ['周期', '说明']], accepted_answer: '说明定制的起订量、可实现范围与生产周期', stage: 'presale', category: '订单服务相关' },
  { template_name: '咨询以旧换新活动', question: '有没有以旧换新；旧衣能不能抵钱；怎么参加', question_list: ['有以旧换新吗？', '旧衣能抵钱吗？', '怎么参加？'], key_points: [['以旧换新', '活动'], ['回收', '旧衣'], ['参与', '方式']], accepted_answer: '说明回收范围、抵扣规则与参与流程', stage: 'presale', category: '价格活动相关' },
  { template_name: '咨询延保服务', question: '能不能买延保；延保多少钱；延保覆盖什么', question_list: ['能买延保吗？', '延保多少钱？', '延保保什么？'], key_points: [['延保', '服务'], ['费用', '说明'], ['范围', '覆盖']], accepted_answer: '说明延保价格、覆盖范围与不保情形', stage: 'presale', category: '订单服务相关' },
  { template_name: '咨询上门安装服务', question: '能不能上门安装；上门要不要收费；怎么预约', question_list: ['能上门安装吗？', '上门要收费吗？', '怎么预约？'], key_points: [['上门', '安装'], ['收费', '说明'], ['预约', '安排']], accepted_answer: '说明上门服务的覆盖城市、收费标准与预约方式', stage: 'presale', category: '订单服务相关' },
  { template_name: '咨询线下门店信息', question: '有没有实体店；门店在哪里；能不能到店试穿', question_list: ['有实体店吗？', '门店在哪里？', '能到店试穿吗？'], key_points: [['门店', '地址'], ['试穿', '可以'], ['导航', '发送']], accepted_answer: '提供门店信息与到店体验安排', stage: 'presale', category: '通用' },

  // ---------- 保修、返厂与售后边界 ----------
  { template_name: '咨询保修范围', question: '保修多久；保修包含哪些；人为损坏保修吗', question_list: ['保修多久？', '保修包含哪些？', '人为损坏保修吗？'], key_points: [['保修', '范围'], ['质保', '时间'], ['人为', '不保']], accepted_answer: '明确质保时长、覆盖范围与免责情形', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '咨询返厂检测时效', question: '返厂要多久；检测要几天；来回运费谁承担', question_list: ['返厂要多久？', '检测要几天？', '来回运费谁出？'], key_points: [['返厂', '检测'], ['时效', '说明'], ['运费', '承担']], accepted_answer: '说明返厂检测各环节时效与运费承担规则', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '咨询人为损坏界定', question: '算不算人为损坏；不小心弄坏能不能保；怎么判定责任', question_list: ['这算人为损坏吗？', '不小心弄坏的能保吗？', '怎么判定责任？'], key_points: [['人为', '界定'], ['检测', '判定'], ['协商', '处理']], accepted_answer: '说明判定依据，检测结论有异议时引导协商', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '咨询超出保修期处理', question: '过保还能修吗；保修期外怎么办；维修要多少钱', question_list: ['过保了还能修吗？', '保修期外怎么办？', '维修要多少钱？'], key_points: [['过保', '维修'], ['费用', '自付'], ['申请', '受理']], accepted_answer: '说明过保后的维修受理方式与费用承担', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '咨询非质量问题退货运费', question: '不喜欢退货运费谁出；无理由退货运费谁承担；能不能报销运费', question_list: ['不喜欢退货运费谁出？', '无理由退货运费谁承担？', '运费能报销吗？'], key_points: [['非质量', '运费'], ['承担', '买家'], ['运费险', '抵扣']], accepted_answer: '区分质量与非质量情形说明运费承担', stage: 'aftersale', category: '退换货相关' },
  { template_name: '咨询赠品是否享受售后', question: '赠品坏了能不能换；赠品有没有保修；赠品能不能单独退', question_list: ['赠品坏了能换吗？', '赠品有保修吗？', '赠品能单独退吗？'], key_points: [['赠品', '售后'], ['质量问题', '补发'], ['凭证', '提供']], accepted_answer: '说明赠品的售后口径，质量问题同样按补发处理', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '咨询已开发票后退货', question: '开票了还能不能退；发票要不要退回；退货后发票怎么处理', question_list: ['开票了还能退吗？', '发票要退回吗？', '退货后发票怎么处理？'], key_points: [['发票', '退回'], ['红冲', '处理'], ['退款', '流程']], accepted_answer: '说明开票后退货的发票处理方式与退款流程', stage: 'aftersale', category: '发票服务相关' },
  { template_name: '咨询退货后优惠券与积分', question: '退货后优惠券会不会退回；用掉的券能退吗；积分退不退', question_list: ['退货后券会退给我吗？', '用掉的券能退吗？', '积分会退吗？'], key_points: [['优惠券', '退回'], ['有效期', '说明'], ['积分', '返还']], accepted_answer: '说明优惠券与积分的退回规则与有效期影响', stage: 'aftersale', category: '退换货相关' },
  { template_name: '咨询跨境与转运订单售后', question: '海外订单能不能退；转运怎么售后；国际运费谁承担', question_list: ['海外订单能退吗？', '转运的怎么售后？', '国际运费谁出？'], key_points: [['跨境', '售后'], ['转运', '限制'], ['运费', '自理']], accepted_answer: '说明跨境与转运订单的售后限制与运费承担', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '咨询换货次数限制', question: '能换几次；换货有没有次数限制；一直不满意怎么办', question_list: ['能换几次？', '换货有次数限制吗？', '一直不满意怎么办？'], key_points: [['换货', '次数'], ['沟通', '方案'], ['协商', '处理']], accepted_answer: '说明换货次数口径，多次不满意时引导升级协商', stage: 'aftersale', category: '退换货相关' },
  { template_name: '咨询能否维修代替更换', question: '能不能只修不换；小问题能修吗；修好要多久', question_list: ['能修就别换吗？', '小问题能修吗？', '修好要多久？'], key_points: [['维修', '方案'], ['时效', '说明'], ['费用', '承担']], accepted_answer: '给出维修与更换两种方案供买家选择', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '咨询保修凭证要求', question: '保修要不要凭证；订单截图可不可以；没有发票能不能保修', question_list: ['保修要凭证吗？', '订单截图可以吗？', '没有发票能保修吗？'], key_points: [['凭证', '订单'], ['保修', '受理'], ['记录', '查询']], accepted_answer: '说明可用凭证类型，不因缺失发票直接拒绝保修', stage: 'aftersale', category: '售后反馈相关' },

  // ---------- 账号、隐私与设置 ----------
  { template_name: '咨询实名认证', question: '要不要实名认证；怎么认证；信息安全吗', question_list: ['需要实名认证吗？', '怎么实名认证？', '信息会不会不安全？'], key_points: [['实名', '认证'], ['信息', '安全'], ['流程', '说明']], accepted_answer: '说明实名要求与信息保护措施', stage: 'presale', category: '账号相关' },
  { template_name: '咨询账号注销', question: '账号能不能注销；注销后订单还能查吗；怎么注销', question_list: ['账号能注销吗？', '注销后订单还能查吗？', '怎么注销？'], key_points: [['注销', '申请'], ['订单', '保留'], ['流程', '说明']], accepted_answer: '说明注销条件、订单与售后记录的处理方式', stage: 'presale', category: '账号相关' },
  { template_name: '咨询隐私信息保护', question: '个人信息会不会泄露；地址会不会被公开；怎么保护隐私', question_list: ['我的信息会泄露吗？', '地址会被公开吗？', '你们怎么保护隐私？'], key_points: [['隐私', '保护'], ['信息', '保密'], ['放心', '承诺']], accepted_answer: '说明信息使用与保护规则，给出明确的安全承诺', stage: 'presale', category: '账号相关' },
  { template_name: '咨询消息推送设置', question: '怎么关闭推送；不想收短信；能只保留站内信吗', question_list: ['怎么关闭推送？', '不想收到短信', '能只留站内信吗？'], key_points: [['推送', '设置'], ['短信', '关闭'], ['站内', '保留']], accepted_answer: '给出推送与短信的关闭路径，尊重买家选择', stage: 'presale', category: '账号相关' },
  { template_name: '咨询多设备登录', question: '能不能同时登录两台手机；换手机要不要重登；会不会被挤下线', question_list: ['能同时登两台手机吗？', '换手机要重新登录吗？', '会被挤下线吗？'], key_points: [['设备', '登录'], ['重新登录', '正常'], ['安全', '提示']], accepted_answer: '说明多设备登录规则与安全提示', stage: 'presale', category: '账号相关' },
  { template_name: '咨询账号绑定与解绑', question: '能不能解绑手机号；能不能绑定微信；绑错了怎么办', question_list: ['能解绑手机号吗？', '能绑定微信吗？', '绑错了怎么办？'], key_points: [['绑定', '解绑'], ['微信', '手机号'], ['修改', '申请']], accepted_answer: '说明绑定解绑规则与换绑所需验证', stage: 'presale', category: '账号相关' },
  { template_name: '咨询企业账号申请', question: '能不能开企业账号；企业账号有什么不同；怎么申请', question_list: ['能开企业账号吗？', '企业账号有什么不同？', '怎么申请？'], key_points: [['企业', '账号'], ['权益', '区别'], ['申请', '流程']], accepted_answer: '说明企业账号权益差异与申请材料', stage: 'presale', category: '账号相关' },
  { template_name: '咨询修改个人资料', question: '怎么改昵称；收货人名字能不能改；资料在哪里修改', question_list: ['怎么改昵称？', '收货人名字能改吗？', '资料在哪里修改？'], key_points: [['资料', '修改'], ['设置', '页面'], ['帮您', '提交']], accepted_answer: '给出资料修改路径，必要时协助提交', stage: 'presale', category: '账号相关' },

  // ---------- 客服服务与沟通 ----------
  { template_name: '咨询如何转人工', question: '怎么转人工；机器人解决不了；能不能找真人客服', question_list: ['怎么转人工？', '机器人解决不了我的问题', '能找真人客服吗？'], key_points: [['人工', '转接'], ['帮您', '处理'], ['稍等', '安排']], accepted_answer: '立即转接人工并简要复述问题，避免买家重复描述', stage: 'presale', category: '通用' },
  { template_name: '咨询客服响应慢', question: '为什么半天不回；是不是没人；能不能快点', question_list: ['怎么半天不回复？', '你们是不是没人？', '能不能快点回我？'], key_points: [['抱歉', '久等'], ['马上', '处理'], ['理解', '感谢']], accepted_answer: '先致歉说明，再立即给出实质处理，不做空口安抚', stage: 'presale', category: '通用' },
  { template_name: '咨询能否加微信沟通', question: '能不能加微信；微信沟通方便；能不能加好友', question_list: ['能加微信吗？', '微信聊方便点', '加个好友行不行？'], key_points: [['微信', '不支持'], ['平台', '沟通'], ['抱歉', '说明']], accepted_answer: '礼貌说明仅支持平台内沟通，并说明原因（留证与安全）', stage: 'presale', category: '通用' },
  { template_name: '咨询安排专人跟进', question: '能不能安排专人；谁来跟进问题；有问题找谁', question_list: ['能安排专人吗？', '谁来跟进我的问题？', '后面有问题找谁？'], key_points: [['专人', '对接'], ['跟进', '安排'], ['联系', '同步']], accepted_answer: '明确对接人与跟进方式，给出后续联系路径', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '咨询客服权限范围', question: '能不能直接免单；你能不能决定；有没有权限', question_list: ['你能给我免单吗？', '你能直接决定吗？', '你有这个权限吗？'], key_points: [['权限', '说明'], ['申请', '上报'], ['主管', '处理']], accepted_answer: '坦诚说明权限边界并给出申请或升级路径', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '投诉客服人员', question: '要投诉客服；认为态度差；要求换人服务', question_list: ['我要投诉你这个客服', '服务态度太差了', '能换个人服务吗？'], key_points: [['抱歉', '歉意'], ['记录', '反馈'], ['更换', '安排']], accepted_answer: '诚恳接受反馈并记录，按买家意愿更换对接人员', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '咨询答复时间承诺', question: '多久能给答复；几小时内回复；会不会又没下文', question_list: ['多久能回我？', '几小时内给答复？', '会不会又没下文？'], key_points: [['时间', '答复'], ['主动', '同步'], ['尽快', '回复']], accepted_answer: '给出明确的答复时间点并主动同步进度', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '咨询工单编号查询', question: '有没有工单号；怎么查工单；能不能提供编号', question_list: ['有工单号吗？', '怎么查我的工单？', '能把工单号给我吗？'], key_points: [['工单', '编号'], ['查询', '入口'], ['记录', '保留']], accepted_answer: '提供工单编号与查询入口，方便买家自助跟踪', stage: 'aftersale', category: '售后反馈相关' },

  // ---------- 评价与互动 ----------
  { template_name: '咨询评价入口与奖励', question: '在哪里评价；怎么给好评；评价有没有奖励', question_list: ['在哪里评价？', '怎么给好评？', '评价有奖励吗？'], key_points: [['评价', '入口'], ['好评', '支持'], ['奖励', '说明']], accepted_answer: '给出评价入口并说明评价激励规则，不诱导好评', stage: 'presale', category: '通用' },
  { template_name: '咨询差评能否修改', question: '差评能不能改；评价能不能删；追评能不能改', question_list: ['差评能改吗？', '评价能删除吗？', '追评能改内容吗？'], key_points: [['评价', '修改'], ['追评', '补充'], ['沟通', '处理']], accepted_answer: '说明评价修改规则，先解决买家问题再谈评价调整', stage: 'aftersale', category: '通用' },
  { template_name: '咨询晒单返现', question: '晒单有没有返现；怎么参加；返现什么时候到', question_list: ['晒单有返现吗？', '怎么参加晒单？', '返现什么时候到账？'], key_points: [['晒单', '返现'], ['参与', '方式'], ['到账', '时间']], accepted_answer: '说明晒单返现条件、提交方式与到账时效', stage: 'presale', category: '价格活动相关' },
  { template_name: '咨询评价是否影响售后', question: '给了差评还能售后吗；评价会不会影响处理；会不会不给退', question_list: ['给了差评还能售后吗？', '评价会影响处理吗？', '会不会因为差评不给我退？'], key_points: [['评价', '不影响'], ['售后', '照常'], ['放心', '处理']], accepted_answer: '明确评价与售后相互独立，不会因差评降低服务', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '咨询买家秀征集方式', question: '买家秀怎么来的；能不能上买家秀；怎么投稿', question_list: ['你们的买家秀是哪来的？', '我能上买家秀吗？', '怎么投稿？'], key_points: [['买家秀', '征集'], ['投稿', '方式'], ['授权', '说明']], accepted_answer: '说明买家秀征集方式与授权使用规则', stage: 'presale', category: '通用' },
  { template_name: '咨询是否必须评价', question: '必须评价吗；不评价会有影响吗；能不能跳过', question_list: ['必须评价吗？', '不评价会有影响吗？', '能不能跳过评价？'], key_points: [['评价', '自愿'], ['影响', '说明'], ['感谢', '支持']], accepted_answer: '说明评价自愿，尊重买家是否评价的选择', stage: 'presale', category: '通用' },

  // ---------- 特殊场景与边界 ----------
  { template_name: '咨询缺货订单处理', question: '缺货会不会自动取消；缺货怎么处理；会不会提前通知', question_list: ['没货了会自动取消吗？', '缺货怎么处理？', '会提前通知我吗？'], key_points: [['缺货', '通知'], ['取消', '退款'], ['补货', '可选']], accepted_answer: '主动通知并给出等待补货或取消退款两种选择', stage: 'presale', category: '订单服务相关' },
  { template_name: '咨询限购规则', question: '每人限购几件；能不能多买；为什么要限购', question_list: ['每人限购几件？', '能多买几件吗？', '为什么要限购？'], key_points: [['限购', '数量'], ['规则', '说明'], ['多买', '不支持']], accepted_answer: '说明限购数量与规则原因，不承诺特批', stage: 'presale', category: '价格活动相关' },
  { template_name: '咨询赠品缺货替换', question: '赠品没了怎么办；能不能换别的赠品；缺赠品还发不发', question_list: ['赠品没了怎么办？', '能换个赠品吗？', '缺赠品还会发吗？'], key_points: [['赠品', '缺货'], ['替换', '方案'], ['补发', '安排']], accepted_answer: '主动告知并给出替换或补发方案，先征得买家同意', stage: 'presale', category: '物流快递相关' },
  { template_name: '咨询套装能否拆分购买', question: '套装能不能单买；能不能只买其中一件；拆开买会不会更贵', question_list: ['套装能单买吗？', '能只买其中一件吗？', '拆开买会更贵吗？'], key_points: [['套装', '拆分'], ['单价', '差异'], ['单独', '链接']], accepted_answer: '说明套装拆分规则与价格差异，可提供单独链接', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询预售延期处理', question: '预售延期了怎么办；能不能退款；什么时候能发', question_list: ['预售延期了怎么办？', '这种情况能退款吗？', '什么时候能发出？'], key_points: [['预售', '延期'], ['抱歉', '通知'], ['退款', '选择']], accepted_answer: '主动告知延期原因与新的发货时间，给出退款选择', stage: 'aftersale', category: '物流快递相关' },
  { template_name: '咨询天气原因物流延误', question: '下雪快递停了吗；台风影响发货吗；延误算谁的责任', question_list: ['下雪快递停了吗？', '台风会影响发货吗？', '这种延误算谁的？'], key_points: [['天气', '影响'], ['不可抗力', '说明'], ['尽快', '恢复']], accepted_answer: '说明不可抗力情形与恢复安排，同步新的时效预期', stage: 'aftersale', category: '物流快递相关' },
  { template_name: '咨询标价错误处理', question: '怀疑标错价格；价格过低于市场；能不能按标注价购买', question_list: ['你们是不是标错价了？', '这个价格也太低了', '能按标注价卖吗？'], key_points: [['价格', '核实'], ['抱歉', '失误'], ['取消', '协商']], accepted_answer: '核实后坦诚说明，按规则协商取消或补偿，不推诿', stage: 'presale', category: '价格活动相关' },
  { template_name: '咨询商品下架后售后', question: '商品下架还能售后吗；链接没了怎么申请；下架影响保修吗', question_list: ['商品下架了还能售后吗？', '链接点不开了怎么申请？', '下架影响保修吗？'], key_points: [['下架', '不影响'], ['售后', '照常'], ['记录', '查询']], accepted_answer: '明确下架不影响已购订单的售后与保修', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '咨询活动叠加冲突', question: '两个活动能不能同时参加；优惠能不能叠加；哪个更划算', question_list: ['两个活动能同时参加吗？', '优惠能叠加吗？', '哪个更划算？'], key_points: [['活动', '叠加'], ['规则', '说明'], ['推荐', '划算']], accepted_answer: '说明活动互斥规则并帮买家算出更划算的方案', stage: 'presale', category: '价格活动相关' },
  { template_name: '咨询大宗订单物流安排', question: '买多了怎么发；能不能分批送；运费怎么算', question_list: ['买多了怎么发货？', '能分批送吗？', '运费怎么算？'], key_points: [['大宗', '分批'], ['物流', '安排'], ['运费', '核算']], accepted_answer: '说明大宗订单的物流方案与运费核算方式', stage: 'presale', category: '物流快递相关' },
  { template_name: '咨询样品申请', question: '能不能先寄样品；样品要不要收费；样品运费谁承担', question_list: ['能先寄样品吗？', '样品要收费吗？', '样品运费谁出？'], key_points: [['样品', '申请'], ['费用', '说明'], ['运费', '承担']], accepted_answer: '说明样品申请条件、费用与运费承担', stage: 'presale', category: '订单服务相关' },
  { template_name: '咨询长期合作与分销', question: '能不能做代理；有没有分销政策；怎么合作', question_list: ['能做代理吗？', '有分销政策吗？', '怎么合作？'], key_points: [['合作', '政策'], ['分销', '申请'], ['对接', '安排']], accepted_answer: '说明合作政策与对接方式，转交商务跟进', stage: 'presale', category: '订单服务相关' },

  // ---------- 补齐：预定、试用与凭证 ----------
  { template_name: '咨询商品能否预定', question: '能不能预定；预定和预售一样吗；预定要不要付定金', question_list: ['能预定吗？', '预定和预售一样吗？', '预定要付定金吗？'], key_points: [['预定', '支持'], ['定金', '说明'], ['到货', '通知']], accepted_answer: '说明预定条件与定金规则，到货主动通知', stage: 'presale', category: '订单服务相关' },
  { template_name: '咨询能否试穿后付款', question: '能不能试穿再付款；货到能不能试穿；不合适能不能退回', question_list: ['能试穿后再付款吗？', '货到能试穿吗？', '不合适能退回吗？'], key_points: [['试穿', '不支持'], ['签收', '验货'], ['退换', '支持']], accepted_answer: '说明不支持试穿后付款，但支持签收验货与无理由退换', stage: 'presale', category: '订单服务相关' },
  { template_name: '咨询是否提供商品视频', question: '有没有商品视频；能不能拍上身效果；有没有细节视频', question_list: ['有商品视频吗？', '能拍个上身效果吗？', '有细节视频吗？'], key_points: [['视频', '提供'], ['上身', '效果'], ['细节', '拍摄']], accepted_answer: '尽量提供视频或细节实拍，帮助买家判断', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询是否有质检报告', question: '有没有质检报告；能不能发检测报告；符不符合国家标准', question_list: ['有质检报告吗？', '能发检测报告吗？', '符合国家标准吗？'], key_points: [['质检', '报告'], ['国标', '符合'], ['提供', '申请']], accepted_answer: '说明执行标准与报告获取方式，不伪造无法提供的材料', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询积分抵扣上限', question: '积分最多能抵多少；有没有抵扣上限；能不能全额抵扣', question_list: ['积分最多能抵多少？', '有抵扣上限吗？', '能全额抵扣吗？'], key_points: [['积分', '抵扣上限'], ['比例', '说明'], ['叠加', '规则']], accepted_answer: '说明积分抵扣比例、上限与叠加规则', stage: 'presale', category: '会员服务相关' },
  { template_name: '咨询优惠券使用范围', question: '这张券能买什么；特价商品能不能用券；券有没有品类限制', question_list: ['这张券能买什么？', '特价商品能用券吗？', '券有品类限制吗？'], key_points: [['优惠券', '范围'], ['特价', '不参与'], ['限制', '说明']], accepted_answer: '说明券的适用商品范围与不可用情形', stage: 'presale', category: '价格活动相关' },
  { template_name: '咨询活动报名方式', question: '怎么报名活动；要不要预约；报名有没有名额限制', question_list: ['怎么报名活动？', '需要预约吗？', '报名有名额限制吗？'], key_points: [['报名', '方式'], ['名额', '限制'], ['提醒', '通知']], accepted_answer: '说明报名路径、名额与提醒方式', stage: 'presale', category: '价格活动相关' },
  { template_name: '咨询抽奖兑奖流程', question: '中奖了怎么兑；兑奖要多久；过期不兑会不会作废', question_list: ['中奖了怎么兑？', '兑奖要多久？', '过期不兑会作废吗？'], key_points: [['兑奖', '流程'], ['时效', '说明'], ['过期', '作废']], accepted_answer: '说明兑奖路径、时效与过期规则', stage: 'presale', category: '会员服务相关' },
  { template_name: '咨询代收货款服务', question: '能不能代收货款；到付和代收一样吗；代收要不要手续费', question_list: ['能代收货款吗？', '到付和代收一样吗？', '代收要手续费吗？'], key_points: [['代收', '货款'], ['手续费', '说明'], ['支持', '范围']], accepted_answer: '说明代收货款的支持范围与手续费口径', stage: 'presale', category: '物流快递相关' },
  { template_name: '咨询快递柜取件问题', question: '快递放柜子了怎么办；没收到取件码；能不能改放驿站', question_list: ['快递放柜子了怎么办？', '取件码没收到', '能改放驿站吗？'], key_points: [['快递柜', '取件码'], ['驿站', '更换'], ['联系', '快递']], accepted_answer: '协助获取取件码或协调改放驿站，跟进到底', stage: 'aftersale', category: '物流快递相关' },
  { template_name: '咨询偏远地区超区派送', question: '这里算不算超区；超区要不要加钱；超区会不会被退回', question_list: ['我们这算超区吗？', '超区要加钱吗？', '超区会被退回吗？'], key_points: [['超区', '派送'], ['加费', '说明'], ['退回', '处理']], accepted_answer: '说明超区判定与派送方案，避免包裹被退回', stage: 'presale', category: '物流快递相关' },
  { template_name: '咨询物流轨迹异常', question: '轨迹一直不动；已揽收却没有物流；怀疑包裹丢失', question_list: ['轨迹一直不动', '显示已揽收但没物流', '是不是包裹丢了？'], key_points: [['轨迹', '异常'], ['核实', '快递'], ['方案', '处理']], accepted_answer: '致歉并立即核实物流，必要时按丢失流程处理', stage: 'aftersale', category: '物流快递相关' },
  { template_name: '咨询签收凭证获取', question: '能不能提供签收凭证；有没有签收照片；谁签收的能不能查', question_list: ['能提供签收凭证吗？', '有签收照片吗？', '谁签收的能查到吗？'], key_points: [['签收', '凭证'], ['提供', '申请'], ['核实', '查询']], accepted_answer: '协助向快递调取签收凭证并如实反馈结果', stage: 'aftersale', category: '物流快递相关' },
  { template_name: '咨询退货运费垫付', question: '退货运费要不要先垫；运费什么时候给我；能不能直接抵扣', question_list: ['退货运费要先垫吗？', '运费什么时候给我？', '能直接抵扣吗？'], key_points: [['垫付', '运费'], ['理赔', '到账'], ['运费险', '说明']], accepted_answer: '说明运费垫付与运费险理赔流程及到账时效', stage: 'aftersale', category: '退换货相关' },
  { template_name: '咨询上门取件时间安排', question: '上门取件几点来；能不能约具体时间；取件员会不会联系', question_list: ['上门取件几点来？', '能约具体时间吗？', '取件员会联系我吗？'], key_points: [['取件', '时间'], ['预约', '安排'], ['联系', '沟通']], accepted_answer: '说明取件时段与联系方式，无法承诺精确到点', stage: 'aftersale', category: '退换货相关' },
  { template_name: '咨询售后是否影响信用', question: '申请售后会不会影响信用；退货会不会留记录；会不会被拉黑', question_list: ['申请售后影响信用吗？', '退货会留记录吗？', '会不会被拉黑？'], key_points: [['售后', '不影响'], ['记录', '说明'], ['放心', '处理']], accepted_answer: '明确正常售后不影响账号信用，消除买家顾虑', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '咨询退货后能否再购买', question: '退货后还能不能再买；价格会不会变；库存还留着吗', question_list: ['退货后还能再买吗？', '价格会变吗？', '库存还留着吗？'], key_points: [['退货', '重新购买'], ['价格', '以页面'], ['库存', '以实际']], accepted_answer: '说明退货后可正常复购，价格与库存以页面为准', stage: 'aftersale', category: '订单服务相关' },
  { template_name: '咨询退款失败排查', question: '退款失败了怎么办；显示退款中却没到账；是不是银行卡问题', question_list: ['退款失败了怎么办？', '显示退款中但没到账', '是不是银行卡有问题？'], key_points: [['退款', '失败'], ['核实', '账户'], ['重新', '提交']], accepted_answer: '核实失败原因并重新提交，必要时提供退款凭证', stage: 'aftersale', category: '退换货相关' },
  { template_name: '咨询是否有语音客服', question: '有没有语音客服；能不能语音沟通；不方便打字的怎么办', question_list: ['有语音客服吗？', '能语音沟通吗？', '不方便打字怎么办？'], key_points: [['语音', '支持'], ['电话', '联系'], ['帮您', '安排']], accepted_answer: '说明可用的语音支持方式，为不便打字的买家提供便利', stage: 'presale', category: '通用' },
  { template_name: '咨询客服是人工还是智能', question: '是不是机器人；是人工还是智能；能不能转真人', question_list: ['你是机器人吗？', '是人工还是智能客服？', '能转真人吗？'], key_points: [['人工', '客服'], ['智能', '辅助'], ['转接', '帮您']], accepted_answer: '如实说明并立即提供转人工选项，不回避', stage: 'presale', category: '通用' },
  { template_name: '咨询是否支持无理由换货', question: '无理由能不能换货；不喜欢能不能换款；换货有没有条件', question_list: ['无理由能换货吗？', '不喜欢能换款吗？', '换货有条件吗？'], key_points: [['无理由', '换货'], ['条件', '说明'], ['运费', '承担']], accepted_answer: '说明无理由换货条件与运费承担', stage: 'aftersale', category: '退换货相关' },
  { template_name: '咨询到货损坏责任划分', question: '到货就是坏的算谁的责任；运输坏了谁赔；能不能补发', question_list: ['到货就坏了算谁的？', '运输坏了谁赔？', '能补发吗？'], key_points: [['运输', '损坏'], ['补发', '处理'], ['抱歉', '说明']], accepted_answer: '不推诿责任，先按补发或退换解决再内部追责', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '咨询发票能否随包裹寄送', question: '发票能不能和商品一起寄；能不能随包裹寄发票；单独寄要多久', question_list: ['发票能和商品一起寄吗？', '能随包裹寄发票吗？', '发票单独寄要多久？'], key_points: [['发票', '随包裹'], ['邮寄', '安排'], ['时效', '说明']], accepted_answer: '说明发票随包裹或单独邮寄的条件与时效', stage: 'presale', category: '发票服务相关' },
  { template_name: '咨询是否有保修卡', question: '有没有保修卡；保修卡丢了怎么办；是不是凭卡才能保修', question_list: ['有保修卡吗？', '保修卡丢了怎么办？', '凭保修卡才能修吗？'], key_points: [['保修卡', '提供'], ['丢失', '可查'], ['凭证', '订单']], accepted_answer: '说明保修卡作用，丢失可凭订单记录受理', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '要求免单或仅退款不退货', question: '要求免单；认为商品已损坏；要求不退货全额退款', question_list: ['这单必须给我免单', '东西都坏了还收钱？', '能全额退款不退货吗？'], key_points: [['抱歉', '理解'], ['核实', '情况'], ['主管', '上报']], accepted_answer: '共情并核实情况，涉及免单等超权限诉求上报主管', stage: 'aftersale', category: '售后反馈相关', transferIdxs: [2] },
  { template_name: '咨询能否指定客服服务', question: '能不能指定某个客服；想找上次那位；能不能固定对接人', question_list: ['能指定某个客服吗？', '上次那个客服在哪？', '能固定一个人对接吗？'], key_points: [['指定', '客服'], ['排班', '说明'], ['帮您', '对接']], accepted_answer: '说明客服排班限制，尽量协调固定对接人', stage: 'presale', category: '通用' },
  { template_name: '咨询售后回访安排', question: '会不会有人回访；处理完会不会确认；会不会打电话确认', question_list: ['会有人回访吗？', '处理完会确认吗？', '会打电话给我吗？'], key_points: [['回访', '安排'], ['确认', '满意度'], ['感谢', '支持']], accepted_answer: '说明回访安排，以买家便利为前提征得同意', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '咨询投诉处理时限', question: '投诉多久有结果；投诉会怎么处理；有没有处理时限', question_list: ['投诉多久有结果？', '投诉会怎么处理？', '有没有处理时限？'], key_points: [['投诉', '时效'], ['处理', '流程'], ['反馈', '尽快']], accepted_answer: '给出投诉受理时限与处理流程，按期反馈', stage: 'aftersale', category: '售后反馈相关' },
  { template_name: '咨询门店是否有同款', question: '门店有没有同款；线上线下一样吗；能不能去店里买', question_list: ['门店有同款吗？', '线上线下一样吗？', '能去店里买吗？'], key_points: [['门店', '同款'], ['价格', '一致'], ['库存', '以门店']], accepted_answer: '说明门店同款情况，价格与库存以门店实际为准', stage: 'presale', category: '商品咨询相关' },
  { template_name: '咨询大件商品如何退货', question: '大件怎么退；能不能上门取；大件运费谁承担', question_list: ['大件怎么退？', '能上门取吗？', '大件运费谁承担？'], key_points: [['大件', '退货'], ['上门', '取件'], ['运费', '承担']], accepted_answer: '说明大件退货的取件安排与运费承担规则', stage: 'aftersale', category: '退换货相关' },
  { template_name: '咨询自行寄回注意事项', question: '自己寄要注意什么；要寄哪家快递；要不要保价', question_list: ['自己寄要注意什么？', '要寄哪家快递？', '需要保价吗？'], key_points: [['寄回', '注意'], ['保价', '建议'], ['单号', '填写']], accepted_answer: '给出寄回清单与注意事项，建议保价并回填单号', stage: 'aftersale', category: '退换货相关' },
  { template_name: '咨询商品是否支持刻字', question: '能不能刻字；刻字要不要加钱；刻字后能不能退换', question_list: ['能刻字吗？', '刻字要加钱吗？', '刻字后能退换吗？'], key_points: [['刻字', '支持'], ['费用', '说明'], ['定制', '不退换']], accepted_answer: '说明刻字服务范围与定制商品不退换的规则', stage: 'presale', category: '订单服务相关' },
  { template_name: '咨询能否加固包装', question: '能不能加固包装；担心运输压坏；易碎品怎么包装', question_list: ['能加固包装吗？', '怕压坏能加泡沫吗？', '易碎品怎么包装？'], key_points: [['加固', '包装'], ['泡沫', '防护'], ['备注', '安排']], accepted_answer: '协助备注加固包装，说明防护措施与运输风险提示', stage: 'presale', category: '物流快递相关' },
];

/**
 * 按模板名索引内置咨询内容。
 * 用途：界面上批量生成剧本时，继承内置内容的口径（例如转接题标记）。
 * 注意：仅内置内容可被索引到；带教自建的内容没有转接题标记。
 */
export const BUILTIN_QA_BY_NAME = new Map(QAS.map((qa) => [qa.template_name, qa]));

/** 商品库：24 个商品，覆盖 10 个类目，供剧本关联使用。 */
export const PRODUCTS: SeedProduct[] = [
  { product_no: '3781182303640879201', title: '牛仔短裤女高腰宽松显瘦修身复古百搭卷边阔腿a字热裤', price: 999.0, stock: 320, category: '女装', scenes: ['节日送礼', '出差/旅行/外出'], services: ['七天无理由', '运费险'], skus: [{ name: 'S 码', price: 999, stock: 120 }, { name: 'M 码', price: 999, stock: 200 }] },
  { product_no: '3781182303640879202', title: '纯棉短袖T恤男夏季宽松透气圆领百搭打底衫', price: 89.0, stock: 1500, category: '男装', scenes: ['日常通勤'], services: ['七天无理由', '48小时发货'], skus: [{ name: 'L 码', price: 89, stock: 800 }] },
  { product_no: '3781182303640879203', title: '轻便折叠旅行背包大容量防泼水双肩包', price: 159.0, stock: 460, category: '箱包', scenes: ['出差/旅行/外出'], services: ['七天无理由', '运费险', '正品保障'], skus: [{ name: '标准款', price: 159, stock: 460 }] },
  { product_no: '3781182303640879204', title: '节日礼盒装坚果大礼包混合零食 8 袋装', price: 129.0, stock: 890, category: '食品', scenes: ['节日送礼'], services: ['七天无理由', '闪电发货'], skus: [{ name: '8 袋装', price: 129, stock: 890 }] },
  { product_no: '3781182303640879205', title: '家用便携挂烫机手持蒸汽熨斗小型', price: 199.0, stock: 230, category: '家电', scenes: ['日常家用'], services: ['七天无理由', '一年质保'], skus: [{ name: '白色', price: 199, stock: 230 }] },
  { product_no: '3781182303640879206', title: '运动跑步鞋男透气减震软底轻便休闲鞋', price: 269.0, stock: 610, category: '鞋靴', scenes: ['运动健身'], services: ['七天无理由', '运费险'], skus: [{ name: '42 码', price: 269, stock: 300 }] },
  { product_no: '3781182303640879207', title: '不锈钢保温杯大容量便携车载水杯 500ml', price: 69.0, stock: 1200, category: '家居', scenes: ['出差/旅行/外出'], services: ['七天无理由'], skus: [{ name: '500ml', price: 69, stock: 1200 }] },
  { product_no: '3781182303640879208', title: '真丝眼罩睡眠遮光透气舒适护眼罩', price: 49.0, stock: 980, category: '家居', scenes: ['出差/旅行/外出', '节日送礼'], services: ['七天无理由', '正品保障'], skus: [{ name: '均码', price: 49, stock: 980 }] },
  { product_no: '3781182303640879209', title: 'V 领针织开衫女春秋薄款外搭宽松毛衣外套', price: 139.0, stock: 420, category: '女装', scenes: ['日常通勤'], services: ['七天无理由', '运费险'], skus: [{ name: 'S 码', price: 139, stock: 150 }, { name: 'M 码', price: 139, stock: 270 }] },
  { product_no: '3781182303640879210', title: '法式碎花连衣裙女夏季收腰显瘦气质长裙', price: 199.0, stock: 360, category: '女装', scenes: ['节日送礼', '日常通勤'], services: ['七天无理由', '运费险'], skus: [{ name: 'S 码', price: 199, stock: 160 }, { name: 'M 码', price: 199, stock: 200 }] },
  { product_no: '3781182303640879211', title: '男士休闲直筒长裤夏季薄款透气宽松西裤', price: 129.0, stock: 780, category: '男装', scenes: ['日常通勤'], services: ['七天无理由', '48小时发货'], skus: [{ name: '30 码', price: 129, stock: 260 }, { name: '32 码', price: 129, stock: 520 }] },
  { product_no: '3781182303640879212', title: '大容量托特包女通勤单肩包包包', price: 179.0, stock: 540, category: '箱包', scenes: ['日常通勤'], services: ['七天无理由', '运费险'], skus: [{ name: '棕色', price: 179, stock: 300 }, { name: '黑色', price: 179, stock: 240 }] },
  { product_no: '3781182303640879213', title: '冻干速溶黑咖啡无蔗糖 30 条装', price: 79.0, stock: 1600, category: '食品', scenes: ['日常通勤', '节日送礼'], services: ['七天无理由', '闪电发货'], skus: [{ name: '30 条装', price: 79, stock: 1600 }] },
  { product_no: '3781182303640879214', title: '花草茶水果茶组合装冷泡茶 10 包', price: 59.0, stock: 1100, category: '食品', scenes: ['节日送礼'], services: ['七天无理由'], skus: [{ name: '10 包', price: 59, stock: 1100 }] },
  { product_no: '3781182303640879215', title: '迷你多功能电煮锅宿舍小锅家用一体锅', price: 149.0, stock: 380, category: '家电', scenes: ['日常家用'], services: ['七天无理由', '一年质保'], skus: [{ name: '白色', price: 149, stock: 380 }] },
  { product_no: '3781182303640879216', title: '桌面加湿器静音大雾量家用车载补水', price: 89.0, stock: 720, category: '家电', scenes: ['日常家用', '日常通勤'], services: ['七天无理由', '一年质保'], skus: [{ name: '白色', price: 89, stock: 720 }] },
  { product_no: '3781182303640879217', title: '百搭小白鞋女软底休闲板鞋透气', price: 219.0, stock: 500, category: '鞋靴', scenes: ['日常通勤'], services: ['七天无理由', '运费险'], skus: [{ name: '37 码', price: 219, stock: 250 }, { name: '38 码', price: 219, stock: 250 }] },
  { product_no: '3781182303640879218', title: '纯棉四件套床上用品裸睡被套床单', price: 259.0, stock: 300, category: '家居', scenes: ['日常家用', '节日送礼'], services: ['七天无理由', '运费险'], skus: [{ name: '1.5 米床', price: 259, stock: 180 }, { name: '1.8 米床', price: 259, stock: 120 }] },
  { product_no: '3781182303640879219', title: '折叠收纳箱衣物整理箱大号加厚', price: 45.0, stock: 1400, category: '家居', scenes: ['日常家用'], services: ['七天无理由'], skus: [{ name: '大号', price: 45, stock: 1400 }] },
  { product_no: '3781182303640879220', title: '无火香薰藤条扩香卧室持久留香', price: 99.0, stock: 860, category: '家居', scenes: ['节日送礼', '日常家用'], services: ['七天无理由'], skus: [{ name: '单瓶装', price: 99, stock: 860 }] },
  { product_no: '3781182303640879221', title: '丝绒雾面口红持久不脱色显白', price: 129.0, stock: 950, category: '美妆', scenes: ['节日送礼'], services: ['七天无理由', '正品保障'], skus: [{ name: '豆沙色', price: 129, stock: 500 }, { name: '正红色', price: 129, stock: 450 }] },
  { product_no: '3781182303640879222', title: '氨基酸补水面膜保湿舒缓 10 片装', price: 89.0, stock: 1300, category: '美妆', scenes: ['日常通勤', '节日送礼'], services: ['七天无理由', '正品保障'], skus: [{ name: '10 片装', price: 89, stock: 1300 }] },
  { product_no: '3781182303640879223', title: '真无线蓝牙耳机降噪入耳式长续航', price: 299.0, stock: 430, category: '数码', scenes: ['日常通勤', '运动健身'], services: ['七天无理由', '一年质保'], skus: [{ name: '白色', price: 299, stock: 430 }] },
  { product_no: '3781182303640879224', title: '婴儿手口湿巾 80 抽 5 包家庭装', price: 39.0, stock: 1900, category: '母婴', scenes: ['日常家用'], services: ['七天无理由', '闪电发货'], skus: [{ name: '5 包装', price: 39, stock: 1900 }] },
  { product_no: '3781182303640879225', title: '高腰直筒牛仔裤女显瘦九分裤', price: 189.0, stock: 620, category: '女装', scenes: ['日常通勤', '周末休闲'], services: ['七天无理由', '运费险'], skus: [{ name: 'S 码', price: 189, stock: 200 }, { name: 'M 码', price: 189, stock: 220 }, { name: 'L 码', price: 189, stock: 200 }] },
  { product_no: '3781182303640879226', title: '羊毛混纺半身裙女秋冬百搭中长款', price: 259.0, stock: 380, category: '女装', scenes: ['日常通勤', '约会聚会'], services: ['七天无理由', '运费险'], skus: [{ name: 'S 码', price: 259, stock: 180 }, { name: 'M 码', price: 259, stock: 200 }] },
  { product_no: '3781182303640879227', title: '针织连衣裙女收腰显瘦中长款', price: 229.0, stock: 420, category: '女装', scenes: ['日常通勤', '约会聚会'], services: ['七天无理由', '运费险'], skus: [{ name: 'S 码', price: 229, stock: 200 }, { name: 'M 码', price: 229, stock: 220 }] },
  { product_no: '3781182303640879228', title: '真丝衬衫女长袖通勤百搭上衣', price: 399.0, stock: 210, category: '女装', scenes: ['面试正式场合', '日常通勤'], services: ['七天无理由', '正品保障'], skus: [{ name: 'S 码', price: 399, stock: 110 }, { name: 'M 码', price: 399, stock: 100 }] },
  { product_no: '3781182303640879229', title: '宽松卫衣女加绒秋冬外套', price: 159.0, stock: 880, category: '女装', scenes: ['周末休闲', '换季添衣'], services: ['七天无理由', '运费险'], skus: [{ name: '均码', price: 159, stock: 880 }] },
  { product_no: '3781182303640879230', title: '风衣外套女中长款双排扣', price: 499.0, stock: 260, category: '女装', scenes: ['日常通勤', '换季添衣'], services: ['七天无理由', '运费险'], skus: [{ name: 'S 码', price: 499, stock: 120 }, { name: 'M 码', price: 499, stock: 140 }] },
  { product_no: '3781182303640879231', title: '高领打底衫女修身薄款内搭', price: 79.0, stock: 1500, category: '女装', scenes: ['换季添衣', '日常通勤'], services: ['七天无理由'], skus: [{ name: '均码', price: 79, stock: 1500 }] },
  { product_no: '3781182303640879232', title: '阔腿裤女垂感显瘦休闲长裤', price: 149.0, stock: 700, category: '女装', scenes: ['日常通勤', '周末休闲'], services: ['七天无理由', '运费险'], skus: [{ name: 'S 码', price: 149, stock: 300 }, { name: 'M 码', price: 149, stock: 400 }] },
  { product_no: '3781182303640879233', title: '羽绒服女中长款加厚保暖外套', price: 699.0, stock: 190, category: '女装', scenes: ['换季添衣'], services: ['七天无理由', '运费险', '一年质保'], skus: [{ name: 'S 码', price: 699, stock: 90 }, { name: 'M 码', price: 699, stock: 100 }] },
  { product_no: '3781182303640879234', title: '吊带背心女内搭外穿打底衫', price: 69.0, stock: 1200, category: '女装', scenes: ['约会聚会', '换季添衣'], services: ['七天无理由'], skus: [{ name: '均码', price: 69, stock: 1200 }] },
  { product_no: '3781182303640879235', title: '男士纯色 polo 衫短袖商务休闲', price: 119.0, stock: 900, category: '男装', scenes: ['日常通勤'], services: ['七天无理由', '48小时发货'], skus: [{ name: 'L 码', price: 119, stock: 450 }, { name: 'XL 码', price: 119, stock: 450 }] },
  { product_no: '3781182303640879236', title: '男士夹克外套春秋薄款休闲', price: 329.0, stock: 430, category: '男装', scenes: ['日常通勤', '换季添衣'], services: ['七天无理由', '运费险'], skus: [{ name: 'L 码', price: 329, stock: 220 }, { name: 'XL 码', price: 329, stock: 210 }] },
  { product_no: '3781182303640879237', title: '男士毛呢大衣中长款冬季外套', price: 599.0, stock: 180, category: '男装', scenes: ['面试正式场合', '换季添衣'], services: ['七天无理由', '运费险'], skus: [{ name: 'L 码', price: 599, stock: 90 }, { name: 'XL 码', price: 599, stock: 90 }] },
  { product_no: '3781182303640879238', title: '男士卫衣加绒宽松休闲套头衫', price: 169.0, stock: 760, category: '男装', scenes: ['周末休闲', '换季添衣'], services: ['七天无理由'], skus: [{ name: 'L 码', price: 169, stock: 380 }, { name: 'XL 码', price: 169, stock: 380 }] },
  { product_no: '3781182303640879239', title: '男士牛仔裤直筒弹力修身长裤', price: 199.0, stock: 680, category: '男装', scenes: ['日常通勤'], services: ['七天无理由', '运费险'], skus: [{ name: '30 码', price: 199, stock: 240 }, { name: '32 码', price: 199, stock: 440 }] },
  { product_no: '3781182303640879240', title: '男士羽绒服短款轻薄保暖外套', price: 559.0, stock: 240, category: '男装', scenes: ['换季添衣'], services: ['七天无理由', '一年质保'], skus: [{ name: 'L 码', price: 559, stock: 120 }, { name: 'XL 码', price: 559, stock: 120 }] },
  { product_no: '3781182303640879241', title: '男士针织毛衣圆领套头打底衫', price: 189.0, stock: 520, category: '男装', scenes: ['日常通勤', '换季添衣'], services: ['七天无理由'], skus: [{ name: 'L 码', price: 189, stock: 260 }, { name: 'XL 码', price: 189, stock: 260 }] },
  { product_no: '3781182303640879242', title: '男士休闲西装外套修身单排扣', price: 399.0, stock: 210, category: '男装', scenes: ['面试正式场合'], services: ['七天无理由', '运费险'], skus: [{ name: 'L 码', price: 399, stock: 110 }, { name: 'XL 码', price: 399, stock: 100 }] },
  { product_no: '3781182303640879243', title: '女士粗跟单鞋通勤浅口工作鞋', price: 259.0, stock: 480, category: '鞋靴', scenes: ['日常通勤', '面试正式场合'], services: ['七天无理由', '运费险'], skus: [{ name: '36 码', price: 259, stock: 160 }, { name: '37 码', price: 259, stock: 160 }, { name: '38 码', price: 259, stock: 160 }] },
  { product_no: '3781182303640879244', title: '女士短靴马丁靴加绒保暖', price: 329.0, stock: 360, category: '鞋靴', scenes: ['换季添衣', '周末休闲'], services: ['七天无理由', '运费险'], skus: [{ name: '37 码', price: 329, stock: 180 }, { name: '38 码', price: 329, stock: 180 }] },
  { product_no: '3781182303640879245', title: '女士雪地靴保暖防水短筒靴', price: 299.0, stock: 300, category: '鞋靴', scenes: ['换季添衣'], services: ['七天无理由', '运费险'], skus: [{ name: '37 码', price: 299, stock: 150 }, { name: '38 码', price: 299, stock: 150 }] },
  { product_no: '3781182303640879246', title: '男士商务皮鞋真皮系带正装鞋', price: 459.0, stock: 220, category: '鞋靴', scenes: ['面试正式场合'], services: ['七天无理由', '正品保障'], skus: [{ name: '41 码', price: 459, stock: 110 }, { name: '42 码', price: 459, stock: 110 }] },
  { product_no: '3781182303640879247', title: '男士运动跑鞋减震透气休闲鞋', price: 339.0, stock: 540, category: '鞋靴', scenes: ['周末休闲', '运动健身'], services: ['七天无理由', '运费险'], skus: [{ name: '41 码', price: 339, stock: 270 }, { name: '42 码', price: 339, stock: 270 }] },
  { product_no: '3781182303640879248', title: '女士帆布鞋低帮百搭休闲鞋', price: 139.0, stock: 800, category: '鞋靴', scenes: ['周末休闲', '日常通勤'], services: ['七天无理由'], skus: [{ name: '36 码', price: 139, stock: 400 }, { name: '37 码', price: 139, stock: 400 }] },
  { product_no: '3781182303640879249', title: '男士休闲板鞋小白鞋百搭', price: 249.0, stock: 460, category: '鞋靴', scenes: ['周末休闲', '日常通勤'], services: ['七天无理由', '运费险'], skus: [{ name: '41 码', price: 249, stock: 230 }, { name: '42 码', price: 249, stock: 230 }] },
  { product_no: '3781182303640879250', title: '女士高跟凉鞋细跟一字扣夏季', price: 229.0, stock: 320, category: '鞋靴', scenes: ['约会聚会'], services: ['七天无理由', '运费险'], skus: [{ name: '37 码', price: 229, stock: 160 }, { name: '38 码', price: 229, stock: 160 }] },
  { product_no: '3781182303640879251', title: '女士斜挎小方包链条单肩包', price: 189.0, stock: 520, category: '箱包', scenes: ['约会聚会', '日常通勤'], services: ['七天无理由', '运费险'], skus: [{ name: '米白色', price: 189, stock: 260 }, { name: '黑色', price: 189, stock: 260 }] },
  { product_no: '3781182303640879252', title: '男士商务双肩包电脑背包大容量', price: 259.0, stock: 430, category: '箱包', scenes: ['日常通勤', '出差旅行'], services: ['七天无理由', '一年质保'], skus: [{ name: '标准款', price: 259, stock: 430 }] },
  { product_no: '3781182303640879253', title: '女士手提包大容量通勤托特包', price: 299.0, stock: 360, category: '箱包', scenes: ['日常通勤'], services: ['七天无理由', '运费险'], skus: [{ name: '棕色', price: 299, stock: 180 }, { name: '黑色', price: 299, stock: 180 }] },
  { product_no: '3781182303640879254', title: '行李箱万向轮登机箱 20 寸', price: 399.0, stock: 280, category: '箱包', scenes: ['出差旅行'], services: ['七天无理由', '一年质保'], skus: [{ name: '20 寸', price: 399, stock: 280 }] },
  { product_no: '3781182303640879255', title: '男士真皮钱包短款多卡位', price: 129.0, stock: 640, category: '箱包', scenes: ['节日送礼', '日常通勤'], services: ['七天无理由', '正品保障'], skus: [{ name: '黑色', price: 129, stock: 640 }] },
  { product_no: '3781182303640879256', title: '女士晚宴手拿包链条单肩小包', price: 219.0, stock: 240, category: '箱包', scenes: ['约会聚会'], services: ['七天无理由', '运费险'], skus: [{ name: '银色', price: 219, stock: 120 }, { name: '黑色', price: 219, stock: 120 }] },
  { product_no: '3781182303640879257', title: '儿童书包小学生减负护脊双肩包', price: 159.0, stock: 560, category: '箱包', scenes: ['日常通勤'], services: ['七天无理由', '运费险'], skus: [{ name: '蓝色', price: 159, stock: 280 }, { name: '粉色', price: 159, stock: 280 }] },
  { product_no: '3781182303640879258', title: '旅行收纳袋衣物整理包六件套', price: 59.0, stock: 1400, category: '箱包', scenes: ['出差旅行'], services: ['七天无理由'], skus: [{ name: '六件套', price: 59, stock: 1400 }] },
  { product_no: '3781182303640879259', title: '女士真皮腰带细款装饰皮带', price: 99.0, stock: 720, category: '配饰', scenes: ['日常通勤', '约会聚会'], services: ['七天无理由'], skus: [{ name: '黑色', price: 99, stock: 360 }, { name: '棕色', price: 99, stock: 360 }] },
  { product_no: '3781182303640879260', title: '女士丝巾春秋薄款百搭方巾', price: 79.0, stock: 900, category: '配饰', scenes: ['节日送礼', '约会聚会'], services: ['七天无理由'], skus: [{ name: '印花款', price: 79, stock: 900 }] },
  { product_no: '3781182303640879261', title: '男士商务皮带自动扣真皮腰带', price: 149.0, stock: 610, category: '配饰', scenes: ['面试正式场合', '节日送礼'], services: ['七天无理由', '正品保障'], skus: [{ name: '黑色', price: 149, stock: 610 }] },
  { product_no: '3781182303640879262', title: '女士羊毛围巾加厚保暖披肩', price: 119.0, stock: 580, category: '配饰', scenes: ['换季添衣', '节日送礼'], services: ['七天无理由'], skus: [{ name: '米色', price: 119, stock: 290 }, { name: '驼色', price: 119, stock: 290 }] },
  { product_no: '3781182303640879263', title: '女士发夹头饰套装简约百搭', price: 39.0, stock: 1600, category: '配饰', scenes: ['约会聚会'], services: ['七天无理由'], skus: [{ name: '六件套', price: 39, stock: 1600 }] },
  { product_no: '3781182303640879264', title: '男士领带商务正装免打结', price: 69.0, stock: 480, category: '配饰', scenes: ['面试正式场合'], services: ['七天无理由'], skus: [{ name: '藏青色', price: 69, stock: 480 }] },
  { product_no: '3781182303640879265', title: '女士墨镜防紫外线偏光太阳镜', price: 129.0, stock: 660, category: '配饰', scenes: ['出差旅行', '约会聚会'], services: ['七天无理由'], skus: [{ name: '茶色', price: 129, stock: 330 }, { name: '黑色', price: 129, stock: 330 }] },
  { product_no: '3781182303640879266', title: '儿童帽子围巾两件套秋冬保暖', price: 79.0, stock: 540, category: '配饰', scenes: ['换季添衣', '节日送礼'], services: ['七天无理由'], skus: [{ name: '均码', price: 79, stock: 540 }] },
  { product_no: '3781182303640879267', title: '儿童卫衣春秋薄款卡通套头衫', price: 99.0, stock: 820, category: '童装', scenes: ['日常通勤', '换季添衣'], services: ['七天无理由', '运费险'], skus: [{ name: '110 码', price: 99, stock: 410 }, { name: '130 码', price: 99, stock: 410 }] },
  { product_no: '3781182303640879268', title: '儿童牛仔裤弹力休闲长裤', price: 119.0, stock: 700, category: '童装', scenes: ['日常通勤'], services: ['七天无理由'], skus: [{ name: '110 码', price: 119, stock: 350 }, { name: '130 码', price: 119, stock: 350 }] },
  { product_no: '3781182303640879269', title: '儿童连衣裙夏季公主裙', price: 129.0, stock: 560, category: '童装', scenes: ['节日送礼', '约会聚会'], services: ['七天无理由', '运费险'], skus: [{ name: '110 码', price: 129, stock: 280 }, { name: '130 码', price: 129, stock: 280 }] },
  { product_no: '3781182303640879270', title: '儿童羽绒服轻薄保暖外套', price: 299.0, stock: 320, category: '童装', scenes: ['换季添衣'], services: ['七天无理由', '运费险'], skus: [{ name: '110 码', price: 299, stock: 160 }, { name: '130 码', price: 299, stock: 160 }] },
  { product_no: '3781182303640879271', title: '儿童运动套装两件套休闲', price: 139.0, stock: 640, category: '童装', scenes: ['周末休闲', '运动健身'], services: ['七天无理由'], skus: [{ name: '110 码', price: 139, stock: 320 }, { name: '130 码', price: 139, stock: 320 }] },
  { product_no: '3781182303640879272', title: '儿童睡衣家居服纯棉套装', price: 89.0, stock: 900, category: '童装', scenes: ['日常家用'], services: ['七天无理由'], skus: [{ name: '110 码', price: 89, stock: 450 }, { name: '130 码', price: 89, stock: 450 }] },
  { product_no: '3781182303640879273', title: '儿童防晒衣轻薄透气外套', price: 99.0, stock: 760, category: '童装', scenes: ['周末休闲', '出差旅行'], services: ['七天无理由'], skus: [{ name: '110 码', price: 99, stock: 380 }, { name: '130 码', price: 99, stock: 380 }] },
  { product_no: '3781182303640879274', title: '儿童帆布鞋软底防滑休闲鞋', price: 109.0, stock: 480, category: '童装', scenes: ['日常通勤', '周末休闲'], services: ['七天无理由', '运费险'], skus: [{ name: '28 码', price: 109, stock: 240 }, { name: '30 码', price: 109, stock: 240 }] },
  { product_no: '3781182303640879275', title: '女士无痕内衣聚拢舒适文胸', price: 119.0, stock: 860, category: '内衣', scenes: ['日常通勤'], services: ['七天无理由'], skus: [{ name: 'M 码', price: 119, stock: 430 }, { name: 'L 码', price: 119, stock: 430 }] },
  { product_no: '3781182303640879276', title: '女士纯棉内裤中腰三角裤三条装', price: 69.0, stock: 1500, category: '内衣', scenes: ['日常通勤'], services: ['七天无理由'], skus: [{ name: 'M 码', price: 69, stock: 750 }, { name: 'L 码', price: 69, stock: 750 }] },
  { product_no: '3781182303640879277', title: '男士纯棉平角内裤三条装', price: 89.0, stock: 1300, category: '内衣', scenes: ['日常通勤'], services: ['七天无理由'], skus: [{ name: 'L 码', price: 89, stock: 650 }, { name: 'XL 码', price: 89, stock: 650 }] },
  { product_no: '3781182303640879278', title: '女士保暖内衣加绒套装秋冬', price: 159.0, stock: 620, category: '内衣', scenes: ['换季添衣'], services: ['七天无理由', '运费险'], skus: [{ name: 'M 码', price: 159, stock: 310 }, { name: 'L 码', price: 159, stock: 310 }] },
  { product_no: '3781182303640879279', title: '男士保暖秋衣秋裤套装加绒', price: 169.0, stock: 580, category: '内衣', scenes: ['换季添衣'], services: ['七天无理由', '运费险'], skus: [{ name: 'L 码', price: 169, stock: 290 }, { name: 'XL 码', price: 169, stock: 290 }] },
  { product_no: '3781182303640879280', title: '女士家居服套装纯棉长袖睡衣', price: 139.0, stock: 700, category: '内衣', scenes: ['日常家用'], services: ['七天无理由'], skus: [{ name: 'M 码', price: 139, stock: 350 }, { name: 'L 码', price: 139, stock: 350 }] },
  { product_no: '3781182303640879281', title: '保湿精华水补水收缩毛孔爽肤水', price: 159.0, stock: 620, category: '美妆', scenes: ['日常通勤', '节日送礼'], services: ['七天无理由', '正品保障'], skus: [{ name: '150ml', price: 159, stock: 620 }] },
  { product_no: '3781182303640879282', title: '氨基酸洁面乳温和清洁不紧绷', price: 89.0, stock: 980, category: '美妆', scenes: ['日常通勤'], services: ['七天无理由', '正品保障'], skus: [{ name: '100g', price: 89, stock: 980 }] },
  { product_no: '3781182303640879283', title: '清爽防晒霜 SPF50 不油腻', price: 129.0, stock: 840, category: '美妆', scenes: ['出差旅行', '周末休闲'], services: ['七天无理由', '正品保障'], skus: [{ name: '50ml', price: 129, stock: 840 }] },
  { product_no: '3781182303640879284', title: '眼影盘大地色日常百搭十二色', price: 99.0, stock: 760, category: '美妆', scenes: ['约会聚会', '节日送礼'], services: ['七天无理由', '正品保障'], skus: [{ name: '十二色', price: 99, stock: 760 }] },
  { product_no: '3781182303640879285', title: '护手霜滋润保湿三支装', price: 59.0, stock: 1200, category: '美妆', scenes: ['换季添衣', '节日送礼'], services: ['七天无理由'], skus: [{ name: '三支装', price: 59, stock: 1200 }] },
  { product_no: '3781182303640879286', title: '记忆棉枕头护颈椎助眠枕', price: 129.0, stock: 540, category: '家居', scenes: ['日常家用'], services: ['七天无理由'], skus: [{ name: '标准款', price: 129, stock: 540 }] },
  { product_no: '3781182303640879287', title: '珊瑚绒沙发毯午睡盖毯', price: 79.0, stock: 880, category: '家居', scenes: ['日常家用', '节日送礼'], services: ['七天无理由'], skus: [{ name: '150x200', price: 79, stock: 880 }] },
  { product_no: '3781182303640879288', title: '浴室防滑地垫吸水脚垫', price: 45.0, stock: 1400, category: '家居', scenes: ['日常家用'], services: ['七天无理由'], skus: [{ name: '40x60', price: 45, stock: 1400 }] },
  { product_no: '3781182303640879289', title: '厨房收纳架多层置物架台面', price: 69.0, stock: 900, category: '家居', scenes: ['日常家用'], services: ['七天无理由'], skus: [{ name: '三层', price: 69, stock: 900 }] },
  { product_no: '3781182303640879290', title: '落地晾衣架折叠晾晒架', price: 99.0, stock: 700, category: '家居', scenes: ['日常家用'], services: ['七天无理由'], skus: [{ name: '标准款', price: 99, stock: 700 }] },
  { product_no: '3781182303640879291', title: '蓝牙音箱便携户外防水重低音', price: 199.0, stock: 420, category: '数码', scenes: ['周末休闲', '运动健身'], services: ['七天无理由', '一年质保'], skus: [{ name: '黑色', price: 199, stock: 420 }] },
  { product_no: '3781182303640879292', title: '手机快充充电器 65W 氮化镓', price: 89.0, stock: 1100, category: '数码', scenes: ['出差旅行', '日常通勤'], services: ['七天无理由', '一年质保'], skus: [{ name: '单口', price: 89, stock: 1100 }] },
  { product_no: '3781182303640879293', title: '移动电源 20000mAh 双向快充', price: 129.0, stock: 860, category: '数码', scenes: ['出差旅行'], services: ['七天无理由', '一年质保'], skus: [{ name: '白色', price: 129, stock: 860 }] },
  { product_no: '3781182303640879294', title: '智能手环运动计步心率防水', price: 159.0, stock: 640, category: '数码', scenes: ['运动健身'], services: ['七天无理由', '一年质保'], skus: [{ name: '黑色', price: 159, stock: 640 }] },
  { product_no: '3781182303640879295', title: '婴儿浴巾纯棉吸水两条装', price: 69.0, stock: 900, category: '母婴', scenes: ['日常家用'], services: ['七天无理由'], skus: [{ name: '两条装', price: 69, stock: 900 }] },
  { product_no: '3781182303640879296', title: '儿童吸管水杯防漏学饮杯', price: 59.0, stock: 1100, category: '母婴', scenes: ['日常家用', '日常通勤'], services: ['七天无理由'], skus: [{ name: '300ml', price: 59, stock: 1100 }] },
  { product_no: '3781182303640879297', title: '婴儿口水巾围兜纯棉五条装', price: 39.0, stock: 1600, category: '母婴', scenes: ['日常家用'], services: ['七天无理由'], skus: [{ name: '五条装', price: 39, stock: 1600 }] },
  { product_no: '3781182303640879298', title: '每日坚果混合装 30 包礼盒', price: 99.0, stock: 1300, category: '食品', scenes: ['节日送礼', '日常通勤'], services: ['七天无理由', '闪电发货'], skus: [{ name: '30 包', price: 99, stock: 1300 }] },
  { product_no: '3781182303640879299', title: '蜂蜜柚子茶冲饮罐装 500g', price: 39.0, stock: 1700, category: '食品', scenes: ['日常家用', '节日送礼'], services: ['七天无理由', '闪电发货'], skus: [{ name: '500g', price: 39, stock: 1700 }] },
  { product_no: '3781182303640879300', title: '全麦面包早餐代餐整箱装', price: 49.0, stock: 1500, category: '食品', scenes: ['日常通勤'], services: ['七天无理由', '闪电发货'], skus: [{ name: '整箱装', price: 49, stock: 1500 }] },
];

/** 快捷短语：覆盖开场、商品、价格、物流、订单、售后、安抚、结束八类场景。 */
export const PHRASES: SeedPhrase[] = [
  { category: '开场', title: '标准问候', content: '亲，您好，很高兴为您服务，请问有什么可以帮您？' },
  { category: '开场', title: '稍等回复', content: '亲，稍等一下，我马上帮您核实～' },
  { category: '开场', title: '买家静默唤回', content: '亲，还在的吗？您刚才问的问题我这边已经帮您确认好了，随时可以回复您～' },
  { category: '商品', title: '尺码推荐', content: '亲，按您提供的身高体重，建议选择 {推荐尺码}；如果喜欢宽松一点，可以拍大一码哦～' },
  { category: '商品', title: '材质说明', content: '亲，这款面料是 {材质成分}，亲肤透气，日常穿着比较舒服～' },
  { category: '商品', title: '色差说明', content: '亲，因为拍摄光线和手机屏幕显示会有轻微差异，实物颜色更接近 {主色调}，比较介意的话可以先看下买家秀哦～' },
  { category: '商品', title: '库存说明', content: '亲，目前 {规格} 还有现货，拍下后会在 {发货时效} 内为您安排发出～' },
  { category: '商品', title: '参数说明', content: '亲，这款的主要参数是：{参数明细}，详情页也有完整标注，您看还有哪里需要我补充的？' },
  { category: '商品', title: '正品保障', content: '亲，我们是品牌官方授权店铺，支持防伪查询，您可以放心购买哦～' },
  { category: '价格', title: '优惠说明', content: '亲，目前店铺 {活动名称} 活动进行中，下单可以直接享受优惠哦～' },
  { category: '价格', title: '到手价说明', content: '亲，这款到手价 {到手价} 元，是 {优惠方式} 之后的实付金额，下单页面会直接显示哦～' },
  { category: '价格', title: '优惠券引导', content: '亲，您可以先领取 {优惠券名称}，下单时自动抵扣，还能和店铺满减一起使用～' },
  { category: '价格', title: '价保说明', content: '亲，这款支持 {价保天数} 天价保，如果期间降价，可以在订单页申请价保补差～' },
  { category: '价格', title: '还价婉拒', content: '亲，价格都是店铺统一的 {活动价}，实在没办法再优惠了，我帮您留意更划算的入手时机好不好？' },
  { category: '物流', title: '发货时效', content: '亲，商品会在 {发货时效} 内为您发出，发出后物流一般 2-4 天送达哦～' },
  { category: '物流', title: '物流核实', content: '亲，非常抱歉给您带来不便，我马上帮您联系快递核实物流进度～' },
  { category: '物流', title: '指定快递', content: '亲，默认发 {默认快递}，需要指定的话我帮您备注，实际以仓库出库为准哦～' },
  { category: '物流', title: '加急申请', content: '亲，我帮您备注加急优先发货，仓库会尽量为您安排，具体以物流揽收时间为准～' },
  { category: '物流', title: '派送异常', content: '亲，我马上联系快递核实并申请重新派送，麻烦您留意一下电话哦～' },
  { category: '订单', title: '修改地址', content: '亲，订单还没发货，我帮您提交修改收货地址，改好之后在聊天里同步给您～' },
  { category: '订单', title: '取消订单', content: '亲，订单未发货可以取消，您点"申请退款"后我这边同步仓库拦截，退款会原路退回～' },
  { category: '订单', title: '催发货', content: '亲，非常抱歉让您久等，我已经帮您催单，仓库会优先为您安排出库～' },
  { category: '售后', title: '安抚话术', content: '亲，非常抱歉给您带来不好的体验，我们一定会给您处理好，请您放心～' },
  { category: '售后', title: '退货引导', content: '亲，支持七天无理由退换，您可以在订单页面点击"申请售后"，选择退货退款即可～' },
  { category: '售后', title: '换货引导', content: '亲，支持换货，您在订单里申请售后选择"换货"，寄回后我们收到会第一时间安排重新发出～' },
  { category: '售后', title: '瑕疵处理', content: '亲，非常抱歉给您带来不好的体验，麻烦您拍一下瑕疵的位置，我核实后马上给您退换或者补发～' },
  { category: '售后', title: '补发安排', content: '亲，核实无误后我马上为您安排补发，预计 {补发时效} 内寄出，运费由我们承担～' },
  { category: '售后', title: '退款进度', content: '亲，您的退款已经提交，一般 1-3 个工作日原路退回到付款账户，麻烦您留意到账哦～' },
  { category: '安抚', title: '情绪降温', content: '亲，我特别理解您现在的心情，换我也会着急，我马上帮您处理，一定给您一个结果～' },
  { category: '安抚', title: '升级处理告知', content: '亲，您的问题我这边权限有限，已经帮您升级给主管处理，稍后会有专人和您对接，请您放心～' },
  { category: '结束', title: '标准结束语', content: '亲，还有其他可以帮您的吗？如果没有问题，祝您生活愉快，感谢您的咨询～' },
  { category: '结束', title: '主动跟进', content: '亲，这个问题我帮您持续跟进，有结果第一时间回复您，您不用一直守着哦～' },
  { category: '开场', title: '需求确认', content: '亲，为了给您更准确的建议，方便告诉我身高体重和平时的尺码吗？' },
  { category: '商品', title: '版型说明', content: '亲，这款是 {版型} 版型，日常穿着比较 {穿着效果}，按尺码表选择就可以啦～' },
  { category: '商品', title: '洗涤建议', content: '亲，建议 {洗涤方式}，水温不要太高，避免长时间暴晒，这样不容易缩水和掉色～' },
  { category: '商品', title: '断码说明', content: '亲，{规格} 目前断码了，预计 {补货时间} 到货，我可以帮您登记到货提醒～' },
  { category: '商品', title: '搭配建议', content: '亲，这款搭配 {搭配单品} 很出效果，日常和通勤都比较好穿～' },
  { category: '价格', title: '预售说明', content: '亲，这款是预售款，预计 {发货时效} 内发货；比较介意的话可以先关注，到货我再提醒您～' },
  { category: '订单', title: '退换时效', content: '亲，收到货后 7 天内可以申请退换，吊牌和包装尽量保持完整，处理起来会更快哦～' },
  { category: '售后', title: '掉色处理', content: '亲，非常抱歉，深色衣物首次清洗可能会有少量浮色，麻烦您把照片发我，我核实后马上给您处理～' },
  { category: '售后', title: '缩水处理', content: '亲，非常抱歉给您带来不便，麻烦您拍一下现在的尺寸和洗标，我核实后马上帮您安排退换～' },
  { category: '售后', title: '发错货处理', content: '亲，实在抱歉发错了，我马上帮您安排换货，来回运费由我们承担，您看可以吗？' },
];

/**
 * 沟通风格：8 种买家性格。
 * 方案 10.3 的默认聊天占比为「友善 30 / 急躁 15 / 直爽 20 / 纠结 20 / 沉默 15」，
 * 因此基础五种按该口径填写（合计 100%）；后三种为扩充风格，默认不参与分配（ratio 为空），
 * 带教可在《沟通风格》页按需填写占比后生效。
 */
export const STYLES: SeedStyle[] = [
  { code: 'friendly', name: '友善随和型', description: '语气客气、容易接受解释', tone: '好的呢，谢谢亲～', emotion: 15, ratio: 30, emotional: false },
  { code: 'impatient', name: '急躁易怒型', description: '语气急促、容易升级为投诉', tone: '到底什么时候发？我都等了三天了！', emotion: 65, ratio: 15, emotional: true },
  { code: 'direct', name: '直爽高效型', description: '只问关键点，要求明确答案', tone: '直接说能不能今天发。', emotion: 30, ratio: 20, emotional: false },
  { code: 'hesitant', name: '纠结谨慎型', description: '反复确认细节，关注风险与售后', tone: '如果收到不合适，退货麻烦吗？', emotion: 40, ratio: 20, emotional: true },
  { code: 'silent', name: '沉默寡言型', description: '回复极短，需要客服主动引导', tone: '嗯。多少钱？', emotion: 20, ratio: 15, emotional: false },
  { code: 'newbie', name: '新手小白型', description: '不熟悉平台流程，需要一步步引导操作', tone: '啊？我不太会用，你说的那个按钮在哪里呀？', emotion: 25, ratio: null, emotional: false },
  { code: 'bargain', name: '精明比价型', description: '精打细算，反复比价并要求额外优惠', tone: '我刚在别家看到更便宜的，你们能再让点吗？', emotion: 35, ratio: null, emotional: false },
  { code: 'skeptic', name: '多疑较真型', description: '对承诺存疑，要凭证、要书面确认', tone: '你说了算吗？能给我个截图或者保证吗？', emotion: 45, ratio: null, emotional: true },
];

/** 售前追问：用于补足剧本轮数，偏向价格、时效与决策类追问。 */
export const FOLLOW_UPS_PRESALE: SeedFollowUp[] = [
  { question: '那大概多久能处理好呢？', keyPoints: ['发货', '时间'] },
  { question: '我再看一下别家，你们有什么优势吗？', keyPoints: ['优势', '保障'] },
  { question: '现在下单还有什么额外优惠吗？', keyPoints: ['优惠', '活动'] },
  { question: '这个和详情页写的不太一样啊', keyPoints: ['详情页', '核实'] },
  { question: '你能帮我确认一下吗？', keyPoints: ['确认', '回复'] },
  { question: '那我再考虑一下吧', keyPoints: ['考虑', '随时'] },
];

/**
 * 客户 2026-10-03：一次接待里的问题要按比例混合售前/售后——
 * 大部分是「**还没有订单**、只咨询商品信息」的售前问题，小部分是「**买完商品后**」的订单类问题。
 * 下面两组就是用来做这个混合的题库（不是补轮数用的追问池）：
 * - ORDER_AFTERSALE_QUESTIONS：买完商品后问订单/快递/催发货这类，属于**售后**；
 * - PRESALE_PRODUCT_QUESTIONS：纯商品咨询（颜色/面料/尺码/评价/优惠），属于**售前**。
 */
export const ORDER_AFTERSALE_QUESTIONS: SeedFollowUp[] = [
  { question: '我地址填错了，能帮我改一下收货地址吗？', keyPoints: ['地址', '登记'] },
  { question: '麻烦帮我换个快递，我不想要中通', keyPoints: ['快递', '备注'] },
  { question: '都两天了怎么还没发货，能帮我催一下吗？', keyPoints: ['催单', '时间'] },
  { question: '我拍错规格了，能帮我改一下订单吗？', keyPoints: ['订单', '规格'] },
  { question: '收货人电话写错了，帮我改一下电话吧', keyPoints: ['电话', '修改'] },
  { question: '能帮我备注一下工作日再送吗？', keyPoints: ['备注', '配送'] },
];

/**
 * 纯商品咨询（售前）：没有订单，只是问商品本身。
 *
 * 注意：这一组是**补进来的**问题，会出现在任何品类的会话里，所以只能用
 * 「**与品类无关**」的问法（优惠 / 活动 / 赠品 / 评价 / 现货 / 运费险 / 发货时效 / 发票），
 * 不能出现尺码、面料这类只在服装下成立的词——否则就违反了客户 2026-10-03 的
 * 「商品问题必须和实际商品一致」要求（校验见 domain/product-consistency.ts）。
 */
export const PRESALE_PRODUCT_QUESTIONS: SeedFollowUp[] = [
  { question: '这款现在有活动吗，和会员价能一起用吗？', keyPoints: ['优惠', '活动'] },
  { question: '现在下单有什么赠品吗？', keyPoints: ['赠品', '活动'] },
  { question: '评价里说的和详情页一致吗？', keyPoints: ['评价', '核实'] },
  { question: '现在拍是现货吗，多久能发出来？', keyPoints: ['现货', '发货'] },
  { question: '这个支持运费险吗？', keyPoints: ['运费险', '保障'] },
  { question: '可以开发票吗？', keyPoints: ['发票', '登记'] },
];

/** 售后追问：用于补足剧本轮数，偏向处理方案、时效与情绪安抚。 */
export const FOLLOW_UPS_AFTERSALE: SeedFollowUp[] = [
  { question: '如果不行的话我该怎么办？', keyPoints: ['方案', '保障'] },
  { question: '什么时候能给我结果？', keyPoints: ['时间', '回复'] },
  { question: '我要投诉你们！', keyPoints: ['抱歉', '主管'] },
  { question: '你们这个质量也太差了吧', keyPoints: ['抱歉', '核实'] },
  { question: '我不要补偿，我就要退货', keyPoints: ['退货', '运费'] },
  { question: '已经等了好几天了，还没人处理', keyPoints: ['抱歉', '加急'] },
];
