# 商品分享链接无头浏览器抓取服务（内部服务，不映射端口）
#
# Chromium 用华为云镜像的浏览器快照（国内 10MB/s 级，比官方/edgedl 源快且稳），
# 驱动用 puppeteer-core（不自带 Chrome 下载）。
FROM node:20-bookworm

# Chromium 运行所需的系统库（版本清单经线上探测容器验证可启动）
# 注意：apt 源切到腾讯云内网镜像（deb.debian.org 在该机房经常超时），
# libatspi2.0-0 在 bookworm 没有 t64 后缀。
RUN sed -i 's|deb.debian.org|mirrors.tencentyun.com|g; s|security.debian.org|mirrors.tencentyun.com|g' \
        /etc/apt/sources.list.d/debian.sources \
    && npm config set registry https://registry.npmmirror.com \
    && apt-get update -qq \
    && apt-get install -y -qq --no-install-recommends \
       curl unzip ca-certificates \
       libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
       libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
       libasound2 libpango-1.0-0 libcairo2 libatspi2.0-0 \
       fonts-liberation fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# Chromium 快照（ revision 1517223 ），解压到 /chrome/chrome-linux/chrome
ARG CHROMIUM_REV=1517223
RUN curl -sf -o /tmp/chrome.zip "https://mirrors.huaweicloud.com/chromium-browser-snapshots/Linux_x64/${CHROMIUM_REV}/chrome-linux.zip" \
    && cd / && unzip -q /tmp/chrome.zip -d /chrome && rm /tmp/chrome.zip \
    && chmod +x /chrome/chrome-linux/chrome

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-fund --no-audit

COPY server.js ./

USER node

EXPOSE 9090

CMD ["node", "server.js"]
