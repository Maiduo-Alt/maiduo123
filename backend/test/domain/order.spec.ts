import {
  buildSimulatedOrder,
  inferQuantityFromTexts,
  isPresaleOrderStage,
  ORDER_STAGE_TEXT,
  orderStageForQuestion,
} from '../../src/domain/order';

/** 客户 2026-10-03 口径：售前 = 发货前（待支付 / 待发货），售后 = 发货后（已发货）。 */
describe('模拟订单（客户 2026-10-03 三张参考图）', () => {
  const now = Date.parse('2026-10-03T10:00:00.000Z');

  it('同一 seed 生成同一笔订单：订单号与金额在三种状态下都一致', () => {
    const unpaid = buildSimulatedOrder(1234, 'unpaid', now);
    const unshipped = buildSimulatedOrder(1234, 'unshipped', now);
    const shipped = buildSimulatedOrder(1234, 'shipped', now);

    expect(unshipped.orderNo).toBe(unpaid.orderNo);
    expect(shipped.orderNo).toBe(unpaid.orderNo);
    expect(unshipped.amount).toBe(unpaid.amount);
    expect(shipped.amount).toBe(unpaid.amount);
    expect(unpaid.placedAt).toBe(unshipped.placedAt);
  });

  it('三种状态的字段与参考图一致：待支付只看订单金额，待发货有承诺发货，已发货有物流', () => {
    const unpaid = buildSimulatedOrder(99, 'unpaid', now);
    expect(unpaid.statusText).toBe(ORDER_STAGE_TEXT.unpaid);
    expect(unpaid.paidAt).toBeNull();
    expect(unpaid.promisedShipAt).toBeNull();
    expect(unpaid.trackingNo).toBeNull();

    const unshipped = buildSimulatedOrder(99, 'unshipped', now);
    expect(unshipped.statusText).toBe('待发货');
    expect(unshipped.paidAt).not.toBeNull();
    expect(unshipped.promisedShipAt).not.toBeNull();
    expect(unshipped.trackingNo).toBeNull();

    const shipped = buildSimulatedOrder(99, 'shipped', now);
    expect(shipped.statusText).toBe('已发货');
    expect(shipped.paidAt).not.toBeNull();
    expect(shipped.shippedAt).not.toBeNull();
    expect(shipped.promisedShipAt).not.toBeNull();
    expect(shipped.shippingMethod).toBeTruthy();
    expect(shipped.trackingCompany).toBeTruthy();
    expect(shipped.trackingNo).toMatch(/^\d{12}$/);
    expect(shipped.signedAt).not.toBeNull();
    /* 参考图 3：承诺送达晚于发货时间，签收早于承诺送达 */
    expect(Date.parse(shipped.promisedShipAt as string)).toBeGreaterThan(Date.parse(shipped.shippedAt as string));
    expect(Date.parse(shipped.signedAt as string)).toBeLessThan(Date.parse(shipped.promisedShipAt as string));
  });

  it('时间线自洽：下单 → 付款 → 发货 → 签收依次推进', () => {
    const order = buildSimulatedOrder(7, 'shipped', now);
    const at = (value: string) => Date.parse(value);

    expect(at(order.paidAt as string)).toBeGreaterThan(at(order.placedAt));
    expect(at(order.shippedAt as string)).toBeGreaterThan(at(order.paidAt as string));
    expect(at(order.signedAt as string)).toBeGreaterThan(at(order.shippedAt as string));
    expect(at(order.placedAt)).toBeLessThan(now);
  });

  it('售前 / 售后以发货为分界', () => {
    expect(isPresaleOrderStage('unpaid')).toBe(true);
    expect(isPresaleOrderStage('unshipped')).toBe(true);
    expect(isPresaleOrderStage('shipped')).toBe(false);
  });

  it('推送哪条问题就配哪一态的订单：售后→已发货，售前问发货→待发货，其余售前→待支付', () => {
    expect(orderStageForQuestion({ stage: 'aftersale', question: '里面棉跑偏了' })).toBe('shipped');
    expect(orderStageForQuestion({ stage: 'presale', question: '大概多久能发货？' })).toBe('unshipped');
    expect(orderStageForQuestion({ stage: 'presale', question: '这两款有什么区别？' })).toBe('unpaid');
    /* 问题没标注阶段时按内容兜底：出现售后词一律算售后 */
    expect(orderStageForQuestion({ question: '我要退货' })).toBe('shipped');
    expect(orderStageForQuestion({ question: '多久能到' })).toBe('unshipped');
  });

  it('售后里「还没发货」的订单类问题配待发货，已经发出的才配已发货（客户 2026-10-03 追加口径）', () => {
    // 买完商品后、但货还没发出去：催发货 / 改地址 / 改快递 / 改单 / 改电话
    expect(orderStageForQuestion({ stage: 'aftersale', question: '都两天了怎么还没发货，能帮我催一下吗？' })).toBe('unshipped');
    expect(orderStageForQuestion({ stage: 'aftersale', question: '我地址填错了，能帮我改一下收货地址吗？' })).toBe('unshipped');
    expect(orderStageForQuestion({ stage: 'aftersale', question: '麻烦帮我换个快递，我不想要中通' })).toBe('unshipped');
    expect(orderStageForQuestion({ stage: 'aftersale', question: '我拍错规格了，能帮我改一下订单吗？' })).toBe('unshipped');
    // 已经发出的：物流 / 签收 / 退换 / 质量
    expect(orderStageForQuestion({ stage: 'aftersale', question: '快递三天没有更新了！' })).toBe('shipped');
    expect(orderStageForQuestion({ stage: 'aftersale', question: '里面棉跑偏了' })).toBe('shipped');
  });

  /** 客户 2026-10-10 / 2026-10-14：订单保障 / 金额 / 规格必须和商品库一致。 */
  it('带商品生成订单：保障=商品服务承诺，金额=商品售价×件数，规格=SKU 规格名/尺码', () => {
    const product = {
      price: 150,
      services: ['七天无理由', '运费险', '48小时发货'],
      skus: [
        { name: '内搭+吊带+裙子', size: 'S', price: 150 },
        { name: '内搭+吊带+裙子', size: 'XL', price: 150 },
        { name: '内搭+吊带', size: 'M', price: 95 },
      ],
    };
    const order = buildSimulatedOrder(555, 'unshipped', now, product);
    expect(order.services).toEqual(['七天无理由', '运费险', '48小时发货']);
    /* 没提数量时默认 1 件，金额 = 「咨询宝贝」展示的商品售价 */
    expect(order.quantity).toBe(1);
    expect(order.amount).toBeCloseTo(150, 2);
    /* 规格仍取选中 SKU */
    const picked = product.skus.find((s) => order.spec.startsWith(s.name) && order.spec.endsWith(s.size));
    expect(picked).toBeTruthy();
    /* 同一 seed 跨状态稳定 */
    const again = buildSimulatedOrder(555, 'shipped', now, product);
    expect(again.orderNo).toBe(order.orderNo);
    expect(again.amount).toBe(order.amount);
    expect(again.spec).toBe(order.spec);
    expect(again.services).toEqual(order.services);
  });

  /** 客户 2026-10-14：买家说买几件，订单就是几件——金额 = 单价 × 件数。 */
  it('件数跟对话逻辑走：两套 = 2 件 = 单价 × 2', () => {
    const product = { price: 150, services: [], skus: [{ name: '套装', size: 'M', price: 150 }] };
    const two = buildSimulatedOrder(560, 'unpaid', now, product, 2);
    expect(two.quantity).toBe(2);
    expect(two.amount).toBeCloseTo(300, 2);
    const three = buildSimulatedOrder(560, 'unpaid', now, product, 3);
    expect(three.quantity).toBe(3);
    expect(three.amount).toBeCloseTo(450, 2);
  });

  it('商品无售价时回退 SKU 价；无商品时保障为空数组', () => {
    const noProductPrice = buildSimulatedOrder(556, 'unpaid', now, { price: 0, services: ['七天无理由'], skus: [{ name: 'A款', size: 'M', price: 200 }] });
    expect(noProductPrice.amount).toBeCloseTo(200, 2);
    expect(noProductPrice.quantity).toBe(1);
    const noProduct = buildSimulatedOrder(557, 'unpaid', now);
    expect(noProduct.services).toEqual([]);
  });
});

describe('从买家话术推断购买件数（客户 2026-10-14）', () => {
  it('识别「买/要/来/拍 + 数量 + 量词」，中文数字与阿拉伯数字都支持', () => {
    expect(inferQuantityFromTexts(['这个我想买两套，有优惠吗？'])).toBe(2);
    expect(inferQuantityFromTexts(['那我拍2件吧'])).toBe(2);
    expect(inferQuantityFromTexts(['给我来三件'])).toBe(3);
    expect(inferQuantityFromTexts(['买五件能便宜多少'])).toBe(5);
  });

  it('多条话术按时间顺序取最后一次提到的数量', () => {
    expect(inferQuantityFromTexts(['先买一件试试', '算了，我要两套'])).toBe(2);
    expect(inferQuantityFromTexts(['我想买两套', '这件质量怎么样'])).toBe(2);
  });

  it('「这件/那套」等泛指不会被误判为数量；无购买意图返回 null', () => {
    expect(inferQuantityFromTexts(['这件衣服会起球吗？'])).toBeNull();
    expect(inferQuantityFromTexts(['那套搭配有现货吗？'])).toBeNull();
    expect(inferQuantityFromTexts(['多少钱？', '包邮吗？'])).toBeNull();
    expect(inferQuantityFromTexts([])).toBeNull();
  });
});
