#!/usr/bin/env node
/**
 * verify-docx.mjs —— 交付前自检脚本
 * 校验 docx 包结构、XML 良构性、图片嵌入、目录域、页脚页码域，并统计结构与占位符。
 *
 * 用法: node tools/verify-docx.mjs 输出.docx
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

function readZip(buf) {
  // 通过中央目录读取条目，避免依赖本地文件头的额外字段。
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('未找到 ZIP 结束记录（EOCD）');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录记录签名错误');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');

    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    const raw = method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
    if (raw.length !== rawSize) throw new Error(`条目 ${name} 解压长度不符`);
    entries.set(name, { raw, crc, method });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 极简 XML 良构性检查：标签配对、属性引号、非法裸 & 字符。 */
function checkXml(text, label) {
  const problems = [];
  const stack = [];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  let last = 0;
  let m = re.exec(text);
  while (m) {
    const between = text.slice(last, m.index);
    if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(between)) {
      problems.push(`未转义的 & 字符，位置 ${m.index}`);
    }
    const [full, close, name, , selfClose] = m;
    if (close === '/') {
      const top = stack.pop();
      if (top !== name) problems.push(`标签不匹配: 期望 </${top}>，实际 </${name}>（位置 ${m.index}）`);
    } else if (!selfClose) {
      stack.push(name);
    }
    last = m.index + full.length;
    m = re.exec(text);
  }
  if (stack.length) problems.push(`存在未闭合标签: ${stack.slice(-5).join(' > ')}`);
  if (problems.length) throw new Error(`[${label}] XML 校验失败:\n  - ${problems.slice(0, 10).join('\n  - ')}`);
  return true;
}

function textOf(xml) {
  return xml
    .replace(/<w:p [^>]*>|<w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/* ---------- OOXML 子元素顺序校验（ECMA-376 CT_* sequence） ---------- */

const ORDERS = {
  pPr: ['pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl', 'numPr', 'suppressLineNumbers', 'pBdr', 'shd', 'tabs', 'suppressAutoHyphens', 'kinsoku', 'wordWrap', 'overflowPunct', 'topLinePunct', 'autoSpaceDE', 'autoSpaceDN', 'bidi', 'adjustRightInd', 'snapToGrid', 'spacing', 'ind', 'contextualSpacing', 'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection', 'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr', 'sectPr', 'pPrChange'],
  rPr: ['rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline', 'shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern', 'position', 'sz', 'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath'],
  tcPr: ['cnfStyle', 'tcW', 'gridSpan', 'hMerge', 'vMerge', 'tcBorders', 'shd', 'noWrap', 'tcMar', 'textDirection', 'tcFitText', 'vAlign', 'hideMark'],
  tblPr: ['tblStyle', 'tblpPr', 'tblOverlap', 'bidiVisual', 'tblStyleRowBandSize', 'tblStyleColBandSize', 'tblW', 'jc', 'tblCellSpacing', 'tblInd', 'tblBorders', 'shd', 'tblLayout', 'tblCellMar', 'tblLook', 'tblCaption', 'tblDescription'],
  sectPr: ['headerReference', 'footerReference', 'footnotePr', 'endnotePr', 'type', 'pgSz', 'pgMar', 'paperSrc', 'pgBorders', 'lnNumType', 'pgNumType', 'cols', 'formProt', 'vAlign', 'noEndnote', 'titlePg', 'textDirection', 'bidi', 'rtlGutter', 'docGrid', 'printerSettings', 'sectPrChange'],
  style: ['name', 'aliases', 'basedOn', 'next', 'link', 'autoRedefine', 'hidden', 'uiPriority', 'semiHidden', 'unhideWhenUsed', 'qFormat', 'locked', 'personal', 'personalCompose', 'personalReply', 'rsid', 'pPr', 'rPr', 'tblPr', 'trPr', 'tcPr', 'tblStylePr'],
  lvl: ['start', 'numFmt', 'lvlRestart', 'pStyle', 'isLgl', 'suff', 'lvlText', 'lvlPicBulletId', 'legacy', 'lvlJc', 'pPr', 'rPr'],
  tr: ['tblPrEx', 'trPr', 'tc', 'customXml', 'sdt', 'sdtContent', 'bookmarkStart'],
};

/** 取出容器元素在 depth=0 层的直接子元素名（按出现顺序）。 */
function directChildren(inner) {
  const names = [];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|[^>"])*?)(\/?)>/g;
  let depth = 0;
  let m = re.exec(inner);
  while (m) {
    const [, close, full, , selfClose] = m;
    const local = full.includes(':') ? full.split(':')[1] : full;
    if (close) {
      depth -= 1;
    } else if (selfClose) {
      if (depth === 0) names.push(local);
    } else {
      if (depth === 0) names.push(local);
      depth += 1;
    }
    m = re.exec(inner);
  }
  return names;
}

function checkChildOrder(xml, container, label) {
  const order = ORDERS[container];
  const problems = [];
  const re = new RegExp(`<w:${container}(?:\\s[^>]*)?>([\\s\\S]*?)</w:${container}>`, 'g');
  let m = re.exec(xml);
  let idx = 0;
  while (m) {
    idx += 1;
    const children = directChildren(m[1]).filter((n) => ORDERS[container].includes(n));
    let lastRank = -1;
    let lastChild = '';
    for (const child of children) {
      const rank = order.indexOf(child);
      if (rank < lastRank) {
        problems.push(`第 ${idx} 个 <w:${container}>: <w:${lastChild}> 之后出现了 <w:${child}>`);
      }
      lastRank = rank;
      lastChild = child;
    }
    m = re.exec(xml);
  }
  if (problems.length) {
    throw new Error(`[${label}] OOXML 子元素顺序错误:\n  - ${problems.slice(0, 8).join('\n  - ')}`);
  }
  return idx;
}

function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('用法: node tools/verify-docx.mjs <文件.docx>');
    process.exit(1);
  }
  const file = path.resolve(target);
  const buf = fs.readFileSync(file);
  const zip = readZip(buf);
  const report = { file, bytes: buf.length, checks: [], warnings: [] };
  const ok = (name, detail) => report.checks.push({ item: name, result: 'PASS', detail });

  const required = [
    '[Content_Types].xml',
    '_rels/.rels',
    'word/document.xml',
    'word/_rels/document.xml.rels',
    'word/styles.xml',
    'word/numbering.xml',
    'word/settings.xml',
    'word/header1.xml',
    'word/footer1.xml',
    'docProps/core.xml',
    'docProps/app.xml',
  ];
  const missing = required.filter((n) => !zip.has(n));
  if (missing.length) throw new Error(`缺少部件: ${missing.join(', ')}`);
  ok('必需部件齐全', `${required.length} 个部件`);

  for (const name of required) {
    if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue;
    checkXml(zip.get(name).raw.toString('utf8'), name);
  }
  ok('XML 良构性', '全部部件标签配对正确、无未转义字符');

  const media = [...zip.keys()].filter((n) => n.startsWith('word/media/'));
  for (const name of media) {
    const sig = zip.get(name).raw.subarray(0, 8).toString('hex');
    if (sig !== '89504e470d0a1a0a') throw new Error(`${name} 不是合法 PNG`);
  }
  if (media.length < 5) report.warnings.push(`图片数量为 ${media.length}，预期 5 张参考图`);
  ok('图片嵌入', `${media.length} 张 PNG，签名校验通过`);

  const docXml = zip.get('word/document.xml').raw.toString('utf8');
  const docRels = zip.get('word/_rels/document.xml.rels').raw.toString('utf8');

  const orderStats = [];
  for (const part of ['word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/header1.xml', 'word/footer1.xml']) {
    const xml = zip.get(part).raw.toString('utf8');
    for (const container of Object.keys(ORDERS)) {
      const n = checkChildOrder(xml, container, part);
      if (n) orderStats.push(`${container}×${n}`);
    }
  }
  ok('OOXML 子元素顺序', orderStats.join('、'));

  const mediaRels = [...docRels.matchAll(/Target="media\/([^"]+)"/g)].map((m) => `word/media/${m[1]}`);
  const orphan = mediaRels.filter((n) => !zip.has(n));
  if (orphan.length) throw new Error(`关系指向的图片不存在: ${orphan.join(', ')}`);
  ok('图片关系一致', `${mediaRels.length} 条关系与 media 目录一一对应`);

  if (!/TOC\s+\\o/.test(docXml)) throw new Error('未找到目录域（TOC field）');
  ok('目录域', 'TOC \\o "1-3" 已写入');

  if (!/updateFields/.test(zip.get('word/settings.xml').raw.toString('utf8'))) {
    report.warnings.push('settings.xml 未设置 updateFields，打开 Word 后需右键更新目录');
  } else {
    ok('目录自动更新', 'updateFields = true');
  }

  const footer = zip.get('word/footer1.xml').raw.toString('utf8');
  if (!/PAGE/.test(footer) || !/NUMPAGES/.test(footer)) throw new Error('页脚缺少 PAGE / NUMPAGES 域');
  ok('页脚页码', 'PAGE 与 NUMPAGES 域均存在');

  const h1 = [...docXml.matchAll(/<w:pStyle w:val="Heading1"\/>/g)].length;
  const h2 = [...docXml.matchAll(/<w:pStyle w:val="Heading2"\/>/g)].length;
  const h3 = [...docXml.matchAll(/<w:pStyle w:val="Heading3"\/>/g)].length;
  const h4 = [...docXml.matchAll(/<w:pStyle w:val="Heading4"\/>/g)].length;
  const tables = [...docXml.matchAll(/<w:tbl>/g)].length;
  const drawings = [...docXml.matchAll(/<w:drawing>/g)].length;
  ok('结构统计', `标题 H1=${h1} H2=${h2} H3=${h3} H4=${h4}；表格 ${tables} 个；内嵌图片 ${drawings} 张`);

  const text = textOf(docXml);
  const placeholders = ['TODO', 'todo', '待填', '占位', 'xxxx', '???', '【待'].filter((p) => text.includes(p));
  if (placeholders.length) report.warnings.push(`发现疑似占位内容: ${placeholders.join(', ')}`);
  else ok('占位符检查', '无 TODO / 待填 / 占位符残留');

  const chapters = [...text.matchAll(/\n\s*(\d{1,2})\s+([^\n]{2,40})\n/g)].map((m) => `${m[1]} ${m[2].trim()}`);
  report.chapters = [...new Set(chapters)].slice(0, 20);
  report.textLength = text.replace(/\s/g, '').length;

  console.log(JSON.stringify(report, null, 2));
}

main();
