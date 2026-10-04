import { isLevelAllowedByTask, isScriptInTaskScope } from '../../src/domain/task-scope';

describe('训练任务的剧本范围限定（方案 F6-03）', () => {
  const script = { id: 7, category: '售后', productIds: [1, 2] };

  it('全部 / 未配置时不限制', () => {
    expect(isScriptInTaskScope(script, { type: 'all', value: {} })).toBe(true);
    expect(isScriptInTaskScope(script, null)).toBe(true);
    expect(isScriptInTaskScope(script, { type: 'category', value: {} })).toBe(true);
    expect(isScriptInTaskScope(script, { type: 'product', value: { productIds: [] } })).toBe(true);
    expect(isScriptInTaskScope(script, { type: 'scripts', value: { scriptIds: [] } })).toBe(true);
  });

  it('按分类：命中才放行', () => {
    expect(isScriptInTaskScope(script, { type: 'category', value: { categories: ['售后', '物流'] } })).toBe(true);
    expect(isScriptInTaskScope(script, { type: 'category', value: { categories: ['售前'] } })).toBe(false);
  });

  it('按商品：剧本关联到其中任一商品即命中', () => {
    expect(isScriptInTaskScope(script, { type: 'product', value: { productIds: [2, 99] } })).toBe(true);
    expect(isScriptInTaskScope(script, { type: 'product', value: { productIds: [99] } })).toBe(false);
    // 字符串 id 也要能比中，接口传参经常是字符串
    expect(isScriptInTaskScope(script, { type: 'product', value: { productIds: ['1'] } })).toBe(true);
  });

  it('按指定剧本清单：按 id 精确匹配', () => {
    expect(isScriptInTaskScope(script, { type: 'scripts', value: { scriptIds: [7] } })).toBe(true);
    expect(isScriptInTaskScope(script, { type: 'scripts', value: { scriptIds: [70] } })).toBe(false);
  });

  /**
   * 客户 2026-10-03：任务可以按**商品种类**（男装/女装…）圈定训练内容，
   * 推送的问题就围绕这些品类的商品。
   */
  it('按商品种类：剧本关联商品里有任一分类命中即放行', () => {
    const apparel = { id: 8, category: '培训', productIds: [10, 11], productCategories: ['女装'] };
    const shoes = { id: 9, category: '培训', productIds: [20], productCategories: ['鞋靴'] };
    const mixed = { id: 10, category: '培训', productIds: [10, 20], productCategories: ['女装', '鞋靴'] };

    expect(isScriptInTaskScope(apparel, { type: 'product_category', value: { categories: ['女装', '男装'] } })).toBe(true);
    expect(isScriptInTaskScope(apparel, { type: 'product_category', value: { categories: ['男装'] } })).toBe(false);
    expect(isScriptInTaskScope(shoes, { type: 'product_category', value: { categories: ['女装'] } })).toBe(false);
    expect(isScriptInTaskScope(mixed, { type: 'product_category', value: { categories: ['鞋靴'] } })).toBe(true);
    // 没选任何分类 = 不限制；剧本没带商品分类时也不因为这条被拦
    expect(isScriptInTaskScope(apparel, { type: 'product_category', value: { categories: [] } })).toBe(true);
    expect(isScriptInTaskScope({ id: 11, category: '培训', productIds: [] }, { type: 'product_category', value: { categories: ['女装'] } })).toBe(false);
  });

  /**
   * 客户 2026-10-03：下发任务时要能**同时多选剧本和商品**——
   * 两个条件都满足才抽到；任一侧留空表示该维度不限制。
   */
  it('剧本 + 商品同时多选：两个条件都满足才放行', () => {
    const scope = (scriptIds: number[], productIds: number[]) => ({
      type: 'scripts_products',
      value: { scriptIds, productIds },
    });

    expect(isScriptInTaskScope(script, scope([7], [2]))).toBe(true);
    // 剧本命中但商品没命中
    expect(isScriptInTaskScope(script, scope([7], [99]))).toBe(false);
    // 商品命中但剧本没命中
    expect(isScriptInTaskScope(script, scope([70], [2]))).toBe(false);
    // 只选剧本：等于「指定剧本清单」
    expect(isScriptInTaskScope(script, scope([7], []))).toBe(true);
    expect(isScriptInTaskScope(script, scope([70], []))).toBe(false);
    // 只选商品：等于「按关联商品」
    expect(isScriptInTaskScope(script, scope([], [2]))).toBe(true);
    expect(isScriptInTaskScope(script, scope([], [99]))).toBe(false);
    // 两边都空 = 不限制
    expect(isScriptInTaskScope(script, scope([], []))).toBe(true);
  });

  it('任务允许的难度：空数组表示不限制', () => {
    expect(isLevelAllowedByTask('L2', ['L1', 'L2'])).toBe(true);
    expect(isLevelAllowedByTask('L3', ['L1', 'L2'])).toBe(false);
    expect(isLevelAllowedByTask('L4', [])).toBe(true);
    expect(isLevelAllowedByTask('L4', undefined)).toBe(true);
  });
});
