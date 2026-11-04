# ADR-005：E2E 测试包的安装单元策略（P0）

- 状态：Accepted（2026-11-04，A13 提出、Lead 已确认；H2 会签待补）
- 关联：决策 #2（单仓 pnpm workspace）、ADR-001 D2/D7、`infra/ci/README.md` §e2e、A12 的 `e2e-job.yml.snippet`
- 适用：`tests/e2e`（真栈 docker-compose + 录播 fixture + 关键路径骨架）

## 背景

仓根是 pnpm workspace（`pnpm-workspace.yaml` 的 packages 为 `packages/* services/* web/* jobs`）。`tests/e2e` 的依赖生命周期与运行环境和应用包不同：需要 Playwright 浏览器、docker-compose 真栈、录播 fixture 和独立的 CI job；它不是一个会被应用 `import` 的包。

若把 `tests/e2e` 纳入 workspace，会带来三类成本：

1. **lockfile 抖动**：E2E 的浏览器/驱动依赖版本随 CI runner 变化，牵动根 `pnpm-lock.yaml`，让业务包安装也受影响；
2. **workspace 安装面扩大**：`pnpm install` 会为不参与构建的 E2E 安装全部依赖，拖慢本地与 CI；
3. **path-guard / ownership 负担**：需要为 E2E 增加额外的 workspace 条目与边界规则，收益只是「少一条安装命令」。

## 决策

**E2E 作为独立安装单元，不加入 pnpm workspace。** CI 中在 `tests/e2e` 目录内执行：

```bash
pnpm install --ignore-workspace --frozen-lockfile
```

即：使用 `tests/e2e` 自己的 `package.json`（与可选 `pnpm-lock.yaml`），`--ignore-workspace` 明确让它脱离根 workspace 上下文，`--frozen-lockfile` 保证可复现。A12 的 `e2e-job.yml.snippet` 里历史上的 `npm ci` 仅作参考，正式口径以本 ADR 为准。

## 被否选项及原因

- **A：把 `tests/e2e` 加入 workspace（`pnpm-workspace.yaml` 加 `tests/e2e`）。** 否决：lockfile 抖动、安装面扩大、path-guard 复杂度上升；E2E 不产出可复用类型/库，没有 workspace 化的收益。
- **C：E2E 使用完全独立的仓库/目录（不在 monorepo 内）。** 否决：P0 阶段竖切片需要与契约、录播 fixture、服务代码同仓评审；独立仓会破坏「契约 diff 出现在 PR 描述」的 gate 和 A12 的快速迭代，拆分属 must_escalate，当前无拆分必要。
- **D：CI 全局 `npm install` 替代 pnpm。** 否决：违背决策 #2/#3 的 pnpm workspace 口径，且 `npm` 与 `pnpm` 混用会产生多份 lockfile。

## 后果

- 根 `pnpm-lock.yaml` 与 workspace 安装面保持稳定；`tests/e2e` 的依赖更新只影响自己的 lockfile 与 E2E job。
- `tests/e2e` 下必须维护自己的 lockfile 并在 CI 用 `--frozen-lockfile`；禁止隐式依赖根 `node_modules`（CI 干净环境会直接暴露）。
- path-guard / ownership 不需要为 E2E 增加 workspace 条目；`tests/e2e` 仍归 A12 的写域。
- 若未来 E2E 需要被其它包复用（例如共享 Playwright 工具库），应把它抽成 `packages/*` 而不是把 `tests/e2e` workspace 化。

## 可逆性

高。若未来确实需要 workspace 化，改 `pnpm-workspace.yaml` 并同步 CI 安装命令即可，不涉及契约或数据结构；但需重新评估 lockfile 抖动成本。
