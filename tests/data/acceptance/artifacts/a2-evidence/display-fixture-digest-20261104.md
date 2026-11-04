# A2 display_manifest fixture 验收（A11 收件，2026-11-04）

- 目录：`warehouse/tests/fixtures/display_manifest/`
- bundle digest（`SHA256SUMS` 文件的 sha256）：`7f2a19491b38826d15c90f460033014b6de016c805e6d8a52994108879af6cb4`
- 旧值 `a4bfd64834aab50c1ed8f50a62adeaaa1c7fab1acd65f4dc6f61429da5628c8b` 作废（A2 去掉了文档里的 `mNNNNN` 后重算）
- 验收命令与结果：
  - `cd warehouse/tests/fixtures/display_manifest && shasum -a 256 SHA256SUMS` → `7f2a1949…`
  - `python3 -m pytest warehouse/tests/test_display_safe.py -q` → `31 passed`
- 版本纪律：v3/v4 证据包引用旧 digest 的**不就地改**；本文件随 v4 以新文件名入包，v3 包保持不动。
- 下一步（A2 已声明）：下一版 fixture 起拆 `payload_digest`（manifest.jsonl+snapshots）/`bundle_digest`（含 README/head/SHA256SUMS）。
