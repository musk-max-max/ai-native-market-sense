#!/bin/sh
# 生产 ingest 一键脚本（services/ingest/scripts/production-sync.sh）
# 顺序：instruments 基线 → 日线 bars → research 数据集（含 fina_indicator/资金流等）
# 频控：15000 档 TUSHARE_RATE_LIMIT_PER_MIN=200（services/ingest/.env:7）
# F1 residual：realtime_quote 不在本脚本（AKshare 独立跑，仅内部展示，红线①）
# 说明：sync-fundamentals 需 --instruments 切片，走 sync-research --datasets=fina_indicator 全市场等价。
# step 4 走 warehouse.load 把 ODS 批次幂等落到 PostgreSQL dwd_* 表；serving.v_cend_* 视图由 warehouse/serving/schema.sql + c-end-metrics.sql 提供。
set -eu
: "${PG_DSN:?set PG_DSN}"
: "${TUSHARE_TOKEN:?set TUSHARE_TOKEN}"
: "${SYNC_LOOKBACK_DAYS:=30}"
START=$(date -u -d "-${SYNC_LOOKBACK_DAYS} days" +%Y-%m-%d)
END=$(date -u +%Y-%m-%d)
echo "[ingest] window ${START} .. ${END}"

echo "[ingest] step 1/3 sync-instruments"
python -m market_ingest sync-instruments \
    --ods-root /data/ods --db /data/ingest.db \
    --config /app/services/ingest/config/ingest.yaml

echo "[ingest] step 2/3 sync-bars market-wide"
python -m market_ingest sync-bars \
    --market-wide \
    --start "${START}" --end "${END}" \
    --ods-root /data/ods --db /data/ingest.db \
    --config /app/services/ingest/config/ingest.yaml

echo "[ingest] step 3/3 sync-research datasets"
python -m market_ingest sync-research \
    --start "${START}" --end "${END}" \
    --ods-root /data/ods --db /data/ingest.db \
    --config /app/services/ingest/config/ingest.yaml

echo "[ingest] step 3b/4 sync-research stk_limit (v_cend_limit_ladder)"
python -m market_ingest sync-research \
    --datasets stk_limit \
    --start "${START}" --end "${END}" \
    --ods-root /data/ods --db /data/ingest.db \
    --config /app/services/ingest/config/ingest.yaml || \
    echo "[ingest] WARN stk_limit sync failed (non-fatal; v_cend_limit_ladder stays empty)"

echo "[ingest] step 4/4 warehouse.load ODS->DWD (PostgreSQL)"
python -m warehouse.load \
    --ods-root /data/ods \
    --internal-ods-root /data/ods/internal \
    --profile dev \
    --dsn "${PG_DSN}"

echo "[ingest] all done"
