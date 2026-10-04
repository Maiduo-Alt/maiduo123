#!/usr/bin/env node
/**
 * 内容库本地预览：把运行中的内容库（背景 / 咨询内容 / 商品 / 剧本 / 快捷短语 / 沟通风格）
 * 导出成一个自带数据的独立 HTML —— docs/内容库预览.html。
 *
 * 为什么要它：验收时要「翻一遍内容」，在系统里得登录、逐页翻；这个页面不登录、不加载前端，
 * 双击就能看全量内容，也可以直接丢给业务方当内容清单。
 *
 * 用法：npm run content:preview
 * 前置：接口服务（3000）在跑，数据取自真实库（不是另写一份死数据）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.SMOKE_BASE || 'http://127.0.0.1:3000';
const USER = process.env.CONTENT_PREVIEW_USER || 'admin';
const PWD = process.env.CONTENT_PREVIEW_PWD || 'Admin@123';
const OUT = path.join(root, 'docs/内容库预览.html');

async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PWD }),
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(`登录失败：${json.message}`);
  return json.data.token;
}

async function api(route, token) {
  const res = await fetch(`${API}/api${route}`, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json();
  if (json.code !== 0) throw new Error(`${route} -> ${json.code} ${json.message}`);
  return json.data;
}

/** 逐页取全量（接口 pageSize 上限 200）。 */
async function fetchAll(route, token) {
  const all = [];
  let page = 1;
  for (;;) {
    const data = await api(`${route}${route.includes('?') ? '&' : '?'}page=${page}&pageSize=200`, token);
    const list = data.list || [];
    all.push(...list);
    if (all.length >= (data.total ?? all.length) || list.length === 0) break;
    page += 1;
  }
  return all;
}

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** 页面里的表格/搜索/展开都是这段原生 JS 干的，不引任何外部依赖。 */
const RUNTIME = `
const DATA = window.__CONTENT__;
const TABS = [
  { key: 'backgrounds', label: '买家咨询背景', rows: DATA.backgrounds, columns: ['分类', '名称', '描述', '创建人', '更新时间'] },
  { key: 'contents', label: '买家咨询内容', rows: DATA.contents, columns: ['分类', '模板名称', '买家问题', '买家接受方案', '应答要点', '接待类型', '来源'] },
  { key: 'products', label: '商品', rows: DATA.products, columns: ['分类', '商品ID', '标题', '价格', '库存', '场景标签', '服务', '状态', '关联剧本'] },
  { key: 'scripts', label: '客户问题剧本', rows: DATA.scripts, columns: ['剧本编号', '剧本名称', '接待类型', '买家咨询背景', '咨询内容', '沟通风格', '轮数', '状态'] },
  { key: 'phrases', label: '快捷短语', rows: DATA.phrases, columns: ['分类', '标题', '内容', '变量', '使用次数', '状态'] },
  { key: 'styles', label: '沟通风格', rows: DATA.styles, columns: ['编码', '名称', '特征', '语气示例', '情绪基线', '占比', '来源'] },
];
const PAGE = 100;
let state = { tab: 'backgrounds', keyword: '', shown: PAGE };

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const tags = (arr) => (arr && arr.length ? arr.map((t) => '<span class="tag">' + esc(t) + '</span>').join('') : '<span class="dim">—</span>');

function cells(row) {
  switch (state.tab) {
    case 'backgrounds':
      return [esc(row.category), esc(row.name), esc(row.description), esc(row.createdByName || '内置'), esc(new Date(row.updatedAt).toLocaleString('zh-CN'))];
    case 'contents':
      return [
        esc(row.category),
        esc(row.templateName),
        esc(row.questionList.join(' / ')),
        esc(row.acceptedAnswer),
        esc((row.keyPoints || []).map((g) => '[' + g.join('+') + ']').join(' ')),
        esc(row.stage === 'aftersale' ? '售后' : '售前'),
        row.builtin ? '<span class="tag">内置</span>' : '<span class="tag tag-alt">自建</span>',
      ];
    case 'products':
      return [
        esc(row.category),
        esc(row.productNo),
        esc(row.title),
        esc('¥' + row.price),
        esc(row.stock),
        tags(row.scenes),
        tags(row.services),
        esc(row.status === 1 ? '上架' : '下架'),
        esc(row.scriptCount || 0),
      ];
    case 'scripts':
      return [
        esc(row.scriptNo),
        esc(row.name),
        esc(row.stage === 'aftersale' ? '售后' : '售前'),
        esc(row.bgName),
        esc(row.qaTemplate),
        esc(row.styleName),
        esc(row.rounds),
        esc(row.status === 1 ? '启用' : '停用'),
      ];
    case 'phrases':
      return [esc(row.category), esc(row.title), esc(row.content), tags(row.variables), esc(row.usedCount ?? 0), esc(row.status === 1 ? '启用' : '停用')];
    case 'styles':
      return [
        esc(row.code),
        esc(row.name),
        esc(row.description),
        esc(row.toneSample),
        esc(row.emotionBase),
        esc(row.ratio + '%'),
        row.isBuiltin ? '<span class="tag">内置</span>' : '<span class="tag tag-alt">自建</span>',
      ];
    default:
      return [];
  }
}

function rowText(row) {
  const parts = [];
  const walk = (v) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v === 'object') return Object.values(v).forEach(walk);
    parts.push(String(v));
  };
  walk(row);
  return parts.join(' ').toLowerCase();
}

function render() {
  const conf = TABS.find((t) => t.key === state.tab);
  const kw = state.keyword.trim().toLowerCase();
  const filtered = kw ? conf.rows.filter((row) => rowText(row).includes(kw)) : conf.rows;
  const visible = filtered.slice(0, state.shown);

  document.getElementById('tabs').innerHTML = TABS.map(
    (t) => '<button class="tab' + (t.key === state.tab ? ' active' : '') + '" data-tab="' + t.key + '">' +
      esc(t.label) + '<b>' + t.rows.length + '</b></button>'
  ).join('');

  const head = conf.columns.map((c) => '<th>' + esc(c) + '</th>').join('');
  const body = visible
    .map((row) => '<tr>' + cells(row).map((c) => '<td>' + c + '</td>').join('') + '</tr>')
    .join('');

  document.getElementById('table').innerHTML =
    '<thead><tr>' + head + '</tr></thead><tbody>' +
    (body || '<tr><td class="empty" colspan="' + conf.columns.length + '">没有匹配的内容</td></tr>') +
    '</tbody>';

  document.getElementById('status').textContent =
    '共 ' + conf.rows.length + ' 条' + (kw ? '，命中 ' + filtered.length + ' 条' : '') + '，已显示 ' + visible.length + ' 条';
  document.getElementById('more').style.display = filtered.length > visible.length ? '' : 'none';
  document.getElementById('more').textContent = '加载更多（还有 ' + (filtered.length - visible.length) + ' 条）';
}

document.addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (tab) {
    state = { tab: tab.dataset.tab, keyword: '', shown: PAGE };
    document.getElementById('search').value = '';
    render();
    return;
  }
  if (event.target.id === 'more') {
    state.shown += PAGE;
    render();
  }
});

document.getElementById('search').addEventListener('input', (event) => {
  state.keyword = event.target.value;
  state.shown = PAGE;
  render();
});

document.getElementById('print').addEventListener('click', () => window.print());
render();
`;

function buildHtml(data, meta) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>内容库本地预览 · 在线模拟接待训练系统</title>
<style>
  :root { --brand:#1f3864; --blue:#1677ff; --line:#e8ecf3; --muted:#8c8c8c; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, -apple-system, "Microsoft YaHei", sans-serif; color:#262626; background:#f5f7fb; }
  header { background:#fff; border-bottom:1px solid var(--line); padding:16px 24px; }
  h1 { margin:0 0 6px; font-size:18px; color:var(--brand); }
  .meta { font-size:12px; color:var(--muted); line-height:1.8; }
  .chips { display:flex; flex-wrap:wrap; gap:8px; padding:14px 24px 0; }
  .chip { background:#fff; border:1px solid var(--line); border-radius:6px; padding:8px 12px; font-size:12px; color:#595959; }
  .chip b { font-size:16px; color:var(--brand); margin-left:6px; }
  main { padding:14px 24px 40px; }
  .tabs { display:flex; flex-wrap:wrap; gap:6px; }
  .tab { border:1px solid var(--line); background:#fff; border-radius:6px 6px 0 0; border-bottom:none;
         padding:8px 14px; font-size:13px; color:#595959; cursor:pointer; }
  .tab b { margin-left:6px; color:var(--muted); font-weight:600; }
  .tab.active { color:var(--blue); font-weight:600; border-color:#bae0ff; background:#f0f7ff; }
  .panel { background:#fff; border:1px solid var(--line); border-radius:0 6px 6px 6px; overflow:hidden; }
  .bar { display:flex; align-items:center; gap:12px; padding:12px 14px; border-bottom:1px solid var(--line); }
  .bar input { flex:0 0 320px; height:32px; padding:0 12px; border:1px solid #d9d9d9; border-radius:16px; font-size:13px; outline:none; }
  .bar input:focus { border-color:#91caff; }
  .bar .spacer { flex:1; }
  .bar .status { font-size:12px; color:var(--muted); }
  .bar button { height:30px; padding:0 12px; border:1px solid #d9d9d9; background:#fff; border-radius:6px; font-size:12px; cursor:pointer; }
  .bar button:hover { color:var(--blue); border-color:#91caff; }
  .scroll { max-height: calc(100vh - 330px); overflow:auto; }
  table { border-collapse:collapse; width:100%; font-size:13px; }
  th, td { text-align:left; padding:9px 12px; border-bottom:1px solid #f2f4f8; vertical-align:top; line-height:1.6; }
  th { position:sticky; top:0; background:#fafbfd; color:#595959; font-weight:600; white-space:nowrap; }
  tbody tr:hover { background:#f7fafe; }
  .tag { display:inline-block; padding:0 6px; margin:0 4px 4px 0; font-size:11px; color:#595959; background:#fafafa; border:1px solid #f0f0f0; border-radius:4px; }
  .tag-alt { color:#0958d9; background:#e6f4ff; border-color:#bae0ff; }
  .dim { color:#bfbfbf; }
  .empty { text-align:center; color:var(--muted); padding:32px; }
  footer { padding:0 24px 32px; font-size:12px; color:var(--muted); }
</style>
</head>
<body>
<header>
  <h1>内容库本地预览</h1>
  <div class="meta">
    数据来源：运行中的接口服务 <code>${escapeHtml(meta.api)}</code>（真实库内容，非写死数据）<br />
    生成时间：${escapeHtml(meta.generatedAt)} ｜ 生成命令：<code>npm run content:preview</code><br />
    内容唯一来源：<code>backend/src/db/seed-content.ts</code>（改内容后重新生成一次即可）
  </div>
</header>
<div class="chips">
  ${meta.chips.map((chip) => `<span class="chip">${escapeHtml(chip.label)}<b>${chip.value}</b></span>`).join('')}
</div>
<main>
  <div class="tabs" id="tabs"></div>
  <div class="panel">
    <div class="bar">
      <input id="search" placeholder="在「当前页签」里搜索（名称 / 问题 / 要点 / 商品…）" />
      <span class="spacer"></span>
      <span class="status" id="status"></span>
      <button id="print">打印 / 存 PDF</button>
    </div>
    <div class="scroll"><table id="table"></table></div>
    <div class="bar"><button id="more" style="display:none">加载更多</button></div>
  </div>
</main>
<footer>提示：本页面是内容清单快照，只读；要改内容请改 <code>backend/src/db/seed-content.ts</code> 后重新生成。</footer>
<script>window.__CONTENT__ = ${JSON.stringify(data).replace(/</g, '\\u003c')};</script>
<script>${RUNTIME}</script>
</body>
</html>
`;
}

(async () => {
  const token = await login();
  const [backgrounds, contents, products, scripts, phrases, stylesRaw] = await Promise.all([
    fetchAll('/backgrounds', token),
    fetchAll('/contents', token),
    fetchAll('/products', token),
    fetchAll('/scripts', token),
    api('/phrases', token).then((d) => d.list || []),
    api('/styles', token),
  ]);
  const styles = Array.isArray(stylesRaw) ? stylesRaw : stylesRaw.list || [];

  const data = { backgrounds, contents, products, scripts, phrases, styles };
  const chips = [
    { label: '买家咨询背景', value: backgrounds.length },
    { label: '买家咨询内容', value: contents.length },
    { label: '商品', value: products.length },
    { label: '客户问题剧本', value: scripts.length },
    { label: '快捷短语', value: phrases.length },
    { label: '沟通风格', value: styles.length },
  ];
  const html = buildHtml(data, {
    api: API,
    generatedAt: new Date().toLocaleString('zh-CN'),
    chips,
  });
  fs.writeFileSync(OUT, html, 'utf8');

  const sizeKb = Math.round(fs.statSync(OUT).size / 1024);
  console.log(`内容库预览已生成：${path.relative(root, OUT)}（${sizeKb} KB）`);
  console.log(chips.map((c) => `${c.label} ${c.value}`).join(' / '));
  console.log(`打开方式：http://127.0.0.1:4180/docs/${encodeURIComponent('内容库预览.html')}，或直接双击该 HTML 文件。`);
})().catch((error) => {
  console.error(`生成失败：${error.message}`);
  console.error('请确认接口服务（3000）在跑：node tools/dev-api-memory.mjs');
  process.exitCode = 1;
});
