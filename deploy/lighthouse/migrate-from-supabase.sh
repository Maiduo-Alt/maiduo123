#!/usr/bin/env bash
#
# 把线上 Supabase（CloudBase 方案用的外部 PostgreSQL）里的数据迁移到轻量服务器本地库
#
# 用法（在服务器上的项目根目录执行，服务已在跑）：
#   bash deploy/lighthouse/migrate-from-supabase.sh 'postgresql://postgres.<ref>:<密码>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require'
#
# 说明：
#   - 连接串用 Supabase 连接池地址（直连地址对境外 pg_dump 可能解析失败，见 deploy/CLOUDBASE.md 三个坑）；
#   - Node 端要求的 ?sslmode=no-verify 是 node-postgres 的扩展，pg_dump 不认，
#     这里用 libpq 标准的 sslmode=require（Supabase 证书是公共 CA 签的，可以正常校验）；
#   - 迁移期间会短暂停止 api（约几秒到几十秒，取决于数据量），避免恢复期间新旧库同时写入；
#   - 幂等性：--clean --if-exists 先清目标库再灌入，重复执行结果一致。
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "用法: bash deploy/lighthouse/migrate-from-supabase.sh '<Supabase 连接串（sslmode=require）>'" >&2
  exit 1
fi
SRC_URL="$1"

cd "$(dirname "$0")/../.."
COMPOSE="docker compose -f deploy/lighthouse/docker-compose.yml --env-file .env"
DUMP="backups/supabase-$(date +%Y%m%d-%H%M%S).dump"
mkdir -p backups

echo "==> 1/4 从 Supabase 导出（一次性 postgres:15-alpine 容器，外网只读）"
docker run --rm -v "$PWD/backups:/b" postgres:15-alpine sh -c \
  "pg_dump --format=custom --no-owner --no-privileges -f /b/$(basename "$DUMP") \"$SRC_URL\""
echo "✅ 已导出到 $DUMP"
ls -lh "$DUMP"

echo "==> 2/4 停止 api（防止迁移期间写入）"
$COMPOSE stop api

echo "==> 3/4 恢复到本地 PostgreSQL"
# --clean --if-exists：先删目标库同名对象再灌入；schema 两边一致（同一套 migrate 脚本建的）
$COMPOSE exec -T postgres pg_restore --clean --if-exists --no-owner -U cs_training -d cs_training \
  < "$DUMP"

echo "==> 4/4 重启 api 并自检"
$COMPOSE up -d api
for i in $(seq 1 30); do
  if $COMPOSE exec -T api wget -qO- http://127.0.0.1:3000/api/health 2>/dev/null | grep -q '"status":"ok"'; then
    echo "✅ 健康检查通过，数据迁移完成"
    break
  fi
  if [ "$i" = "30" ]; then
    echo "❌ api 启动后健康检查未通过，看日志：$COMPOSE logs --tail=100 api" >&2
    exit 1
  fi
  sleep 5
done

echo
echo "🎉 迁移完成。请抽查：账号能否登录、《明细》里的历史接待记录是否齐全。"
echo "⚠️  提醒：CloudBase 云托管没有持久卷，商品图/头像等上传文件此前重启即丢、不在数据库里，"
echo "   需要在迁移后重新上传；新服务器的 uploads 卷是持久的，之后不会再丢。"
