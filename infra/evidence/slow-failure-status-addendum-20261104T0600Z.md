# #4 封版状态补充（2026-11-04T06:00Z）

- **authority**: authoritative（状态说明，不是测量数据）
- **phase**: post-fix
- **case_ids**: ["L77","H5-R19"]
- 关系：补充 `slow-failure-tcp-sink-20261104T0555Z.md`（测量 artifact，字节不改；本条为状态口径，不覆盖测量）。
- 对象：`infra/evidence/slow-failure-tcp-sink-20261104T0555Z.md` sha256 `e528e6c837cf629ef476f44dbc396a74ee73d1705cb3360ae4e70c8d16b3e10d`、transcript sha256 `cebf4f22a3a2863f5f0030411cf76267b6ea4614bfdfbc18713735f3a52544a3`、commit `19df937`。

## 分项状态（H4 m02472 / A3 m02544）

| 项 | 状态 | 依据 |
|---|---|---|
| #1 connect_timeout ≤1s | **closed** | Pool connectionTimeoutMillis/query_timeout/statement_timeout = 1000ms；control 读 withTimeout 1000ms |
| #2 黑洞 quote 403+no-store P95≤1500ms | **closed** | 20/20 403、no-store、P95 2.7ms |
| #3 受限 403 P95≤50ms（whitelist quote/bars/fundamental-summary） | **采样 PASS，封版前置未清** | 30/30 403、no-store、P95 1.0ms；但 `contracts/shared/openapi.yaml:187/243/253` 与 `docs/adr/ADR-001:57` 仍是旧「404 优先/未收录不得 403 掩盖」文案，须 A0 同步契约/ADR 后才能把 #3 记 closed（H4 口径；A3 m02544） |
| #4 撤黑洞 ≤30s 恢复 + healthz reason | **closed** | 2.04s 首条 200、同进程未重启；healthz `entitlement_degraded_reason=control_unavailable`，无 DSN/主机/端口 |
| healthz 可见性前提 | 记录 | 仅 c_end_display 档（gate 读 control）可见 `control_unavailable`；internal_eval 档不读库、黑洞不可见（产品语义，已同步 A11/H5） |

**结论**：#1/#2/#4 closed；#3 采样 PASS（1.0ms，非旧 v2 的 1011ms），**不标完全 closed**，待 A0 契约文案同步后由 Lead 封版。没有把"403 永久先于 404"写进任何结论；正常档仍是 404→403→取数 404。
