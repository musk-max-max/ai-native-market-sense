# TRANSCRIPTS 索引（A12 · #5 证据 run）

- run_id：`11-12-f1-dom-20261104T0557Z-v2`（索引由包级打包器从逐场景 verdict 生成，不是 transcript 正文）
- 根目录：`tests/e2e/evidence/11-12-f1-dom-20261104T0557Z-v2/`

| 场景 | verdict | generated_at | transcript | playwright exit code |
|---|---|---|---|---|
| expired | PASS | 2026-11-04T13:57:22+08:00 | `tests/e2e/evidence/11-12-f1-dom-20261104T0557Z-v2/expired/transcript.log` | `0` |
| hold_active | PASS | 2026-11-04T13:57:28+08:00 | `tests/e2e/evidence/11-12-f1-dom-20261104T0557Z-v2/hold_active/transcript.log` | `0` |
| hold_stale | PASS | 2026-11-04T13:57:32+08:00 | `tests/e2e/evidence/11-12-f1-dom-20261104T0557Z-v2/hold_stale/transcript.log` | `0` |
| restricted_malformed_403 | PASS | 2026-11-04T13:57:23+08:00 | `tests/e2e/evidence/11-12-f1-dom-20261104T0557Z-v2/restricted_malformed_403/transcript.log` | n/a（malformed：网络层注入，不跑 P0-06/P0-12） |
| unauthorized_config | PASS | 2026-11-04T13:57:17+08:00 | `tests/e2e/evidence/11-12-f1-dom-20261104T0557Z-v2/unauthorized_config/transcript.log` | `0` |

每份 transcript 头部字段：`run_id` / `batch_started_at` / `started_at` / `host` / `uname` / `node` / `python` / `cwd` / `command` / `env（脱敏）` / `finished_at` / `exit code`。
