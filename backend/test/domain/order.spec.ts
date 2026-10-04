import {
  buildSimulatedOrder,
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
});
