# 前端合规出口清单与四态文案映射（A7 / H3 交付）

> 版本轴：`COPY_VERSION = 2026.11.4`（与后端同一轴，ADR-006 D2）。
> 单一来源：`web/h5/src/lib/copy.ts`。除该文件与下方列明的数据源外，`web/h5/src` 不得出现中文文案。

## 1. 客户端可取得出口清单（“客户端可取得”即出口，不要求肉眼可见）

| # | 出口 | 内容来源 | 约束 | 校验 |
| --- | --- | --- | --- | --- |
| 1 | 页面可见文本 | `copy.ts` | 不得硬编码；403/429 等不得临场解释 | `test/compliance.test.ts`「除 copy.ts 外无中文字面量」 |
| 2 | 错误提示（标题/说明/提示） | `copy.ts` 的 `errorCopy(status, network)` | 只按 HTTP status 映射，不按内部 `code`、不读 `Problem.detail` | 同上；四态测试 |
| 3 | DOM 属性 | 业务语义值（`data-source` 为契约公开枚举、`aria-*` 为可访问性语义） | 不出现 `data-problem-code`；生产不输出内部错误码 | `scripts/check-dom-compliance.mjs` |
| 4 | JS/CSS/HTML 产物 | 源码常量 | 不含厂商名/`internal_eval`/`c_end_display`/`channel=`/`source_id`/`ENTITLEMENT_RESTRICTED`/`tier`/`积分套餐`；`F1` 按形态判定：高置信（中文/括号/引号上下文）直接红，裸 `F1`（键盘键名）进低置信清单，须发版时人工在 `scripts/f1-low-confidence-ack.json` 签字（含 `COPY_VERSION` 与清单 hash），否则构建失败 | `scripts/check-bundle-compliance.mjs`（`pnpm build` 自带） |
| 5 | sourcemap | 构建 `sourcemap: false` | 生产不下发 sourcemap；开启时必须重新跑负向扫描 | `vite.config.ts` + bundle 扫描 |
| 6 | 免责/来源/时点 | 服务端 `meta.disclaimer`、`meta.source` | 原样展示，不折叠、不可关闭；来源标识经 `SOURCE_LABELS` 转人话 | E2E P0-04/05 + `data-source` 断言 |
| 7 | 埋点字段 | `lib/analytics.ts` 白名单 | 仅 `instrumentId`/`route`/`uiState`/`action`；无用户标识、无渠道/来源内部 ID；不接第三方/境外 | `test/compliance.test.ts` 白名单用例 |

例外（经验证，不属“文案实现”）：

- 证券名称、代码：来自 API 契约数据，必须与接口一致，不由前端改写；
- 免责正文与版本：来自服务端 `meta.disclaimer`（版本化下发），前端只展示；
- `index.html` 的 `<noscript>`：JS 未启用时无法读取 `copy.ts`，文案与 `copy.app.noscript` **双向**逐字一致（比对前规范化空白与 HTML 实体），由测试锁定；文案不得含授权/供应商/牌照/「暂不提供」类解释。

## 2. 四态文案映射

| 状态 | 触发条件 | 用户看到 | 明确不出现 |
| --- | --- | --- | --- |
| 正常 | 行情 200 且 `meta.entitlement.is_entitled === true` | 价格/涨跌幅/`as_of`/来源/口径/免责/基本面 | 无 |
| 受限 403 | 行情 403（`ENTITLEMENT_RESTRICTED` 等） | 「数据暂不可用」+「当前版本暂不提供该标的行情数据，本页不会展示任何价格数字。」+「该数据在当前版本中不提供。」+ 免责；**不提供重试按钮**（确定状态，不暗示可恢复） | 任何价格数字、占位 `0`/`--`/骨架数字位、授权/牌照/未取得/网络异常/加载失败/不存在/退市/稍后重试 |
| 429 | 行情 429 | 「请求暂时无法处理」+「当前请求暂时无法完成，请稍后重试。」 | 频繁/限流/阈值/额度等内部原因 |
| 断网 | `navigator.onLine === false` 或请求网络异常 | 「网络连接不可用」+ 重试按钮 | 旧缓存数值、旧价格占位 |
| 5xx / 未知 | 其它状态码 | 「服务暂时不可用」/ 兜底文案 | 英文原文、内部错误码、trace id |

唯一放行条件：`meta.entitlement.is_entitled === true`（在 `data/apiGateway.ts` 判断）。
没有前端 env/flag 放行路径；mock 适配器只在 `import.meta.env.DEV` 下装配，生产构建被摇树删除。

缓存旁路（H4/H5）：无 Service Worker、无 SSR/预渲染；`server.mjs` 对 `/v1/*`（含 403）强制
`Cache-Control: no-store, no-cache, must-revalidate`，HTML `no-store`，带 hash 的静态资源长缓存。

## 3. 断言与运行

```bash
cd web/h5
pnpm test                 # copy 单一来源、403/429 文案、埋点白名单、版本轴、noscript
pnpm check:copy           # copy.ts ↔ docs/release/copy-snapshots/2026.11.4.frontend.json 逐字一致
pnpm build                # tsc + copy 快照校验 + vite build + 生产产物负向扫描
pnpm check:dom            # 需先起生产服务：BASE_URL=http://127.0.0.1:3011 …
```

- `pnpm build` 在以下情况失败：文案改了但没升 `COPY_VERSION`/没更新快照/manifest 未登记前端 hash；产物含内部标识。
- 发版：改文案 → 升 `COPY_VERSION`（与后端同轴，由 A0 发版对齐）→ `node scripts/copy-snapshot.mjs --write`（生成 `<version>.<hash12>.frontend.json`）→ 在 `docs/release/copy-version-manifest.md` 追加一行（前后端成对登记，写实际文件名）→ 重新签 `scripts/f1-low-confidence-ack.json`（版本变化即需重签）。
- DOM 断言：`docs/adr/ADR-006` D4 清单；`data-problem-code` 不保留，生产 DOM 无任何语义内部码。

## 4. 已知边界

- E2E 关键文案（「已自选」「原始披露」「元」、`as_of` ISO）保持逐字不变；如涉及具体品种投资分析/选择/时点表述，需 H3 预审。
- 需求方若要求新增“演示模式”，必须先走 H3 合规评审：本前端不提供任何数值放行开关。
