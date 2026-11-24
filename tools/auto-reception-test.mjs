#!/usr/bin/env node
/**
 * 全自动 10 客户模拟接待验收脚本（支持 L1 / L2 / L3 / L4 并发接待）。
 *
 * 环境变量：
 *   BASE_URL       系统地址，例如 http://1.14.102.186:8080
 *   TEST_USERNAME  客服登录账号（默认 agent）
 *   TEST_PASSWORD  客服登录密码（默认 Agent@123）
 *   TEST_LEVEL     接待难度（默认 L2）
 *   TEST_SOURCE    free 或 task（默认 free）
 *   REPORT_PATH    可选，输出 Markdown 报告文件路径
 */
import fs from 'node:fs';

const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const USERNAME = process.env.TEST_USERNAME || 'agent';
const PASSWORD = process.env.TEST_PASSWORD || 'Agent@123';
const LEVEL = (process.env.TEST_LEVEL || 'L2').toUpperCase();
const SOURCE = process.env.TEST_SOURCE || 'auto';
const TASK_NAME = process.env.TEST_TASK_NAME || '';
const REPORT_PATH = process.env.REPORT_PATH || '';
const MAX_DURATION_MS = Number(process.env.MAX_DURATION_MS || 25 * 60 * 1000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status} 非 JSON 响应: ${text.slice(0, 200)}`);
  }
  if (!res.ok || (typeof json.code === 'number' && json.code !== 0)) {
    throw new Error(`API ${method} ${path} 失败 (HTTP ${res.status}, code=${json.code}): ${json.message || text.slice(0, 200)}`);
  }
  return json.data;
}

async function connectSocket(token) {
  let socket = null;
  let heartbeat = null;
  try {
    const { io } = await import('socket.io-client');
    socket = io(BASE_URL, { path: '/realtime', auth: { token }, transports: ['websocket'] });
    await new Promise((resolve) => {
      const guard = setTimeout(resolve, 6000);
      socket.on('reception.connected', () => { clearTimeout(guard); resolve(); });
      socket.on('connect_error', () => { clearTimeout(guard); resolve(); });
    });
    heartbeat = setInterval(() => {
      if (socket?.connected) socket.emit('client.ack', { at: Date.now() });
    }, 5000);
  } catch (err) {
    console.warn(`Socket.IO 连接降级（不影响 HTTP 轮询，但注意断线宽限）：${err.message}`);
  }
  return () => {
    if (heartbeat) clearInterval(heartbeat);
    if (socket) socket.disconnect();
  };
}

function getProductMaterialSummary(product) {
  if (!product) return { raw: '', cotton: null, hasPolyester: null, hasWash: false };
  const attrs = Array.isArray(product.attributes) ? product.attributes : [];
  const raw = [product.title || '', ...attrs.map((a) => `${a.name || ''}:${a.value || ''}`)].join('；');
  const cottonMatch = raw.match(/(?:含棉量|棉含量|棉占比|棉)[^\d]{0,4}(\d{1,3}(?:\.\d+)?)\s*[%％]|(\d{1,3}(?:\.\d+)?)\s*[%％]\s*棉/u);
  const cotton = cottonMatch ? Number(cottonMatch[1] ?? cottonMatch[2]) : /纯棉|全棉/u.test(raw) && !/仿|棉感/u.test(raw) ? 100 : null;
  const hasPolyester = /聚酯纤维|涤纶/u.test(raw) ? true : cotton === 100 ? false : null;
  const hasWash = /洗标|洗涤|机洗|手洗|干洗|水洗/u.test(raw);
  return { raw, cotton, hasPolyester, hasWash };
}

function generateReply(buyerText, session) {
  const q = String(buyerText || '').trim();
  const mat = getProductMaterialSummary(session.product);

  // 开场白 / 问候 / 商品链接
  if (session.seq === 0 || session.openerPending || /^(?:亲|你好|您好|在吗|有人在吗|请问在吗|https?:\/\/|商品链接|发个链接)/u.test(q) && q.length <= 28 && !/吗\S+/.test(q)) {
    return '您好亲，在的呢，请问这款商品有什么可以帮您解答的？';
  }
  // 1. 洗涤 / 机洗
  if (/机洗/u.test(q) && /可以|能|适合|支持/u.test(q)) {
    return '亲，这款商品详情页未明确标注是否支持机洗，稳妥起见不建议机洗，确认前建议冷水轻柔手洗，收到后以水洗标为准哦。';
  }
  // 2. 干洗
  if (/干洗/u.test(q)) {
    if (/要不要|需不需要|是否需要|用不用|需要|必须|要/u.test(q)) {
      return '亲，不需要专门干洗的，平时按水洗标要求冷水轻柔手洗即可。';
    }
    return '亲，商品详情页未明确标注是否允许干洗，建议收到后以水洗标说明为准，平时轻柔手洗即可。';
  }
  // 3. 晾晒
  if (/晾晒|晾干|晒干|暴晒|阴干/u.test(q)) {
    return '亲，洗后建议平铺或悬挂在阴凉通风处自然阴干，避免阳光直射暴晒哦。';
  }
  // 3b. 洗衣袋 / 水温 / 清洗方式
  if (/洗衣袋/u.test(q)) {
    return '亲，稳妥起见优先建议冷水轻柔手洗；如果收到后水洗标明确允许机洗，建议装入洗衣袋并选择轻柔模式清洗，减少勾丝变形哦。';
  }
  if (/水温|多少度|冷水|温水/u.test(q)) {
    return '亲，清洗时建议使用 30 度以下的冷水或常温水轻柔手洗，避免热水浸泡导致缩水或褪色哦。';
  }
  if (/怎么洗|怎么清洗|清洗方法|如何洗|怎样洗/u.test(q)) {
    return '亲，建议用 30 度以下冷水加中性洗涤剂轻柔手洗，深浅色分开，洗后阴凉通风处自然晾干，具体以收到后的水洗标为准哦。';
  }
  // 4. 注意事项 / 清洗打理
  if (/注意(?:事项|的地方|什么|的)|要注意|需要注意/u.test(q)) {
    if (/尺码|选码/u.test(q)) {
      return '亲，选码时建议量一下腰围和臀围，对照商品尺码表选择，喜欢宽松可以选大一码哦。';
    }
    return '亲，建议收到后先核对水洗标说明，平时冷水轻柔手洗、深浅色分开，阴凉通风处自然晾干，避免暴晒和高温熨烫哦。';
  }
  // 5. 含棉量
  if (/含棉|棉含量|棉的比例|棉占比|多少棉|棉成分/u.test(q)) {
    if (mat.cotton !== null) {
      return `亲，这款含棉量是 ${mat.cotton}% 哦，穿着亲肤舒适。`;
    }
    return '亲，这款商品详情页未单独标注具体含棉量数据，建议收到后查看衣服内侧水洗标确认哦。';
  }
  // 6. 是否聚酯纤维
  if (/聚酯纤维|涤纶/u.test(q)) {
    if (mat.hasPolyester === true) return '亲，是的，这款含有聚酯纤维面料，垂感好不易皱。';
    if (mat.hasPolyester === false) return '亲，这款不是聚酯纤维哦。';
    return '亲，商品详情页未单独标注是否含有聚酯纤维，建议收到后核对衣服水洗标成分哦。';
  }
  // 7. 舒适度 / 透气性
  if (/闷|不舒服|舒服|舒适|透气|扎人|刺痒|亲肤/u.test(q)) {
    return '亲，这款面料亲肤透气，上身清爽柔软不会闷热，也不扎人，穿着很舒服哦。';
  }
  // 8. 搭配：外套 + 鞋子
  if (/外套/u.test(q) && /鞋/u.test(q)) {
    return '亲，外套推荐搭配短款西装、针织开衫或风衣，鞋子搭小白鞋、乐福鞋或短靴都很百搭显气质哦。';
  }
  // 9. 搭配：外套颜色
  if (/外套|开衫|风衣|夹克|西装/u.test(q) && /颜色|色系|什么色/u.test(q)) {
    return '亲，推荐搭配米白色、卡其色或浅灰色外套，都很百搭显白又高级哦。';
  }
  // 10. 搭配：鞋子
  if (/鞋/u.test(q) && /搭|配|穿/u.test(q)) {
    return '亲，日常休闲推荐搭配小白鞋、帆布鞋或乐福鞋，舒适又百搭显腿长哦。';
  }
  // 11. 色差
  if (/色差|颜色差/u.test(q)) {
    return '亲，实物和详情页主图基本一致，因拍摄光线和屏幕显示差异可能有极细微色差，收到不合适支持退换哦。';
  }
  // 12. 买家秀 / 实拍图 / 视频
  if (/买家秀|实拍|视频|晒图|实物图/u.test(q)) {
    if (/哪里|在哪|怎么看|查看|位置/u.test(q)) {
      return '亲，买家秀可以在商品评价区选择晒图查看，实拍图和视频在商品详情页主图轮播里就能看到哦。';
    }
    return '亲，有的哦，商品评价区可以看买家秀晒图，详情页主图轮播也可以看实拍展示。';
  }
  // 13. 工艺：包边 / 锁边
  if (/包边|锁边/u.test(q)) {
    return '亲，这款内里采用精细包边锁边工艺处理，针脚扎实不易开线脱线；详情页未单独标注的细节收到后也可以检查确认哦。';
  }
  // 14. 工艺：走线
  if (/走线|缝线|车线|线头/u.test(q)) {
    return '亲，这款出厂前都经过严格质检，走线工整、针脚细密均匀，基本没有多余线头，您可以放心哦。';
  }
  // 15. 换货 / 换码
  if (/换货|换码|换.{0,4}码|能换吗|可以换吗/u.test(q)) {
    return '亲，支持的哦，我们支持 7 天无理由退换货，尺码不合适可以直接联系客服办理换码。';
  }
  // 16. 梨形 / 显瘦
  if (/梨形|微胖|胯宽/u.test(q)) {
    return '亲，这款采用高腰收腰 A 字版型，遮胯遮肉很显瘦，对梨形身材非常友好哦。';
  }
  // 17. 偏大 / 偏小
  if (/偏大|偏小|尺码.{0,4}(?:正|标准)|码数.{0,4}(?:正|标准)/u.test(q)) {
    return '亲，这款是标准正码，不偏大也不偏小，按您平时常穿的尺码选择就可以哦。';
  }
  // 18. 选码 / 穿什么码
  if (/尺码|选码|穿.{0,5}码|围度/u.test(q)) {
    if (/\d{3}\s*[/／]\s*\d{2,3}/u.test(q)) {
      return '亲，按您提供的身材数据建议选 S 码比较合身，喜欢偏宽松一点可以选 M 码，也可以对照商品尺码表腰臀围确认哦。';
    }
    return '亲，建议测量一下腰围和臀围，对照商品详情页尺码表选择，喜欢宽松一点可以选大一码哦。';
  }
  // 19. 物流查询路径
  if (/物流|快递/u.test(q) && /哪里|在哪|怎么查|查询|查看/u.test(q)) {
    return '亲，发货后您可以在订单详情页点击查看物流，就能凭快递单号实时跟踪物流进度哦。';
  }
  // 20. 到货时效
  if (/多久|几天|什么时候/u.test(q) && /收到|到货|送达|到达|能到/u.test(q)) {
    return '亲，发出后非偏远地区一般 2 到 3 天左右就能送达您手上哦。';
  }
  // 21. 现货与发货时效
  if (/现货|发货|发出|出库/u.test(q)) {
    return '亲，目前都是现货供应，下单付款后一般当天安排发出，最晚不超过 48 小时内发货哦。';
  }
  // 22. 物流停滞跟进
  if (/停滞|卡住|不动|跟进/u.test(q) && /物流|快递/u.test(q)) {
    return '亲，如果物流出现停滞或长时间未更新，随时联系在线客服，我们会第一时间帮您联系快递网点核实并催促派送哦。';
  }
  // 23. 优惠 / 支付 / 发票 / 运费 / 包装 / 修改订单
  if (/优惠|折扣|活动|优惠券/u.test(q)) {
    return '亲，下单时系统会自动匹配店铺当前可用的优惠活动和优惠券，具体优惠金额以提交订单结算页显示为准哦。';
  }
  if (/支付|付款方式/u.test(q)) {
    return '亲，下单时支持微信支付、支付宝和银行卡等平台常规支付方式，在收银台直接选择即可完成付款哦。';
  }
  if (/发票|开票/u.test(q)) {
    return '亲，支持开具电子发票的，下单时勾选开票或确认收货后在订单详情页申请开票，联系客服也可以协助处理哦。';
  }
  if (/运费|包邮/u.test(q)) {
    return '亲，店铺商品默认包邮发货（偏远地区以结算页运费显示为准），并赠送运费险，购物更放心哦。';
  }
  if (/包装/u.test(q)) {
    return '亲，发货时会采用防尘内袋加防水外包装袋严密打包，保护衣物运输途中不易弄脏损坏哦。';
  }
  if (/外套长度|包包|鞋跟/u.test(q)) {
    return '亲，通勤建议选过臀短款或中长款外套更利落显比例，配简约托特包或腋下包，鞋跟选 3-5 厘米中低跟舒适又显气质哦。';
  }
  if (/修改订单|改地址/u.test(q)) {
    return '亲，未发货前可以在订单详情页修改收货信息或联系客服帮您备注修改；已发出后需要联系客服协助拦截改址哦。';
  }
  // 24. 售后处理
  if (/售后|退货|退款|质量|瑕疵/u.test(q)) {
    return '亲，收到后如有任何质量问题，可以直接拍照联系在线客服，或在订单页面申请售后退换货处理，我们会第一时间为您解决。';
  }
  return '亲，这款商品详情页有完整参数与尺码说明，现货 48 小时内发货并支持 7 天无理由退换，有任何问题随时联系在线客服为您处理哦。';
}

const FETCH_LATEST_ONLY = process.env.FETCH_LATEST_ONLY === 'true';

function buildMarkdownReport(attemptNo, level, elapsedSec, result, taskInfo, detailData) {
  const sessions = result.sessions || [];
  const totalScore = Number(result.totalScore ?? 0);
  const conclusion = result.conclusion === 'pass' ? '达标' : '未达标';
  const totalTimeouts = sessions.reduce((sum, s) => sum + Number(s.timeoutCount ?? s.metrics?.timeoutCount ?? 0), 0);
  const avgList = sessions
    .map((s) => s.metrics?.avgResponseSec ?? s.avgResponseSec)
    .filter((v) => typeof v === 'number');
  const avgSec = avgList.length ? (avgList.reduce((a, b) => a + b, 0) / avgList.length).toFixed(1) : '—';
  const mins = Math.floor(elapsedSec / 60);
  const secs = elapsedSec % 60;

  const lines = [
    `# ${level} 难度 · 10 个客户全自动并发接待测试报告`,
    '',
    `> 会话编号：**${attemptNo}**`,
    `> 账号：${USERNAME} · 难度：${level}${taskInfo ? ` · 任务「${taskInfo.name}」` : ''} · 接待时长：${mins}分${secs}秒`,
    `> 结论：**总分 ${totalScore} 分（${conclusion}）** · 超时 **${totalTimeouts} 次** · 平均响应 **${avgSec} 秒** · 会话数 **${sessions.length}**`,
    '',
    '## 10 个客户接待明细',
    '',
    '| # | 买家 | 剧本场景 | 得分 | 首响 | 平均响应 | 超时 | 主要失分明细 |',
    '|---|---|---|---|---|---|---|---|',
  ];

  sessions.forEach((s, idx) => {
    const firstSec = s.metrics?.firstResponseSec;
    const avg = s.metrics?.avgResponseSec ?? s.avgResponseSec;
    const timeouts = s.timeoutCount ?? s.metrics?.timeoutCount ?? 0;
    const deductions = (s.deductions || [])
      .filter((d) => Number(d.points) > 0)
      .map((d) => `${d.reason}(-${d.points})`)
      .join('；') || '无失分（满分）';
    lines.push(`| ${idx + 1} | ${s.buyerName || s.id} | ${s.scriptName || '—'} | ${s.score ?? s.totalScore ?? '—'} | ${firstSec ?? '—'}s | ${avg ?? '—'}s | ${timeouts} | ${deductions} |`);
  });

  const nonPerfect = sessions.filter((s) => Number(s.score ?? s.totalScore ?? 0) < 100);
  if (nonPerfect.length && Array.isArray(detailData?.messages)) {
    lines.push('', '## 失分会话对话复盘', '');
    for (const s of nonPerfect) {
      const msgs = detailData.messages.filter((m) => Number(m.sessionId ?? m.session_id) === Number(s.id));
      lines.push(`### ${s.buyerName}（${s.scriptName || '—'}，${s.score ?? s.totalScore} 分）`);
      for (const m of msgs) {
        const rr = m.ruleResult || m.rule_result || {};
        const tag = m.sender === 'agent'
          ? ` [seq=${m.seq} resp=${m.responseSec ?? m.response_sec ?? '-'}s timeout=${m.isTimeout ?? m.is_timeout ?? false} src=${rr.replyAssessment?.source || '-'}/${rr.modelEvaluation?.decisionSource || '-'} status=${rr.replyAssessment?.status || '-'} reason=${rr.replyAssessment?.reason || '-'}]`
          : ` [seq=${m.seq}]`;
        lines.push(`- **${m.sender}**${tag}: ${String(m.content || '').replace(/\n/g, ' ')}`);
      }
      lines.push('');
    }
  }

  lines.push('');
  return lines.join('\n');
}

async function resolveStartBody(token) {
  if (SOURCE === 'free') return { body: { level: LEVEL, source: 'free' }, taskInfo: null };
  const tasks = await api('/api/tasks', { token }).catch(() => []);
  const list = Array.isArray(tasks) ? tasks : [];
  const matchesLevel = (t) => !Array.isArray(t.levels) || t.levels.length === 0 || t.levels.includes(LEVEL);
  const candidates = list.filter((t) => t.status === 'running' && matchesLevel(t));
  const preferred = (TASK_NAME ? candidates.find((t) => String(t.name || '').includes(TASK_NAME)) : null)
    || candidates[0]
    || list.find((t) => t.status === 'running')
    || list.find(matchesLevel);
  if (preferred) {
    console.log(`==> 自动匹配任务：id=${preferred.id} name="${preferred.name}" status=${preferred.status} levels=${JSON.stringify(preferred.levels)}`);
    return {
      body: { level: LEVEL, source: 'task', taskId: Number(preferred.id) },
      taskInfo: { id: Number(preferred.id), name: preferred.name },
    };
  }
  if (SOURCE === 'task') {
    throw new Error(`未找到分配给当前账号且包含 ${LEVEL} 的进行中任务`);
  }
  return { body: { level: LEVEL, source: 'free' }, taskInfo: null };
}

async function main() {
  console.log(`==> 登录 ${BASE_URL} (user=${USERNAME}, level=${LEVEL}, source=${SOURCE}, fetchLatestOnly=${FETCH_LATEST_ONLY})...`);
  const login = await api('/api/auth/login', { method: 'POST', body: { username: USERNAME, password: PASSWORD } });
  const token = login.token;

  if (FETCH_LATEST_ONLY) {
    const records = await api(`/api/records?level=${encodeURIComponent(LEVEL)}&page=1&pageSize=1`, { token });
    const latest = records?.list?.[0];
    if (!latest) throw new Error(`未找到 ${LEVEL} 的历史接待记录`);
    const result = await api(`/api/receptions/${latest.id}/result`, { token });
    const detail = await api(`/api/records/${latest.id}`, { token }).catch(() => null);
    const elapsedSec = latest.startedAt && latest.finishedAt
      ? Math.max(0, Math.round((Date.parse(latest.finishedAt) - Date.parse(latest.startedAt)) / 1000))
      : 0;
    const report = buildMarkdownReport(latest.attemptNo, LEVEL, elapsedSec, result, null, detail);
    console.log('\n' + report);
    if (REPORT_PATH) fs.writeFileSync(REPORT_PATH, report, 'utf8');
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n', 'utf8');
    return;
  }

  const closeSocket = await connectSocket(token);

  try {
    // 清理可能残留的进行中接待
    const current = await api('/api/receptions/current', { token }).catch(() => null);
    if (current?.attemptId) {
      console.log(`==> 发现未结束接待 attemptId=${current.attemptId}，先结束清理...`);
      await api(`/api/receptions/${current.attemptId}/finish`, { method: 'POST', token }).catch(() => {});
      await sleep(1000);
    }

    const levels = await api('/api/receptions/levels', { token });
    const targetLevel = levels.find((l) => l.code === LEVEL);
    if (!targetLevel?.unlocked) {
      throw new Error(`难度 ${LEVEL} 尚未解锁（当前解锁状态：${JSON.stringify(levels.map((l) => `${l.code}:${l.unlocked}`))}）`);
    }

    const { body: startBody, taskInfo } = await resolveStartBody(token);
    const startedAt = Date.now();
    const started = await api('/api/receptions', { method: 'POST', token, body: startBody });
    const attemptId = started.attemptId;
    const attemptNo = started.attemptNo;
    console.log(`==> 已开启 ${LEVEL} 接待：${attemptNo} (attemptId=${attemptId}, source=${startBody.source}, taskId=${startBody.taskId ?? '—'}, sessions=${started.sessions.length})`);

    const repliedLastBuyerMsgId = new Map();
    const closedSent = new Set();

    while (Date.now() - startedAt < MAX_DURATION_MS) {
      let snap;
      try {
        snap = await api(`/api/receptions/${attemptId}/snapshot`, { token });
      } catch (err) {
        if (String(err.message).includes('code=2002') || String(err.message).includes('已结束')) {
          console.log('==> 整局接待已全部结束并落库（code=2002）！');
          break;
        }
        throw err;
      }
      if (snap.attempt?.status === 'finished') {
        console.log('==> 整局接待已全部结束并落库！');
        break;
      }

      const messagesBySession = new Map();
      for (const m of snap.messages || []) {
        const list = messagesBySession.get(m.sessionId) || [];
        list.push(m);
        messagesBySession.set(m.sessionId, list);
      }

      const activeSessions = (snap.sessions || []).filter((s) =>
        ['serving', 'timeout', 'awaiting_agent_close'].includes(s.state)
      );

      for (const session of activeSessions) {
        if (session.timerPausedAt) continue;

        if (session.state === 'awaiting_agent_close') {
          if (!closedSent.has(session.sessionId)) {
            console.log(`  [Session ${session.sessionId} ${session.buyerName}] 发送收尾语并关闭`);
            try {
              await api(`/api/receptions/${attemptId}/sessions/${session.sessionId}/messages`, {
                method: 'POST',
                token,
                body: { content: '不客气亲，感谢您的咨询，祝您购物愉快，有需要随时联系我哦～', backgroundJudgment: true },
              });
              closedSent.add(session.sessionId);
              await sleep(300);
              await api(`/api/receptions/${attemptId}/sessions/${session.sessionId}/finish`, {
                method: 'POST',
                token,
              });
            } catch (err) {
              console.warn(`  [Session ${session.sessionId}] 收尾/关闭重试：${err.message}`);
            }
          }
          continue;
        }

        const msgs = messagesBySession.get(session.sessionId) || [];
        const buyerMsgs = msgs.filter((m) => m.sender === 'buyer');
        if (!buyerMsgs.length) continue;
        const lastBuyer = buyerMsgs[buyerMsgs.length - 1];
        if (repliedLastBuyerMsgId.get(session.sessionId) === lastBuyer.id) continue;

        // 收集自上一条客服有效回复之后的全部买家气泡
        let lastAgentIdx = -1;
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].sender === 'agent') { lastAgentIdx = i; break; }
        }
        const pendingBuyerText = msgs
          .slice(lastAgentIdx + 1)
          .filter((m) => m.sender === 'buyer')
          .map((m) => m.content)
          .join('\n') || lastBuyer.content;

        const reply = generateReply(pendingBuyerText, session);
        console.log(`  [Session ${session.sessionId} ${session.buyerName} seq=${session.seq}] 问: ${pendingBuyerText.replace(/\n/g, ' ')} => 答: ${reply.slice(0, 42)}...`);
        try {
          await api(`/api/receptions/${attemptId}/sessions/${session.sessionId}/messages`, {
            method: 'POST',
            token,
            body: { content: reply, backgroundJudgment: true },
          });
          repliedLastBuyerMsgId.set(session.sessionId, lastBuyer.id);
        } catch (err) {
          console.warn(`  [Session ${session.sessionId}] 发送失败待重试：${err.message}`);
        }
      }

      await sleep(800);
    }

    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    const result = await api(`/api/receptions/${attemptId}/result`, { token });
    const detail = await api(`/api/records/${attemptId}`, { token }).catch(() => null);
    const report = buildMarkdownReport(attemptNo, LEVEL, elapsedSec, result, taskInfo, detail);
    console.log('\n' + report);

    if (REPORT_PATH) {
      fs.writeFileSync(REPORT_PATH, report, 'utf8');
      console.log(`==> 报告已写入 ${REPORT_PATH}`);
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n', 'utf8');
    }
  } finally {
    closeSocket();
  }
}

main().catch((err) => {
  console.error(`自动接待测试失败：${err.message}`);
  process.exit(1);
});
