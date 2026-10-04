import { inflateRawSync } from 'zlib';

/**
 * 极简 .xlsx 读取器（对应方案 3.4「Excel/CSV 导入」）。
 *
 * .xlsx 本质是一个 ZIP 包，里面是若干 XML。这里用 Node 内置的 zlib 自行解包，
 * 不引入 SheetJS 等第三方依赖，保证离线环境也能导入 Excel。
 * 支持范围（够覆盖平台导出与手工整理的商品表）：
 * - ZIP 的 store(0) 与 deflate(8) 两种压缩方式；
 * - 共享字符串（sharedStrings）、内联字符串（inlineStr）、数值、布尔；
 * - 稀疏单元格与 Excel 常见的合并/空行。
 * 不支持：加密工作簿、.xls（旧二进制格式）、公式求值（读取缓存值）。
 */

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

/** 读取 ZIP 内的全部条目。 */
function readZipEntries(buf: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let eocd = -1;
  const minStart = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minStart; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx 文件（未找到 ZIP 结构）');

  const total = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < total; i += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CEN_SIG) break;
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');

    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));

    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** 还原 XML 实体（含数字实体）。 */
export function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, code: string) => {
    if (code.startsWith('#x') || code.startsWith('#X')) return String.fromCodePoint(parseInt(code.slice(2), 16));
    if (code.startsWith('#')) return String.fromCodePoint(Number(code.slice(1)));
    return XML_ENTITIES[code] ?? whole;
  });
}

/** 列引用（如 BC12）转 0 基列号。 */
export function columnIndex(ref: string): number {
  const letters = ref.replace(/[^A-Za-z]/g, '').toUpperCase();
  let value = 0;
  for (const ch of letters) value = value * 26 + (ch.charCodeAt(0) - 64);
  return value - 1;
}

function textsOf(xml: string): string {
  return [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join('');
}

function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const out: string[] = [];
  for (const si of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) out.push(textsOf(si[1]));
  return out;
}

function cellValue(attrs: string, body: string, shared: string[]): string {
  const type = /t="([^"]+)"/.exec(attrs)?.[1] || 'n';
  if (type === 'inlineStr') return textsOf(body);
  const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
  if (raw === undefined) return '';
  if (type === 's') return shared[Number(raw)] ?? '';
  if (type === 'b') return raw.trim() === '1' ? 'TRUE' : 'FALSE';
  return decodeXml(raw);
}

function parseSheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  let autoRow = 0;
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowAttr = /r="(\d+)"/.exec(rowMatch[1]);
    const rowIndex = rowAttr ? Number(rowAttr[1]) - 1 : autoRow;
    autoRow = rowIndex + 1;

    const cells: string[] = [];
    let autoCol = 0;
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2] || '';
      const refAttr = /r="([A-Za-z]+\d+)"/.exec(attrs);
      const col = refAttr ? columnIndex(refAttr[1]) : autoCol;
      autoCol = col + 1;
      while (cells.length < col) cells.push('');
      cells[col] = cellValue(attrs, body, shared);
    }
    rows[rowIndex] = cells;
  }
  for (let i = 0; i < rows.length; i += 1) if (!rows[i]) rows[i] = [];
  return rows;
}

/** 解析 .xlsx，返回首个工作表的二维文本数组。 */
export function parseXlsx(buffer: Buffer): string[][] {
  if (buffer.length < 22 || buffer.subarray(0, 2).toString('latin1') !== 'PK') {
    throw new Error('不是有效的 xlsx 文件（文件头不是 ZIP）');
  }
  const entries = readZipEntries(buffer);
  const shared = parseSharedStrings(entries.get('xl/sharedStrings.xml')?.toString('utf8'));
  const sheetNames = [...entries.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => {
      const na = Number(/sheet(\d+)\.xml$/.exec(a)?.[1] ?? 0);
      const nb = Number(/sheet(\d+)\.xml$/.exec(b)?.[1] ?? 0);
      return na - nb;
    });
  if (!sheetNames.length) throw new Error('xlsx 中未找到工作表');
  return parseSheet(entries.get(sheetNames[0])!.toString('utf8'), shared);
}

/** 兼容前端上传的 dataURL 或纯 base64。 */
export function base64ToBuffer(input: string): Buffer {
  const comma = input.indexOf(',');
  const data = comma >= 0 ? input.slice(comma + 1) : input;
  return Buffer.from(data.replace(/\s/g, ''), 'base64');
}
