# infra/ci —— CI 门禁（A13 维护）

所有脚本**零依赖**（Node 内置模块 / bash），原因：path guard 与仓库探测必须在 `pnpm install` 之前、甚至在没有任何依赖时就能跑；门禁本身不应该成为供应链风险。

## 门禁清单

| 入口                           | 作用                                                                                                                                                   | 何时 skip                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| `path-guard.mjs`               | 按 `ownership.yaml` 校验写域；越界写 → 失败；`--self-test` 自检                                                                                        | 永不 skip                         |
| `has.mjs`                      | 仓库存量探测；供 workflow 判断「有没有东西可查」                                                                                                       | —                                 |
| `typecheck.mjs`                | 逐个 workspace 跑 `tsc -p`                                                                                                                             | 没有任何 tsconfig 时显式 skip     |
| `contract-diff.mjs`            | redocly lint + oasdiff 1.35.0 breaking diff（按域）+ `--severity-levels contracts/oasdiff-severity.txt`（缺文件即失败，PR/baseline 同口径，无 waiver） | 非 git/无基线；无契约目录         |
| `check-runbooks.mjs`           | 每条告警必须有 runbook；runbook 六段齐全；SLO 目录 9 条；AI 四项                                                                                       | 告警与 runbook 都为空             |
| `check-db-bootstrap.mjs`       | DB bootstrap 顺序/幂等/两端授权边界/迁移 ledger 静态校验（两角色模型）                                                                                 | 永不 skip（无 DB 也跑）           |
| `check-entitlement-config.mjs` | 授权配置 fail-closed（Helm 显式注入 + 正反渲染 + e2e 默认 internal_eval + 禁默认 c_end_display + APP_PROFILE=prod 渲染断言）                           | 无 helm 时渲染检查 skip，静态仍跑 |
| `check-source-vocabulary.mjs`  | 对外契约/生成产物禁止供数厂商标识；`SourceRef.source` 必须平台词表 enum（A0 新增，A13 维护）                                                           | 永不 skip                         |
| `check-all.mjs`                | 本地一键跑上述门禁                                                                                                                                     | —                                 |

## e2e 是「独立安装单元」（重要，2026-11 已拍板 B）

`tests/e2e` **不在** `pnpm-workspace.yaml` 的 packages 里（只有 `packages/* services/* web/* jobs`）。
因此**不能**在该目录直接跑普通 `pnpm install`：pnpm 会上溯到根 workspace，结果 `@playwright/test`
不会装进 `tests/e2e/node_modules`，`playwright test` 报找不到包。

CI 固定做法（`.github/workflows/ci.yml` 的 `e2e` job）：

```bash
cd tests/e2e
pnpm install --ignore-workspace --frozen-lockfile
pnpm exec playwright install --with-deps chromium
pnpm exec playwright test
```

理由：e2e 的依赖生命周期（浏览器二进制、录播 fixture、docker compose）与应用依赖不同；混进根
workspace 会让每次 `pnpm install` 变慢变脆。`tests/e2e/pnpm-lock.yaml` 必须独立提交，`--frozen-lockfile`
保证可复现。

`tests/e2e/ci/e2e-job.yml.snippet`（A12 提供）里用的是 `npm ci`；以本文件与 `ci.yml` 为准，snippet
仅作历史参考。

## 当前门禁状态（2026-11-04，诚实口径）

| job           | 现状                          | 说明                                                                                                                                                                                                                                      |
| ------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lint`        | ✅ 本机通过                   | `eslint .` + `prettier --check .`                                                                                                                                                                                                         |
| `format`      | ✅ 本机通过                   | 同 lint job                                                                                                                                                                                                                               |
| `typecheck`   | ✅ 本机通过                   | packages/api-client、web/h5 有 tsconfig；其余 workspace 无 tsconfig 时显式 skip                                                                                                                                                           |
| `unit`        | ✅ 本机通过                   | infra/ci/test 16 passed；业务测试缺失不伪装通过                                                                                                                                                                                           |
| `contracts`   | ✅ 本机通过                   | redocly lint 4 份契约 + oasdiff 1.35.0 版本锁定 + 词表门禁；破坏性 diff 在本机（非 git）skip，CI 会执行                                                                                                                                   |
| `path-guard`  | ✅ 本机通过                   | 注册表 26 条 + self-test 13 项                                                                                                                                                                                                            |
| `runbooks`    | ✅ 本机通过                   | 5 篇 runbook / 18 条告警全绑 runbook / AI 四项 + StalePageNotMarked                                                                                                                                                                       |
| `web-quality` | ✅ 本机通过                   | check:budget（79.1/200KB gzip）、check:testids（25 id 对齐）                                                                                                                                                                              |
| `db-schema`   | ✅ 本机通过（静态）+ 真库复验 | 110 项断言（六角色）；2026-11-04 在 PG16@55432 scratch 库跑通 bootstrap → 迁移 → 授权 → 越权=0（含 hold 视图、列级 INSERT、append-only、reconciler 幂等）                                                                                 |
| `iac`         | ✅ 本机通过                   | terraform fmt/validate（dev+preview）、helm lint/template、授权 fail-closed 正反渲染（19 项）、promtool 28 rules、actionlint、shell -n                                                                                                    |
| `e2e-static`  | ⚠️ 未在 CI 跑过               | 静态断言 / 录播代理 / preflight --offline，本机可跑；首次 CI 运行前不等于通过                                                                                                                                                             |
| `e2e`         | ⚠️ **CI 未验证**              | 真栈已用「本机 PG + 直连 DSN」跑过：10 passed / 1 skipped（P0-10 缺 replay 资产），见 agents/BOARD.md §6；**CI runner 上从未跑过**，compose 路径仍未验证。`continue-on-error: true` + 显式「未验证」；首次在 runner 连续 3 次绿后才转必绿 |

## e2e 验证到哪一步为止（诚实声明）

**已发生的事实**（Lead 2026-11-04 亲自跑，agents/BOARD.md §6）：本机无 docker 但用 brew PostgreSQL 16 +
真 `services/api` + 真 `web/h5/server.mjs` + 真 `warehouse.load` 跑通真栈，`npx playwright test` =
**10 passed / 1 skipped**（P0-10 缺 replay 资产）。所以「e2e 完全没验证」是错的；但**compose 路径与
GitHub runner 上的 e2e 仍未跑过**，两者不能混为一谈。

在没有 docker 的环境里，CI 的 `e2e` job 能验证的只有：

1. compose 文件结构不退化（真栈服务齐全、断网、fixture 只读挂载、禁止真实外呼）——`validate_compose.py`；
2. 录播代理本身可单测——`tushare-replay/test_server.py`（pytest）；
3. preflight 离线分支不崩（SKIP=78 而非 FAIL）——`preflight.py --offline`；
4. Playwright 配置/spec 可被解析（依赖装不上时连这步都危险）。

**不能**验证：浏览器真实渲染、compose 全栈联调、CI 环境网络/浏览器依赖、P0 页面在 CI 的可用性。
所以：`e2e` job 在 CI 里存在，但**不诚实地说它绿**；它第一次在 GitHub runner 上跑通之前，
`ci-gate` 的通过**不构成 e2e 通过**。复现记法固定为「命令 + 环境 + 结果」三元组（见 tests/e2e/RUNBOOK.md）。

## 授权配置 fail-closed（H5 卡点，2026-11 新增）

H5 抓到过真实 fail-open：Helm values 少写 `ENTITLEMENT_TIER`/`ENTITLEMENT_EXPIRES_AT`，部署后服务按代码默认
`c_end_display` 展示行情。现在：

- Helm 必须显式注入两个 key；`config.ENTITLEMENT_TIER` 由 `required` 强制；非 `internal_eval` 且
  `ENTITLEMENT_EXPIRES_AT` 为空 → **渲染失败**（fail-closed），dev/preview 也显式写 `internal_eval`。
- `node infra/ci/check-entitlement-config.mjs` 把上述约束 + E2E compose 默认档 + 禁止默认 `c_end_display`
  变成门禁（CI `iac` job 必跑；本地 `HELM_BIN=/tmp/tools/helm`）。
- 真库侧授权边界由 `check-db-bootstrap.mjs`（81 项）守，真库执行仍以 `bootstrap.sh --verify` 为准。

## preview 成本控制（lead 2026-11 指令）

- 按需创建：只有 PR 打 `preview` label 才起（不再每次 push 都起）。
- 24h 回收：`.github/workflows/preview-reap.yml` 每 6h 跑 `infra/scripts/preview-reap.sh`，
  按 `.preview-state/pr-*.tfstate` mtime / `helm list` updated 回收超龄环境；Terraform `ttl_hours` 默认 24（上限 72）。
- 配额：preview namespace quota 8 pods / 2 CPU / 4Gi（limits 4 CPU / 8Gi），无本地 PG/Redis 常驻
  （当前 chart 只部署 api/worker，数据库为外部/共享，不是每 PR 一套 PG+Redis）。
- 无 `KUBE_CONFIG` 时预览与回收都显式 skip，不制造「已起/已收」的假象。

## CI 工作流

- `.github/workflows/ci.yml`：PR + push main。detect → lint / typecheck / unit / contracts / path-guard /
  runbooks / web-quality / db-schema / iac / e2e-static / e2e → ci-gate。失败或取消 = 红灯；
  `e2e` 例外（`continue-on-error` + 显式未验证，见上表）。
- `.github/workflows/preview.yml`：PR 打 `preview` label → 起 preview；关闭 → 销毁（`infra/scripts/preview-*.sh`）。
- `.github/workflows/preview-reap.yml`：每 6h 回收 >24h 的 preview（成本兜底）。
- `.github/workflows/deploy-dev.yml`：手动触发，部署 dev（非生产；生产发布 S0 未启用）。
- `.github/workflows/rollback.yml`：手动触发 + 审批环境，回滚（生产需 H5 批准，A13 执行）。

## 本地复现

```bash
node infra/ci/check-all.mjs          # path guard / runbooks / contracts / db
bash -n infra/ci/*.sh infra/scripts/*.sh
actionlint                           # 需本地安装（见 docs/adr 或 /tmp/tools）
```

## 诚实声明

本机无 docker，无法用 `act` 跑 GitHub Actions；workflow 的正确性由 `actionlint` + 手工重放各 step 命令
保证，首次 CI 运行以 GitHub 上的实际结果为准。

## 证据包 manifest（H5-R19，11-12 硬门禁）

- `infra/evidence/evidence-manifest.json` 是唯一索引：每条 `path/sha256/bytes/authority/phase/case_ids/recompute`。
- `node infra/ci/check-evidence-manifest.mjs`：文件存在 + size>0 + sha256 **由脚本独立复算** + 目录覆盖 100%；`--tarball <pkg>` 时校验 tar 内文件集合与 manifest 一一对应。
- 不扫描 artifact 内容里的十六进制串（H5-R21：会误伤引用其他哈希的 transcript）；自指哈希只允许以 `errata` 记差异，权威值在 manifest。
- 内容一改必须换新文件名（UTC 时间戳）并保留旧文件；manifest 不内嵌自身哈希。

## ci-gate 状态口径（H2 L79/H5 L74）

- 只允许 `PASS / PARTIAL / FAIL / PENDING-H5`；不允许无条件打印「CI 通过」。
- 当前 ci-gate：e2e 非 success → 状态固定 `PARTIAL`（明确写「不代表 e2e 已验证」）；台账 `.ci/e2e-ledger.jsonl`（run_id/attempt/sha/event/ref/e2e result）每 run 一行，artifact `e2e-ledger`。
- S1 转必绿：连续 3 次 success（以台账为准）后，e2e failure 计入红灯；在此之前的任何发布说明只能写 `PARTIAL`。
