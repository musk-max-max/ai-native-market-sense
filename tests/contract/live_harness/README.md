# G-IMPL 本地实现驱动（无 docker 模式）

`tests/contract/live_impl_check.py` 需要一个真实 HTTP 服务。CI 里用 A12 的
`tests/e2e/docker-compose.yml` 真栈；**没有 docker 的开发机**用本目录的 harness：
它 import A3 的真实 `createMarketPlugin`（路由/序列化/错误映射都是被测代码），
只把 `ServingRepo` / `WatchlistRepo` 换成内存假实现，数据全部合成（`origin=synthetic`）。

## 用法

```bash
services/market/node_modules/.bin/tsx tests/contract/live_harness/harness.ts
# 输出一行 JSON：{"baseUrl":"http://127.0.0.1:<port>"}
python3 -m tests.contract.live_impl_check --base-url <baseUrl>
```

退出码：0=实现符合契约，1=有 LIVE-* 违规，2=配置缺失（都按失败处理，不 skip）。

## 能查什么 / 不能查什么

- 能查：A3 的 HTTP 边界——状态码是否已声明、Content-Type、schema 闭合性、Problem
  语义（code/status/trace_id）、时区+08:00、内部字段泄漏、`meta.adjustment` 回显、
  consumer 依赖字段、停牌/受限态不得返回行情数值。
- 不能查：Postgres/serving view 的 SQL 语义、ingest 幂等、真实 tushare 录播链路——
  那是 A12 真栈 E2E + A1/A2 的范围。假数据里的 `source: platform_eod` 是**契约合法值**；
  真实 serving 行若给 `tushare`，说明 A3 边界缺词表映射（G-IMPL 会以 LIVE-03 抓住）。
