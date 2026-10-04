#!/usr/bin/env node
/**
 * build-docx.mjs
 * 将 Markdown 源稿编译为 Word (.docx)。
 * 纯 Node 标准库实现（zlib + buffer），不依赖任何第三方包，不需要联网。
 *
 * 用法:
 *   node tools/build-docx.mjs docs/方案源稿.md 输出.docx
 *
 * 支持的 Markdown 子集:
 *   头部元数据: @title / @subtitle / @version / @date / @secret / @org / @rev
 *   指令: @toc / @pagebreak
 *   标题: # ## ### ####
 *   段落、- 无序列表（缩进 2 空格为次级）、1. 有序列表
 *   表格: GFM 管道语法
 *   引用: > 文本（渲染为提示框）
 *   代码: ``` 围栏（渲染为等宽灰底块）
 *   图片: ![图注](绝对路径)
 *   行内: **加粗** 与 `等宽`
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

const PAGE_W_TWIPS = 11906; // A4 宽
const PAGE_H_TWIPS = 16838; // A4 高
const MARGIN_TWIPS = 1440; // 左右上下页边距 1 英寸
const CONTENT_TWIPS = PAGE_W_TWIPS - MARGIN_TWIPS * 2;
const MAX_IMAGE_EMU = CONTENT_TWIPS * 635; // twip -> EMU
const FONT_BODY = '微软雅黑';
const FONT_HEAD = '黑体';
const FONT_ASCII_BODY = 'Microsoft YaHei';
const FONT_ASCII_HEAD = 'SimHei';

/* ------------------------------------------------------------------ *
 * 工具函数
 * ------------------------------------------------------------------ */

function esc(str) {
  return String(str)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c >>> 0;
  }
  return CRC_TABLE;
}

function crc32(buf) {
  const table = crcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

/** 生成标准 ZIP 包（deflate）。 */
function buildZip(entries, mtime = new Date()) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const dosTime = ((mtime.getHours() << 11) | (mtime.getMinutes() << 5) | Math.floor(mtime.getSeconds() / 2)) & 0xffff;
  const dosDate = (((mtime.getFullYear() - 1980) << 9) | ((mtime.getMonth() + 1) << 5) | mtime.getDate()) & 0xffff;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const compressed = zlib.deflateRawSync(raw, { level: 9 });
    const store = compressed.length >= raw.length;
    const data = store ? raw : compressed;
    const method = store ? 0 : 8;
    const crc = crc32(raw);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0x0800, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(dosTime, 10);
    lfh.writeUInt16LE(dosDate, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18);
    lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);

    locals.push(lfh, nameBuf, data);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(dosTime, 12);
    cdh.writeUInt16LE(dosDate, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(data.length, 20);
    cdh.writeUInt32LE(raw.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(0, 38);
    cdh.writeUInt32LE(offset, 42);
    centrals.push(cdh, nameBuf);

    offset += lfh.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const cdOffset = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

function pngSize(buf) {
  if (buf.length < 24) return { width: 800, height: 600 };
  const sig = buf.subarray(0, 8).toString('hex');
  if (sig !== '89504e470d0a1a0a') return { width: 800, height: 600 };
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function displayWidth(str) {
  let w = 0;
  for (const ch of String(str)) {
    const code = ch.codePointAt(0);
    w += code > 0x2e80 ? 2 : 1;
  }
  return w;
}

/* ------------------------------------------------------------------ *
 * Markdown 解析
 * ------------------------------------------------------------------ */

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function isSeparatorRow(line) {
  return /^\|?[\s:|-]+\|?$/.test(line.trim()) && line.includes('-');
}

function parseMarkdown(src) {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const meta = {};
  const revisions = [];
  const blocks = [];
  let i = 0;

  // 头部元数据
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith('@')) break;
    const sp = line.indexOf(' ');
    const key = (sp === -1 ? line.slice(1) : line.slice(1, sp)).trim();
    const value = sp === -1 ? '' : line.slice(sp + 1).trim();
    if (key === 'rev') revisions.push(value.split('|').map((s) => s.trim()));
    else meta[key] = value;
  }

  while (i < lines.length) {
    const raw = lines[i];
    const t = raw.trim();

    if (t === '') {
      i += 1;
      continue;
    }
    if (t === '---' || t === '***') {
      i += 1;
      continue;
    }
    if (t.startsWith('@pagebreak')) {
      blocks.push({ type: 'pagebreak' });
      i += 1;
      continue;
    }
    if (t.startsWith('@toc')) {
      blocks.push({ type: 'toc' });
      i += 1;
      continue;
    }
    if (t.startsWith('@cover-info')) {
      const rows = [];
      i += 1;
      while (i < lines.length && lines[i].trim().startsWith(':')) {
        const item = lines[i].trim().slice(1).trim();
        rows.push(item.split('|').map((s) => s.trim()));
        i += 1;
      }
      blocks.push({ type: 'cover-info', rows });
      continue;
    }
    if (t.startsWith('```')) {
      i += 1;
      const buf = [];
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push({ type: 'code', lines: buf });
      continue;
    }
    if (t.startsWith('#### ')) {
      blocks.push({ type: 'h4', text: t.slice(5).trim() });
      i += 1;
      continue;
    }
    if (t.startsWith('### ')) {
      blocks.push({ type: 'h3', text: t.slice(4).trim() });
      i += 1;
      continue;
    }
    if (t.startsWith('## ')) {
      blocks.push({ type: 'h2', text: t.slice(3).trim() });
      i += 1;
      continue;
    }
    if (t.startsWith('# ')) {
      blocks.push({ type: 'h1', text: t.slice(2).trim() });
      i += 1;
      continue;
    }
    if (t.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cur = lines[i].trim();
        if (!isSeparatorRow(cur)) rows.push(splitRow(cur));
        i += 1;
      }
      if (rows.length) blocks.push({ type: 'table', rows });
      continue;
    }
    if (/^!\[[^\]]*\]\([^)]*\)$/.test(t)) {
      const m = t.match(/^!\[([^\]]*)\]\(([^)]*)\)$/);
      blocks.push({ type: 'image', alt: m[1].trim(), src: m[2].trim() });
      i += 1;
      continue;
    }
    if (/^([-*]|\d+\.)\s+/.test(t)) {
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
        if (!m) break;
        items.push({
          level: Math.min(2, Math.floor(m[1].replace(/\t/g, '  ').length / 2)),
          ordered: /^\d/.test(m[2]),
          text: m[3].trim(),
        });
        i += 1;
      }
      if (items.length) blocks.push({ type: 'list', items });
      continue;
    }
    if (t.startsWith('>')) {
      const buf = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        buf.push(lines[i].trim().replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({ type: 'quote', text: buf.join('') });
      continue;
    }

    const buf = [];
    while (i < lines.length) {
      const t2 = lines[i].trim();
      if (t2 === '' || /^(#{1,4}\s|```|\||>\s?|[-*]\s|\d+\.\s|!\[|@)/.test(t2)) break;
      buf.push(t2);
      i += 1;
    }
    if (buf.length) blocks.push({ type: 'p', text: buf.join('') });
    else i += 1;
  }

  return { meta, revisions, blocks };
}

/* ------------------------------------------------------------------ *
 * 行内样式与 XML 片段
 * ------------------------------------------------------------------ */

function inlineParts(text) {
  const parts = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m = re.exec(text);
  while (m) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    const tok = m[0];
    if (tok.startsWith('**')) parts.push({ text: tok.slice(2, -2), bold: true });
    else parts.push({ text: tok.slice(1, -1), code: true });
    last = m.index + tok.length;
    m = re.exec(text);
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/**
 * 生成 run。注意：w:rPr 子元素必须遵循 OOXML 定义顺序，
 * 依次为 rFonts → b/bCs → color → shd（依据 ECMA-376 CT_RPr 顺序）。
 */
function runXml(run, options = {}) {
  const color = options.color || (run.code ? 'B03A2E' : null);
  const parts = [];
  if (run.code) parts.push(`<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="${FONT_BODY}"/>`);
  if (run.bold) parts.push('<w:b/><w:bCs/>');
  if (color) parts.push(`<w:color w:val="${color}"/>`);
  if (run.code) parts.push('<w:shd w:val="clear" w:color="auto" w:fill="F5F5F5"/>');
  const rPr = parts.length ? `<w:rPr>${parts.join('')}</w:rPr>` : '';
  return `<w:r>${rPr}<w:t xml:space="preserve">${esc(run.text)}</w:t></w:r>`;
}

function runsXml(text, options = {}) {
  return inlineParts(text)
    .map((r) => runXml(r, options))
    .join('');
}

function paraXml(runs, pPrInner = '') {
  return `<w:p>${pPrInner ? `<w:pPr>${pPrInner}</w:pPr>` : ''}${runs}</w:p>`;
}

function headingXml(level, text) {
  const style = `Heading${level}`;
  const pPr = `<w:pStyle w:val="${style}"/><w:keepNext/><w:outlineLvl w:val="${level - 1}"/>`;
  return paraXml(runsXml(text), pPr);
}

function spacerXml(pt = 6) {
  return `<w:p><w:pPr><w:spacing w:before="0" w:after="${pt * 20}" w:line="240" w:lineRule="auto"/></w:pPr></w:p>`;
}

/* ------------------------------------------------------------------ *
 * 表格
 * ------------------------------------------------------------------ */

function tableXml(rows) {
  const cols = Math.max(...rows.map((r) => r.length));
  const padded = rows.map((r) => {
    const copy = r.slice();
    while (copy.length < cols) copy.push('');
    return copy;
  });

  const weights = [];
  for (let c = 0; c < cols; c += 1) {
    let maxLen = 6;
    for (const r of padded) maxLen = Math.max(maxLen, displayWidth(r[c]));
    weights.push(Math.min(maxLen, 34));
  }
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => Math.max(720, Math.round((CONTENT_TWIPS * w) / totalWeight)));

  const grid = widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('');
  const borders =
    '<w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFC6D4"/>`)
      .join('') +
    '</w:tblBorders>';

  const trs = padded
    .map((row, rowIndex) => {
      const isHead = rowIndex === 0;
      const tcs = row
        .map((cell, colIndex) => {
          const shade = isHead
            ? '<w:shd w:val="clear" w:color="auto" w:fill="DEE7F5"/>'
            : '<w:shd w:val="clear" w:color="auto" w:fill="FFFFFF"/>';
          const cellMar = isHead ? '<w:tcMar><w:top w:w="60" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/></w:tcMar>' : '';
          const tcPr =
            `<w:tcW w:w="${widths[colIndex]}" w:type="dxa"/>` +
            shade +
            cellMar +
            '<w:vAlign w:val="center"/>';
          const cellRuns = isHead
            ? inlineParts(cell)
                .map((r) => runXml({ ...r, bold: true }, { color: '1F3864' }))
                .join('')
            : runsXml(cell);
          const cellPara = `<w:p><w:pPr><w:spacing w:before="40" w:after="40" w:line="288" w:lineRule="auto"/>${
            isHead ? '<w:jc w:val="center"/>' : '<w:jc w:val="left"/>'
          }</w:pPr>${cellRuns || '<w:r><w:t xml:space="preserve"></w:t></w:r>'}</w:p>`;
          return `<w:tc><w:tcPr>${tcPr}</w:tcPr>${cellPara}</w:tc>`;
        })
        .join('');
      const trPr = isHead ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
      return `<w:tr>${trPr}${tcs}</w:tr>`;
    })
    .join('');

  const tblPr =
    '<w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="' +
    CONTENT_TWIPS +
    '" w:type="dxa"/><w:jc w:val="center"/>' +
    borders +
    '<w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="90" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tblCellMar></w:tblPr>';

  return (
    `<w:tbl>${tblPr}<w:tblGrid>${grid}</w:tblGrid>${trs}</w:tbl>` +
    '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:p>'
  );
}

/* ------------------------------------------------------------------ *
 * 图片
 * ------------------------------------------------------------------ */

let drawingId = 1;

function imageParagraphXml(relId, cx, cy, name) {
  const id = drawingId;
  drawingId += 1;
  return (
    '<w:p><w:pPr><w:spacing w:before="120" w:after="60" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr><w:r><w:drawing>' +
    `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
    '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
    `<wp:docPr id="${id}" name="图片 ${id}"/>` +
    '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="${esc(name)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    '<pic:spPr><a:xfrm><a:off x="0" y="0"/>' +
    `<a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    '</pic:pic></a:graphicData></a:graphic></wp:inline>' +
    '</w:drawing></w:r></w:p>'
  );
}

/* ------------------------------------------------------------------ *
 * 固定 XML 部件
 * ------------------------------------------------------------------ */

function contentTypesXml(imageCount) {
  const overrides = [
    ['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
    ['/word/styles.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml'],
    ['/word/numbering.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml'],
    ['/word/settings.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml'],
    ['/word/header1.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml'],
    ['/word/footer1.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml'],
    ['/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'],
    ['/docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml'],
  ];
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    (imageCount ? '<Default Extension="png" ContentType="image/png"/>' : '') +
    overrides.map(([part, ct]) => `<Override PartName="${part}" ContentType="${ct}"/>`).join('') +
    '</Types>'
  );
}

function rootRelsXml() {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    '</Relationships>'
  );
}

function docRelsXml(imageParts) {
  const base = [
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>',
    '<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>',
    '<Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>',
    '<Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>',
  ];
  const images = imageParts.map(
    (part, index) =>
      `<Relationship Id="rIdImg${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${part.fileName}"/>`
  );
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    [...base, ...images].join('') +
    '</Relationships>'
  );
}

function stylesXml() {
  const fonts = `<w:rFonts w:ascii="${FONT_ASCII_BODY}" w:hAnsi="${FONT_ASCII_BODY}" w:eastAsia="${FONT_BODY}" w:cs="${FONT_ASCII_BODY}"/>`;
  const headFonts = `<w:rFonts w:ascii="${FONT_ASCII_HEAD}" w:hAnsi="${FONT_ASCII_HEAD}" w:eastAsia="${FONT_HEAD}" w:cs="${FONT_ASCII_HEAD}"/>`;
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults>' +
    `<w:rPrDefault><w:rPr>${fonts}<w:color w:val="262626"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault>` +
    '<w:pPrDefault><w:pPr><w:spacing w:before="0" w:after="120" w:line="360" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr></w:pPrDefault>' +
    '</w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="0" w:after="120" w:line="360" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="4" w:color="2E5C9A"/></w:pBdr><w:spacing w:before="360" w:after="180" w:line="300" w:lineRule="auto"/><w:jc w:val="left"/><w:outlineLvl w:val="0"/></w:pPr>'
      + `<w:rPr>${headFonts}<w:b/><w:color w:val="1F3864"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>` +
    '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="140" w:line="300" w:lineRule="auto"/><w:jc w:val="left"/><w:outlineLvl w:val="1"/></w:pPr>'
      + `<w:rPr>${headFonts}<w:b/><w:color w:val="2E5C9A"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>` +
    '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="220" w:after="120" w:line="300" w:lineRule="auto"/><w:jc w:val="left"/><w:outlineLvl w:val="2"/></w:pPr>'
      + `<w:rPr>${headFonts}<w:b/><w:color w:val="333F50"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>` +
    '<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="180" w:after="100" w:line="300" w:lineRule="auto"/><w:jc w:val="left"/><w:outlineLvl w:val="3"/></w:pPr>'
      + `<w:rPr>${headFonts}<w:b/><w:color w:val="404040"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>` +
    '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="0" w:after="180" w:line="264" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr>'
      + '<w:rPr><w:color w:val="808080"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F5F5F5"/><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:left="120" w:right="120"/><w:jc w:val="left"/></w:pPr>'
      + '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="' + FONT_BODY + '"/><w:color w:val="333333"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="6" w:color="2E5C9A"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="F2F6FC"/><w:spacing w:before="120" w:after="120" w:line="300" w:lineRule="auto"/><w:ind w:left="240" w:right="120"/><w:jc w:val="left"/></w:pPr>'
      + '<w:rPr><w:color w:val="44546A"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="CoverTitle"><w:name w:val="Cover Title"/><w:pPr><w:spacing w:before="2400" w:after="120"/><w:jc w:val="center"/><w:outlineLvl w:val="9"/></w:pPr>'
      + `<w:rPr>${headFonts}<w:b/><w:color w:val="1F3864"/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr></w:style>` +
    '<w:style w:type="paragraph" w:styleId="CoverSubtitle"><w:name w:val="Cover Subtitle"/><w:pPr><w:spacing w:before="0" w:after="360"/><w:jc w:val="center"/><w:outlineLvl w:val="9"/></w:pPr>'
      + `<w:rPr>${headFonts}<w:color w:val="2E5C9A"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>` +
    '<w:style w:type="paragraph" w:styleId="CoverMeta"><w:name w:val="Cover Meta"/><w:pPr><w:spacing w:before="0" w:after="80"/><w:jc w:val="center"/></w:pPr>'
      + '<w:rPr><w:color w:val="404040"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="0" w:after="60" w:line="336" w:lineRule="auto"/><w:contextualSpacing/><w:jc w:val="both"/></w:pPr></w:style>' +
    '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders>'
      + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="BFC6D4"/>`).join('')
      + '</w:tblBorders></w:tblPr></w:style>' +
    '</w:styles>'
  );
}

function numberingXml() {
  const bulletLvl = (ilvl, text, font, indent) =>
    `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/>` +
    `<w:pPr><w:ind w:left="${indent}" w:hanging="360"/></w:pPr>` +
    `<w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:hint="default"/><w:color w:val="2E5C9A"/></w:rPr></w:lvl>`;
  const numLvl = (ilvl, fmt, text, indent) =>
    `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/>` +
    `<w:pPr><w:ind w:left="${indent}" w:hanging="360"/></w:pPr>` +
    '<w:rPr><w:rFonts w:ascii="' + FONT_ASCII_BODY + '" w:hAnsi="' + FONT_ASCII_BODY + '" w:eastAsia="' + FONT_BODY + '"/></w:rPr></w:lvl>';
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>' +
    bulletLvl(0, '●', 'Symbol', 420) +
    bulletLvl(1, '○', 'Courier New', 840) +
    bulletLvl(2, '▪', 'Wingdings', 1260) +
    '</w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>' +
    numLvl(0, 'decimal', '%1.', 420) +
    numLvl(1, 'lowerLetter', '%2)', 840) +
    numLvl(2, 'lowerRoman', '%3.', 1260) +
    '</w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
    '</w:numbering>'
  );
}

function settingsXml() {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:zoom w:percent="100"/>' +
    '<w:defaultTabStop w:val="420"/>' +
    '<w:updateFields w:val="true"/>' +
    '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>' +
    '</w:settings>'
  );
}

function headerXml(title) {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="2" w:color="BFBFBF"/></w:pBdr>' +
    '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="right"/></w:pPr>' +
    `<w:r><w:rPr><w:rFonts w:ascii="${FONT_ASCII_BODY}" w:hAnsi="${FONT_ASCII_BODY}" w:eastAsia="${FONT_BODY}"/><w:color w:val="808080"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${esc(title)}</w:t></w:r>` +
    '</w:p></w:hdr>'
  );
}

function footerXml() {
  const field = (instr) =>
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    `<w:r><w:instrText xml:space="preserve">${instr}</w:instrText></w:r>` +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    '<w:r><w:t>1</w:t></w:r>' +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
  const rpr = `<w:rPr><w:rFonts w:ascii="${FONT_ASCII_BODY}" w:hAnsi="${FONT_ASCII_BODY}" w:eastAsia="${FONT_BODY}"/><w:color w:val="808080"/><w:sz w:val="18"/></w:rPr>`;
  const text = (t) => `<w:r>${rpr}<w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr>' +
    text('第 ') +
    field(' PAGE ') +
    text(' 页 / 共 ') +
    field(' NUMPAGES ') +
    text(' 页') +
    '</w:p></w:ftr>'
  );
}

function coreXml(meta, isoDate) {
  const title = meta.title || '文档';
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${esc(title)}</dc:title>` +
    `<dc:subject>${esc(meta.subtitle || '')}</dc:subject>` +
    `<dc:creator>${esc(meta.author || 'Codex')}</dc:creator>` +
    `<cp:lastModifiedBy>${esc(meta.author || 'Codex')}</cp:lastModifiedBy>` +
    `<cp:revision>1</cp:revision>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${isoDate}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${isoDate}</dcterms:modified>` +
    '</cp:coreProperties>'
  );
}

function appXml() {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    '<Application>Codex built-in docx writer</Application>' +
    '<DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>' +
    '<LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged>' +
    '</Properties>'
  );
}

/* ------------------------------------------------------------------ *
 * 文档主体
 * ------------------------------------------------------------------ */

function coverXml(meta) {
  const parts = [];
  parts.push(
    paraXml(runsXml(meta.title || ''), '<w:pStyle w:val="CoverTitle"/>')
  );
  if (meta.subtitle) parts.push(paraXml(runsXml(meta.subtitle), '<w:pStyle w:val="CoverSubtitle"/>'));
  if (meta.tagline) parts.push(paraXml(runsXml(meta.tagline), '<w:pStyle w:val="CoverMeta"/>'));
  parts.push(spacerXml(24));
  if (meta.org) parts.push(paraXml(runsXml(meta.org), '<w:pStyle w:val="CoverMeta"/>'));
  if (meta.version) parts.push(paraXml(runsXml(`版本：${meta.version}`), '<w:pStyle w:val="CoverMeta"/>'));
  if (meta.date) parts.push(paraXml(runsXml(`编制日期：${meta.date}`), '<w:pStyle w:val="CoverMeta"/>'));
  if (meta.secret) parts.push(paraXml(runsXml(`密级：${meta.secret}`), '<w:pStyle w:val="CoverMeta"/>'));
  return parts.join('');
}

function tocXml() {
  return (
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:keepNext/><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="4" w:color="2E5C9A"/></w:pBdr>' +
    '<w:spacing w:before="0" w:after="180" w:line="300" w:lineRule="auto"/><w:jc w:val="left"/><w:outlineLvl w:val="9"/></w:pPr>' +
    '<w:r><w:rPr><w:rFonts w:ascii="' + FONT_ASCII_HEAD + '" w:hAnsi="' + FONT_ASCII_HEAD + '" w:eastAsia="' + FONT_HEAD + '"/><w:b/><w:color w:val="1F3864"/><w:sz w:val="32"/></w:rPr><w:t>目　录</w:t></w:r></w:p>' +
    '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    '<w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    '<w:r><w:rPr><w:color w:val="808080"/></w:rPr><w:t>【目录将在 Word/WPS 打开时自动更新；若未显示，请在此处右键选择“更新域”】</w:t></w:r>' +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
  );
}

function revisionsXml(revisions) {
  if (!revisions.length) return '';
  const rows = [['版本', '日期', '修订内容', '编制', '审核'], ...revisions];
  return headingXml(2, '修订记录') + tableXml(rows);
}

function listXml(items) {
  return items
    .map((item) => {
      const numId = item.ordered ? 2 : 1;
      const pPr =
        '<w:pStyle w:val="ListParagraph"/>' +
        `<w:numPr><w:ilvl w:val="${item.level}"/><w:numId w:val="${numId}"/></w:numPr>` +
        `<w:spacing w:before="0" w:after="60" w:line="336" w:lineRule="auto"/><w:ind w:left="${420 + item.level * 420}" w:hanging="360"/>`;
      return paraXml(runsXml(item.text), pPr);
    })
    .join('');
}

function codeXml(lines) {
  if (!lines.length) return '';
  const runs = lines
    .map((line, idx) => {
      const br = idx === 0 ? '' : '<w:br/>';
      return (
        '<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="' +
        FONT_BODY +
        '"/><w:color w:val="333333"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>' +
        `${br}<w:t xml:space="preserve">${esc(line)}</w:t></w:r>`
      );
    })
    .join('');
  return (
    '<w:p><w:pPr><w:pStyle w:val="CodeBlock"/><w:spacing w:before="120" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>' +
    runs +
    '</w:p>'
  ) + '<w:p><w:pPr><w:pStyle w:val="CodeBlock"/><w:spacing w:before="0" w:after="180" w:line="120" w:lineRule="auto"/></w:pPr></w:p>';
}

function quoteXml(text) {
  return paraXml(runsXml(text), '<w:pStyle w:val="Quote"/>');
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

function main() {
  const [, , srcArg, outArg] = process.argv;
  if (!srcArg || !outArg) {
    console.error('用法: node tools/build-docx.mjs <源稿.md> <输出.docx>');
    process.exit(1);
  }
  const srcPath = path.resolve(srcArg);
  const outPath = path.resolve(outArg);
  const source = fs.readFileSync(srcPath, 'utf8');
  const { meta, revisions, blocks } = parseMarkdown(source);

  const imageParts = [];
  const bodyParts = [];

  const renderBlocks = (list, opts = {}) => {
    const out = [];
    for (const block of list) {
      switch (block.type) {
        case 'h1':
          out.push(headingXml(1, block.text));
          break;
        case 'h2':
          out.push(headingXml(2, block.text));
          break;
        case 'h3':
          out.push(headingXml(3, block.text));
          break;
        case 'h4':
          out.push(headingXml(4, block.text));
          break;
        case 'p':
          out.push(paraXml(runsXml(block.text)));
          break;
        case 'quote':
          out.push(quoteXml(block.text));
          break;
        case 'list':
          out.push(listXml(block.items));
          break;
        case 'code':
          out.push(codeXml(block.lines));
          break;
        case 'table':
          out.push(tableXml(block.rows));
          break;
        case 'toc':
          out.push(tocXml());
          break;
        case 'pagebreak':
          out.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
          break;
        case 'cover-info':
          out.push(
            tableXml([['项目', '内容'], ...block.rows])
          );
          break;
        case 'image': {
          const abs = path.resolve(path.dirname(srcPath), block.src);
          if (!fs.existsSync(abs)) {
            console.warn(`[warn] 图片不存在，已跳过: ${abs}`);
            break;
          }
          const buf = fs.readFileSync(abs);
          const { width, height } = pngSize(buf);
          const fileName = `image${imageParts.length + 1}.png`;
          imageParts.push({ fileName, data: buf });
          const relId = `rIdImg${imageParts.length}`;
          let cx = Math.round(width * 9525);
          let cy = Math.round(height * 9525);
          if (cx > MAX_IMAGE_EMU) {
            const ratio = MAX_IMAGE_EMU / cx;
            cx = Math.round(cx * ratio);
            cy = Math.round(cy * ratio);
          }
          out.push(imageParagraphXml(relId, cx, cy, fileName));
          if (block.alt) {
            out.push(paraXml(runsXml(block.alt), '<w:pStyle w:val="Caption"/>'));
          }
          break;
        }
        default:
          break;
      }
    }
    return out.join('');
  };

  // 封面
  bodyParts.push(coverXml(meta));
  bodyParts.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');

  const hasToc = blocks.some((b) => b.type === 'toc');
  if (!hasToc) {
    bodyParts.push(tocXml());
    bodyParts.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
  }

  bodyParts.push(revisionsXml(revisions));
  if (revisions.length) bodyParts.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');

  bodyParts.push(renderBlocks(blocks));

  const sectPr =
    '<w:sectPr>' +
    '<w:headerReference w:type="default" r:id="rIdHeader"/>' +
    '<w:footerReference w:type="default" r:id="rIdFooter"/>' +
    `<w:pgSz w:w="${PAGE_W_TWIPS}" w:h="${PAGE_H_TWIPS}"/>` +
    `<w:pgMar w:top="${MARGIN_TWIPS}" w:right="${MARGIN_TWIPS}" w:bottom="${MARGIN_TWIPS}" w:left="${MARGIN_TWIPS}" w:header="851" w:footer="992" w:gutter="0"/>` +
    '<w:cols w:space="425"/><w:docGrid w:type="lines" w:linePitch="312"/>' +
    '</w:sectPr>';

  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<w:body>' +
    bodyParts.join('') +
    sectPr +
    '</w:body></w:document>';

  const isoDate = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  const entries = [
    { name: '[Content_Types].xml', data: contentTypesXml(imageParts.length) },
    { name: '_rels/.rels', data: rootRelsXml() },
    { name: 'docProps/core.xml', data: coreXml(meta, isoDate) },
    { name: 'docProps/app.xml', data: appXml() },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/_rels/document.xml.rels', data: docRelsXml(imageParts) },
    { name: 'word/styles.xml', data: stylesXml() },
    { name: 'word/numbering.xml', data: numberingXml() },
    { name: 'word/settings.xml', data: settingsXml() },
    { name: 'word/header1.xml', data: headerXml(meta.title || '') },
    { name: 'word/footer1.xml', data: footerXml() },
    ...imageParts.map((p) => ({ name: `word/media/${p.fileName}`, data: p.data })),
  ];

  const zip = buildZip(entries);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, zip);

  const stats = {
    output: outPath,
    bytes: zip.length,
    images: imageParts.length,
    headings: blocks.filter((b) => /^h[1-4]$/.test(b.type)).length,
    tables: blocks.filter((b) => b.type === 'table').length,
    paragraphs: blocks.filter((b) => b.type === 'p').length,
  };
  console.log(JSON.stringify(stats, null, 2));
}

main();
