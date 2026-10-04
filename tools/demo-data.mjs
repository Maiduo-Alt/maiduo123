#!/usr/bin/env node
/**
 * 铺一份「可验收」的演示数据（幂等，重复跑不会重复造）：
 *   - 客服 3 局已结束接待（L1 / L2 / L3），每局对每个会话回一句再结束 → 明细 / 导出 / 成长曲线有数据
 *   - 带教 3 条案例（含 1 条走文件导入、带标签）→ 案例页有内容
 *   - 带教 1 个下发给「新人客服 A」的任务 → 首页「我的任务」与接待页任务卡有内容
 *
 * 用法：node tools/demo-data.mjs      （要求接口服务已在跑）
 * 内存库模式下重启接口会清空数据，重新跑一次这个脚本即可。
 */
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3000';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(`${path} -> ${json.code} ${json.message}`);
  return json.data;
}

const login = async (username, password) => (await call('/auth/login', { method: 'POST', body: { username, password } })).token;

/** 播种结束后要还原的「合计接待人数」设置（在 try/finally 里执行，避免中途失败把客户设置留在 2 人）。 */
let restoreLevelTotal = null;

const REPLIES = [
  '亲，您好，很高兴为您服务～我马上帮您核实一下，请稍等片刻。',
  '亲，非常抱歉给您带来不便，我这边立刻帮您处理，处理好第一时间回复您。',
];

/** 跑一局接待：进线后对每个会话回一句，然后结束整局。taskId 有值即走任务训练。 */
async function runReception(token, level, reply, taskId) {
  const running = await call('/receptions/current', { token });
  if (running) await call(`/receptions/${running.attemptId}/finish`, { method: 'POST', token, body: {} });

  const started = await call('/receptions', {
    method: 'POST',
    token,
    body: taskId ? { level, source: 'task', taskId } : { level, source: 'free' },
  });
  await sleep(3500);
  const snapshot = await call(`/receptions/${started.attemptId}/snapshot`, { token });
  /**
   * 客户 2026-10-03 C5：一局的「合计接待人数」可能大于「同时在线人数」，
   * 多出来的买家会以 pending（待接入）排队，要等有并发位才自动进线。
   * 这里只对已经进线的会话回复，pending 的跳过（否则接口会拒绝并让整段播种失败）。
   */
  const admitted = snapshot.sessions.filter((session) => session.state !== 'pending');
  let actionUsed = null;
  for (const session of admitted) {
    await call(`/receptions/${started.attemptId}/sessions/${session.sessionId}/messages`, {
      method: 'POST',
      token,
      body: { content: reply },
    });
    /**
     * 客户 2026-10-03：订单卡片上的平台侧操作会记一次业务动作。
     * 每局顺手点一个（按当前订单状态挑合法的那个），这样演示数据里就能看到业务动作的痕迹。
     */
    if (!actionUsed) {
      const stage = session.order?.stage;
      const code = stage === 'unpaid' ? 'urge_pay' : stage === 'unshipped' ? 'ship_goods' : 'logistics_card';
      try {
        await call(`/receptions/${started.attemptId}/sessions/${session.sessionId}/actions`, {
          method: 'POST',
          token,
          body: { action: code },
        });
        actionUsed = code;
      } catch (error) {
        console.log(`  · 业务动作未记录（${error.message}）`);
      }
    }
    await sleep(250);
  }
  if (actionUsed) console.log(`  · 已记录一次业务动作：${actionUsed}`);
  console.log(
    `  · attempt ${started.attemptId}：进线 ${admitted.length} 人 / 合计 ${snapshot.sessions.length} 人`
  );
  await call(`/receptions/${started.attemptId}/finish`, { method: 'POST', token, body: {} });
  return started.attemptId;
}

async function main() {
  const agent = await login('agent', 'Agent@123');
  const leader = await login('leader', 'Leader@123');
  const admin = await login('admin', 'Admin@123');

  /**
   * 演示数据用小口径：客户 2026-10-03 的默认「合计接待人数」是 10 人，
   * 播种时若按 10 人跑，每次都会造 10 个会话、总分被未接入的会话拉低，演示数据很难看。
   * 这里临时压到 2 人，跑完还原成原来的值（不动客户/管理员自己的设置）。
   */
  const before = (await call('/settings', { token: admin })).levelTotal || {};
  restoreLevelTotal = async () => {
    /* before 缺档位时回落到客户默认 10 人，避免把非法值写回系统参数 */
    const restored = {};
    for (const level of ['L1', 'L2', 'L3', 'L4']) {
      const value = Number(before[level]);
      restored[level] = Number.isFinite(value) && value > 0 ? value : 10;
    }
    await call('/settings', { method: 'PUT', token: admin, body: { levelTotal: restored } });
    console.log(`已还原合计接待人数设置：${JSON.stringify(restored)}`);
  };
  await call('/settings', { method: 'PUT', token: admin, body: { levelTotal: { L1: 2, L2: 2, L3: 2, L4: 2 } } });

  // 1) 带教跑两局自由练习（客户新增需求后只有管理员/主管能自由练习）
  const levels = ['L1', 'L2', 'L3'];
  for (let i = 0; i < 2; i += 1) {
    const attemptId = await runReception(leader, levels[i], REPLIES[i % REPLIES.length]);
    console.log(`✓ 带教自由练习 ${levels[i]} 已结束（attempt ${attemptId}）`);
  }

  // 2) 案例（按标题去重，重复跑不会造重复数据）
  const existing = new Set((await call('/cases?pageSize=200', { token: leader })).list.map((row) => row.title));
  const textCases = [
    {
      title: '物流三天未更新',
      text: '买家:快递三天没有更新了！\n客服:亲，非常抱歉，我马上帮您核实物流进度～\n买家:什么时候能给我答复？',
      shop: '官方旗舰店',
      stage: 'aftersale',
      tags: ['物流', '情绪-高'],
    },
    {
      title: '尺码推荐咨询',
      text: '买家:我165/50kg穿什么码\n客服:亲，建议您选 M 码，喜欢宽松可以拍大一码～',
      stage: 'presale',
      tags: ['商品'],
    },
  ];
  for (const item of textCases) {
    if (existing.has(item.title)) continue;
    await call('/cases/import/text', { method: 'POST', token: leader, body: item });
    console.log(`✓ 案例「${item.title}」已导入`);
  }
  if (!existing.has('文件导入示例')) {
    await call('/cases/import/file', {
      method: 'POST',
      token: leader,
      body: {
        title: '文件导入示例',
        fileName: 'case.csv',
        text: 'role,content\n买家,什么时候发货\n客服,亲，今天就会为您发出～',
        stage: 'presale',
        tags: ['发货'],
      },
    });
    console.log('✓ 案例「文件导入示例」已导入（走 CSV 适配器）');
  }

  // 3) 任务：下发给 agent（已存在同名任务就跳过）
  const taskName = '会员与物流场景强化训练';
  let tasks = await call('/tasks', { token: leader });
  let taskId = tasks.find((row) => row.name === taskName)?.id;
  if (!taskId) {
    const accounts = await call('/accounts', { token: leader });
    const agentId = accounts.list.find((row) => row.username === 'agent')?.id;
    const created = await call('/tasks', {
      method: 'POST',
      token: leader,
      body: {
        name: taskName,
        levels: ['L1', 'L2', 'L3'],
        targetCount: 3,
        startAt: new Date().toISOString(),
        deadline: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
        assignees: [agentId],
        scopeType: 'all',
        targets: [{ metric: 'total_score', operator: 'gte', threshold: 80 }],
      },
    });
    taskId = created.id;
    console.log(`✓ 任务「${taskName}」已下发给新人客服 A`);
  }

  // 4) 客服走任务训练（客户新增需求后这是客服唯一的训练入口）
  // 方案 4.4：难度逐步解锁——客服默认只有 L1，要在演示里跑 L2 得先由带教开放难度。
  // 这里顺便把「带教为客服开放难度」这条通道也演一遍（界面上在《账号》页有同名入口）。
  {
    const accounts = await call('/accounts', { token: leader });
    const agentId = accounts.list.find((row) => row.username === 'agent')?.id;
    if (agentId) {
      await call(`/accounts/${agentId}/unlock-levels`, { method: 'POST', token: leader, body: { levels: ['L2'] } });
      console.log('✓ 带教已为新人客服 A 开放 L2 难度');
    }
  }
  for (const level of ['L1', 'L2']) {
    const attemptId = await runReception(agent, level, REPLIES[0], taskId);
    console.log(`✓ 客服任务训练 ${level} 已结束（attempt ${attemptId}）`);
  }

  // 汇总
  const records = await call('/records?pageSize=5', { token: agent });
  const cases = await call('/cases', { token: admin });
  const reminderCount = (await call('/tasks/reminders', { token: agent })).items.length;
  console.log(`\n演示数据就绪：明细 ${records.total} 条、案例 ${cases.total} 条、待催办任务 ${reminderCount} 个`);
  console.log('打开 http://127.0.0.1:4173/ 开始验收（账号见 docs/验收指引.md）');

}

main()
  .catch((error) => {
    console.error('铺演示数据失败：', error.message);
    console.error('请确认接口服务在跑：npm run dev:api:mem');
    process.exitCode = 1;
  })
  .finally(async () => {
    if (restoreLevelTotal) {
      await restoreLevelTotal().catch((error) => console.error('还原合计接待人数失败：', error.message));
    }
  });
