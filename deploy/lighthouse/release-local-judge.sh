#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
test -f .env
compose=(sudo docker compose --env-file .env -f deploy/lighthouse/docker-compose.yml -f deploy/lighthouse/compose.semantic.yml -f deploy/lighthouse/compose.local-judge.yml --profile semantic)
"${compose[@]}" up -d --no-deps semantic-judge
model="$("${compose[@]}" config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["api"]["environment"]["LOCAL_SEMANTIC_JUDGE_MODEL"])')"
echo "本地判定模型：$model"
if ! "${compose[@]}" exec -T semantic-judge ollama show "$model" >/dev/null 2>&1; then
  "${compose[@]}" exec -T semantic-judge ollama pull "$model"
fi

# Test the actual judge in the new image before replacing the running API.
"${compose[@]}" build api
"${compose[@]}" build web
"${compose[@]}" run --rm --no-deps -T api node - <<'NODE'
const { evaluateWithModels } = require('./backend/dist/domain/model-reception.js');
(async () => {
  const cases = [
    ['走线整齐吗？', '整齐的哦', true],
    ['走线整齐吗？', '我帮您查一下。', false],
    ['实物和详情页图片色差大吗？', '图片光线和屏幕可能产生细微色差，如果收到不合适可以联系客服。', true],
    ['实物和详情页图片色差大吗？', '这款用的是聚酯纤维，收到不合适可以联系客服。', false],
    ['买家秀在哪里看？', '在评价区选择晒图就能看。', true, 'media-location'],
    ['是聚酯纤维吗？', '是的哈，聚酯纤维的面料。', true, 'material-details'],
    ['要不要干洗？', '不需要专门干洗，可以按洗标要求轻柔清洗。', true, 'dry-clean-required'],
    ['如果想穿得休闲一些，鞋子可以怎么搭配呢？', '鞋子配乐福鞋、尖头平底鞋或短靴都很搭。', true, 'shoe-styling'],
    ['可以机洗吗？', '详情页没标注，请以洗标为准，确认前建议轻柔手洗。', true],
    ['可以机洗吗？', '没标注机洗，不过用洗衣袋就一定能机洗。', false],
    ['这款连衣裙可以机洗吗？', '亲，这款商品页没有明确标注是否可机洗或需干洗哦。稳妥起见建议轻柔手洗，或洗衣袋机洗选轻柔模式，水温30度以下，洗后自然晾干避免暴晒烘干～收到后也可以看洗水标确认哦。', false],
  ];
  for (const [question, reply, expected, rule] of cases) {
    const washingCase = question.includes('机洗');
    const expectedSource = rule || (washingCase ? 'wash-guidance' : question.includes('色差') ? 'color-difference' : undefined);
    const started = Date.now();
    const result = await evaluateWithModels(
      { question, goals: [], history: [{ role: 'buyer', content: question }], reply, judgmentVersion: 2,
        ...(washingCase || rule === 'material-details' || rule === 'dry-clean-required' ? { facts: { product: { title: '测试服装', attributes: [{ name: '材质', value: '其他' }] } } } : {}) },
      { local: { url: process.env.LOCAL_SEMANTIC_JUDGE_URL, model: process.env.LOCAL_SEMANTIC_JUDGE_MODEL,
        onFailure: reason => console.error('本地模型预检失败：' + reason) } },
    );
    if (result.resolved !== expected) throw Error('本地模型对部署样例的判定不符：' + JSON.stringify({question, reply, expected, result}));
    if (result.decisionSource !== expectedSource) throw Error('样例的判定来源不符：' + question);
    console.log('本地预检耗时 ' + (Date.now() - started) + ' ms：' + question);
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
"${compose[@]}" up -d --no-deps --wait --wait-timeout 90 web
curl -fsS --max-time 5 --retry 10 --retry-delay 3 --retry-all-errors http://127.0.0.1:8080/api/health |
  python3 -c 'import json,sys; r=json.load(sys.stdin); print(r); d=r.get("data") or {}; sys.exit(0 if r.get("code")==0 and d.get("status")=="ok" and d.get("db")=="up" else 1)'
echo "部署完成，版本 $(git rev-parse --short HEAD)，数据库备份 $backup"
