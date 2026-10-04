#!/usr/bin/env node
/**
 * 内置内容库自检：校验 backend/src/db/seed-content.ts 的硬约束。
 *
 * 用法：
 *   npm run content:check          # 直接检查（会自动使用已编译的产物）
 *   npm run build -w backend && node tools/check-content.mjs
 *
 * 覆盖的约束（与 seed-content.ts 顶部的写作口径一一对应）：
 * 1. 每条咨询内容的 question_list 与 key_points 长度必须相等；
 * 2. 每组要点固定 2 个（允许 1～3 个，超出即报错），且都是非空短词；
 * 3. transferIdxs 必须落在问题序号范围内；
 * 4. 分类必须登记在 CATEGORY_SETS 中，避免筛选器里选不到；
 * 5. 名称、编码唯一；字段长度不超过数据库列宽；
 * 6. 沟通风格占比合计必须等于 100%。
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compiled = path.join(root, 'backend', 'dist', 'db', 'seed-content.js');

if (!fs.existsSync(compiled)) {
  console.error('未找到编译产物，请先执行: npm run build -w backend');
  process.exit(1);
}

const require = createRequire(import.meta.url);
const {
  BACKGROUNDS,
  CATEGORY_SETS,
  PHRASES,
  PRODUCTS,
  QAS,
  SCRIPT_SCOPE_CATEGORIES,
  SCRIPT_VARIANTS_PER_CONTENT,
  STYLES,
  isScriptInScope,
} = require(compiled);

const problems = [];
const fail = (msg) => problems.push(msg);

const len = (s) => [...String(s ?? '')].length;
const duplicates = (list) => {
  const seen = new Map();
  for (const item of list) seen.set(item, (seen.get(item) || 0) + 1);
  return [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
};

// ---- 1~3. 咨询内容 ----
for (const qa of QAS) {
  const name = qa.template_name;
  if (len(name) > 80) fail(`[内容] ${name}：template_name 超过 80 字`);
  if (len(qa.question) > 1000) fail(`[内容] ${name}：question 超过 1000 字`);
  if (len(qa.accepted_answer) > 1500) fail(`[内容] ${name}：accepted_answer 超过 1500 字`);
  if (!['presale', 'aftersale'].includes(qa.stage)) fail(`[内容] ${name}：stage 非法（${qa.stage}）`);
  if (!CATEGORY_SETS.qa.includes(qa.category)) fail(`[内容] ${name}：分类「${qa.category}」未登记在 CATEGORY_SETS.qa`);

  if (!qa.question_list?.length) fail(`[内容] ${name}：question_list 为空`);
  if (qa.question_list.length !== qa.key_points.length) {
    fail(`[内容] ${name}：问题 ${qa.question_list.length} 个，但要点只有 ${qa.key_points.length} 组（必须一一对应）`);
  }
  qa.key_points.forEach((group, i) => {
    if (!Array.isArray(group) || !group.length) {
      fail(`[内容] ${name}：第 ${i + 1} 组要点为空，该轮将退化为兜底要点「有效回应」`);
      return;
    }
    if (group.length > 3) {
      fail(`[内容] ${name}：第 ${i + 1} 组有 ${group.length} 个要点，全部命中才算解决，超过 3 个会过难`);
    }
    group.forEach((point) => {
      if (!String(point || '').trim()) fail(`[内容] ${name}：第 ${i + 1} 组含空要点`);
    });
  });
  for (const idx of qa.transferIdxs || []) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= qa.question_list.length) {
      fail(`[内容] ${name}：transferIdxs 含越界序号 ${idx}（问题共 ${qa.question_list.length} 个）`);
    }
  }
}
for (const dup of duplicates(QAS.map((q) => q.template_name))) fail(`[内容] 模板名重复：${dup}`);

// ---- 4. 素材背景 ----
for (const bg of BACKGROUNDS) {
  if (len(bg.name) > 80) fail(`[素材] ${bg.name}：name 超过 80 字`);
  if (len(bg.description) > 300) fail(`[素材] ${bg.name}：description 超过 300 字`);
  if (!CATEGORY_SETS.bg.includes(bg.category)) fail(`[素材] ${bg.name}：分类「${bg.category}」未登记在 CATEGORY_SETS.bg`);
}
for (const dup of duplicates(BACKGROUNDS.map((b) => b.name))) fail(`[素材] 背景名重复：${dup}`);

// ---- 5. 商品 ----
for (const p of PRODUCTS) {
  if (len(p.product_no) > 32) fail(`[商品] ${p.product_no}：product_no 超过 32 字`);
  if (len(p.title) > 160) fail(`[商品] ${p.product_no}：标题超过 160 字`);
  if (!CATEGORY_SETS.product.includes(p.category)) fail(`[商品] ${p.product_no}：分类「${p.category}」未登记在 CATEGORY_SETS.product`);
  if (!(p.price >= 0)) fail(`[商品] ${p.product_no}：price 非法`);
  if (!Array.isArray(p.skus) || !p.skus.length) fail(`[商品] ${p.product_no}：缺少 SKU`);
}
for (const dup of duplicates(PRODUCTS.map((p) => p.product_no))) fail(`[商品] 货号重复：${dup}`);

// ---- 6. 快捷短语 ----
for (const ph of PHRASES) {
  if (len(ph.title) > 64) fail(`[短语] ${ph.title}：title 超过 64 字`);
  if (len(ph.content) > 500) fail(`[短语] ${ph.title}：content 超过 500 字`);
  if (!ph.category) fail(`[短语] ${ph.title}：缺少分类`);
}

// ---- 7. 沟通风格 ----
for (const s of STYLES) {
  if (len(s.name) > 64) fail(`[风格] ${s.code}：name 超过 64 字`);
  if (len(s.description) > 300) fail(`[风格] ${s.code}：description 超过 300 字`);
  if (len(s.tone) > 300) fail(`[风格] ${s.code}：tone_sample 超过 300 字`);
}
for (const dup of duplicates(STYLES.map((s) => s.code))) fail(`[风格] 编码重复：${dup}`);
// 未填写占比的风格（ratio 为空）不参与默认分配，只校验已填写部分
const filledStyles = STYLES.filter((s) => typeof s.ratio === 'number' && s.ratio > 0);
const ratioSum = filledStyles.reduce((sum, s) => sum + Number(s.ratio), 0);
if (Math.abs(ratioSum - 100) > 0.01) {
  fail(`[风格] 已填写占比合计为 ${ratioSum}%（${filledStyles.length} 种），必须等于 100%`);
}

// ---- 8. 剧本生成范围 ----
for (const category of SCRIPT_SCOPE_CATEGORIES) {
  if (!CATEGORY_SETS.product.includes(category)) fail(`[范围] 剧本范围类目「${category}」不在 CATEGORY_SETS.product 中`);
}
if (!SCRIPT_SCOPE_CATEGORIES.length) fail('[范围] SCRIPT_SCOPE_CATEGORIES 为空，剧本将不会生成');

// 剧本规则：每条咨询内容生成 SCRIPT_VARIANTS_PER_CONTENT 个剧本（商品与背景轮转挑选）。
const pairTotal = BACKGROUNDS.length * QAS.length;
const scopeProductTotal = PRODUCTS.filter((p) => isScriptInScope(p.category)).length;
const variants = Math.min(SCRIPT_VARIANTS_PER_CONTENT, scopeProductTotal);
const scopedPairTotal = QAS.length * variants;
if (!scopedPairTotal) fail('[范围] 当前范围内没有任何「背景 × 内容」组合，剧本将不会生成');

const counts = {
  素材背景: BACKGROUNDS.length,
  咨询内容: QAS.length,
  商品: `${PRODUCTS.length}（其中范围内 ${scopeProductTotal}）`,
  快捷短语: PHRASES.length,
  沟通风格: STYLES.length,
  全部组合: pairTotal,
  当前范围预计剧本: scopedPairTotal,
};
console.log('剧本生成范围：', SCRIPT_SCOPE_CATEGORIES.join('、'));
console.log('内容库规模：', JSON.stringify(counts, null, 2));

if (problems.length) {
  console.error(`\n发现 ${problems.length} 个问题：`);
  for (const p of problems) console.error(' - ' + p);
  process.exit(1);
}
console.log('\n内容库自检通过：结构与字段约束全部满足。');
