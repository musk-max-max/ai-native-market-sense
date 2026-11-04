# tushare 合成录播 fixture（A12 owns，A1/A3/A7 消费）

## 这是什么

`recordings/` 是 **tushare HTTP 边界的合成响应**：结构/字段名镜像 tushare 公开文档，
**值全部伪造且一眼可辨**（`SYNTHETIC-` 前缀、价格 9999.99 等），由
`tests/fixtures/tushare/synthetic/build_recordings.py` 生成，**不录制真实报文**（L32，F1 个人非商业条款：
把真实报文落进仓库等于上游数据再分发）。回放时代理 `tests/e2e/tushare-replay/server.py` 顶替
`api.tushare.pro`，api 侧 adapter（`services/ingest/adapters/tushare/`）照常做 tushare→canonical 映射——
**adapter 这一跳始终被真实执行**，这是录播放在 HTTP 边界而不是 mock adapter 的原因。

## 目录

```
tests/fixtures/tushare/
├── recordings/<sha256>.json     # 一次 tushare HTTP 调用的请求（去 token）+ 合成响应
├── manifest.json                # 录制清单（generated_by=synthetic/build_recordings.py）
├── scenarios/p0-stock-page.json # 场景：旅程涉及的 tushare 接口与产品调用顺序（回放共用）
├── synthetic/build_recordings.py# 合成生成器（值伪造规则 + --check 校验）
└── README.md
```

单条 recording 结构（schema_version=1）：`kind="tushare-http-raw"`、`scope="raw-source"`、
`key`、`request{api_name,params,fields}`、`upstream_response`、`recorded_at`
（`synthetic:2026-11-03` 这类标记）、`origin`（synthetic）。

## 与 C01 的关系（重要）

C01 禁止「代码.交易所后缀」（如 `600519.SH`）出现在落库/日志/配置/测试夹具。Lead 裁定（m00193）：
tushare 原生标识**只允许**出现在 `services/ingest/adapters/**`、`warehouse/ods/` 的 raw 列、
`tests/fixtures/tushare/**`、`tests/e2e/tushare-replay/recordings/**`；DWD 及以上 / `contracts/` /
`web/` / 任何 API 响应里出现即红灯。本目录属第三类（数据源边界原始工件，等价 ODS/raw 层），
canonical 层仍必须用 `InstrumentId`（`SSE:600519`）。

## 合成生成（默认路径，L32：不落真实 tushare 报文）

```bash
python3 tests/fixtures/tushare/synthetic/build_recordings.py          # 重新生成
python3 tests/fixtures/tushare/synthetic/build_recordings.py --check  # 只校验（CI/preflight 可跑）
```

- 生成器按 adapter 实际会发出的 api_name/params/fields 造响应（`daily`、`adj_factor`、`trade_cal`、
  `fina_indicator`、`income`），值全伪造：名称 `SYNTHETIC-甲/乙/丙`、价格 9999.99、量额常量，
  测试断言不得把它们当真实行情。
- key 复用 `tests/e2e/tushare-replay/server.py:canonical_key`（规范化请求的 sha256）；**不要手改 recordings**，
  preflight 会逐条校验 key/结构/无 token，手改会被判 `FIXTURES_CORRUPT`。
- 合成资产单一审计口径：`services/ingest/tools/audit_synthetic_fixtures.py`（A1 交付）覆盖的正是同一批
  `tests/fixtures/tushare/recordings/*.json`，清单落 `services/ingest/var/fixture-inventory.md`；
  e2e replay 与 ingest 不得出现第二套 fixture。

## 回放（CI/本地默认）

默认 compose 的 app-net `internal: true`：容器结构上无外网出口。缺录制时代理返回
`503 FIXTURE_MISSING`（含 key/api_name/available_api_names），绝不返回伪造成功响应。
preflight 读 `/__health` 判定完整性：`/__livez` 只证明进程活着，`/__health` 才代表 fixture 齐。
`MARKET_NOW` 必须 pin（例如 `2026-11-04T15:00:00+08:00`）：`adj_factor` 的 `end_date` 取时钟，
不 pin 会跨天失效，表现为 `FIXTURE_MISSING` 而不是「时间问题」。

## 真实上游录制（默认禁用）

`tests/e2e/scripts/record-fixtures.sh` 保留但**默认禁用**：需 H4 书面批准（`H4_APPROVAL_REF` +
`A12_ALLOW_REAL_TUSHARE=1`）才可运行。L32 的结论是「不该录真实报文」，合成数据足够覆盖形状与异常
（字段缺失、429、部分失败、乱序、重复）；不要把真实报文放进仓库或 release 材料。

## 约定

- `request` 中永远不含 `token`（生成器/代理写入前剥离；preflight 断言）。
- 时间戳保留（`recorded_at`），但不参与 key——重新生成不应造成无意义 diff。
- 文件名 = key。新增录制后 `manifest.json` 必须同步（生成器自动重建；preflight 校验一致）。
- 合成数据用途边界（H1 钉死）：E2E 报告/M2 材料明写「合成样本」，**不进 release note / 对外材料，
  不作为 DA 组证据**。
