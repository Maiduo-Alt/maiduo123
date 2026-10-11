import { ReceptionService } from '../../src/modules/reception/reception.service';

/**
 * 要点命中（matchKeyPoints）口径：
 * 1. 要点原文直接包含；
 * 2. 同义词表放宽；
 * 3. 兜底要点「有效回应」= 任何非空回复都算命中（缺失要点时的退化值，
 *    语义是「有过实质回应即可」，否则兜底题永远拿不到分/永远被追问）。
 */
describe('matchKeyPoints（要点命中口径）', () => {
  // matchKeyPoints 不依赖任何构造注入，用最小桩实例直接测
  const svc = Object.create(ReceptionService.prototype) as ReceptionService;

  it('要点原文包含即命中', () => {
    expect(svc.matchKeyPoints('亲这款很显瘦哦', ['显瘦', '版型'])).toEqual(['显瘦']);
  });

  it('命中同义词也算（客服很少原样打出要点词）', () => {
    expect(svc.matchKeyPoints('夏天穿不会闷，很透气', ['透气'])).toEqual(['透气']);
    expect(svc.matchKeyPoints('面料是聚酯纤维的', ['聚酯'])).toEqual(['聚酯']);
  });

  it('兜底要点「有效回应」：任何非空回复都命中', () => {
    expect(svc.matchKeyPoints('这款很显瘦的', ['有效回应'])).toEqual(['有效回应']);
    expect(svc.matchKeyPoints('任何一句正常回复', ['有效回应'])).toEqual(['有效回应']);
  });

  it('空内容不命中任何要点', () => {
    expect(svc.matchKeyPoints('', ['有效回应'])).toEqual([]);
    expect(svc.matchKeyPoints('   ', ['显瘦'])).toEqual([]);
  });

  it('未命中要点的普通回复返回空数组（触发追问的依据）', () => {
    expect(svc.matchKeyPoints('亲这款是今年的新款，很多顾客都在买呢', ['显瘦', '版型'])).toEqual([]);
  });
});
