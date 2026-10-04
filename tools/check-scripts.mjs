#!/usr/bin/env node
/**
 * 剧本库自检：核对运行中的服务里，剧本库的规模与覆盖是否均匀。
 *
 * 用法：
 *   npm run dev:api:mem        # 另开一个终端先把服务跑起来
 *   npm run scripts:check
 *
 * 关注点：
 * 1. 每条咨询内容产出的剧本数是否一致（不一致说明生成规则被破坏）；
 * 2. 每个买家背景是否都被用到且次数接近；
 * 3. 是否只关联了剧本范围内的商品类目；
 * 4. 是否存在重名剧本（背景简称撞车会导致带教无法区分）。
 *
 * 注意：统计的是「当前库里所有剧本」，会包含带教在界面上手动 / 批量生成的那些。
 * 想看内置基线，请用刚启动（刚 seed 完）的服务跑本检查。
 */
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3000';

const login = await (
  await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Admin@123' }),
  })
).json();
const token = login.data?.token || login.token;
const headers = { authorization: `Bearer ${token}` };
const get = async (path) => (await (await fetch(BASE + path, { headers })).json()).data;

const first = await get('/api/scripts?pageSize=100&page=1');
const total = first.total;
const rows = [];
for (let page = 1; rows.length < total && page <= Math.ceil(total / 100) + 2; page += 1) {
  const data = await get(`/api/scripts?pageSize=100&page=${page}`);
  rows.push(...(data.list || []));
}

const tally = (key) => {
  const map = new Map();
  for (const row of rows) map.set(row[key], (map.get(row[key]) || 0) + 1);
  return map;
};
const stats = (map) => {
  const values = [...map.values()];
  return { 不同取值: map.size, 最小: Math.min(...values), 最大: Math.max(...values) };
};

const products = (await get('/api/products?pageSize=100')).list;
const categoryOf = new Map(products.map((p) => [p.id, p.category]));
const categories = new Set();
for (const row of rows) for (const id of row.productIds || []) categories.add(categoryOf.get(id));

const rounds = rows.map((r) => r.rounds);
console.log('剧本总数 =', rows.length, '/ total =', total);
console.log('每条内容产出剧本数 =', JSON.stringify(stats(tally('qaTemplate'))));
console.log('每个背景被用次数 =', JSON.stringify(stats(tally('bgName'))));
console.log('风格分布 =', JSON.stringify(Object.fromEntries(tally('styleCode'))));
console.log('剧本轮数 =', Math.min(...rounds), '~', Math.max(...rounds));
console.log('关联商品类目 =', [...categories].join('、'));
console.log('需转接的剧本数 =', rows.filter((r) => (r.questionSeq || []).some((q) => q.needTransfer)).length);

const nameDup = new Map();
for (const row of rows) nameDup.set(row.name, (nameDup.get(row.name) || 0) + 1);
const dup = [...nameDup.entries()].filter(([, n]) => n > 1);
console.log('重名剧本 =', dup.length ? JSON.stringify(dup.slice(0, 5)) : '无');
