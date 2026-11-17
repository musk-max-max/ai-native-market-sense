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
# END 取昨日 UTC：避免日中运行时把今日 bar 的 as_of=15:00 与 fetched_at=now 倒挂（C04 loader 拒）。
# 生产常规在 18:00 UTC（次日 02:00 Asia/Shanghai）跑，昨日=已收盘交易日。
END=$(date -u -d '-1 day' +%Y-%m-%d)
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
# 生产场景预期冲突 blocker 显式降 warn：
# - STRUCT-06: bars 缺 adj_factor (SKIP_ANCHOR_PRELOAD=1 下预期)
# - CONS-01: 窗口边界 prev_close 缺前日 bar (30d lookback 起点预期)
# - RES-03: hk_hold/退市 top_inst 引用不在 dim_instrument (研究数据源覆盖广于 instrument 基线)
# - CONS-02: stk_limit 引用退市/暂停股不在 dim_instrument (tushare 返回 SZSE:002731 等，数据源覆盖差异)
# - RES-05: tushare 返回涨跌停价格哨兵值/脏数据 (BSE:920085 prev=17.79 up=99999.99 down=0.0，数据源质量)
# 非 SKIP_ANCHOR 场景 STRUCT-06/CONS-01 仍会拦（quality_config.json 是 single source of truth）。
python -m warehouse.load \
    --ods-root /data/ods \
    --internal-ods-root /data/ods/internal \
    --profile dev \
    --dsn "${PG_DSN}" \
    --skip-rule STRUCT-06 \
    --skip-rule CONS-01 \
    --skip-rule RES-03 \
    --skip-rule CONS-02 \
    --skip-rule RES-05

echo "[ingest] all done"
