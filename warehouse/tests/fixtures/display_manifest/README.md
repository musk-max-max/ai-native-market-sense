# display_manifest：A2 读取侧的跨 agent 校验产物

用途：验证 **A1 的写入侧**（`verify-manifest`）与 **A2 的读取侧**
（`warehouse.ods.loader.load_display_safety`）对同一条 manifest 的理解一致。
A1 读这个目录，A2 读 `services/ingest/var/audit-demo`，双向通过才算链口径闭合。

形状（H4 m01228 M1/M2 + lead L52）：

- 首条真实事件 `prev_hash` = 64 个 `0`（不是 `GENESIS`）。
- `hash = sha256(prev_hash + "\n" + canonical_json)`；canonical = 键排序、紧凑分隔符、UTF-8，
  排除 `prev_hash` / `hash`。
- 中间夹一条 `synthetic: true`（`display_safe: false`）：整行跳过，不进链/不进 count；
  下一条真实事件 `prev_hash` 跨过 synthetic 行接第一条真实 hash。
- `manifest.head = {"schema_version":1,"count":2,"last_hash":"65b8bc…","updated_at":"…","note":"…"}`
  —— `note` 是故意加的未知键，读取方必须忽略。
- 快照 `snapshots/instruments-<checksum_sha256>.json`，事件带 `snapshot_path` 与
  `snapshot_sha256`（文件字节哈希）；快照内嵌 `checksum_sha256` 与事件一致、`rows` 数一致。

期望值（任何一侧不得擅自改；改了要两边同时改）：

| 事件 | event_id | hash |
| --- | --- | --- |
| A（manual_import display） | `fixture-a2-0001` | `b8d649b7ec4adfd4a357cfa208230c841ec6e048ca7554dfb79f1a07e10f348a` |
| B（official_api display） | `fixture-a2-0002` | `65b8bcb513dd13b14b4eb92433dfae78513ba793cc01b7dcb70f75e4d6365dfe` |

读取结果：`SSE:600519`、`SZSE:000001`、`BSE:830799` 三只标的 `display_safe=True`。

回归锁：`warehouse/tests/test_display_safe.py::test_read_side_fixture_is_valid_and_documents_expected_hashes`
（fixture 被改坏或链口径漂移时 CI 直接红）。

## BOARD 登记（L79）

本目录是合成 fixture（非 11-12 授权件），按 L79 需把 path+sha256 登记进 `agents/BOARD.md`
（BOARD 归 lead；A2 不自写）。逐文件哈希见同目录 `SHA256SUMS`（不含自身）；
BOARD 登记 `SHA256SUMS` 的 sha256（登记时实算，不写回本 README——否则自引用）。
任何文件改动都会使汇总哈希变化；改 fixture 必须同步 A1 的只读引用测试
（`test_verify_manifest_accepts_a2_read_side_fixture`）与本目录 README 的期望值。
