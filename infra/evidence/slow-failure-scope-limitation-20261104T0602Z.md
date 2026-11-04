# #4 证据适用范围限定（H4 m02409，2026-11-04T06:02Z）

- **authority**: authoritative（适用范围声明，不是测量数据）
- **phase**: post-fix
- **case_ids**: ["L77","H5-R19"]
- 适用对象：`infra/evidence/slow-failure-tcp-sink-20261104T0555Z.md`（sha256 `e528e6c837cf629ef476f44dbc396a74ee73d1705cb3360ae4e70c8d16b3e10d`）及其 transcript（sha256 `cebf4f22a3a2863f5f0030411cf76267b6ea4614bfdfbc18713735f3a52544a3`）、commit `19df937`；测量字节不改，本条只加限定。

## 强制限定（原文，H4 m02409）

> 本次复跑为 `ENTITLEMENT_TIER=c_end_display` + `ENTITLEMENT_AUDIT=0` 的 test profile；`internal_eval` 档 gate 不读 control，TCP 黑洞在 `/healthz` 上不可见。本证据只表述"已授权档位的黑洞/熔断/恢复行为"，不得推及 11-12 现网（internal_eval）degraded 可见性。

## 对应结论

- #1/#2/#4 的 PASS 只在该 test profile 下成立；
- 11-12 现网 `internal_eval` 档：gate 不读 control，黑洞期间 `/healthz` 不会出现 `control_unavailable`（受控语义，不是缺陷）；`#4` 的 healthz 证据不得用于宣称现网可见 degraded；
- #3 仍为「采样 PASS、封版前置=契约/ADR 文案同步（A0）」，未 closed。
