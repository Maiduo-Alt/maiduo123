import { deflateRawSync } from 'zlib';

/**
 * 在测试里构造最小可用的 .xlsx（本质是 ZIP + XML）。
 * 用于验证 Excel 导入链路，同时避免为了测试引入 SheetJS 等第三方依赖。
 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function zip(files: { name: string; content: string }[]): Buffer {
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const data = Buffer.from(file.content, 'utf8');
    const compressed = deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    parts.push(local, compressed);
    centrals.push(central);
    offset += local.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, eocd]);
}

/** 用第一个工作表的 XML 与共享字符串表拼出一个可被解析的 .xlsx。 */
export function buildXlsxBuffer(sheetXml: string, sharedXml?: string): Buffer {
  const files = [
    {
      name: '[Content_Types].xml',
      content:
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    },
    { name: 'xl/worksheets/sheet1.xml', content: sheetXml },
  ];
  if (sharedXml) files.push({ name: 'xl/sharedStrings.xml', content: sharedXml });
  return zip(files);
}

/** 把字符串数组转成 sharedStrings.xml。 */
export function sharedStringsXml(values: string[]): string {
  const items = values.map((v) => `<si><t>${v}</t></si>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${items}</sst>`;
}
