FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY requirements.txt ./requirements.txt
# 国内服务器走清华镜像，否则 PyPI 国际链路只有十几 KB/s
RUN pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple --requirement requirements.txt
COPY main.py ranking.py ./

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
