/**
 * 模拟订单（客户 2026-10-03 口径）。
 *
 * 抖店客服工作台里，订单卡片按状态展示不同字段与操作，三态对应三张参考图：
 * - `unpaid`    待支付：显示「订单金额 / 下单时间」，操作是核对地址、催付、改价、改地址；
 * - `unshipped` 待发货：即「已付款未发货」，显示「实付金额 / 付款时间 / 承诺发货时间」；
 * - `shipped`   已发货：显示「实付金额 / 付款时间 / 物流信息 / 发货时间/方式 / 收货信息」。
 *
 * 售前 / 售后以**发货为分界**：`unpaid`、`unshipped` 属售前；`shipped` 属售后。
 * 推送问题时按问题自身的订单状态取订单，所以「售前问题配待支付/待发货、售后问题配已发货」。
 *
 * 本模块是纯函数（给定 seed 结果完全可复现），便于单测与历史复盘。
 */

export type OrderStage = 'unpaid' | 'unshipped' | 'shipped';

export const ORDER_STAGE_TEXT: Record<OrderStage, string> = {
  unpaid: '待支付',
  unshipped: '待发货',
  shipped: '已发货',
};

/** 售前 = 发货前（待支付 / 待发货），售后 = 发货后（已发货）。 */
export function isPresaleOrderStage(stage: OrderStage): boolean {
  return stage !== 'shipped';
}

export interface SimulatedOrder {
  orderNo: string;
  stage: OrderStage;
  statusText: string;
  /** 商品件数（参考图里的 [1件]） */
  quantity: number;
  /** 规格（参考图里的「浅蓝色(浅蓝色) / M(M)」） */
  spec: string;
  /** 待支付看「订单金额」，其余看「实付金额」 */
  amount: number;
  placedAt: string;
  paidAt: string | null;
  /** 待发货才有的承诺发货时限 */
  promisedShipAt: string | null;
  shippedAt: string | null;
  shippingMethod: string | null;
  trackingCompany: string | null;
  trackingNo: string | null;
  signedAt: string | null;
  /** 脱敏收货人（参考图里的「澈*, 1***」） */
  receiver: string;
  address: string;
}

const PROVINCES = [
  ['湖北省', '襄阳市', '樊城区'],
  ['江西省', '新余市', '渝水区'],
  ['广东省', '广州市', '天河区'],
  ['浙江省', '杭州市', '余杭区'],
  ['江苏省', '南京市', '鼓楼区'],
  ['四川省', '成都市', '武侯区'],
];
const EXPRESS = ['中通快递', '圆通速递', '韵达快递'];
const SPECS = ['浅蓝色 / M', '米白色 / L', '黑色 / XL', '卡其色 / S'];

/** 小巧的可复现随机源（不引第三方，也不依赖 Math.random）。 */
function lcg(seed: number): () => number {
  let state = (Math.floor(Math.abs(seed)) % 2147483647) || 1;
  return () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
}

const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 3600 * 1000;

/**
 * 生成（或按新状态刷新）一笔模拟订单。
 * 同一个 seed 会得到同一个订单号与金额——同一局的订单在各状态间是"同一笔订单"在推进。
 */
export function buildSimulatedOrder(seed: number, stage: OrderStage, now = Date.now()): SimulatedOrder {
  const rng = lcg(seed);
  const orderNo = `69${String(Math.floor(rng() * 9e15)).padStart(15, '0').slice(0, 15)}`;
  const amount = Math.round((rng() * 900 + 60) * 100) / 100;
  const [province, city, district] = PROVINCES[Math.floor(rng() * PROVINCES.length)];
  const receiver = `${['澈', '果', '林', '陈', '王'][Math.floor(rng() * 5)]}*, 1***`;
  const address = `${province}${city}${district}…`;
  const placedAt = now - Math.round((rng() * 2 + 1) * HOUR);
  const paidAt = placedAt + Math.round((rng() * 20 + 3) * 60 * 1000);

  const order: SimulatedOrder = {
    orderNo,
    stage,
    statusText: ORDER_STAGE_TEXT[stage],
    quantity: Math.floor(rng() * 2) + 1,
    spec: SPECS[Math.floor(rng() * SPECS.length)],
    amount,
    placedAt: iso(placedAt),
    paidAt: null,
    promisedShipAt: null,
    shippedAt: null,
    shippingMethod: null,
    trackingCompany: null,
    trackingNo: null,
    signedAt: null,
    receiver,
    address,
  };

  if (stage === 'unshipped' || stage === 'shipped') {
    order.paidAt = iso(paidAt);
  }
  if (stage === 'unshipped') {
    // 参考图 2：承诺发货 1 天 23 小时 59 分内发货
    order.promisedShipAt = iso(paidAt + (48 * HOUR - 60 * 1000));
  }
  if (stage === 'shipped') {
    const shippedAt = paidAt + Math.round((rng() * 6 + 2) * HOUR);
    order.shippedAt = iso(shippedAt);
    /* 参考图 3：已发货的卡片上「承诺送达」是一个还没到的时间点，和「发货时间」不是同一个 */
    order.promisedShipAt = iso(shippedAt + (48 * HOUR - 60 * 1000));
    order.shippingMethod = rng() > 0.5 ? '保税仓发货' : '现货仓发货';
    order.trackingCompany = EXPRESS[Math.floor(rng() * EXPRESS.length)];
    order.trackingNo = String(Math.floor(rng() * 9e11)).padStart(12, '0');
    /* 签收发生在承诺送达之前（参考图 3：12:24 已签收，承诺当天 23:59 前送达） */
    order.signedAt = iso(shippedAt + Math.round((rng() * 24 + 6) * HOUR));
  }
  return order;
}

/**
 * 判断某个问题对应的订单状态（客户口径：以发货为节点）。
 * 售后内容一律「已发货」；售前内容里，问到发货/物流/时效的算「待发货」（已付款未发），
 * 其余（价格、优惠、商品、会员等）算「待支付」。
 */
export function orderStageForQuestion(question: { stage?: string | null; question?: string | null }): OrderStage {
  const text = String(question.question || '');
  /* 问题没带阶段时，按内容兜底判断是不是售后（退货、退款、投诉、质量……） */
  const stage =
    question.stage === 'aftersale' || question.stage === 'presale'
      ? question.stage
      : /退货|退款|售后|投诉|质量问题|破损|补发|换货|差评/.test(text)
        ? 'aftersale'
        : 'presale';
  /**
   * 客户 2026-10-03 追加口径：售后 = 「买完商品后」的咨询，里面还要再分一层——
   * 催发货 / 改地址 / 改快递 / 改单这类**订单还没发出去**的问题，订单卡给「待发货」；
   * 物流、签收、退换、质量这类**已经发出**的问题，才给「已发货」。
   */
  if (stage === 'aftersale') {
    // 「还没发出去」的诉求：催发货、改收货信息、改快递、改单、备注配送
    const changeBeforeShip =
      /催发货|催单|催一下|还没发货|怎么还不发|什么时候发|多久发货|改地址|收货地址|地址填错|地址写错|改快递|换快递|换个快递|换一个快递|改单|修改订单|改电话|改收货人|收货人|备注|改一下/.test(
        text
      );
    // 「已经发出」的诉求：物流进度、签收、退换、质量、投诉
    const afterShip = /退货|退款|收到货|签收|破损|质量|补发|换货|差评|投诉|物流|包裹|派送|没有更新|没收到|漏发|少发|运费/.test(text);
    return changeBeforeShip && !afterShip ? 'unshipped' : 'shipped';
  }
  return /发货|物流|快递|送达|到货|多久|时效|签收|配送|什么时候能到|几天能到/.test(text) ? 'unshipped' : 'unpaid';
}
