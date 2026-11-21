#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
test -f .env
compose=(sudo docker compose --env-file .env -f deploy/lighthouse/docker-compose.yml -f deploy/lighthouse/compose.semantic.yml -f deploy/lighthouse/compose.local-judge.yml --profile semantic)
"${compose[@]}" up -d --no-deps semantic-judge
model="$("${compose[@]}" config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["api"]["environment"]["LOCAL_SEMANTIC_JUDGE_MODEL"])')"
"${compose[@]}" exec -T semantic-judge ollama pull "$model"

# The running API container can reach Ollama on the Compose network before it is replaced.
"${compose[@]}" exec -T api node - "$model" <<'NODE'
(async () => {
  const reply = '整齐的哦';
  const response = await fetch('http://semantic-judge:11434/v1/chat/completions', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    signal: AbortSignal.timeout(45000),
    body: JSON.stringify({
      model: process.argv[2], temperature: 0, max_tokens: 256, response_format: {type:'json_object'},
      messages: [{role:'system',content:'判断客服是否回答买家问题。输出 JSON，包含 resolved 布尔值、reason 字符串、evidence 数组（引用答复原文）、matchedPoints 空数组、buyerReply 字符串。'},
        {role:'user',content:JSON.stringify({question:'走线整齐吗？', reply})}],
    }),
  });
  if (!response.ok) throw Error('本地模型 HTTP '+ response.status);
  const result = JSON.parse((await response.json()).choices[0].message.content);
  if (result.resolved !== true || !Array.isArray(result.evidence) || !result.evidence.length ||
      result.evidence.some(x => typeof x !== 'string' || !x.trim() || !reply.includes(x)) ||
      typeof result.reason !== 'string' || !Array.isArray(result.matchedPoints) || result.matchedPoints.length ||
      typeof result.buyerReply !== 'string' || !result.buyerReply.trim()) throw Error('本地模型未通过判定检查');
  console.log('本地模型判定检查通过');
})().catch(e=>{console.error(e.message); process.exitCode=1});
NODE

umask 077
mkdir -p /home/ubuntu/cs-training-backups
backup="$(mktemp /home/ubuntu/cs-training-backups/before-local-judge-XXXXXXXX.dump)"
timeout 60s sudo docker exec cs-training-postgres-1 pg_dump -w -U cs_training -Fc cs_training > "$backup"
test -s "$backup"
timeout 60s sudo docker exec -i cs-training-postgres-1 pg_restore -l < "$backup" >/dev/null
"${compose[@]}" build api
"${compose[@]}" up -d --no-deps --wait --wait-timeout 90 api
curl -fsS --max-time 5 --retry 10 --retry-delay 3 --retry-all-errors http://127.0.0.1:8080/api/health |
  python3 -c 'import json,sys; r=json.load(sys.stdin); print(r); d=r.get("data") or {}; sys.exit(0 if r.get("code")==0 and d.get("status")=="ok" and d.get("db")=="up" else 1)'
echo "部署完成，版本 $(git rev-parse --short HEAD)，数据库备份 $backup"
