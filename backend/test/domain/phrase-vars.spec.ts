import { extractVariables } from '../../src/domain/phrase-vars';

describe('快捷短语变量（方案 3.8 F8-08）', () => {
  it('从内容里抽取 {变量}，按出现顺序去重', () => {
    expect(extractVariables('亲，这款到手价 {到手价} 元，{优惠方式} 后实付，还有 {到手价} 的价保哦～')).toEqual([
      '到手价',
      '优惠方式',
    ]);
    expect(extractVariables('亲，您好，很高兴为您服务，请问有什么可以帮您？')).toEqual([]);
    expect(extractVariables('')).toEqual([]);
  });

  it('忽略空占位与嵌套花括号，避免把正常文案误当成变量', () => {
    expect(extractVariables('价格 {} 与 {   } 都不算变量')).toEqual([]);
    expect(extractVariables('包含 {{双层}} 的内容')).toEqual(['双层']);
  });
});
