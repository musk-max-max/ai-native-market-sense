SYNTHETIC — 非真实取数

本目录是**合成样例**，不是真实导入证据：CSV 为本地占位（5 只切片标的），
`replay/stock_basic.jsonl` 为手写回放夹具，未访问任何交易所/tushare 接口。
所有 manifest 事件都带 `"synthetic": true`；真实批禁止携带该字段（H4 m01335）。

用途：给 H4 看 11-12 主数据审计机制的**形状与执行路径**：
- 成功批：`channel=manual_import`、`status=succeeded`、**`display_safe=false`**（synthetic 行
  永不作为展示依据）、含
  `snapshot_path`/`snapshot_sha256`、`run_id`、`source_url`、`source_sha256`（原始 CSV
  载荷哈希，与内容哈希 `checksum_sha256` 区分）；
- blocked 批：改名无公告依据 → exit 4、`display_safe=false`、无 ODS 产物；
- 内部交叉校验批：`channel=tushare`、`display_safe=false`，独立 checksum（internal 形状
  9 字段 vs display 7 字段）。
时间戳统一 UTC（`Z`，毫秒）。`synthetic` 事件**不进真实链、不进 head.count**：真实事件的
`prev_hash` 跨过 synthetic 行接上一条真实 hash；synthetic 行另有自己的独立链，
`prev_hash` 首条为 64 个 `0`（H4 m01552 M1，不用字符串哨兵）。`hash = sha256(prev_hash + "\n" + canonical)`，
canonical = 去 `prev_hash`/`hash` 后 `sort_keys`、UTF-8、无空格。

成功事件字段：`snapshot_path`（相对 manifest root）与 `snapshot_sha256`（**快照文件字节**
sha256，H4 m01496）；`checksum_sha256` 是批次内容身份（同时是快照文件名与快照内嵌值），
`source_sha256` 是原始 CSV 载荷哈希——三者用途不同，不要混读。

本目录的 synthetic 事件均不写 `manifest.head`（head 只统计真实事件）。真实链+head 的
可复现 smoke 生成在 `services/ingest/var/audit-demo/`（dev 产物，目录内有 `DEMO` 标记；
供 A2/A11 机制冒烟，**不是 11-12 证据、不得进 release 证据目录**）：

```
PYTHONPATH=src python -m market_ingest verify-manifest --manifest-root var/audit-demo --allow-demo
```

复现（确定性时钟，见 A12 m01420）：

```
MARKET_NOW=2026-11-03T15:00:00+08:00
PYTHONPATH=src python -m market_ingest sync-instruments --source csv \
  --csv-file samples/_synthetic/base_info.csv --channel manual_import \
  --operator synthetic-sample-generator --synthetic \
  --source-url https://example.invalid/e2e/base_info.csv \
  --terms-version synthetic-terms-v1 --terms-file samples/_synthetic/terms-synthetic.txt \
  --credential-ref sha256:<csv 文件哈希> \
  --manifest-root samples/_synthetic/run/audit --ods-root samples/_synthetic/run/ods \
  --db samples/_synthetic/run/ingest.db

PYTHONPATH=src python -m market_ingest verify-manifest --manifest-root samples/_synthetic/run/audit
```
