# infra/db —— 数据库底座（A13 维护）

数据库不是「跑个 SQL 文件」：顺序、幂等、授权边界、生产门禁都在这里固化，避免靠记忆。

## 组成

| 文件                           | 作用                                                                                                                                                                                                    | 属主                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `bootstrap.sh`                 | 按 **DWD → serving → 角色 → 授权（→ 断言）** 执行；单事务；生产需 H5 批准                                                                                                                               | A13                    |
| `sql/10_roles.sql`             | 幂等创建/校正六个角色：`market_app`、`warehouse_loader`、`ci_deploy_writer`、`reconciler`（LOGIN）；`human_hold_clear`、`audit_reader`（NOLOGIN）；无 SUPERUSER/CREATEDB/CREATEROLE/BYPASSRLS，互不继承 | A13                    |
| `sql/15_role_passwords.sql`    | 仅当提供 `APP_DB_MARKET_PASSWORD` / `APP_DB_LOADER_PASSWORD` 时设置密码（psql 变量注入，不硬编码）                                                                                                      | A13                    |
| `sql/20_grants.sql`            | 按进程最小授权：market_app 只读 serving + 自选 DML + 审计列级 INSERT + hold 只读视图；loader 只 DML dwd/dim；ci 列级 INSERT；reconciler 仅函数；audit_reader 只读 + verify 函数                         | A13                    |
| `sql/90_verify_privileges.sql` | 运行时断言「有什么权限」与「没有什么权限」：越权=0 才通过                                                                                                                                               | A13                    |
| `migrations/`                  | 跨服务域的表迁移（如审计/授权状态表，A5 出 DDL、A13 署名执行）                                                                                                                                          | A13 执行 / A5 提供 DDL |
| `../scripts/db-migrate.sh`     | 迁移执行器（shared ledger + sha256 + advisory lock + 生产备份 + 迁移后重跑授权/断言）                                                                                                                   | A13                    |
| `../ci/check-db-bootstrap.mjs` | 以上全部约束的静态门禁（CI 必跑，不连库）                                                                                                                                                               | A13                    |

DDL 单一真源在 `warehouse/dwd/schema.sql` 与 `warehouse/serving/schema.sql`（A2 写域）。本目录**不复制 DDL**，只负责执行顺序与权限。

## 权限模型（按「进程」切，不按「服务」切）

| 角色               | 能做什么                                                                                                                                                   | 不能做什么                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `market_app`       | `serving.*` SELECT；`public.watchlist_items` DML；`audit.entitlement_events` **列级** INSERT（排除 prev_hash/hash）；`audit.entitlement_hold_state` SELECT | 读/写 `dwd_*`/`dim_*`（含 SELECT）；CREATE；TRUNCATE；读审计事件；写 hash 列；改 hold |
| `warehouse_loader` | `public.dwd_*` / `public.dim_*` SELECT/INSERT/UPDATE/DELETE（仅 load 进程）                                                                                | 读 serving、读/写 watchlist、读/写 audit；DDL；TRUNCATE/REFERENCES/TRIGGER            |
| `ci_deploy_writer` | 审计事件列级 INSERT（deploy/tier_switch，从不可变产物写）                                                                                                  | 读事件、改/删事件；hold 任何权限；DWD/serving 读写                                    |
| `reconciler`       | EXECUTE `raise_hold(text,text)` / `mark_reconciled(timestamptz)`；SELECT hold 视图                                                                         | 表级读写；`clear_hold`（只有人能清 hold）                                             |
| `human_hold_clear` | 仅 EXECUTE `clear_hold(text,text,text)`（NOLOGIN，T2 工单 + H5 签字后 SET ROLE）                                                                           | 其他任何权限                                                                          |
| `audit_reader`     | SELECT `audit.entitlement_events` / `entitlement_hold` / `_state`；EXECUTE `verify_entitlement_chain()`                                                    | 任何写；任何写函数 EXECUTE（NOLOGIN，经 SET ROLE）                                    |

为什么不给一个「读写角色」：API 同时要读行情与写自选；若合成一个角色，一次注入就能改 DWD，而 DWD 是所有展示的口径源头。分割后越权会变成运行时 `permission denied`，而不是评审记忆。

补充规则：

- 直读 `public.dwd_*` / `public.dim_*` 对 `market_app` 当场 `permission denied` —— 这是**故意**的，把 A2 写域边界变成运行时错误。
- serving 视图不依赖调用者底层表权限；新 serving view 自动获得 SELECT（`ALTER DEFAULT PRIVILEGES`）。
- 新表默认零授权：两个角色都 `ALTER DEFAULT PRIVILEGES ... REVOKE ALL`，新表授权必须显式写进 `20_grants.sql`。
- 权限模型不依赖 IaC 之外的 `kubectl`/`psql` 手工操作；生产执行只走流水线。

## 待落（等 A5 DDL / H5 卡点）

H5 发布卡点要求把「写事件」再按进程拆细，A13 在 A5 的审计/控制表 DDL 落地后补：

1. `ci_deploy_writer`：仅 INSERT deploy/tier_switch 事件（从不可变产物写，禁止交互式手写）。
2. `reconciler_writer`：写 hold_set/hold_clear 事件 + 更新 control 行 `last_reconciled_at`。
3. hold 的只读入口是 canonical 视图 `audit.entitlement_hold_state`（market_app/reconciler）；基表写/读权限都收掉。
4. `90_verify_privileges.sql` 增加上述三条断言（含「清 hold 只能人做」：market_app 无 UPDATE/INSERT/DELETE）。

## 用法

```bash
# 本地/预发（可重复执行）
infra/db/bootstrap.sh --env dev --dsn "$DATABASE_URL" --verify

# 只打印执行计划（无 psql 也能跑）
infra/db/bootstrap.sh --env dev --dry-run

# 角色密码（生产来自 secret manager，CI 永不设置明文）
APP_DB_MARKET_PASSWORD='***' APP_DB_LOADER_PASSWORD='***' \
  infra/db/bootstrap.sh --env dev --dsn "$DATABASE_URL"

# 生产：必须 H5 批准 + 显式开关；A13 只执行不自批
APPROVAL_REF='<H5 批准链接>' ALLOW_PRODUCTION_BOOTSTRAP=1 \
  infra/db/bootstrap.sh --env production --dsn "$PROD_DSN"

# 迁移（services/*/migrations 与 infra/db/migrations 共用 ledger；生产先 pg_dump 备份）
infra/scripts/db-migrate.sh --env production --dsn "$PROD_DSN" --dry-run
```

## 环境事实（诚实声明）

- 本机无 `psql`、无 PostgreSQL 实例时，`bootstrap.sh` 只验证到 `--dry-run` + 静态门禁（当前 CI 也是这么跑）；**不等于真库执行成功**。
- 真库验证：`bootstrap.sh --verify` + `infra/scripts/db-migrate.sh`（迁移后强制重跑 20_grants/90_verify）。2026-11-04 已在 PG16@55432 scratch 库验证：越权=0、append-only 生效、列级 INSERT 生效、reconciler 重复 raise_hold 不新增事件。
- 审计 canonical DDL 是 `services/compliance/migrations/001_audit_entitlement_events.sql`（A5 写、A5/H3 review）；**禁止在 infra 复制**，详见 `infra/db/migrations/README.md`。
- `audit_reader` 是 NOLOGIN 角色：H3/A16/A14 的**具名身份**经受控 membership 后 `SET ROLE`，不建共享登录账号、不设密码；谁在何时读审计走身份审计，不做人人可用的公共角色。
- seed 事件只允许进**一次性验收库**（`a13_verify`/`a5_l49_final`/…`_e2e`/…`_test`）；脚本对其它库名 `exit 4` 拒绝，确需覆盖必须 `SEED_ALLOW_NON_SCRATCH=1` 且 H4/Lead 批准。保留事件的 `trace_id` 一律 `seed:` 前缀，避免 H3 把假事件当成真实复核签字。
- release 栈 seed 的 `last_reconciled_at=now()-16min` **只服务 A11 #4 的 stale 用例**；用例结束必须 `infra/db/seed-entitlement-audit.sh --restore-fresh`（release-gate 已用 always 步骤兜底），否则默认环境会一直 fail-closed。
- 生产迁移需 A13 在流水线执行、H5 批准；S0 生产发布尚未启用（`deploy.sh` production 分支直接拒绝）。
