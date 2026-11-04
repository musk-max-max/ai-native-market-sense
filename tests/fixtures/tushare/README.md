# tushare 录播 fixture（A12 owns，A1/A3/A7 消费）

## 这是什么

`recordings/` 存的是 **tushare HTTP 边界的原始响应**（录一次、回放无限次），不是手写假数据，
也不是 canonical 夹具。回放时代理 `tests/e2e/tushare-replay/server.py` 顶替 `api.tushare.pro`，
api 侧 adapter（`services/ingest/adapters/tushare/`）照常做 tushare→canonical 映射——
**adapter 这一跳始终被真实执行**，这是录播放在 HTTP 边界而不是 mock adapter 的原因。

## 目录

```
tests/fixtures/tushare/
├── recordings/<sha256>.json     # 一次 tushare HTTP 调用的请求（去 token）+ 原始响应
├── manifest.json                # 录制清单，由代理在 record 模式自动重建
├── scenarios/p0-stock-page.json # 场景：旅程涉及的 tushare 接口与产品调用顺序（录制/回放共用）
└── README.md
```

单条 recording 结构（schema_version=1）：`kind="tushare-http-raw"`、`scope="raw-source"`、
`key`、`request{api_name,params,fields}`、`upstream_response`、`recorded_at`、`origin`。

## 与 C01 的关系（重要）

C01 禁止「代码.交易所后缀」（如 `600519.SH`）出现在落库/日志/配置/测试夹具。本录播是
**数据源边界原始工件（等价 ODS/raw 层，scope=raw-source）**：tushare 的 HTTP 协议本身就要求
`ts_code=600519.SH`，原始响应也带该字段；若在录制时改写，adapter 的解析路径就不再被真实测试。
因此本目录不适用于 C01 的 canonical 层约束——canonical 层（PG 落库、API 响应、日志）仍必须用
`InstrumentId`（`SSE:600519`）。此定位需 A0/H2 在契约评审中确认（已随 task-7 上报 lead）。

## 录制（本地、需真实 tushare token，禁止进 CI）

```bash
export TUSHARE_TOKEN=...          # H4 提供；脚本不会落盘
bash tests/e2e/scripts/record-fixtures.sh
```

脚本做的事：起 record 模式栈（唯一允许出网的模式）→ 用真实产品跑一遍
`scenarios/p0-stock-page.json` 的 calls → 代理把 tushare 原始响应写入 `recordings/` →
重建 manifest → 关栈。**不要手写/手改 recordings**：key 由规范化请求算 sha256，
preflight 会逐条校验 key 一致性，手改会被判 FIXTURES_CORRUPT。

## 回放（CI/本地默认）

默认 compose 的 app-net `internal: true`：容器结构上无外网出口。缺录制时代理返回
`503 FIXTURE_MISSING`（含 key/api_name/available_api_names），绝不返回伪造成功响应。
preflight 读 `/__health` 判定完整性：`/__livez` 只证明进程活着，`/__health` 才代表 fixture 齐。

## 约定

- `request` 中永远不含 `token`（代理写入前剥离；preflight 断言）。
- 录制时间戳保留（`recorded_at`），但不参与 key——重新录制不应造成无意义 diff。
- 文件名 = key。新增录制后 `manifest.json` 必须同步（代理自动重建；preflight 校验一致）。
- S0 阶段 recordings 为空是预期：等 A1 adapter 注入点 + token 到位后录制。空 fixture 不会被
  E2E 静默忽略：preflight 状态文件与报告里显式出现 `FIXTURES_PENDING` / `FIXTURE_MISSING`。
