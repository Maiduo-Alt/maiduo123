#!/usr/bin/env node
/**
 * 部署配置自检：把 docker-compose.yml / Dockerfile / nginx 配置里的「引用」逐个对着仓库核对。
 *
 * 为什么需要它：本机跑的是内存库模式（tools/dev-api-memory.mjs），部署产物（镜像、compose、反代）
 * 平时根本不会被执行到；里面一个路径写错、脚本名改了、上游服务名对不上，只有真正上服务器那天才会炸。
 * 这个脚本把「能不能装配起来」变成一次可重复的静态核对（不需要 docker、不联网）。
 *
 * 用法：npm run deploy:check
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(root, rel));

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

/* ---------- 1. compose：服务、镜像构建、卷、端口 ---------- */

const compose = read('docker-compose.yml');

// build.dockerfile 指向的 Dockerfile 必须存在
const dockerfiles = [...compose.matchAll(/dockerfile:\s*(\S+)/g)].map((m) => m[1]);
check(
  'compose → Dockerfile 路径存在',
  dockerfiles.length > 0 && dockerfiles.every((f) => exists(f)),
  dockerfiles.map((f) => `${f}${exists(f) ? '✓' : '✗'}`).join('、')
);

// 挂载的宿主机路径：带扩展名的按「文件」要求必须存在；
// 不带扩展名的（backups/、uploads/）是运行期目录，Docker 会自动创建，只做提示不算失败。
const hostMounts = [...compose.matchAll(/-\s+\.\/([^\s:]+):/g)].map((m) => m[1]);
const fileMounts = hostMounts.filter((f) => /\.[a-z0-9]+$/i.test(f));
const dirMounts = hostMounts.filter((f) => !/\.[a-z0-9]+$/i.test(f));
check(
  'compose → 挂载的宿主配置文件存在',
  fileMounts.length > 0 && fileMounts.every((f) => exists(f)),
  fileMounts.map((f) => `${f}${exists(f) ? '✓' : '✗'}`).join('、') +
    (dirMounts.length ? `（目录挂载 ${dirMounts.join('、')} 由 Docker 自动创建）` : '')
);

// compose 里用到的服务名（反代的上游必须是 compose 里真实存在的服务）
const servicesBlock = (compose.split(/^services:\s*$/m)[1] || '').split(/^volumes:\s*$/m)[0];
const serviceNames = [...servicesBlock.matchAll(/^ {2}([a-z][\w-]*):$/gm)].map((m) => m[1]);
check('compose → 服务清单', serviceNames.length >= 4, serviceNames.join('、'));

const nginxConf = read('deploy/nginx.conf');
const upstreams = [...new Set([...nginxConf.matchAll(/proxy_pass\s+http:\/\/([\w-]+):(\d+)/g)].map((m) => m[1]))];
check(
  'nginx → 反代上游都在 compose 服务里',
  upstreams.every((u) => serviceNames.includes(u)),
  upstreams.map((u) => `${u}${serviceNames.includes(u) ? '✓' : '✗'}`).join('、')
);

// 端口：外层 nginx 暴露 8080，转发到 api 的 3000（compose 里 api 的 PORT=3000）
const apiPort = /PORT:\s*'?(\d+)'?/.exec(compose)?.[1];
const proxyPorts = [...new Set([...nginxConf.matchAll(/proxy_pass\s+http:\/\/[\w-]+:(\d+)/g)].map((m) => m[1]))];
check(
  'nginx → 反代端口与 api 的 PORT 一致',
  !!apiPort && proxyPorts.includes(apiPort),
  `api PORT=${apiPort}，反代端口 ${proxyPorts.join('/')}`
);
check(
  'compose → 暴露前端 8080（可用 .env 的 WEB_PORT 覆盖）',
  /\$\{WEB_PORT:-8080\}:80/.test(compose) || /'8080:80'|"8080:80"|8080:80/.test(compose),
  'nginx 服务映射 ${WEB_PORT:-8080}:80'
);

// WebSocket 反代（实时通道 /realtime）必须带 Upgrade 头
check(
  'nginx → /realtime 支持 WebSocket 升级',
  /location\s+\/realtime\//.test(nginxConf) && /Upgrade/.test(nginxConf) && /Connection/.test(nginxConf),
  'location /realtime/ + Upgrade/Connection 头'
);
check('nginx → /uploads/ 已反代（商品图/内容配图）', /location\s+\/uploads\//.test(nginxConf), '/uploads/ 反代到 api');

// 容器启动命令里的脚本：node dist/db/migrate.js → 源码 src/db/migrate.ts 必须存在，
// 并且编译产物（本机刚构建过）里也要有对应 js。
const composedCommands = [...compose.matchAll(/node (dist\/[\w./-]+\.js)/g)].map((m) => m[1]);
const commandOk = composedCommands.every((distPath) => {
  const srcPath = `backend/src/${distPath.replace(/^dist\//, '').replace(/\.js$/, '.ts')}`;
  return exists(`backend/${distPath}`) && exists(srcPath);
});
check(
  'compose → 启动命令的脚本存在（产物 + 源码）',
  composedCommands.length > 0 && commandOk,
  composedCommands.join(' → ')
);

/* ---------- 2. Dockerfile：COPY 源、npm 脚本、CMD ---------- */

const workspaceScripts = (ws) => {
  const pkg = JSON.parse(read(`${ws}/package.json`));
  return new Set(Object.keys(pkg.scripts || {}));
};
const rootPkg = JSON.parse(read('package.json'));

for (const dockerfile of dockerfiles) {
  const content = read(dockerfile);
  const label = path.basename(path.dirname(dockerfile));

  // COPY <src> ...（跳过 --from= 的多阶段拷贝）
  const copies = [...content.matchAll(/^COPY\s+(?!\-\-from=)([^\s]+)/gm)].map((m) => m[1]);
  const copyOk = copies.every((src) => exists(src.replace(/\*$/, '')));
  check(
    `${label}/Dockerfile → COPY 源存在`,
    copyOk,
    copies.map((c) => `${c}${exists(c.replace(/\*$/, '')) ? '✓' : '✗'}`).join('、')
  );

  // RUN npm run <script> -w <workspace>
  const runs = [...content.matchAll(/npm run ([\w:.-]+)(?:\s+-w\s+(\w+))?/g)];
  const runOk = runs.every(([, script, ws]) =>
    ws ? workspaceScripts(ws).has(script) : new Set(Object.keys(rootPkg.scripts || {})).has(script)
  );
  check(
    `${label}/Dockerfile → npm 脚本存在`,
    runs.length > 0 && runOk,
    runs.map(([, s, w]) => `${w ? `${w}:` : ''}${s}${(w ? workspaceScripts(w) : new Set(Object.keys(rootPkg.scripts || {}))).has(s) ? '✓' : '✗'}`).join('、')
  );

  // CMD ["node", "backend/dist/main.js"] → 产物必须真的构建出来过
  const cmd = /CMD\s+\[([^\]]+)\]/.exec(content);
  if (cmd) {
    const parts = cmd[1].split(',').map((p) => p.trim().replace(/^"|"$/g, ''));
    const target = parts[parts.length - 1];
    check(`${label}/Dockerfile → CMD 目标产物已构建`, exists(target), `${parts.join(' ')}（${exists(target) ? '存在' : '缺失，先 npm run build'}）`);
  }
}

/* ---------- 3. 与本地验证链的一致性 ---------- */

const composeEnv = (key) => new RegExp(`${key}:\\s*'?([^'\\n]+)'?`).exec(compose)?.[1]?.trim();
check(
  'compose → 用真实数据库（USE_PG_MEM=false）',
  composeEnv('USE_PG_MEM') === 'false',
  `USE_PG_MEM=${composeEnv('USE_PG_MEM')}`
);
check(
  'compose → 备份容器保留天数与方案一致（30 天）',
  composeEnv('BACKUP_KEEP') === `'30'` || composeEnv('BACKUP_KEEP') === '30',
  `BACKUP_KEEP=${composeEnv('BACKUP_KEEP')}`
);
check(
  'compose → JWT_SECRET 有占位提示（上线必须改）',
  // 现在写成 ${JWT_SECRET:-change-me-in-production}：可以用 .env 覆盖，缺省仍是占位值
  /JWT_SECRET:\s*\$\{JWT_SECRET:-change-me-in-production\}/.test(compose),
  'compose 用 ${JWT_SECRET:-change-me-in-production}，上线时用 .env 覆盖成随机串'
);

/* ---------- 4. 方案 5.10 的运维要求：worker / 健康检查 / 日志轮转 ---------- */

// worker 容器：复用 api 镜像、只跑后台任务（WORKER_ONLY），且不映射端口
check(
  'compose → worker 容器（方案 5.10：复用 api 镜像跑后台任务）',
  serviceNames.includes('worker') &&
    /worker:[\s\S]*?WORKER_ONLY:\s*'true'/.test(compose) &&
    /WORKER_ONLY/.test(read('backend/src/main.ts')),
  serviceNames.includes('worker') ? 'worker 服务 + WORKER_ONLY=true + main.ts 支持' : '缺少 worker 服务'
);

// 健康检查接口：方案 5.10 要求提供 /api/health；compose 的 api healthcheck 也要用它
const healthController = read('backend/src/modules/health/health.controller.ts');
check(
  '后端 → 健康检查接口 GET /api/health（方案 5.10）',
  /@Controller\('api\/health'\)/.test(healthController) && /@Public\(\)/.test(healthController),
  'health.controller.ts 存在且免登录（监控用）'
);
check(
  'compose → api 容器用 /api/health 做 healthcheck',
  /healthcheck:[\s\S]*?\/api\/health/.test(compose),
  'api 服务带 healthcheck（容器编排与监控据此判断存活）'
);

// 日志轮转：方案 5.10 要求日志按天滚动保留 30 天；这里核对每个长跑服务都配了轮转
const loggedServices = [...compose.matchAll(/max-file:\s*'(\d+)'/g)].map((m) => Number(m[1]));
check(
  'compose → 容器日志轮转（保留 30 份，方案 5.10）',
  loggedServices.length >= 4 && loggedServices.every((n) => n >= 30),
  `${loggedServices.length} 个服务配了 max-size/max-file，保留 ${[...new Set(loggedServices)].join('/')} 份`
);

/* ---------- 5. 免费云方案的两份材料（Render + 托管库 compose） ---------- */

const renderYaml = read('render.yaml');
check(
  'render.yaml → 用 backend/Dockerfile 构建、带 /api/health 健康检查',
  /dockerfilePath:\s*\.\/backend\/Dockerfile/.test(renderYaml) && /healthCheckPath:\s*\/api\/health/.test(renderYaml),
  'Render Blueprint（免费 Web Service）'
);
check(
  'render.yaml → 首次部署会 migrate + seed',
  /migrate\.js[\s\S]*seed\.js[\s\S]*main\.js/.test(renderYaml),
  'dockerCommand 串起 migrate → seed → main'
);
const managedCompose = read('deploy/compose.managed-db.yml');
const managedServices = [...managedCompose.matchAll(/^ {2}([a-z][\w-]*):$/gm)].map((m) => m[1]);
check(
  'compose.managed-db.yml → 只有 api/worker/web/nginx（库走外部托管）',
  ['api', 'worker', 'web', 'nginx'].every((s) => managedServices.includes(s)) &&
    !managedServices.includes('postgres') &&
    /\$\{DATABASE_URL:\?/.test(managedCompose),
  `服务：${managedServices.join('、')}`
);
check(
  '前端 → 支持 VITE_API_BASE（前后端分开部署时指向外部 API）',
  /VITE_API_BASE/.test(read('frontend/src/api/client.ts')) && /VITE_SOCKET_URL|API_BASE/.test(read('frontend/src/realtime.ts')),
  '构建时注入 VITE_API_BASE / VITE_SOCKET_URL 即可'
);

/* ---------- 输出 ---------- */

const failed = results.filter((r) => !r.ok);
results.forEach((r) => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(42)} ${r.detail}`));
console.log(`\n部署配置自检：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('提示：镜像装配无法在本机执行（未安装 docker），这里只核对「引用是否对得上」。');
}
process.exit(failed.length ? 1 : 0);
