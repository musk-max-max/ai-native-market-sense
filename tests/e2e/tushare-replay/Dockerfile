# tushare-replay（A12 owns）：零依赖 Python 镜像，仅承载 tests/e2e/tushare-replay/server.py
FROM python:3.12-slim

WORKDIR /app
COPY tushare-replay/server.py /app/server.py

ENV PYTHONUNBUFFERED=1 \
    FIXTURE_MODE=replay \
    FIXTURES_DIR=/fixtures/tushare \
    PORT=18080

EXPOSE 18080
USER 65534:65534
CMD ["python3", "/app/server.py"]
