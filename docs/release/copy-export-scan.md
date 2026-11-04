# 客户端可达出口扫描清单（H3 m00839 / m00870）

扫描范围：`services/api/src`、`services/market/src`、`web/h5/src`（HTTP 响应 body/headers、
Problem title/detail、copy 文本、生产构建 DOM 属性）。扫描日期：2026-11-04。
判据见 `docs/adr/ADR-006-user-visible-copy.md` D4。判据为"客户端可取得"，不是"肉眼可见"。

| #   | 位置                                      | 发现                                                                     | 处置                                                                                                                    | owner | 状态                              |
| --- | ----------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ----- | --------------------------------- |
| 1   | services/api/src/errors.ts（4xx 兜底）    | 旧实现 `title=error.message` 透英文原文                                  | 改为 `ERROR_TITLES`（copy.ts 查表）                                                                                     | A0    | DONE                              |
| 2   | services/api/src/errors.ts（schema 校验） | detail 用 `error.message`（英文）                                        | 改为 `VALIDATION_FAILED_DETAIL`                                                                                         | A0    | DONE                              |
| 3   | services/api/src/errors.ts（404）         | title 硬编码「路由不存在」                                               | 改为 `ERROR_TITLES[404]`（「资源不存在」）                                                                              | A0    | DONE                              |
| 4   | services/market/src/errors.ts:32          | 403 detail 含「（F1）」；同文件域内中文文案（「证券不存在」「请求参数校验失败」「数据不存在」等）自建 | A3 已改：`services/market/src/errors.ts` 全部 import `MARKET_COPY`/`VALIDATION_FAILED_DETAIL`（旧「（F1）」已删）；`config.ts` 注释已与 internal_eval 默认值一致、`ENTITLEMENT_CONFIG_EXPECTED_SHA256` 非 internal_eval 缺省拒绝启动；A0 复扫无域内自拼中文；H3 m01651 复验通过 | A3    | DONE                              |
| 5   | services/market/src、services/api/src     | 响应头/兜底文案                                                          | H3 m01498 裁定生产不发 `X-Entitlement-Cause`（诊断只进事件/日志）。A3 已整体删除该头（无 config 开关、routes 不发、market 单测断言 403 无该头且头值无 expired/hold/stale/unauthorized）；shell 在 `/v1/*` onSend 统一 removeHeader 保留为 defense-in-depth，`app.test.ts` 增 403 头断言；A12 E2E 加响应头扫描仍为 go-live 门禁（不因本项通过而免） | A0/A3/A12 | DONE（H3 m01651 复验通过）        |
| 6   | web/h5/src/data/apiGateway.ts:49          | 前端兜底文案表重复（ENTITLEMENT_RESTRICTED→中文）                        | 迁入 `web/h5/src/lib/copy.ts` 统一引用，删重复表（A7 已回报完成）                                                        | A7    | DONE                              |
| 7   | web/h5/src/lib/copy.ts                    | 曾用 `2026.11.4.frontend.json`（无 hash，违反 D3）；现有 COPY_VERSION=2026.11.4 与快照/hash 校验 | 实际快照为 `2026.11.4.aa617e39c03e.frontend.json`（manifest `P0-pre-2` 行，139 条文案；f0282/0172/f55 均已删除并各留墓碑）；A7 已同步校验脚本，`copy-manifest --check` 取 aa61 | A7    | 待复验                             |
| 8   | web/h5 生产 DOM                           | `data-problem-code` 等 `data-*`/aria 若带内部码即出口                    | 生产构建剥离（A7 已回报：DOM/bundle 不再出现语义内部码，并加 bundle/dom 合规脚本）；A7 实际选择生产**完全不下发** `data-problem-code`（比单值更严）；若保留则属性值只允许单一 `entitlement` | A7    | 待复验                             |
| 9   | services/api/test/app.test.ts             | 断言 400/404/500 响应不含 F1/厂商名/tier/`source_id`/错误码原值/英文原文 | 已新增测试，11 passed（含 no-store/分页/429/403 头断言）                                                                            | A0    | DONE                              |
| 10  | E2E 全链路                                | 所有客户端可见响应统一扫描                                               | A12 在 E2E 加出口扫描断言（H3 验收线）                                                                                  | A12   | OPEN                              |

已确认非出口（不处置）：

- 服务端内部常量/类型（`internal_eval` 等）只参与判定，不写入响应；`services/api/src/errors.ts` 的
  `ProblemCode` 联合类型不是输出。
- `services/market/src/cache.ts` 的 `source_id` 仅内部缓存/审计，`domain/build.ts` 不写入响应 `meta`。
- ADR/内部文档中的厂商名不是客户端可达出口（C01b 门禁已排除）。
