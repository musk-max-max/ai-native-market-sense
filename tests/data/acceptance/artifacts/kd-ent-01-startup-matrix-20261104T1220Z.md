# KD-ENT-01 启动矩阵证据（A11，2026-11-04T12:20Z）

- 缺陷：`E2E_MODE=1` 默认关 hold/audit 且跳过 EXPECTED_SHA256 自检（H5 m03570），e2e+c_end_display+raise_hold 实测 200 真实行情。
- 门禁：`tests/data/test_startup_matrix.py` + `tests/data/acceptance/startup_matrix_runner.ts`（tsx 黑盒：`loadMarketConfig` + `createMarketPlugin` 真实 listen 127.0.0.1:0）。
- 矩阵：3 profile（prod/e2e/test）× tier（internal_eval/c_end_display）× 授权控制状态（missing / 显式 0 / 配齐）= **15 组合**；另两条全局断言（无 fail-open 组合、维度覆盖）。
- 判据：
  1. `tier != internal_eval` 且 flags 缺失/显式 0 → 必须拒启（配置抛错，不 listen）；
  2. 放行组合必须真实监听，且 `holdCheck=auditEnabled=expectedSha256Present=true`；
  3. 拒启原因必须 ∈ `BLOCKING_REASONS`（`config_mismatch`），不得静默放行；
  4. `internal_eval` + flags 缺失时默认仍 hold/audit=true（E2E_MODE 不改默认值）；显式 0 仅 internal 档允许。
- EXPECTED_SHA256 样本：`sha256("c_end_display|2026-12-31T16:00:00.000Z")` = `d1eb0f62e8a28299479a886e5bb04672e7ce9a2a31a8ef09a8a7024315d4f15f`。
- 阻断集合（从 `services/market/src/domain/entitlement-gate.ts` 解析）：`['audit_write_misconfigured', 'config_mismatch', 'control_missing', 'control_stale', 'control_unavailable', 'expired', 'hold_active']`。

## 实跑（tsx 输出逐条）

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

结果：**17 passed**（`python3 -m pytest tests/data/test_startup_matrix.py -q`）。运行环境：本机 working tree（A3 的 `services/market/src/config.ts` 修复**尚未提交**，见 `git status` 的 `M services/market/src/config.ts`）——因此该门禁在当前 HEAD 上会红，A3 提交后转绿；这正是 KD-ENT-01 的回归钉。

## 与 KD-ENT-01 的对应

- `e2e-cend-missing` / `e2e-cend-zero` → `False`，message 为「必须显式配置 ENTITLEMENT_HOLD_CHECK=1、ENTITLEMENT_AUDIT=1、ENTITLEMENT_CONFIG_EXPECTED_SHA256」；
- `e2e-internal-missing` → 启动且 hold/audit 均为 true（E2E_MODE 不再改默认值）；
- `prod-internal-zero` / `prod-cend-zero` → 仍按 L73 拒启（放行 flag 不因 tier 放宽）。
