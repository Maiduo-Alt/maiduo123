#!/usr/bin/env bash
#
# 一键上线（方案 5.10：Docker Compose 单机部署）
#
# 用法（在服务器上的项目根目录执行）：
#   bash deploy/up.sh              # 首次部署：生成 .env → 构建 → 启动 → 等健康检查
#   bash deploy/up.sh --no-build   # 只重启（不重新构建镜像）
#
# 前置：服务器已装 docker + docker compose 插件（docker compose version 能跑通）。
# 脚本做四件事：① 检查 docker ② 生成/复用 .env（随机 JWT_SECRET）③ compose up -d ④ 等到健康检查通过并打印访问地址。
set -euo pipefail

cd "$(dirname "$0")/.."
BUILD_FLAG="--build"
if [ "${1:-}" = "--no-build" ]; then BUILD_FLAG=""; fi

echo "==> 1/4 检查 docker"
if ! command -v docker >/dev/null 2>&1; then
  echo "未找到 docker。请先安装 Docker（含 compose 插件）后重试。" >&2
  exit 1
fi
docker compose version >/dev/null

echo "==> 2/4 准备 .env"
if [ ! -f .env ]; then
  cp deploy/env.production.example .env
  # 生成随机 JWT 密钥（没有 openssl 就用 node —— 镜像构建也依赖 node，通常都有其一）
  if command -v openssl >/dev/null 2>&1; then
    SECRET="$(openssl rand -hex 32)"
  else
    SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  fi
  # 兼容 GNU sed 与 BSD sed
  sed -i.bak "s/^JWT_SECRET=.*/JWT_SECRET=${SECRET}/" .env 2>/dev/null || \
    sed -i '' "s/^JWT_SECRET=.*/JWT_SECRET=${SECRET}/" .env
  rm -f .env.bak
  echo "已生成 .env（JWT_SECRET 为随机值，WEB_PORT 默认 8080）"
else
  echo "检测到已存在的 .env，沿用（如需改端口/口令请编辑后再跑）"
fi

if grep -q '^JWT_SECRET=CHANGE_ME' .env; then
  echo "⚠️  .env 里的 JWT_SECRET 还是占位值，请改成随机串后再上线" >&2
  exit 1
fi

echo "==> 3/4 构建并启动（首次构建需要联网拉取基础镜像与依赖）"
docker compose up -d ${BUILD_FLAG}

echo "==> 4/4 等待健康检查 /api/health"
PORT="$(grep '^WEB_PORT=' .env | cut -d= -f2)"; PORT="${PORT:-8080}"
for i in $(seq 1 60); do
  if docker compose exec -T api wget -qO- http://127.0.0.1:3000/api/health 2>/dev/null | grep -q '"status":"ok"'; then
    echo "✅ 后端健康检查通过"
    break
  fi
  if [ "$i" = "60" ]; then
    echo "❌ 300 秒内没等到健康检查通过，用下面命令看日志：" >&2
    echo "   docker compose logs --tail=100 api worker" >&2
    exit 1
  fi
  sleep 5
done

echo
echo "🎉 部署完成"
echo "   应用入口：http://<服务器IP>:${PORT}/"
echo "   健康检查：http://<服务器IP>:${PORT}/api/health"
echo "   演示账号：admin/Admin@123、leader/Leader@123、agent/Agent@123"
echo "   查看状态：docker compose ps ；看日志：docker compose logs -f api"
echo "   每日备份：容器 backup 会把 pg_dump 写到宿主机的 ./backups（保留 30 份）"
