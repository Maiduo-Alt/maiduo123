import { parseXlsx } from '../../src/common/xlsx';
import { buildXlsx } from '../../src/common/xlsx-writer';

/**
 * 导出用的 .xlsx 生成器（方案 F2-08 明细导出 / F4-07 商品导出）。
 * 最有力的验证是「自己写的能用自己的解析器读回来」——两边都只用 Node 内置 zlib，
 * 一旦 XML 或 ZIP 结构写错，这里立刻会失败。
 */
describe('xlsx 生成（导出一致性）', () => {
  it('生成的文件能被本项目的解析器读回（字符串 / 数字 / 布尔 / 空值）', () => {
    const buffer = buildXlsx([
      {
        name: '明细',
        rows: [
          ['接待编号', '客服', '总分', '达标'],
          ['AT20261002-0001', '新人客服 A', 88.5, true],
          ['AT20261002-0002', '', null, false],
        ],
      },
    ]);
    const rows = parseXlsx(buffer);
    expect(rows[0]).toEqual(['接待编号', '客服', '总分', '达标']);
    expect(rows[1]).toEqual(['AT20261002-0001', '新人客服 A', '88.5', 'TRUE']);
    expect(rows[2]).toEqual(['AT20261002-0002', '', '', 'FALSE']);
  });

  it('XML 特殊字符会被转义，读回来仍是原文', () => {
    const buffer = buildXlsx([{ name: '对话', rows: [['买家<1>', 'A & B "引号" \'单引\'']] }]);
    const rows = parseXlsx(buffer);
    expect(rows[0]).toEqual(['买家<1>', 'A & B "引号" \'单引\'']);
  });

  it('支持多工作表', () => {
    const buffer = buildXlsx([
      { name: '明细', rows: [['a']] },
      { name: '对话全文', rows: [['b']] },
    ]);
    // 解析器读第一张表；第二张表的路径写在 ZIP 中央目录里（名称不压缩，可直接搜）
    expect(parseXlsx(buffer)[0]).toEqual(['a']);
    expect(buffer.includes(Buffer.from('xl/worksheets/sheet2.xml'))).toBe(true);
    expect(buffer.includes(Buffer.from('xl/worksheets/sheet1.xml'))).toBe(true);
  });

  it('空数据也能生成一个合法工作簿', () => {
    const rows = parseXlsx(buildXlsx([{ name: '空', rows: [] }]));
    expect(rows).toEqual([]);
  });
});
