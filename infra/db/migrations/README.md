# infra/db/migrations/

本目录只放**跨域/基础设施**迁移（由 A13 署名执行）；业务表迁移放 `services/<svc>/migrations/`。

## 授权审计表的 canonical DDL 不在这里

`audit.entitlement_events` / `audit.entitlement_hold` / 三个 hold 函数 / 哈希链触发器，
**唯一真源是 `services/compliance/migrations/001_audit_entitlement_events.sql`**（A5 署名）。

原因：2026-11-04 曾同时存在 A13 在 infra 下的初版与 A5 的完整版，db-migrate 依次执行时
第二份 `CREATE TABLE IF NOT EXISTS` 被跳过、随后按其列名建索引直接失败（真实执行暴露）。
两份 DDL 并存必然分叉。最终保留 A5 的合规 schema（列更完整、含 append-only 触发器、
链校验函数、hold 视图），A13 的职责在 `infra/db/sql/20_grants.sql`（授权）与
`90_verify_privileges.sql`（越权断言），以及 `infra/db/seed-entitlement-audit.sh`（release 栈 seed）。

## 现有迁移

- `002_display_safe.sql`：旧库补 `dim_instrument.display_safe` 列；视图重放由
  `infra/scripts/db-migrate.sh` 第 6.5 步执行 `warehouse/serving/schema.sql` 完成。
- `001_audit_entitlement_events.sql`（已删除）：与 A5 canonical 冲突，勿恢复；
  历史见上。

## 迁移文件进入 ledger 后不可改写（L54）

db-migrate.sh 用 `meta.schema_migrations(filename, sha256)` 对账；同一 filename 内容一变，脚本直接 exit 5「迁移文件已被篡改」。这是 fail-closed，不是 bug。

- 生产首次应用 = 仓库当前 001 最终版；
- 此后 001 只要进过任何环境的 ledger，任何改动（哪怕只改函数体）都必须新增 002+；
- S0 验证库（a13_verify）重建后再从 001 重放，不要为保住 scratch ledger 伪造历史。

2026-11-04 现场取证（A13 从空库重建 `a13_verify`，重放 001+002 两遍，第二遍全部 skip；002_audit_gap 封版 sha `c118eeb3…`（L71））：

```
psql -d a13_verify -c "select filename, sha256, applied_at from meta.schema_migrations order by filename;"
infra/db/migrations/002_display_safe.sql|6d240088fba98aede9b1d094161a060f6ffda8dca20ae56330f073d193e0944e
services/compliance/migrations/001_audit_entitlement_events.sql|c8116e4fa5bb0d88da5cbfb643cdebbcfcec6d24853544425ec59cfa8c5ffd5e
services/compliance/migrations/002_audit_gap.sql|c118eeb3950149564c06f73a04d4e2e5561a6a6201abae101502635c30e999da
services/market/migrations/001_watchlist.sql|a877f9d365b45cb0ec7a6a865e3c000745e882f9632fc156f052e3f6dd2a89f4
```

002_audit_gap 终版（`window_start`/`window_end` 冻结口径；`lost_count` 按 reason 分支：transient 整数 ≥1；process_restart 允许 null（重启后计数不可知）或整数 ≥1；缺 window_start 也由 CHECK 拒绝）新增 `recorded_at`（触发器强制 `now()`，不参与链 hash）与第 10 类 `audit_gap`，并把 `schema_version` 默认值放宽为 2；`market_app`/`ci_deploy_writer` 的列级 INSERT **排除 recorded_at**（自证列，由 DB 写入）。
重建前同库曾记录旧版 001（`9db11b3c…`，08:40 应用）；旧库不补丁升级，直接 dropdb/createdb 后从 001 重放。`market_sense` / `market_sense_a19` / `market_a3_test` 当时均报 `relation "meta.schema_migrations" does not exist`，说明 001 从未进过真栈环境。
