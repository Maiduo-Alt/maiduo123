import { columnIndex, decodeXml, parseXlsx } from '../../src/common/xlsx';
import { buildXlsxBuffer } from '../util/xlsx-fixture';

// 第 4 条用富文本 <r> 分段，验证解析器会把多段文本拼回一个单元格。
const SHARED = `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <si><t>product_no</t></si>
  <si><t>title</t></si>
  <si><t>price</t></si>
  <si><r><t>牛仔</t></r><r><t>短裤</t></r></si>
</sst>`;

const SHEET = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
  <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
  <row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" t="inlineStr"><is><t>纯棉 T 恤 &amp; 打底衫</t></is></c><c r="C2"><v>89</v></c></row>
  <row r="4"><c r="A4"><v>3781</v></c><c r="C4"><v>129.5</v></c></row>
</sheetData></worksheet>`;

describe('xlsx 解析（方案 3.4 Excel 导入）', () => {
  it('解析共享字符串、内联字符串与数值，并还原 XML 实体', () => {
    const rows = parseXlsx(buildXlsxBuffer(SHEET, SHARED));
    expect(rows[0]).toEqual(['product_no', 'title', 'price']);
    expect(rows[1]).toEqual(['牛仔短裤', '纯棉 T 恤 & 打底衫', '89']);
    expect(rows[2]).toEqual([]);
    expect(rows[3]).toEqual(['3781', '', '129.5']);
  });

  it('缺少共享字符串表时，行内字符串与数字仍可读取', () => {
    const sheet = `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>product_no</t></is></c></row></sheetData></worksheet>`;
    expect(parseXlsx(buildXlsxBuffer(sheet))).toEqual([['product_no']]);
  });

  it('非 xlsx 文件给出明确报错', () => {
    expect(() => parseXlsx(Buffer.from('这不是一个 Excel 文件'))).toThrow(/不是有效的 xlsx/);
  });

  it('列引用与实体解码的边界处理', () => {
    expect(columnIndex('A1')).toBe(0);
    expect(columnIndex('Z9')).toBe(25);
    expect(columnIndex('AA1')).toBe(26);
    expect(columnIndex('BC12')).toBe(54);
    expect(decodeXml('&lt;a&gt;&#65;&#x42;&quot;')).toBe('<a>AB"');
  });
});
