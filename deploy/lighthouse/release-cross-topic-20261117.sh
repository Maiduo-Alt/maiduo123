#!/usr/bin/env bash
# Run on the existing Lighthouse host; the target commit must already be fetched.
set -Eeuo pipefail
cd /home/ubuntu/cs-training
release_target=${1:?请传入已校验的发布提交}
[[ "$release_target" =~ ^[0-9a-f]{40}$ ]] || { echo '提交格式无效'; exit 1; }
git cat-file -e "${release_target}^{commit}"
exec 9>/tmp/cs-training-release.lock
flock -n 9 || { echo '另一个部署正在进行，已停止'; exit 1; }
[[ -f .env ]] || { echo '缺少 .env，已停止'; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo '工作区有未提交内容，已停止'; exit 1; }
release_previous=$(git rev-parse HEAD)
case "$release_previous" in
  f9a22d1bca33a04651d5968b182297788b25aa63|"$release_target") ;;
  *) echo "当前版本不符合预期，已停止：$release_previous"; exit 1 ;;
esac
trap 'echo "部署未完成，停止于第 $LINENO 行；请保留输出，不要反复重跑。" >&2' ERR
compose() {
  sudo docker compose --env-file .env \
    -f deploy/lighthouse/docker-compose.yml \
    -f deploy/lighthouse/compose.semantic.yml --profile semantic "$@"
}
echo '[1/5] 版本与工作区检查通过，备份数据库'
umask 077
mkdir -p /home/ubuntu/cs-training-backups
release_backup="/home/ubuntu/cs-training-backups/before-cross-topic-$(date +%Y%m%d-%H%M%S)-$$.dump"
timeout 60s sudo docker exec cs-training-postgres-1 \
  pg_dump -w -U cs_training -Fc cs_training > "$release_backup"
test -s "$release_backup"
timeout 30s sudo docker exec -i cs-training-postgres-1 pg_restore -l < "$release_backup" > /dev/null
printf '备份已验证：%s\n原代码版本：%s\n' "$release_backup" "$release_previous"
printf '%s\n' "$release_previous" > "${release_backup}.previous-commit"
echo '[2/5] 切换到已校验的发布版本'
git switch --detach "$release_target"
echo '[3/5] 构建 API 和网页镜像'
compose build api web
echo '[4/5] 启动更新后的 API 和网页容器'
compose up -d --no-deps api web
echo '[5/5] 等待接口和数据库健康，启动初期可能短暂返回 502'
curl --connect-timeout 3 --max-time 8 --retry 15 --retry-delay 3 --retry-all-errors \
  -fsS http://127.0.0.1:8080/api/health > "${release_backup}.health.json"
python3 - "${release_backup}.health.json" <<'PY'
import json, sys
with open(sys.argv[1]) as stream:
    result = json.load(stream)
data = result.get('data', {})
if not (result.get('code') == 0 and data.get('status') == 'ok' and data.get('db') == 'up' and data.get('memoryDb') is False):
    raise SystemExit('健康检查未通过，请保留输出并检查容器日志')
print('健康检查通过：API 正常，数据库已连接')
PY
compose ps api web
printf '\n部署完成，代码版本：%s\n数据库备份：%s\n' "$(git rev-parse HEAD)" "$release_backup"
