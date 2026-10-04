import {
  actionsForStage,
  BUSINESS_ACTIONS,
  findBusinessAction,
  renderActionPhrase,
} from '../../src/domain/business-actions';

/** 客户 2026-10-03：「点击后记为一次业务动作」——订单卡片上的平台侧操作要有一套确定的动作口径。 */
describe('业务动作（订单卡片上的平台侧操作）', () => {
  it('动作清单自洽：编码唯一、话术非空、都绑定至少一种订单状态', () => {
    const codes = BUSINESS_ACTIONS.map((item) => item.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(BUSINESS_ACTIONS.every((item) => item.name && item.phrase.trim() && item.stages.length > 0)).toBe(true);
    expect(findBusinessAction('urge_pay')?.name).toBe('催付');
    expect(findBusinessAction('not-exist')).toBeUndefined();
  });

  it('按钮按订单状态分组（与三张参考图一致）', () => {
    const unpaid = actionsForStage('unpaid').map((item) => item.code);
    expect(unpaid).toContain('urge_pay');
    expect(unpaid).toContain('change_price');
    expect(unpaid).not.toContain('ship_goods');
    expect(unpaid).not.toContain('logistics_card');

    const unshipped = actionsForStage('unshipped').map((item) => item.code);
    expect(unshipped).toContain('ship_goods');
    expect(unshipped).toContain('ship_negotiate');
    expect(unshipped).toContain('after_sale_card');
    expect(unshipped).not.toContain('urge_pay');

    const shipped = actionsForStage('shipped').map((item) => item.code);
    expect(shipped).toContain('logistics_card');
    expect(shipped).toContain('after_sale_proxy');
    expect(shipped).not.toContain('urge_pay');
    expect(shipped).not.toContain('after_sale_card');
  });

  it('话术变量会被替换掉，不会把 {xxx} 发给买家', () => {
    const urge = findBusinessAction('urge_pay')!;
    expect(renderActionPhrase(urge)).not.toMatch(/\{[^}]+\}/);

    const card = renderActionPhrase(findBusinessAction('logistics_card')!, {
      trackingCompany: '中通快递',
      trackingNo: '76985584179955',
    });
    expect(card).toContain('中通快递');
    expect(card).toContain('76985584179955');
    expect(card).not.toMatch(/\{[^}]+\}/);

    const verify = renderActionPhrase(findBusinessAction('verify_address')!, {
      receiver: '澈*, 1***',
      address: '湖北省襄阳市樊城区…',
    });
    expect(verify).toContain('澈*, 1***，湖北省襄阳市樊城区…');
  });
});
