#!/usr/bin/env bash
#
# 轻量服务器一键上线（低延迟优化版，compose 用 deploy/lighthouse/docker-compose.yml）
#
# 用法（在服务器上的项目根目录执行）：
#   bash deploy/lighthouse/up.sh              # 首次部署：生成 .env → 构建 → 启动 → 等健康检查
#   bash deploy/lighthouse/up.sh --no-build   # 只重启（不重新构建镜像）
#
# 前置：服务器已装 docker + docker compose 插件；8080 端口已在
#       腾讯云控制台「防火墙」和系统防火墙（如启用了 ufw）放行。
set -euo pipefail

cd "$(dirname "$0")/../.."
COMPOSE="docker compose -f deploy/lighthouse/docker-compose.yml --env-file .env"
BUILD_FLAG="--build"
if [ "${1:-}" = "--no-build" ]; then BUILD_FLAG=""; fi

echo "==> 1/4 检查 docker"
if ! command -v docker >/dev/null 2>&1; then
  echo "未找到 docker。请先执行 bash deploy/lighthouse/setup-server.sh 或手动安装 Docker 后重试。" >&2
  exit 1
fi
docker compose version >/dev/null

echo "==> 2/4 准备 .env"
if [ ! -f .env ]; then
  cp deploy/env.production.example .env
  if command -v openssl >/dev/null 2>&1; then
    SECRET="$(openssl rand -hex 32)"
  else
    SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  fi
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

# 建议：从 CloudBase 迁移时把原 JWT_SECRET 填进 .env，老用户无需重新登录
if [ "${1:-}" != "--no-build" ]; then
  echo "（提示：若从 CloudBase 切流，建议把云托管服务里的 JWT_SECRET 原值写进 .env，已登录用户不掉线）"
fi

echo "==> 3/4 构建并启动（首次构建需要联网拉取基础镜像与依赖，约 3~8 分钟）"
# shellcheck disable=SC2086
$COMPOSE up -d ${BUILD_FLAG}

echo "==> 4/4 等待健康检查 /api/health"
for i in $(seq 1 60); do
  if $COMPOSE exec -T api wget -qO- http://127.0.0.1:3000/api/health 2>/dev/null | grep -q '"status":"ok"'; then
    echo "✅ 后端健康检查通过"
    break
  fi
  if [ "$i" = "60" ]; then
    echo "❌ 300 秒内没等到健康检查通过，用下面命令看日志：" >&2
    echo "   $COMPOSE logs --tail=100 api" >&2
    exit 1
  fi
  sleep 5
done

PORT="$(grep '^WEB_PORT=' .env | cut -d= -f2)"; PORT="${PORT:-8080}"
echo
echo "🎉 部署完成"
echo "   应用入口：http://<服务器IP>:${PORT}/"
echo "   健康检查：http://<服务器IP>:${PORT}/api/health"
echo "   演示账号：admin/Admin@123、leader/Leader@123、agent/Agent@123"
echo "   查看状态：$COMPOSE ps"
echo "   看日志：  $COMPOSE logs -f api"
echo "   每日备份：容器 backup 会把 pg_dump 写到宿主机的 ./backups（保留 30 份）"
