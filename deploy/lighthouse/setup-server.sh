#!/usr/bin/env bash
#
# 全新 Ubuntu 轻量服务器初始化（在服务器上以 root 或 sudo 权限执行）
#
# 做的事：
#   1. 安装 Docker 引擎 + compose 插件（官方 apt 源；国内机器若拉取慢，见文件底部注释换阿里云镜像源）
#   2. 系统防火墙放行 8080（腾讯云控制台的「防火墙」是另一道，需自己在网页上放行）
#   3. 克隆代码仓库并一键部署
#
# 用法：
#   curl -fsSL <本文件 raw 地址> | bash        # 或先把文件传到服务器再执行
#   bash deploy/lighthouse/setup-server.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 执行，或：sudo bash deploy/lighthouse/setup-server.sh" >&2
  exit 1
fi

echo "==> 1/4 安装 Docker"
apt-get update
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
docker compose version

echo "==> 2/4 防火墙放行 8080"
if command -v ufw >/dev/null 2>&1; then
  ufw allow 8080/tcp || true
  ufw --force enable || true
fi
echo "⚠️  还需要在腾讯云轻量服务器控制台 → 防火墙 → 添加规则放行 TCP 8080（控制台网页操作，脚本够不到）"

echo "==> 3/4 克隆代码"
mkdir -p /opt
if [ ! -d /opt/cs-training/.git ]; then
  git clone https://github.com/Maiduo-Alt/maiduo123.git /opt/cs-training
fi
cd /opt/cs-training
git pull

echo "==> 4/4 一键部署"
bash deploy/lighthouse/up.sh

# ─────────────────────────────────────────────────────────────
# 国内机器安装 Docker 太慢时，把上面「安装 Docker」一节换成阿里云镜像源：
#
#   apt-get update
#   apt-get install -y ca-certificates curl
#   curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/ubuntu/gpg | \
#     gpg --dearmor -o /etc/apt/keyrings/docker.gpg
#   echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
#     https://mirrors.aliyun.com/docker-ce/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
#     > /etc/apt/sources.list.d/docker.list
#   apt-get update
#   apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
# ─────────────────────────────────────────────────────────────
