import { cloneParams, mergeParams, validateWeights } from '../../src/domain/params';
import { DEFAULT_PARAMS } from '../../src/domain/types';

describe('系统参数合并与校验（方案 4.8 / 10.3）', () => {
  it('未传参数时返回默认值的深拷贝，改动不影响默认值', () => {
    const merged = mergeParams(undefined);
    expect(merged).toEqual(DEFAULT_PARAMS);
    expect(merged).not.toBe(DEFAULT_PARAMS);

    merged.weights.response = 1;
    merged.sootheWords.push('测试词');
    expect(DEFAULT_PARAMS.weights.response).toBe(40);
    expect(DEFAULT_PARAMS.sootheWords).not.toContain('测试词');
  });

  it('嵌套字段按字段合并，未覆盖的部分保留默认值', () => {
    const merged = mergeParams({ weights: { response: 50 } as any, passLine: 85 });
    expect(merged.weights.response).toBe(50);
    expect(merged.weights.solving).toBe(DEFAULT_PARAMS.weights.solving);
    expect(merged.passLine).toBe(85);
    expect(merged.timeoutSec).toBe(DEFAULT_PARAMS.timeoutSec);
  });

  // 客户 2026-10-02 确认的两条默认值，锁在用例里，避免以后被无意改回去
  it('客户确认：达标 1 次解锁下一档，各档接入人数默认 1/2/3/4', () => {
    expect(DEFAULT_PARAMS.unlockConsecutive).toBe(1);
    expect(DEFAULT_PARAMS.levelConcurrent).toEqual({ L1: 1, L2: 2, L3: 3, L4: 4 });
  });

  it('各档接入人数支持按档覆盖，未覆盖的档位保留默认值', () => {
    const merged = mergeParams({ levelConcurrent: { L1: 3 } as any });
    expect(merged.levelConcurrent).toEqual({ L1: 3, L2: 2, L3: 3, L4: 4 });
  });

  it('waitToleranceFactor 与 defaultStyleRatio 同样按字段合并', () => {
    const merged = mergeParams({
      waitToleranceFactor: { L1: 2 } as any,
      defaultStyleRatio: { friendly: 40 } as any,
    });
    expect(merged.waitToleranceFactor.L1).toBe(2);
    expect(merged.waitToleranceFactor.L2).toBe(DEFAULT_PARAMS.waitToleranceFactor.L2);
    expect(merged.defaultStyleRatio.friendly).toBe(40);
    expect(merged.defaultStyleRatio.impatient).toBe(DEFAULT_PARAMS.defaultStyleRatio.impatient);
  });

  it('数组类字段由传入值整体覆盖', () => {
    const merged = mergeParams({ sootheWords: ['亲亲'] });
    expect(merged.sootheWords).toEqual(['亲亲']);
    expect(merged.negativeWords).toEqual(DEFAULT_PARAMS.negativeWords);
  });

  it('评分权重之和必须为 100', () => {
    expect(() => validateWeights(DEFAULT_PARAMS)).not.toThrow();
    const broken = cloneParams(DEFAULT_PARAMS);
    broken.weights.response = 30;
    expect(() => validateWeights(broken)).toThrow(/权重之和必须等于 100/);
  });
});
