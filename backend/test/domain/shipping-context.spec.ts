import { shippingConditionsCompatible } from '../../src/domain/shipping-context';

describe('发货时效的适用条件', () => {
  it('现货答复不覆盖预售问题', () => {
    expect(shippingConditionsCompatible('现货多久发货', '现货48小时内发货', '预售多久发货')).toBe(false);
  });
  it('没有节假日依据时不能复用为节假日时效', () => {
    expect(shippingConditionsCompatible('多久发货', '48小时内发货', '节假日多久发货')).toBe(false);
    expect(shippingConditionsCompatible('非节假日多久发货', '48小时内发货', '节假日多久发货')).toBe(false);
    expect(shippingConditionsCompatible('非节日多久发货', '48小时内发货', '节日多久发货')).toBe(false);
  });
  it('明确相同条件与当前上下文的追问可以复用', () => {
    expect(shippingConditionsCompatible('现货多久发货', '现货48小时内发货', '现货什么时候发出')).toBe(true);
    expect(shippingConditionsCompatible('现货多久发货', '现货48小时内发货', '那一般什么时候发出')).toBe(true);
  });
  it('春节和付款前后条件不能混用', () => {
    expect(shippingConditionsCompatible('多久发货', '48小时内发货', '春节多久发货')).toBe(false);
    expect(shippingConditionsCompatible('付款后多久发货', '48小时内发货', '付款前多久发货')).toBe(false);
    expect(shippingConditionsCompatible('工作日多久发货', '48小时内发货', '非工作日多久发货')).toBe(false);
  });
  it('涉及不同工作日条件时不复用', () => {
    expect(shippingConditionsCompatible('周末多久发货', '48小时内发货', '工作日多久发货')).toBe(false);
  });
});
