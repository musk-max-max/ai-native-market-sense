# A2 落库镜像：单一职责，只跑 `python -m warehouse.load`。
#
# 构建（上下文必须是仓库根）：
#   docker build -f warehouse/Dockerfile -t market-sense/warehouse-load .
#
# 验证状态：未构建验证
# 本机无容器运行时，静态核对见 warehouse/README.md §8。
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# 只有 psycopg[binary]（warehouse/requirements.txt 唯一依赖）
COPY warehouse/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# 镜像内只放数仓包（不含 tests/fixtures，减小体积与暴露面）
COPY warehouse/__init__.py /app/warehouse/__init__.py
COPY warehouse/load.py /app/warehouse/load.py
COPY warehouse/dwd /app/warehouse/dwd
COPY warehouse/ods /app/warehouse/ods
COPY warehouse/quality /app/warehouse/quality
COPY warehouse/metrics /app/warehouse/metrics
COPY warehouse/serving /app/warehouse/serving

# /state 是 A12 挂载 quality.json 的目录：必须归属于运行用户，
# 否则 named volume 初始化后是 root:root，写报告会 EACCES（exit 2）。
RUN useradd --create-home --uid 10001 warehouse \
    && mkdir -p /state \
    && chown 10001:10001 /state
USER warehouse

ENTRYPOINT ["python", "-m", "warehouse.load"]
