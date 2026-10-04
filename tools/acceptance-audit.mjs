#!/usr/bin/env node
/**
 * 验收进度核查：把方案里的每条功能点对到当前代码库的真实证据，产出 docs/验收进度.json。
 *
 * 用法：
 *   npm run progress          # 跑一次，打印摘要并写 JSON
 *   npm run progress:serve    # 起一个会自动刷新的看板（见 tools/progress-server.mjs）
 *
 * 判定口径（宁严勿松）：
 *   已实现 = 该条目挂的**全部**证据都能在代码库里找到；少一条就算「待补」并列出缺哪条。
 *   二期   = 方案标为二期的条目；如果代码里已经有完整证据，会额外标成「二期·已超前实现」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  ACCEPTANCE,
  API_SHAPE_EXCEPTIONS,
  CLIENT_OVERRIDES,
  CLIENT_REQUIREMENTS,
  EXCLUDED_ITEMS,
  ITEM_EVIDENCE,
  ITEM_NOTES,
  MODULE_EVIDENCE,
  NOT_REQUIRED,
  OPEN_QUESTIONS,
  PAGES,
  PERF_SECURITY,
  PLAN_PARAM_MAP,
} from './acceptance-manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const rel = (p) => path.join(root, p);
const exists = (p) => fs.existsSync(rel(p));
const readIfExists = (p) => (exists(p) ? fs.readFileSync(rel(p), 'utf8') : null);

const MODULE_NAMES = {
  F1: '在线模拟接待',
  F2: '模拟接待明细',
  F3: '客户问题剧本',
  F4: '商品库',
  F5: '案例收藏',
  F6: '回复模拟任务',
  F7: '沟通风格',
  F8: '账号',
};

/* ---------- 1. 从方案原文解析 F 编号清单（单一事实来源） ---------- */

function parsePlanItems() {
  const plan = readIfExists('docs/方案源稿.md') || '';
  const items = [];
  const line = /^\|\s*(F\d+-\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(一期|二期)\s*\|\s*$/gm;
  let match = line.exec(plan);
  while (match) {
    items.push({
      id: match[1],
      title: match[2].trim(),
      description: match[3].trim(),
      scope: match[4],
      module: match[1].split('-')[0],
    });
    match = line.exec(plan);
  }
  return items;
}

/* ---------- 2. 后端路由索引（controller 前缀 + 方法注解） ---------- */

function walk(dir, filter, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, acc);
    else if (filter(full)) acc.push(full);
  }
  return acc;
}

function buildRouteIndex() {
  const controllers = walk(rel('backend/src'), (p) => p.endsWith('.controller.ts'));
  const routes = new Set();
  for (const file of controllers) {
    const source = fs.readFileSync(file, 'utf8');
    const prefix = /@Controller\(([^)]*)\)/.exec(source);
    const base = prefix ? prefix[1].replace(/['"`]/g, '').trim() : '';
    const decorator = /@(Get|Post|Put|Delete|Patch)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g;
    let match = decorator.exec(source);
    while (match) {
      const method = match[1].toUpperCase();
      const sub = (match[2] || '').replace(/^\/+/, '');
      const full = `/${[base, sub].filter(Boolean).join('/')}`.replace(/\/+$/, '') || '/';
      routes.add(`${method} ${full}`);
      match = decorator.exec(source);
    }
  }
  return routes;
}

/* ---------- 3. 证据判定 ---------- */

function checkEvidence(evidence, ctx) {
  const { kind } = evidence;
  const raw = evidence.value;
  if (kind === 'file') {
    return { label: `文件 ${raw}`, ok: exists(raw), detail: exists(raw) ? '存在' : '缺失' };
  }
  if (kind === 'dir') {
    const files = walk(rel(raw), (p) => p.endsWith('.ts'));
    return { label: `目录 ${raw}`, ok: files.length > 0, detail: `${files.length} 个 ts 文件` };
  }
  if (kind === 'route') {
    const ok = ctx.routes.has(raw);
    return { label: `接口 ${raw}`, ok, detail: ok ? '已注册' : '未在后端 controller 中找到' };
  }
  if (kind === 'ui' || kind === 'test') {
    const [file, marker] = String(raw).split('#');
    const source = readIfExists(file);
    if (source === null) return { label: `${kind === 'ui' ? '页面' : '用例'} ${file}`, ok: false, detail: '文件缺失' };
    if (!marker) return { label: `${kind === 'ui' ? '页面' : '用例'} ${file}`, ok: true, detail: '存在' };
    const ok = source.includes(marker);
    return {
      label: `${kind === 'ui' ? '页面' : '用例'} ${file} → 关键字「${marker}」`,
      ok,
      detail: ok ? '命中' : '未命中该关键字',
    };
  }
  return { label: String(raw), ok: false, detail: `未知证据类型 ${kind}` };
}

/* ---------- 4. 内容库与用例规模（来自编译产物，运行期即可刷新） ---------- */

function readContentStats() {
  const compiled = rel('backend/dist/db/seed-content.js');
  if (!fs.existsSync(compiled)) {
    return { available: false, note: '未找到 backend/dist/db/seed-content.js，请先 npm run build -w backend' };
  }
  try {
    const seed = require(compiled);
    const qas = seed.QAS?.length ?? 0;
    const products = seed.PRODUCTS?.length ?? 0;
    const backgrounds = seed.BACKGROUNDS?.length ?? 0;
    const phrases = seed.PHRASES ?? [];
    const styles = seed.STYLES ?? [];
    const variants = seed.SCRIPT_VARIANTS_PER_CONTENT ?? 0;
    const totalVars = phrases.reduce((sum, item) => {
      const found = String(item.content || '').match(/\{[^{}\s]{1,32}\}/g) || [];
      return sum + new Set(found).size;
    }, 0);
    return {
      available: true,
      backgrounds,
      qas,
      products,
      phrases: phrases.length,
      phraseCategories: new Set(phrases.map((p) => p.category)).size,
      phrasesWithVariables: phrases.filter((p) => /\{[^{}\s]{1,32}\}/.test(String(p.content || ''))).length,
      phraseVariables: totalVars,
      styles: styles.length,
      styleRatioTotal: styles.reduce((sum, s) => sum + Number(s.ratio || 0), 0),
      scripts: qas * variants,
      scriptVariantsPerContent: variants,
      targets: [
        { name: '咨询内容', value: qas, target: 300, unit: '条' },
        { name: '商品', value: products, target: 100, unit: '个' },
        { name: '剧本', value: qas * variants, target: 500, unit: '个' },
      ],
    };
  } catch (error) {
    return { available: false, note: `读取内容库失败：${error.message}` };
  }
}

/**
 * 浏览器层自检结果：render-check / flow-check 每跑一次会把自己的结果合并进
 * docs/浏览器自检.json，这里读出来放到看板上，避免「浏览器层跑没跑」只能靠人记。
 */
function readBrowserChecks() {
  const file = rel('docs/浏览器自检.json');
  if (!fs.existsSync(file)) {
    return { available: false, note: '尚未跑过浏览器自检：npm run render:check / npm run flow:check' };
  }
  try {
    return { available: true, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    return { available: false, note: `浏览器自检结果读取失败：${error.message}` };
  }
}

function readTestScale() {
  const files = walk(rel('backend/test'), (p) => p.endsWith('.spec.ts') || p.endsWith('-spec.ts'));
  let cases = 0;
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    cases += (source.match(/\n\s*it\(/g) || []).length;
  }
  return { files: files.length, cases };
}

/* ---------- 5. 组装结果 ---------- */

/** 方案 7.2 接口清单 vs 真实注册的路由。 */
function checkApiContract(routes) {
  const plan = readIfExists('docs/方案源稿.md') || '';
  const section = (plan.split('## 7.3')[0].split('## 7.2')[1] || '');
  // 路径参数名不参与比较：方案写 {id}/{sid}，实现写 :id/:sessionId，视为同一个端点
  const canon = (path) => path.replace(/\{[^}]+\}/g, ':p').replace(/:[A-Za-z_][\w]*/g, ':p').replace(/\/+$/, '');
  const normalized = new Set([...routes].map((route) => {
    const [method, path] = route.split(' ');
    return `${method} ${canon(path)}`;
  }));
  // 例外表也按同一口径归一化，避免 /api/accounts/{id} 与 /api/accounts/:id 对不上
  const exceptions = new Map(
    Object.entries(API_SHAPE_EXCEPTIONS).map(([key, detail]) => {
      const [method, path] = key.split(' ');
      return [`${method} ${canon(path)}`, detail];
    })
  );
  const items = [];
  const line = /^\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*`?(\/api[^|`]*?)`?\s*\|\s*([^|]*?)\s*\|\s*$/gm;
  let match = line.exec(section);
  while (match) {
    const module = match[1].trim();
    const methods = match[2]
      .split('/')
      .map((m) => m.trim().toUpperCase())
      .filter(Boolean);
    const planPath = match[3].trim();
    const path = canon(planPath);
    const note = match[4].trim();
    const isPhase2 = note.includes('二期');
    for (const method of methods) {
      const key = `${method} ${path}`;
      // 「GET / POST / PUT / DELETE | /api/accounts」这种合并写法里，
      // PUT / DELETE 落到的是 /api/accounts/{id}
      const registered = normalized.has(key) || normalized.has(`${method} ${path}/:p`);
      const exception = exceptions.get(key) || exceptions.get(`${method} ${path}/:p`);
      items.push({
        module,
        method,
        path,
        planPath,
        note,
        phase2: isPhase2,
        ok: registered || Boolean(exception),
        implemented: registered,
        detail: registered ? '已注册' : exception ? `形态不同：${exception}` : '未实现',
      });
    }
    match = line.exec(section);
  }
  return {
    total: items.length,
    ok: items.filter((i) => i.ok).length,
    missing: items.filter((i) => !i.ok).map((i) => ({ module: i.module, method: i.method, path: i.path, note: i.note })),
    shapeDifferences: items.filter((i) => i.ok && !i.implemented).map((i) => ({ method: i.method, path: i.path, detail: i.detail })),
    items,
  };
}

/** 方案 10.3 默认参数总表 vs DEFAULT_PARAMS。 */
function checkParamContract() {
  const compiled = rel('backend/dist/domain/types.js');
  if (!fs.existsSync(compiled)) {
    return { available: false, note: '未找到 backend/dist/domain/types.js，请先编译后端', items: [], mismatched: 0 };
  }
  const { DEFAULT_PARAMS } = require(compiled);
  const norm = (value) => {
    if (Array.isArray(value)) return value.map(norm);
    if (value && typeof value === 'object') {
      return Object.keys(value)
        .sort()
        .reduce((acc, key) => ({ ...acc, [key]: norm(value[key]) }), {});
    }
    return value;
  };
  const items = PLAN_PARAM_MAP.map((row) => {
    const actual = row.code.includes('+')
      ? row.code.split('+').map((key) => DEFAULT_PARAMS[key])
      : DEFAULT_PARAMS[row.code];
    // 客户明确要求改过的参数：以客户值为准，偏差单独登记为「客户覆盖」
    const override = CLIENT_OVERRIDES[row.code];
    const expected = override ? override.value : row.value;
    const ok = JSON.stringify(norm(actual)) === JSON.stringify(norm(expected));
    return {
      plan: row.plan,
      code: row.code,
      expected,
      planValue: row.value,
      clientOverride: override ? override.reason : null,
      actual,
      ok,
    };
  });
  return {
    available: true,
    total: items.length,
    mismatched: items.filter((item) => !item.ok).length,
    overridden: items.filter((item) => item.clientOverride).length,
    items,
  };
}

export function runAudit() {
  const routes = buildRouteIndex();
  const ctx = { routes };
  const planItems = parsePlanItems();

  const modules = new Map();
  for (const item of planItems) {
    const explicit = ITEM_EVIDENCE[item.id];
    // 二期条目只认「条目级证据」：模块级默认证据不足以证明某条二期功能真的做了，
    // 否则会把「模块存在」误当成「这条功能已实现」。
    const evidenceList = explicit || (item.scope === '一期' ? MODULE_EVIDENCE[item.module] : []) || [];
    const evidence = evidenceList.map((entry) => checkEvidence(entry, ctx));
    const allOk = evidence.length > 0 && evidence.every((e) => e.ok);
    let status;
    // 业务方明确不做的条目单独一个状态：既不算已实现，也不再计入待办
    if (EXCLUDED_ITEMS[item.id]) status = 'excluded';
    else if (item.scope === '二期') status = allOk ? 'phase2-done' : 'phase2';
    else status = allOk ? 'done' : 'todo';
    const note =
      NOT_REQUIRED[item.id] ||
      EXCLUDED_ITEMS[item.id] ||
      ITEM_NOTES[item.id] ||
      (item.scope === '二期' && status === 'phase2' ? '方案列为二期，本版未见对应实现证据' : '');
    if (!modules.has(item.module)) {
      modules.set(item.module, {
        key: item.module,
        name: MODULE_NAMES[item.module] || item.module,
        items: [],
      });
    }
    modules.get(item.module).items.push({
      ...item,
      status,
      evidence,
      note,
      notRequired: Boolean(NOT_REQUIRED[item.id]),
    });
  }

  const moduleList = [...modules.values()].map((module) => {
    const phase1 = module.items.filter((item) => item.scope === '一期');
    const done = phase1.filter((item) => item.status === 'done').length;
    return {
      ...module,
      phase1Total: phase1.length,
      phase1Done: done,
      percent: phase1.length ? Math.round((done / phase1.length) * 100) : 100,
    };
  });

  const phase1Items = planItems.filter((item) => item.scope === '一期');
  const phase1Done = phase1Items.filter((item) => modules.get(item.module).items.find((i) => i.id === item.id).status === 'done');
  const phase2Items = planItems.filter((item) => item.scope === '二期');
  const phase2Done = phase2Items.filter(
    (item) => modules.get(item.module).items.find((i) => i.id === item.id).status === 'phase2-done'
  );
  // 业务方确认不做的条目：从「还需交付」的口径里剔除，但仍然登记在案
  const phase2Excluded = phase2Items.filter((item) => EXCLUDED_ITEMS[item.id]);

  const acceptance = ACCEPTANCE.map((group) => ({
    group: group.group,
    items: group.items.map((item) => {
      const evidence = item.evidence.map((entry) => checkEvidence(entry, ctx));
      return { ...item, evidence, ok: evidence.every((e) => e.ok) };
    }),
  }));

  // 方案外的客户新增需求：已实现的照常核证据，确认「不做」的只登记不判分
  const clientRequirements = CLIENT_REQUIREMENTS.map((item) => {
    const evidence = item.evidence.map((entry) => checkEvidence(entry, ctx));
    return {
      ...item,
      evidence,
      ok: item.status === 'skipped' ? true : evidence.length > 0 && evidence.every((e) => e.ok),
    };
  });

  const pages = PAGES.map((page) => {
    const uiReady = exists(page.ui);
    const routeReady = (readIfExists('frontend/src/App.tsx') || '').includes(`path="${page.route}"`);
    return { ...page, ok: uiReady && routeReady, uiReady, routeReady };
  });

  const verification = (() => {
    try {
      return JSON.parse(readIfExists('docs/验收证据.json') || 'null');
    } catch {
      return null;
    }
  })();

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      phase1Total: phase1Items.length,
      phase1Done: phase1Done.length,
      percent: phase1Items.length ? Math.round((phase1Done.length / phase1Items.length) * 1000) / 10 : 100,
      phase2Total: phase2Items.length,
      phase2Done: phase2Done.length,
      phase2Excluded: phase2Excluded.length,
      phase2Required: phase2Items.length - phase2Excluded.length,
      notRequiredIds: planItems.filter((item) => NOT_REQUIRED[item.id]).map((item) => item.id),
      todoIds: planItems
        .filter((item) => item.scope === '一期')
        .filter((item) => modules.get(item.module).items.find((i) => i.id === item.id).status !== 'done')
        .map((item) => item.id),
      acceptanceOk: acceptance.every((group) => group.items.every((item) => item.ok)),
      clientRequirementsDone: clientRequirements.filter((item) => item.status !== 'skipped' && item.ok).length,
      clientRequirementsTotal: clientRequirements.filter((item) => item.status !== 'skipped').length,
      pagesOk: pages.filter((page) => page.ok).length,
      pagesTotal: pages.length,
      routes: routes.size,
      ...readTestScale(),
    },
    modules: moduleList,
    acceptance,
    clientRequirements,
    perfSecurity: PERF_SECURITY,
    browserChecks: readBrowserChecks(),
    pages,
    content: readContentStats(),
    verification,
    contracts: {
      api: checkApiContract(routes),
      params: checkParamContract(),
    },
    remaining: {
      phase1Todo: planItems
        .filter((item) => item.scope === '一期')
        .filter((item) => modules.get(item.module).items.find((i) => i.id === item.id).status !== 'done'),
      phase2Todo: planItems
        .filter((item) => item.scope === '二期')
        .filter((item) => {
          const status = modules.get(item.module).items.find((i) => i.id === item.id).status;
          return status !== 'phase2-done' && status !== 'excluded';
        })
        .map((item) => ({
          ...item,
          note: modules.get(item.module).items.find((i) => i.id === item.id).note,
        })),
      excluded: phase2Items
        .filter((item) => EXCLUDED_ITEMS[item.id])
        .map((item) => ({ id: item.id, title: item.title, reason: EXCLUDED_ITEMS[item.id] })),
      notRequired: planItems
        .filter((item) => NOT_REQUIRED[item.id])
        .map((item) => ({ id: item.id, title: item.title, reason: NOT_REQUIRED[item.id] })),
      openQuestions: OPEN_QUESTIONS,
      envRequired: PERF_SECURITY.filter((item) => item.key === 'soak' || item.key === 'compat'),
    },
  };
}

/* ---------- 6. CLI ---------- */

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = runAudit();
  const outFile = rel('docs/验收进度.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));

  console.log(`方案条目：一期 ${result.summary.phase1Done}/${result.summary.phase1Total} 已实现（${result.summary.percent}%）`);
  console.log(
    `二期条目：${result.summary.phase2Done}/${result.summary.phase2Required} 已超前实现` +
      `（方案共 ${result.summary.phase2Total} 条，其中 ${result.summary.phase2Excluded} 条业务方确认不做）`
  );
  console.log(`页面：${result.summary.pagesOk}/${result.summary.pagesTotal} 就绪；后端路由 ${result.summary.routes} 条`);
  console.log(`用例：${result.summary.cases} 项（${result.summary.files} 个文件）`);
  if (result.browserChecks?.available) {
    const b = result.browserChecks;
    const fmt = (item) => (item ? `${item.passed}/${item.total}${item.ok ? '' : '（有失败）'}` : '未跑');
    console.log(`浏览器层自检：页面渲染 ${fmt(b.render)} / 交互流程 ${fmt(b.flow)}`);
  } else {
    console.log(`浏览器层自检：${result.browserChecks?.note || '未跑'}`);
  }
  if (result.content.available) {
    const c = result.content;
    console.log(`内容库：背景 ${c.backgrounds} / 内容 ${c.qas} / 商品 ${c.products} / 剧本 ${c.scripts} / 短语 ${c.phrases}（${c.phrasesWithVariables} 条含变量）/ 风格 ${c.styles}（占比合计 ${c.styleRatioTotal}%）`);
  }
  for (const module of result.modules) {
    const todo = module.items.filter((item) => item.status === 'todo').map((item) => item.id);
    console.log(`${module.key} ${module.name}：${module.phase1Done}/${module.phase1Total}${todo.length ? `  待补 ${todo.join(', ')}` : '  ✓'}`);
  }
  for (const group of result.acceptance) {
    const bad = group.items.filter((item) => !item.ok).map((item) => item.id);
    console.log(`${group.group}：${group.items.length - bad.length}/${group.items.length}${bad.length ? `  待补 ${bad.join(', ')}` : '  ✓'}`);
  }
  const crDone = result.clientRequirements.filter((item) => item.status !== 'skipped');
  const crBad = crDone.filter((item) => !item.ok);
  console.log(
    `客户新增需求：${crDone.length - crBad.length}/${crDone.length} 已实现` +
      `${crBad.length ? `，待补 ${crBad.map((i) => i.id).join(', ')}` : '  ✓'}` +
      `（另有 ${result.clientRequirements.length - crDone.length} 条客户确认不做）`
  );
  const api = result.contracts.api;
  console.log(
    `方案 7.2 接口清单：${api.ok}/${api.total} 已具备${api.missing.length ? `，未实现 ${api.missing.map((m) => `${m.method} ${m.path}`).join('、')}` : '  ✓'}`
  );
  if (api.shapeDifferences.length) {
    console.log(`  形态不同（有意）：${api.shapeDifferences.map((d) => `${d.method} ${d.path}`).join('、')}`);
  }
  const params = result.contracts.params;
  console.log(
    params.available
      ? `方案 10.3 默认参数：${params.total - params.mismatched}/${params.total} 与方案一致` +
        `${params.overridden ? `（其中 ${params.overridden} 项按客户要求覆盖）` : ''}` +
        `${params.mismatched ? '，有偏差' : '  ✓'}`
      : `方案 10.3 默认参数：${params.note}`
  );
  console.log(`已写入 ${path.relative(root, outFile)}`);
}
