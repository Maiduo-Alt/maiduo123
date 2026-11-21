#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
test -f .env
compose=(sudo docker compose --env-file .env -f deploy/lighthouse/docker-compose.yml -f deploy/lighthouse/compose.semantic.yml -f deploy/lighthouse/compose.local-judge.yml --profile semantic)
"${compose[@]}" up -d --no-deps semantic-judge
model="$("${compose[@]}" config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["api"]["environment"]["LOCAL_SEMANTIC_JUDGE_MODEL"])')"
"${compose[@]}" exec -T semantic-judge ollama pull "$model"

# Test the actual judge in the new image before replacing the running API.
"${compose[@]}" build api
"${compose[@]}" run --rm --no-deps -T api node - <<'NODE'
const { evaluateWithModels } = require('./backend/dist/domain/model-reception.js');
(async () => {
  for (const [reply, expected] of [['整齐的哦', true], ['我帮您查一下。', false]]) {
    const result = await evaluateWithModels(
      { question: '走线整齐吗？', goals: [], history: [], reply, judgmentVersion: 2 },
      { local: { url: process.env.LOCAL_SEMANTIC_JUDGE_URL, model: process.env.LOCAL_SEMANTIC_JUDGE_MODEL, timeoutMs: 120000,
        onFailure: reason => console.error('本地模型预检失败：' + reason) } },
    );
    if (result.resolved !== expected) throw Error('本地模型对部署样例的判定不符：' + JSON.stringify({reply, expected, result}));
  }
  console.log('本地模型通过有效答复和空泛答复检查');
})().catch(e=>{console.error(e.message); process.exitCode=1});
NODE

umask 077
mkdir -p /home/ubuntu/cs-training-backups
backup="$(mktemp /home/ubuntu/cs-training-backups/before-local-judge-XXXXXXXX.dump)"
timeout 60s sudo docker exec cs-training-postgres-1 pg_dump -w -U cs_training -Fc cs_training > "$backup"
test -s "$backup"
timeout 60s sudo docker exec -i cs-training-postgres-1 pg_restore -l < "$backup" >/dev/null
"${compose[@]}" up -d --no-deps --wait --wait-timeout 90 api
curl -fsS --max-time 5 --retry 10 --retry-delay 3 --retry-all-errors http://127.0.0.1:8080/api/health |
  python3 -c 'import json,sys; r=json.load(sys.stdin); print(r); d=r.get("data") or {}; sys.exit(0 if r.get("code")==0 and d.get("status")=="ok" and d.get("db")=="up" else 1)'
echo "部署完成，版本 $(git rev-parse --short HEAD)，数据库备份 $backup"
