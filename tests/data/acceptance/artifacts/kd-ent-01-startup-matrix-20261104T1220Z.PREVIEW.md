# 状态：preview / uncommitted-tree（不是验收件）

- 对象：同目录 `kd-ent-01-startup-matrix-20261104T1220Z.md`（sha256 `bf4a87df9eabe492435e25d953570c2e901aea20e99f3115169b877128d99f44`，3354B）。
- 原因：该次矩阵跑在 **未提交工作树**（`services/market/src/config.ts` 当时为 `M`，A3 的 KD-ENT-01 修复尚未提交），不满足 H5 m03552「签字证据必须绑 commit」。
- 处置：原文件**不删不改字节**；A3 提交修复后，在干净 HEAD 重跑 `pytest tests/contract tests/data`，另出 `kd-ent-01-startup-matrix-<commit7>-<UTC>.md` 新文件（新 sha256），并把 commit 写进 CI_MOUNT §7.12。
- 当前 HEAD 上预期：`pytest tests/data/test_startup_matrix.py` 红（旧实现 E2E_MODE 默认关 hold/audit），这正是 KD-ENT-01 的回归钉，不得关闭 audit 或放宽矩阵来变绿。
