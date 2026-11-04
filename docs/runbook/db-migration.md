# RB-DB-001 · 数据库 bootstrap / 迁移失败与只读权限异常

- **Runbook ID**：RB-DB-001
- **Owner**：A13（执行）/ A2（warehouse DDL 属主）/ A3（services/\*/migrations 属主）
- **关联**：`infra/db/bootstrap.sh`、`infra/scripts/db-migrate.sh`、`infra/ci/check-db-bootstrap.mjs`
- **SLO 关联**：availability_trading、availability_offhours（DB 底座故障会直接放大为 API 5xx）

## 症状

- 部署流水线 `db-bootstrap` 或 `db-migrate` 步骤 exit 4/5，日志出现 `psql: error:`、`permission denied`、`迁移文件已被篡改`。
- 服务启动报 `permission denied for schema serving` / `permission denied for table dwd_*` / `relation "serving.xxx" does not exist`。
- 应用账号（`market_app`）能连库但查询 serving 报表不存在或超时；自选写入 `permission denied`。
- 迁移被并发部署打断：`pg_advisory_xact_lock` 等待、`lock_timeout` 超时。

## 影响

- 阻塞：A3 的 API/读取适配器无法启动或所有 serving 查询 500；行情/自选页不可用（交易时段按 99.9% SLO 计）。
- 数据风险：迁移失败若发生在生产，写了一半的业务表可能处于「schema 已变、数据未迁」的不一致态（本流程单文件单事务，失败会回滚，但跨文件多步仍可能半完成）。
- 权限风险：`market_app` 若被误授权 dwd*/dim*，等于绕过 A2 写域边界，可能读到未校验/未发布的原始数据并出现在 H5 页面；`warehouse_loader` 若误得 serving/自选权限，则 load 进程可污染展示口径。

## 判断

1. `psql "$DSN" -c '\dn'`：确认 `serving`、`meta` schema 是否存在；`\dt public.*` 确认 `dwd_*` 表。
2. `psql "$DSN" -c "SELECT filename, sha256, applied_at, applied_by FROM meta.schema_migrations ORDER BY filename"`：定位失败文件与最后成功点。
3. `SELECT grantee, table_schema, table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee IN ('market_app','warehouse_loader') ORDER BY 1,2,3`：确认 market_app 只含 serving SELECT + watchlist DML + audit INSERT，loader 只含 dwd/dim DML。
4. `node infra/ci/check-db-bootstrap.mjs`：静态门禁是否通过（顺序/幂等/授权边界）。
5. 判断是否「DDL 不可逆」：出现 `DROP`、`ALTER ... DROP COLUMN` 或数据回填迁移 → 禁止直接 rollback 版本，必须走备份恢复评审。

## 止血

- **bootstrap 失败（首次/新环境）**：修复后重跑同一命令；所有文件幂等，单事务失败即整体回滚，不会留半套 schema。顺序固定 DWD → serving → 角色 → 授权。
- **迁移失败**：ledger 未写入即视为未执行；修复方式只能是**新增**后续迁移（禁止改写已执行文件，runner 会因 sha256 不一致拒绝）。
- **迁移文件篡改告警**：立即停流水线，保留现场；由 A3/A2 确认是否误改历史文件，必要时补一条修正迁移，A13 重跑。
- **权限异常**：重跑 `infra/db/sql/20_grants.sql`（幂等），再跑 `90_verify_privileges.sql`；若 `market_app` 报 `permission denied for table dwd_*`，说明有人绕过 serving 直读 DWD —— 不回退权限，让查询继续失败，转 A3 修适配器；若 loader 报 serving 权限不足，属预期（按进程切权限），转 A1/A2 改 load 路径。
- **生产迁移需回滚**：从 `backups/prod-<ts>.dump` 做 `pg_restore` 到**新库**验证后再切换；生产原地 restore 属高危操作，必须 H5 批准并二次确认。
- 交易时段（09:15–15:00）禁止非紧急 schema 变更；紧急止血优先只读降级/停写，不扩 DDL。

## 升级

1. 5 分钟未止血 → A2（warehouse DDL）+ A3（应用迁移）+ lead。
2. 涉及生产数据不一致/需 restore → 立即 H5 + lead；A13 只执行不自批。
3. 权限边界被绕过（API 直读 DWD）→ 安全事件口径：通知 lead/H5，保留审计证据，禁止私自补授权。
4. tushare 侧无关；若是 PG 实例本身不可用 → 按基础设施故障升级平台/云厂商。

## 复盘

- 记录：失败文件与 exit code、ledger 最后成功点、备份路径与 restore 耗时、影响时长、是否触及 SLO。
- 必答：为什么静态门禁/预发没拦住？顺序、幂等、授权边界哪一层失效？是否有人绕过 `deploy.sh`/`db-migrate.sh` 手工改库？
- 产出：新增一条 `infra/ci/check-db-bootstrap.mjs` 断言、或补 CI job / 演练用例；更新本 runbook 与 `infra/db/README.md`。
- 若根因是「A3 迁移不幂等」：A3 补 `IF NOT EXISTS` 并加回归测试，A13 在 CI 静态检查里固化。
