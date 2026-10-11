# Self-hosted semantic matching

The optional `semantic-api` service runs a Chinese CPU embedding model inside the same Docker Compose network as the API. It uses `BAAI/bge-small-zh-v1.5` through FastEmbed/ONNX Runtime; model files are downloaded on first start and retained in the `semantic-model-cache` volume. No external inference API or model API key is used.

From the repository root on the Tencent Cloud Lighthouse server:

```bash
# Build and start the normal stack plus the private semantic service.
docker compose -f docker-compose.yml -f deploy/compose.semantic.yml --profile semantic up -d --build

# Check model-service health and API logs. The service is internal to Compose and does not publish port 8000.
docker compose -f docker-compose.yml -f deploy/compose.semantic.yml --profile semantic ps
docker compose -f docker-compose.yml -f deploy/compose.semantic.yml logs -f semantic-api api
```

The first start downloads the model and can take several minutes. Allow outbound HTTPS to the Hugging Face model host, or set `HF_ENDPOINT` in the server's `.env` to an approved reachable mirror before starting. The mounted model volume keeps the download across container rebuilds. Budget about 4 GB RAM for a small CPU server running the full stack and this service; one Uvicorn worker avoids duplicating the model in memory. CPU inference is suitable for training traffic at modest concurrency.

In a script's question JSON, set `semanticGoals`. A point can have exact `matchAny` expressions and optional `businessRules` (`mustIncludeAll`, `mustIncludeAny`, `mustExclude`). The vector service returns candidate point IDs above `SEMANTIC_MATCH_THRESHOLD` (default `0.78`); candidates only count as covered after the configured deterministic checks pass. Set phrases to match the scenario's actual facts. `riskRules` independently record and deduct business-risk phrases. Legacy questions without semantic goals continue using the existing key-point matcher.

Example question extension:

```json
{
  "seq": 1,
  "question": "你们家尺码偏大吗？",
  "keyPoints": ["尺码"],
  "semanticGoals": [
    {
      "id": "size-normal",
      "name": "说明尺码是否偏大",
      "requiredPoints": [
        {
          "id": "normal",
          "label": "说明尺码正常",
          "matchAny": ["标准尺码", "正常尺码", "不偏大"],
          "businessRules": { "mustIncludeAny": ["尺码", "M码"], "mustExclude": ["偏大很多"] }
        }
      ]
    }
  ]
}
```

Configure goals from the script preview's **配置语义目标** editor. `matchAny` supports deterministic exact expressions without the model; business rules are required before a vector-only candidate can count. Partial goals remain open for later questions. Fully covered goals on future configured questions are skipped, and a clear closing reply such as “暂时没有其他问题，谢谢您” ends the simulated conversation early. Skipped rounds are excluded from response-time scoring while remaining visible in the goal completion score.

To disable inference, omit `deploy/compose.semantic.yml` from the Compose command. The application also falls back to configured exact rules whenever the model service is unavailable.
