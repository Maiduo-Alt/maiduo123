# CloudBase + GitHub 上线操作卡（你点 / 我验证）

> 配套文档：`deploy/CLOUDBASE.md`（配置口径与排错表）、`deploy/FREE.md`（免费方案对比）。
> 分工：**浏览器里的注册/授权/控制台点击由你做**（我不能代注册或代登录）；推代码、验证、构建前端、排错由我做。

## 动手前先确认三件事
1. 腾讯云账号能登录，且 **云开发 CloudBase 已开通**（能进控制台看到「环境」）
2. GitHub 能登录（用来托管代码）
3. 一个邮箱（Supabase 注册用）

---

## 第 1 步 GitHub：建空仓库（2 分钟）

1. 打开 https://github.com/new
2. **Repository name**：`cs-training`（随意）
3. 可见性：Private / Public 都行（CloudBase 授权后私有仓库也能读）
4. **不要**勾 Add a README / .gitignore / license → 点 **Create repository**
5. 建好后复制仓库地址（形如 `https://github.com/你的用户名/cs-training.git`）

**推代码（二选一）**
- **A（省事）**：把仓库地址 + 一个临时 PAT 发我 → 我在这台机器上 push（本地已提交好 193 个文件）
- **B（自己来）**：PowerShell 执行
  ```powershell
  cd D:\codex工作区\在线模拟接待训练系统
  git remote add origin <你的仓库地址>
  git push -u origin main
  ```
✅ 成功标志：仓库首页能看到 `backend/`、`frontend/`、`deploy/`、`docker-compose.yml`

---

## 第 2 步 Supabase：建 PostgreSQL ✅ 已完成（2026-10-04 实测）

项目已建好，并且已在本机跑通「建表 + 灌数据」。**第 3 步直接用下面这串，不要再从控制台复制 URI。**

```
postgresql://postgres.cdbcdkddqhbsoommkipb:你的数据库密码@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres?sslmode=no-verify
```

项目档案：

| 项 | 值 |
| --- | --- |
| 项目名 | `Maiduo-Alt's Project`（组织 `cs-training`） |
| 项目 ref | `cdbcdkddqhbsoommkipb` |
| 区域 | Oceania (Sydney) `ap-southeast-2` / 规格 NANO |
| 版本 | PostgreSQL 17.11 |
| 已就绪 | 25 张表 + 商品 100 / 剧本 900 / 买家背景 32 / 素材 300 / 账号 4 |

**两个踩过的坑（照抄上面的连接串就不会遇到）**

1. **不要用控制台「Direct connection string」里的 `db.<ref>.supabase.co`**：新项目的该域名不发布记录，本机实测 `getaddrinfo ENOTFOUND`，连不上。必须走**连接池** `aws-0-<region>.pooler.supabase.com`。
2. **连接池的用户名是 `postgres.<ref>`，不是 `postgres`**；库名仍是 `postgres`。写成 `postgres` 会报 `tenant/user ... not found`。
3. **ssl 用 `sslmode=no-verify`**：`sslmode=require` 在 pg 8.23 + Node 24 下会报 `SELF_SIGNED_CERT_IN_CHAIN`（裸 TLS 校验其实是通的，是驱动层兼容问题）。`no-verify` 仍然全程加密，只是不校验证书链。

> 想换成腾讯云 PostgreSQL 或别的库时：把 `DATABASE_URL` 换掉即可，改完用
> `node tools/db-check.mjs "<新连接串>"` 先验一次，再重启服务。

⚠️ 免费版连接数上限 60：云托管「最小实例数」设 `1` 就够，别设大。
⚠️ 从国内连 Sydney 单次建连约 3~5 秒，**最小实例数建议设 1**，避免冷启动时健康检查超时。

---

## 第 3 步 CloudBase：建云托管服务（5 分钟）

1. https://console.cloud.tencent.com → 搜「云开发 CloudBase」→ 进控制台
2. 没有环境先 **新建环境**（按量付费；记下 **环境 ID** 与 **地域**，如 `ap-shanghai`）
3. 左侧 **云托管 → 新建服务**，按下表填：

| 配置项 | 填什么 |
| --- | --- |
| 服务名称 | `cs-training-api` |
| 代码源 | **GitHub** → 点授权（跳 GitHub 授权页 → Authorize）→ 选仓库 + 分支 `main` |
| 构建方式 | Dockerfile |
| Dockerfile 路径 | `backend/Dockerfile` |
| 构建上下文 / 根目录 | `/`（必须是仓库根，否则 COPY 不到 package.json） |
| 容器端口 | `3000` |
| 健康检查路径 | `/api/health` |
| 启动命令 | `sh -c "node backend/dist/db/migrate.js && node backend/dist/db/seed.js && node backend/dist/main.js"` |
| 实例规格 | 最小档（0.25 核 / 512MB 起） |
| 最小实例数 | `0`（省钱，首次访问冷启动；要给多人用设 1） |

4. **环境变量（4 条，逐条加）**

| 变量 | 值 |
| --- | --- |
| `USE_PG_MEM` | `false` |
| `DATABASE_URL` | 第 2 步那串（含 `?sslmode=no-verify`） |
| `JWT_SECRET` | 本地跑一次生成：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `UPLOAD_DIR` | `/app/uploads` |

5. 点 **部署 / 发布** → 看构建日志（首次 3~8 分钟：npm install → tsc → 构建镜像 → 启动）
6. 完成后复制控制台给的**默认域名**（形如 `https://xxx-xxxx.ap-shanghai.app.tcloudbase.com`）

---

## 第 4 步 交给我（这步你不用动手）

你把域名发我，我做两件事：
1. 验证后端：`https://<域名>/api/health` 必须是 `{"status":"ok","db":"up","memoryDb":false}`
2. 本地用 `VITE_API_BASE=https://<域名>` 构建前端，打成 zip 给你（省掉你手动构建）

---

## 第 5 步 前端静态托管（2 分钟）

1. CloudBase 控制台 → **静态网站托管** → 开通（有免费额度）
2. 上传我给你的前端产物（`dist` 整个目录，或 zip 解压后上传）
3. 打开静态托管给的访问域名 → 用 `admin/Admin@123` 登录

---

## 第 6 步 上线收尾（上线后必做）

- [ ] 《账号》页改掉三个演示账号口令（`admin` / `leader` / `agent`）
- [ ] `JWT_SECRET` 抄进你们的密钥管理（换密钥会让所有人重新登录）
- [ ] 确认备份：Supabase 控制台有自动备份；需要的话我给你一条导出命令
- [ ] 图片持久化：云托管**没有持久卷**，上传的商品图在重新部署后会丢；要长期使用请改存 COS / CloudBase 存储

---

## 常见报错对照

| 现象 | 原因与处理 |
| --- | --- |
| 健康检查 `db=down` | `DATABASE_URL` 写错 / 少了 `?sslmode=require` / 云托管出网被限 |
| 部署完成但访问 502 | 容器端口不是 3000，或健康检查路径写错 |
| 前端能开、登录报网络错误 | 构建前端时 `VITE_API_BASE` 没填或填错（重新构建） |
| 构建日志 npm install 超时 | 重试，或在云托管里配 npm 镜像源 |
| 上传图片过一会儿就丢 | 云托管无持久卷（见第 6 步） |
