# 上线清单（按方案 5.10 部署：Docker Compose 单机多容器）

> 面向运维/上线执行人。照着从上往下做，最后一条是「验收怎么确认」。

## 0. 需要准备什么

| 项 | 要求 | 说明 |
| --- | --- | --- |
| 服务器 | 2 核 4G 起（建议 4 核 8G），Linux（Ubuntu 20.04+/Debian 11+/CentOS 7+） | 方案 5.10 是**内网单机**部署；要公网访问就绑公网 IP / 域名 |
| Docker | Docker 20.10+ 且带 `docker compose` 插件 | 执行 `docker compose version` 能输出版本即可 |
| 端口 | 默认对外 **8080**（可用 `.env` 的 `WEB_PORT` 改） | 服务器防火墙/安全组要放行该端口 |
| 磁盘 | ≥ 20G | 镜像 + 数据库卷 + 每日备份（保留 30 份） |
| 网络 | 首次构建需要联网（拉 node:20-alpine / postgres:15-alpine / redis:7-alpine / nginx:alpine） | 拉完可以断网运行 |

## 1. 拷代码上去

把项目目录整个传上去（不用带 `node_modules`、`frontend/dist`，镜像里会重新构建）：

```bash
scp -r 在线模拟接待训练系统  ops@<服务器IP>:~/cs-training
ssh ops@<服务器IP>
cd ~/cs-training
```

（也可以直接用仓库地址 `git clone` 到服务器上。）

## 2. 一条命令上线

```bash
bash deploy/up.sh
```

脚本会：检查 docker → 生成 `.env`（**JWT_SECRET 自动换成随机值**）→ `docker compose up -d --build`
→ 轮询 `/api/health` 直到通过 → 打印访问地址。首次构建约 3～8 分钟（取决于网络）。

不想用脚本、手动来的话等价于：

```bash
cp deploy/env.production.example .env
# 编辑 .env，把 JWT_SECRET 改成随机串（openssl rand -hex 32），按需改 WEB_PORT / POSTGRES_PASSWORD
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:8080/api/health
```

## 3. 上线后确认（验收）

```bash
docker compose ps                     # api/worker/postgres/redis/web/nginx/backup 都应是 Up
curl -s http://127.0.0.1:8080/api/health
# {"code":0,...,"data":{"status":"ok","db":"up","memoryDb":false,...}}
#   ↑ memoryDb 必须是 false —— 线上用的是真 PostgreSQL，不是内存库
```

浏览器打开 `http://<服务器IP>:8080/`，用 `admin/Admin@123` 登录，
按 `docs/验收指引.md` 的「5 分钟快速路径」走一遍即可。

**上线后必做两件事**：
1. 用管理员在《账号》页把三个演示账号的口令改掉（或停用 `agent` 演示账号）。
2. 把 `.env` 里的 `JWT_SECRET` 备份到你们的密钥管理里（换密钥会让所有人重新登录）。

## 4. 日常运维

| 事情 | 命令 |
| --- | --- |
| 看状态 | `docker compose ps` |
| 看日志（api / worker） | `docker compose logs -f --tail=200 api worker` |
| 只看错误 | `docker compose logs --tail=500 api \| grep -i error` |
| 重启 | `bash deploy/up.sh --no-build`（或 `docker compose restart api worker`） |
| 升级代码 | 传新代码 → `bash deploy/up.sh`（会重新构建并滚动重启，数据库卷保留） |
| 手动备份一次 | `docker compose exec backup sh -c 'pg_dump --format=custom --no-owner --file /backups/manual.dump "$DATABASE_URL"'` |
| 恢复某份备份 | `docker compose exec -T postgres pg_restore --clean --no-owner --if-exists -U cs_training -d cs_training < backups/cs_training_YYYYmmdd-HHMMSS.dump` |
| 停服务（保留数据） | `docker compose down` |
| 彻底清库重来 | `docker compose down -v`（**会删掉 pgdata/uploads/redisdata 三个卷，谨慎**） |

**备份与日志**（方案 5.10 要求）：
- `backup` 容器每 24 小时 `pg_dump` 一次到宿主机 `./backups/`，自动只保留最近 30 份；
- 上传的图片在 `uploads` 数据卷里，跟数据库一起纳入备份范围（
  `docker run --rm -v cs-training_uploads:/data -v $PWD/backups:/backup alpine tar czf /backup/uploads.tgz /data` 可按需单备）；
- 容器日志用 json-file 驱动轮转（`max-size=20m`、`max-file=30`，即最多保留 30 份，方案里的「按天滚动、保留 30 天」用等价口径实现）。

## 5. 要不要上 HTTPS / 域名

方案 7.1 的口径是「HTTPS（内网可用 HTTP）」。当前 nginx 只监听 80（对外映射 8080）：

- **内网使用**：直接 HTTP 即可，无需改动。
- **公网使用**：建议在 nginx 前再加一层公司 HTTPS 网关，或把 `deploy/nginx.conf` 换成带 443 证书的版本
  （域名解析到服务器 + 证书挂载进 nginx 容器 + 80 跳转 443）。需要的话告诉我域名与证书方式（自签 / Let's Encrypt），我把配置补上。

## 6. 出问题先看这三样

1. `docker compose ps` —— 哪个容器没 Up；
2. `docker compose logs --tail=200 <那个服务>` —— 常见原因：端口被占用（改 `WEB_PORT`）、
   首次构建拉镜像失败（网络/代理）、`postgres` 卷口令与 `.env` 不一致（改过 `POSTGRES_PASSWORD` 需要同步 `DATABASE_URL` 或用 `-v` 重建卷）；
3. `curl -s http://127.0.0.1:<WEB_PORT>/api/health` —— `db=down` 说明 api 连不上 postgres。
