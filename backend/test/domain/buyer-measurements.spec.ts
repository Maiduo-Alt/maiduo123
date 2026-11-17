import { buyerMeasurements } from '../../src/domain/buyer-measurements';

describe('模拟买家身材信息', () => {
  it('优先沿用本会话买家已提供的数据', () => {
    expect(buyerMeasurements(101, ['我158/92穿什么码'])).toEqual({ heightCm: 158, weightJin: 92 });
    expect(buyerMeasurements(101, ['我身高165厘米，体重55公斤'])).toEqual({ heightCm: 165, weightJin: 110 });
    expect(buyerMeasurements(101, ['我165/55kg']).heightCm).toBe(165);
    expect(buyerMeasurements(101, ['我165/55kg']).weightJin).toBe(110);
    expect(buyerMeasurements(101, ['身高1米65，体重110斤'])).toEqual({ heightCm: 165, weightJin: 110 });
  });
  it('生成数据在同一会话和恢复后稳定，不依赖其他会话', () => {
    const first = buyerMeasurements(201, []);
    expect(buyerMeasurements(201, [])).toEqual(first);
    expect(buyerMeasurements(201, [`我身高${first.heightCm}厘米，体重${first.weightJin}斤`])).toEqual(first);
    expect(buyerMeasurements(202, [])).not.toEqual(first);
    expect(buyerMeasurements(201, [])).toEqual(first);
  });
  it('只提供部分数据时保留已经提供的值', () => {
    expect(buyerMeasurements(201, ['身高165厘米']).heightCm).toBe(165);
    expect(buyerMeasurements(201, ['体重110斤']).weightJin).toBe(110);
  });
});
