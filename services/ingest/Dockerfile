# A1 数据接入镜像（e2e 的 ingest-once 服务 / K8s CronJob 共用）
#
# 构建上下文 = 仓库根（tests/e2e/docker-compose.yml 的 context: ../..），因为需要
# config/ingest.yaml 的相对路径与 data/instruments/base_info.csv：
#   docker build -f services/ingest/Dockerfile -t market-sense-ingest .
#
# 入口 = `python -m market_ingest <子命令>`（sync-bars / sync-instruments /
# sync-fundamentals）；e2e 通过 DATA_SOURCE_MODE=replay + TUSHARE_API_URL 指向录播代理，
# 不访问真实接口。
#
# 可写路径约定（compose/K8s 按需挂持久卷）：
#   /data/ods      ODS 批次根（<root>/display 与 <root>/internal 两个渠道子目录）
#   /data/ingest.db  SQLite 台账（raw/DLQ/checkpoint/quota）
#   /data/audit    manifest 审计（H4：生产必须 PVC/对象存储，否则不是审计证据）
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/services/ingest/src \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DATA_SOURCE_MODE=replay

RUN pip install --no-cache-dir "PyYAML>=6"

RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin ingest

WORKDIR /app
COPY services/ingest /app/services/ingest
COPY data/instruments /app/data/instruments
# 显式再补一次配置目录（services/ingest 已包含，此处防 COPY 层被裁剪/误解）：
COPY services/ingest/config /app/services/ingest/config

RUN mkdir -p /data/ods /data/audit /app/services/ingest/var \
    && chown -R ingest:ingest /data /app/services/ingest/var

USER ingest

VOLUME ["/data"]

ENTRYPOINT ["python", "-m", "market_ingest"]
# 默认只做预算估算，不写库、不调用数据源；e2e 用 command 覆盖。
CMD ["sync-bars", "--dry-run", "--ods-root", "/data/ods", "--db", "/data/ingest.db"]
