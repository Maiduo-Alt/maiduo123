# 免费云部署方案（三选一）
#
# 目标：不花钱把这套系统跑成"能对外访问"的形态。
# 前提回顾：后端是 NestJS 常驻进程 + PostgreSQL（Redis 可选），
#          所以"纯 Serverless 平台（微信云开发 / 腾讯云开发免费版）"跑不了我们的 API —— 它们不给 PostgreSQL。
#
# ─────────────────────────────────────────────────────────────
# 方案 F1【推荐：全免费组合】托管 Postgres + 免费容器 + 免费静态托管
# ─────────────────────────────────────────────────────────────
#   Supabase 免费版（PostgreSQL 500MB）   ← 数据库
#   Render 免费 Web Service（512MB, Docker）← 跑我们的 API（含 /api/health，仓库里有 render.yaml）
#   Cloudflare Pages / Netlify 免费额度    ← 托管前端静态产物
#
# 步骤：
#   1) Supabase 建项目 → 控制台 Settings → Database 拿连接串（形如
#      postgresql://postgres:<pwd>@db.<ref>.supabase.co:5432/postgres），末尾补 ?sslmode=require
#   2) 仓库推到 GitHub → Render: New → Blueprint → 选仓库（自动读 render.yaml）→
#      在环境变量里填 DATABASE_URL（上一步的连接串）；JWT_SECRET 由 Render 自动生成
#   3) 首次部署会执行 migrate → seed → main（见 render.yaml 的 dockerCommand），
#      部署完访问 https://<你的服务>.onrender.com/api/health 应返回 "status":"ok","db":"up","memoryDb":false
#   4) 前端：本机构建时注入 API 地址（前端已支持 VITE_API_BASE）
#        cd frontend
#        VITE_API_BASE=https://<你的服务>.onrender.com node ../node_modules/vite/bin/vite.js build
#      把 frontend/dist 拖到 Cloudflare Pages（或 Netlify）即可；实时通道会自动用同一个地址。
#
# 坑与代价（务必知道）：
#   - Render 免费实例 15 分钟无访问会休眠，下次访问冷启动约 30 秒；
#   - Render 免费实例磁盘是临时的：上传的图片（UPLOAD_DIR=/app/uploads）重新部署后会丢；
#     要长期用就把图片改存对象存储，或改用 F2；
#   - Supabase 免费库 500MB / 有连接数上限；本系统种子数据只有几 MB，够用；
#   - 免费额度会变，以各家官网为准（写这段时是 2026-10）。
#
# ─────────────────────────────────────────────────────────────
# 方案 F2【最接近现在的部署方式】永久免费小机器 + 托管库（或自带库）
# ─────────────────────────────────────────────────────────────
#   Oracle Cloud Always Free（ARM 4 核 24G，永久免费额度）或其它厂商的免费/长期低价小机
#   → 直接把仓库里的 docker-compose.yml 跑起来（自带 postgres/redis/备份），
#     或者用 deploy/compose.managed-db.yml（数据库用托管库，机器只跑 api/worker/web/nginx）。
#
# 步骤（自带库，一条命令）：
#   git clone <你的仓库> && cd <仓库> && bash deploy/up.sh
# 步骤（托管库）：
#   DATABASE_URL='postgresql://...?sslmode=require' JWT_SECRET='<随机串>' WEB_PORT=8080 \
#     docker compose -f deploy/compose.managed-db.yml up -d --build
#
# 坑与代价：
#   - Oracle 注册要国际信用卡验证，国内直连速度一般（可加 CDN 或换国内低价机）；
#   - 免费小机磁盘/带宽有限，注意保留 20% 空闲给日志与备份。
#
# ─────────────────────────────────────────────────────────────
# 方案 F3【已有腾讯云账号】用新用户特惠 + 托管库
# ─────────────────────────────────────────────────────────────
#   腾讯云轻量应用服务器 / CVM 的新用户特惠（几元~几十元/月，1 年起）比"永久免费"更稳；
#   数据库可选：自建 PG（一条 compose 命令）或腾讯云 PG 免费试用/低配版。
#   部署方式与 F2 完全相同：上传 release/*.zip → bash deploy/up.sh。
#
# ─────────────────────────────────────────────────────────────
# 建议
# ─────────────────────────────────────────────────────────────
#   - 只是"给人看看、跑通验收" → F1（全免费，冷启动 30 秒可接受）；
#   - 准备长期给客服队伍用 → F2 或 F3（一台小机 + 我们的 compose，含自动备份与日志轮转）；
#   - 无论哪条，上线后请改掉三个演示账号口令，并把 JWT_SECRET 存到密钥管理里。
