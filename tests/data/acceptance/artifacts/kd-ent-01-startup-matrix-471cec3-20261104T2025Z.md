# KD-ENT-01 启动矩阵证据（commit-bound）

- 绑定 commit：`471cec31f1e61382dff248f73f03d86c3bd0e997`（`git rev-parse HEAD`；该树包含 A3 修复提交 `f9e5506` 与 A11 门禁提交 `4803d0d`/`ee33117`）
- 运行目录：`git worktree` 干净 HEAD；跑前 `git status --porcelain` = 空（`node_modules` 工具链接由 `.git/info/exclude` 忽略，不入工作树）
- 命令与退出码：
  - `git status --porcelain` → 空，exit 0
  - `python3 -m pytest tests/contract tests/data -q` → `191 passed, 2 warnings`，exit 0
  - `python3 -m pytest tests/data/test_startup_matrix.py -q` → `18 passed`，exit 0
- 脚本：`tests/data/test_startup_matrix.py` + `tests/data/acceptance/startup_matrix_runner.ts`（真实 `loadMarketConfig` + `createMarketPlugin` + `listen 127.0.0.1:0`）
- 矩阵：profile∈{prod,e2e,test} × tier∈{internal_eval,c_end_display} × 授权控制∈{missing,显式0,配齐} = 15 组合
- 判据：①`tier!=internal_eval` 且 flags 缺失/0 → 拒启且不监听；②放行组合必须真实监听且 hold/audit/sha true；③拒启 reason ∈ `BLOCKING_REASONS`（`config_mismatch`）；④`internal_eval`+缺失默认 hold/audit=true（E2E_MODE 不改默认值），显式 0 仅 internal 允许；⑤静态断言：`entitlementHoldCheck:`/`entitlementAuditEnabled:` 表达式不得引用 `e2eMode`/`E2E_MODE`。
- 阻断集合（从 `services/market/src/domain/entitlement-gate.ts` 解析）：`['audit_write_misconfigured', 'config_mismatch', 'control_missing', 'control_stale', 'control_unavailable', 'expired', 'hold_active']`

## 15 组合实跑

| id | tier | started | hold | audit | sha | refusal |
|---|---|---|---|---|---|---|
| `prod-internal-missing` | internal_eval | True | True | True | False | - |
| `prod-internal-zero` | - | False | - | - | - | config_mismatch |
| `prod-cend-missing` | - | False | - | - | - | config_mismatch |
| `prod-cend-zero` | - | False | - | - | - | config_mismatch |
| `prod-cend-complete` | c_end_display | True | True | True | True | - |
| `e2e-internal-missing` | internal_eval | True | True | True | False | - |
| `e2e-internal-zero` | internal_eval | True | False | False | False | - |
| `e2e-cend-missing` | - | False | - | - | - | config_mismatch |
| `e2e-cend-zero` | - | False | - | - | - | config_mismatch |
| `e2e-cend-complete` | c_end_display | True | True | True | True | - |
| `test-internal-missing` | internal_eval | True | True | True | False | - |
| `test-internal-zero` | internal_eval | True | False | False | False | - |
| `test-cend-missing` | - | False | - | - | - | config_mismatch |
| `test-cend-zero` | - | False | - | - | - | config_mismatch |
| `test-cend-complete` | c_end_display | True | True | True | True | - |

## 对照 KD-ENT-01 缺陷

- `e2e-cend-missing` / `e2e-cend-zero` → 拒启，message「ENTITLEMENT_TIER=c_end_display 必须显式配置 ENTITLEMENT_HOLD_CHECK=1、ENTITLEMENT_AUDIT=1、ENTITLEMENT_CONFIG_EXPECTED_SHA256」；
- `e2e-internal-missing` → 启动且 hold/audit=true（E2E_MODE 不再改默认值）；
- `prod-internal-zero`/`prod-cend-zero` → 按 L73 拒启；
- 旧 preview 证据 `kd-ent-01-startup-matrix-20261104T1220Z.md`（sha `bf4a87df…`）与 `.PREVIEW.md` 字节未动。
