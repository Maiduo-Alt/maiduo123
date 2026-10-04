# 腾讯云 CloudBase（云开发）部署指南

> 目标：用 **CloudBase 云托管（CloudBase Run）** 从 **GitHub 仓库** 构建并运行我们的后端 API，
> 前端放 **CloudBase 静态网站托管**，数据库用**外部 PostgreSQL**（CloudBase 自带数据库不是 PostgreSQL）。

## 0. 先明确三件事（避免走弯路）

| 项 | 结论 |
| --- | --- |
| CloudBase 自带数据库 | 不是 PostgreSQL（文档型/MySQL 系）→ **不能**直接给我们的后端用；必须外接 PostgreSQL |
| 外部 PostgreSQL 选谁 | Supabase 免费版（500MB，最省事）／腾讯云 PostgreSQL 低配或试用／自建 PG |
| 费用 | **静态网站托管有免费额度；云托管是按量计费（CPU/内存×时长）**，不是永久免费；想全免费请见 `deploy/FREE.md` 的 F1/F2 |
| 实时通道 | 云托管支持 WebSocket，我们的 `/realtime`（Socket.IO）可以直接用 |

## 1. 准备 GitHub 仓库

仓库里已经带了：`backend/Dockerfile`（多阶段构建，产物 `backend/dist`）、`.gitignore`（已排除 node_modules/dist/.env/release 等）。
在本机项目根目录执行（把 `<你的仓库地址>` 换成实际地址）：

```bash
git init
git add -A
git commit -m "在线模拟接待训练系统：初始提交（含 CloudBase/Render/compose 部署配置）"
git branch -M main
git remote add origin <你的仓库地址>
git push -u origin main
```

> 私有仓库也行，CloudBase 云托管授权 GitHub 后可以读私有仓库。

## 2. 建外部 PostgreSQL

**Supabase 免费版**（推荐，2 分钟）：
1. supabase.com 建项目 → 记下 **项目 ref** 与 **区域**（形如 `ap-southeast-2`）；
2. 连接串**用连接池地址**，形如：
   `postgresql://postgres.<ref>:密码@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=no-verify`
3. 改完先自检：`node tools/db-check.mjs "<连接串>"`，看到「数据库可用」再往下走。

**三个实测坑（2026-10-04）**

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `getaddrinfo ENOTFOUND db.<ref>.supabase.co` | 新项目不发布直连 DNS（IPv6-only） | 改用连接池 `aws-0-<region>.pooler.supabase.com` |
| `tenant/user postgres.<ref> not found` | 连接池用户名必须是 `postgres.<ref>` | 别写成 `postgres`；区域写错也会这样 |
| `SELF_SIGNED_CERT_IN_CHAIN` | pg 8.23 把 `sslmode=require` 当 verify-full，与 Node 24 兼容性差 | 用 `?sslmode=no-verify`（仍加密，不校验证书链） |

（用腾讯云 PostgreSQL 的话，把连接串换成它的内网/外网地址即可，注意云托管要能访问到。）

## 3. 建云托管服务（从 GitHub 部署）

CloudBase 控制台 → **云托管** → 新建服务：

| 配置项 | 填什么 |
| --- | --- |
| 服务名称 | `cs-training-api` |
| 代码源 | **GitHub** → 授权 → 选仓库与分支（`main`） |
| 构建方式 | Dockerfile |
| Dockerfile 路径 | `backend/Dockerfile` |
| 构建上下文 | `/`（仓库根，必须，因为 Dockerfile 要 COPY `package.json` 与 `backend/`） |
| 容器端口 | **3000** |
| 健康检查路径 | `/api/health` |
| 启动命令 | `sh -c "node backend/dist/db/migrate.js && node backend/dist/db/seed.js && node backend/dist/main.js"`（首次建表 + 灌内容库，之后每次部署重复执行也是幂等的） |
| 实例规格 | 最小档（0.25~0.5 核 / 512MB~1G 起） |
| 最小实例数 | 有访问即冷启动可设 0；要常驻设 1（费用按量） |

**环境变量**（在服务配置里加）：

| 变量 | 值 |
| --- | --- |
| `USE_PG_MEM` | `false` |
| `DATABASE_URL` | 第 2 步的连接串 |
| `JWT_SECRET` | 一串随机值（`openssl rand -hex 32`；**不要**用仓库里的占位值） |
| `UPLOAD_DIR` | `/app/uploads` |

> 云托管容器**没有持久卷**：上传的图片在重启/重新部署后会丢。要长期保留图片，请把图片改存对象存储
> （腾讯云 COS 或 CloudBase 存储），或改用 `deploy/FREE.md` 的 F2（一台小机 + 我们的 compose，带数据卷与每日备份）。

部署完成后，控制台会给出一个默认域名，先自测：
```bash
curl https://<云托管默认域名>/api/health
# {"code":0,...,"data":{"status":"ok","db":"up","memoryDb":false,...}}
```
`memoryDb` 必须是 `false` —— 说明接的是外部真库。

## 4. 前端放静态网站托管

```bash
cd frontend
VITE_API_BASE=https://<云托管默认域名> node ../node_modules/vite/bin/vite.js build
# 产物在 frontend/dist
```
CloudBase 控制台 → **静态网站托管** → 上传 `frontend/dist`（或用它的 GitHub 自动部署，构建命令
`npm run build -w frontend`、产物目录 `frontend/dist`，并在构建环境变量里加 `VITE_API_BASE=https://<云托管默认域名>`）。

打开静态托管的访问域名即可使用；前端会自动用 `VITE_API_BASE` 连后端，实时通道同源同地址。

## 5. 上线后要做的事

1. **改掉三个演示账号口令**（`admin/Admin@123`、`leader/Leader@123`、`agent/Agent@123`），可在《账号》页改；
2. `JWT_SECRET` 备份到你们的密钥管理里（换密钥会让所有人重新登录）；
3. 配监控告警：健康检查 URL 用 `https://<后端域名>/api/health`，判断 `"status":"ok"`；
4. 数据库备份：用 Supabase 控制台的自动备份，或在我们自己的小机上跑 `deploy/compose.managed-db.yml` 时的 backup 容器。

## 6. 排错

| 现象 | 原因/处理 |
| --- | --- |
| 健康检查一直是 `degraded`、`db=down` | `DATABASE_URL` 不对 / 缺少 `?sslmode=require` / 云托管出网被限（检查安全组与 NAT） |
| 部署成功但打开是 502 | 容器端口不是 3000（我们默认 `PORT=3000`）或健康检查路径写错 |
| 前端能打开但登录报网络错误 | `VITE_API_BASE` 没填或填错（要 https + 不带结尾斜杠），重新构建前端 |
| 图片上传后一会儿就丢 | 云托管无持久卷，见第 3 步的说明 |
