import bcrypt from 'bcryptjs';
import { DbService } from './db.service';
import { loadEnv } from './env';
import { runMigrations } from './migrate';
import { DEFAULT_PARAMS } from '../domain/types';
import { allocateStyles, normalizeRatios } from '../domain/style-ratio';
import { createRng } from '../domain/rng';
import {
  BACKGROUNDS,
  BUILTIN_QA_BY_NAME,
  CATEGORY_SETS,
  PHRASES,
  PRODUCTS,
  QAS,
  SCRIPT_VARIANTS_PER_CONTENT,
  STYLES,
  isScriptInScope,
} from './seed-content';
import { buildQuestionSeq } from '../domain/question-seq';
import { isProductCompatibleWithQuestions } from '../domain/product-consistency';
import { extractVariables } from '../domain/phrase-vars';

export async function runSeed(db: DbService): Promise<{ products: number; backgrounds: number; contents: number; scripts: number }> {
  await runMigrations(db);

  // 角色
  await db.query(
    `INSERT INTO roles (code, name, permission_json) VALUES
      ('admin','管理员','["*"]'::jsonb),
      ('leader','主管','["reception","records:all","materials","scripts","tasks","cases"]'::jsonb),
      ('agent','客服','["reception","records:self"]'::jsonb)
     ON CONFLICT (code) DO NOTHING`
  );

  // 小组
  const existingGroup = await db.one<{ id: number }>(`SELECT id FROM groups WHERE name = $1`, ['新人一组']);
  const groupId = existingGroup ? existingGroup.id : (await db.one<{ id: number }>(`INSERT INTO groups (name) VALUES ($1) RETURNING id`, ['新人一组'])).id;

  // 账号
  const adminPwd = bcrypt.hashSync(process.env.BOOTSTRAP_ADMIN_PASSWORD || 'Admin@123', 10);
  const leaderPwd = bcrypt.hashSync('Leader@123', 10);
  const agentPwd = bcrypt.hashSync('Agent@123', 10);
  const accounts = [
    { username: process.env.BOOTSTRAP_ADMIN_USERNAME || 'admin', name: '系统管理员', role: 'admin', pwd: adminPwd, group: groupId },
    { username: 'leader', name: '带教组长', role: 'leader', pwd: leaderPwd, group: groupId },
    { username: 'agent', name: '新人客服 A', role: 'agent', pwd: agentPwd, group: groupId },
    { username: 'agent2', name: '新人客服 B', role: 'agent', pwd: agentPwd, group: groupId },
  ];
  for (const a of accounts) {
    await db.query(
      // password_changed_at 给个初始值，避免刚建好的账号一登录就被判定「密码过期」
      `INSERT INTO accounts (username, password_hash, display_name, employee_no, role_code, group_id, password_changed_at)
       VALUES ($1,$2,$3,$4,$5,$6, now()) ON CONFLICT (username) DO NOTHING`,
      [a.username, a.pwd, a.name, `E${1000 + Math.floor(Math.random() * 8999)}`, a.role, a.group]
    );
  }

  // 系统参数
  const paramRow = await db.one(`SELECT id FROM app_params LIMIT 1`);
  if (!paramRow) {
    await db.query(`INSERT INTO app_params (value, version) VALUES ($1::jsonb, 1)`, [JSON.stringify(DEFAULT_PARAMS)]);
  }

  // 分类
  for (const type of ['bg', 'qa', 'script', 'product'] as const) {
    const names = CATEGORY_SETS[type];
    for (let i = 0; i < names.length; i += 1) {
      const exists = await db.one(`SELECT id FROM categories WHERE type=$1 AND name=$2`, [type, names[i]]);
      if (!exists) await db.query(`INSERT INTO categories (type, name, sort) VALUES ($1,$2,$3)`, [type, names[i], i]);
    }
  }

  // 沟通风格
  for (let i = 0; i < STYLES.length; i += 1) {
    const s = STYLES[i];
    await db.query(
      `INSERT INTO styles (code, name, description, tone_sample, emotion_base, ratio, is_emotional, is_builtin, sort)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8) ON CONFLICT (code) DO NOTHING`,
      [s.code, s.name, s.description, s.tone, s.emotion, s.ratio, s.emotional, i]
    );
  }
  // 占比自愈：老库已有基础风格时，新增内置风格会让总占比超过 100%，
  // 这里按比例缩放回 100%，避免风格页因占比校验失败而打不开。
  const styleRatioSum = await db.one<{ sum: string }>(
    `SELECT COALESCE(sum(ratio), 0)::text AS sum FROM styles WHERE ratio IS NOT NULL`
  );
  if (Number(styleRatioSum.sum) > 100) {
    await db.query(
      `UPDATE styles SET ratio = round(ratio * 100.0 / $1::numeric, 2) WHERE ratio IS NOT NULL`,
      [Number(styleRatioSum.sum)]
    );
  }
  const styleRows = await db.many<{ id: number; code: string; ratio: string; is_emotional: boolean }>(`SELECT id, code, ratio, is_emotional FROM styles ORDER BY sort`);
  const styleByCode = new Map(styleRows.map((s) => [s.code, s]));

  // 商品
  for (const p of PRODUCTS) {
    await db.query(
      `INSERT INTO products (product_no, title, cover_url, price, stock, skus, services, scenes, category, status)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,1) ON CONFLICT (product_no) DO NOTHING`,
      [p.product_no, p.title, '', p.price, p.stock, JSON.stringify(p.skus), JSON.stringify(p.services), JSON.stringify(p.scenes), p.category]
    );
  }
  const productRows = await db.many<{ id: number; category: string }>(`SELECT id, category FROM products ORDER BY id`);

  // 买家咨询背景 / 内容
  for (const bg of BACKGROUNDS) {
    const exists = await db.one(`SELECT id FROM buyer_bg WHERE name=$1`, [bg.name]);
    if (!exists) await db.query(`INSERT INTO buyer_bg (name, description, category) VALUES ($1,$2,$3)`, [bg.name, bg.description, bg.category]);
  }
  for (const qa of QAS) {
    const exists = await db.one(`SELECT id FROM buyer_qa WHERE template_name=$1`, [qa.template_name]);
    if (!exists) {
      await db.query(
        `INSERT INTO buyer_qa (template_name, question, question_list, accepted_answer, key_points, stage, category)
         VALUES ($1,$2,$3::jsonb,$4,$5::jsonb,$6,$7)`,
        [qa.template_name, qa.question, JSON.stringify(qa.question_list), qa.accepted_answer, JSON.stringify(qa.key_points), qa.stage, qa.category]
      );
    }
  }

  // 剧本：在剧本范围内按「内容 × 变体」生成，买家背景与商品轮转挑选，风格按占比分配
  const bgRows = await db.many<{ id: number; name: string }>(`SELECT id, name FROM buyer_bg ORDER BY id`);
  const qaRows = await db.many<{ id: number; template_name: string; stage: string; question_list: string[]; key_points: string[][] }>(
    `SELECT id, template_name, stage, question_list, key_points FROM buyer_qa ORDER BY id`
  );
  const existingScriptCount = await db.one<{ count: string }>(`SELECT count(*)::text AS count FROM scripts`);
  let createdScripts = 0;
  if (Number(existingScriptCount.count) === 0) {
    // 剧本范围：只为 SCRIPT_SCOPE_CATEGORIES 内的商品生成剧本。
    // 规则：每条咨询内容生成 SCRIPT_VARIANTS_PER_CONTENT 个剧本，
    // 商品与买家背景都按序号轮转挑选，保证同一内容下背景与商品都不重复、
    // 且各背景被用到的次数大体均衡。剧本总数只随内容量线性增长。
    const scopeProducts = productRows.filter((p) => isScriptInScope(p.category));
    const variants = Math.min(SCRIPT_VARIANTS_PER_CONTENT, scopeProducts.length);
    const scopedPairs: { bg: { id: number; name: string }; qa: typeof qaRows[number]; productId: number }[] = [];
    /** 客户 2026-10-03：一条内容都没有兼容商品时跳过，并记下来（不允许把不匹配的商品配给内容）。 */
    const skippedByConsistency: string[] = [];
    for (let c = 0; c < qaRows.length && bgRows.length; c += 1) {
      /**
       * 商品必须与**这条内容的问题**兼容：内容里出现尺码/面料这类词，就只能配服饰类商品；
       * 出现鞋码就只能配鞋靴；通用问题（价格/物流/订单…）任何品类都行。
       * 判定函数与接待抽剧本时的兜底过滤、以及一致性用例共用同一套规则。
       */
      const questions = (qaRows[c].question_list as unknown as string[]) || [];
      const compatibleProducts = scopeProducts.filter((p) =>
        isProductCompatibleWithQuestions(p.category, questions)
      );
      if (!compatibleProducts.length) {
        skippedByConsistency.push(qaRows[c].template_name);
        continue;
      }
      for (let k = 0; k < variants; k += 1) {
        const cursor = c * variants + k;
        scopedPairs.push({
          bg: bgRows[cursor % bgRows.length],
          qa: qaRows[c],
          productId: compatibleProducts[cursor % compatibleProducts.length].id,
        });
      }
    }
    if (skippedByConsistency.length) {
      console.warn(
        `[seed] 有 ${skippedByConsistency.length} 条内容没有兼容品类的商品，已跳过（避免"问题与商品不一致"）：` +
          skippedByConsistency.slice(0, 3).join('、')
      );
    }

    const ratios = normalizeRatios(styleRows.map((s) => ({ code: s.code, ratio: Number(s.ratio) })));
    const styleSeq = allocateStyles(ratios, scopedPairs.length, createRng(20261001));

    let index = 0;
    for (const pair of scopedPairs) {
      const styleCode = styleSeq[index] || 'friendly';
      const style = styleByCode.get(styleCode);
      const seq = buildQuestionSeq(
        {
          question_list: pair.qa.question_list as unknown as string[],
          key_points: pair.qa.key_points as unknown as string[][],
          stage: pair.qa.stage,
          transferIdxs: BUILTIN_QA_BY_NAME.get(pair.qa.template_name)?.transferIdxs,
        },
        DEFAULT_PARAMS.levelRounds
      );
      const stageName = pair.qa.stage === 'aftersale' ? '售后' : '售前';
      // 背景名形如「使用场景：出差/旅行/外出」，取冒号后的部分做简称：
      // 前 8 条背景里有大量相同前缀（如 8 条「使用场景：」），取前缀会导致剧本重名。
      const bgShort = pair.bg.name.replace(/^[^：:]*[：:]/, '');
      const name = `${stageName}-${bgShort}-${pair.qa.template_name}`;
      const scriptNo = `SC20261001-${String(index + 1).padStart(4, '0')}`;
      await db.query(
        `INSERT INTO scripts (script_no, name, category, stage, bg_id, qa_id, style_id, product_ids, question_seq, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,1,1) ON CONFLICT (script_no) DO NOTHING`,
        [scriptNo, name, '培训', pair.qa.stage, pair.bg.id, pair.qa.id, style.id, JSON.stringify([pair.productId]), JSON.stringify(seq)]
      );
      createdScripts += 1;
      index += 1;
    }
  }

  // 快捷短语
  const phraseCount = await db.one<{ count: string }>(`SELECT count(*)::text AS count FROM phrases`);
  if (Number(phraseCount.count) === 0) {
    for (const p of PHRASES) {
      // variables 由内容里的 {变量} 占位符推导，保证与内容始终一致
      await db.query(`INSERT INTO phrases (category, title, content, variables) VALUES ($1,$2,$3,$4::jsonb)`, [
        p.category,
        p.title,
        p.content,
        JSON.stringify(extractVariables(p.content)),
      ]);
    }
  }

  // 解锁进度：L1 默认开放
  const agentRows = await db.many<{ id: number }>(`SELECT id FROM accounts WHERE role_code = 'agent'`);
  for (const a of agentRows) {
    for (const level of ['L1', 'L2', 'L3', 'L4']) {
      const exists = await db.one(`SELECT id FROM unlock_progress WHERE account_id=$1 AND level=$2`, [a.id, level]);
      if (!exists) {
        await db.query(`INSERT INTO unlock_progress (account_id, level, streak, unlocked) VALUES ($1,$2,0,$3)`, [a.id, level, level === 'L1']);
      }
    }
  }

  return {
    products: PRODUCTS.length,
    backgrounds: BACKGROUNDS.length,
    contents: QAS.length,
    scripts: createdScripts,
  };
}

async function main(): Promise<void> {
  loadEnv();
  const db = new DbService();
  try {
    const stats = await runSeed(db);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ message: '[seed] 初始化完成', ...stats }, null, 2));
  } finally {
    await db.onModuleDestroy();
  }
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[seed] 失败:', err.message);
    process.exit(1);
  });
}
