# L77 #4 封版：H5 运维签字的 residual 记录（2026-11-04T06:04Z）

- **authority**: authoritative（PASS 记录的伴随限定）
- **phase**: post-fix
- **case_ids**: ["L77","H5-R19"]
- 关联测量：`slow-failure-tcp-sink-20261104T0555Z.md`（sha `e528e6c8…`）、transcript（`cebf4f22…`）、`slow-failure-scope-limitation-20261104T0602Z.md`、`slow-failure-status-addendum-20261104T0600Z.md`。
- 签字：H5 m02596 —— **#4 运维层行为 PASS；#1/#2/#4 closed；#3 维持「采样 PASS」，封版前置=契约/ADR 文案同步（A0/H4），不得写 closed。**

## residual（必须随 PASS 记录，不许省略）

1. **connect 阶段黑洞未真验**：TCP sink 接受连接，只证明「连接建立后挂起」；`connect_timeout=1000ms` 是配置断言，不是行为证据。SYN-drop 类故障未测（无 root 无法构造，已如实记录，不当作已验证）。
2. **故障开始后的首请求延迟未单独测**：已测样本是降级稳态/短路路径（P95 2.7ms）；首请求的 1s 超时路径没有独立样本。
3. **范围仅 test profile `c_end_display`**：`internal_eval` 档 gate 不读 control，不得用此证据宣称 11-12 现网 `/healthz` 可见 degraded。

## 归属

- residual 1/2：测量能力缺口（A13，需具备 NET_ADMIN/SYN-drop 的 Linux 环境）；配置事实见 `infra/evidence/slow-failure-timeouts-20261104.txt`。
- residual 3：产品语义（A3/H5），证据使用方不得外推。
