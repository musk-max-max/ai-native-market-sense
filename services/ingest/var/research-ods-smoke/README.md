# research-ods-smoke（合成冒烟数据，非真实取数）

用途：给 A2 做研究数据集 ODS → DWD/serving 的本地冒烟输入；全部行来自手写
`fixture.jsonl`（合成值 `SYNTHETIC` / 占位十进制），**不得作为真实数据或验收证据引用**。

覆盖 11 个研究 endpoint（`*.v1`）：

- 日频：daily_basic、index_daily、top_list、top_inst、moneyflow、margin、hk_hold、stk_limit
- 逐标的：fina_indicator（`dt=2023-12-31`，按报告期分区）
- 快照：index_classify（L1/L2/L3 三层，`dt=2026-11-04`）、index_member_all（`is_new=Y`）

重生成（确定性时钟，录播夹具，不联网）：

```bash
cd services/ingest
MARKET_NOW=2026-11-04T15:00:00+08:00 PYTHONPATH=src python3 -m market_ingest sync-research \
  --datasets daily_basic,index_daily,top_list,top_inst,moneyflow,margin,hk_hold,stk_limit,fina_indicator,index_classify,index_member_all \
  --start 2024-01-02 --end 2024-01-02 --instruments SSE:600519 --index-codes SSE:000300 \
  --replay-fixture var/research-ods-smoke/fixture.jsonl --ods-root var/research-ods-smoke \
  --db var/research-ods-smoke/ingest.db --budget-calls 100
```

说明：`load_batches(<root>/internal)` 只认已注册的 endpoint schema；A2 侧需补充
`stk_limit.v1`、`fina_indicator.v1`、`index_classify.v1`、`index_member_all.v1` 后才能读到
这批新增 ODS（现有 7 个 endpoint 已可读）。
