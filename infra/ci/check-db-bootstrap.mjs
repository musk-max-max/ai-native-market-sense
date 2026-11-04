#!/usr/bin/env node
/**
 * infra/ci/check-db-bootstrap.mjs —— DB bootstrap / 权限边界的静态门禁
 *
 * WHY：本机与 CI 都不保证有可连的 PostgreSQL。「真跑库」无法在每次 PR 验证时，至少要把
 * 顺序、幂等、授权边界这些一旦写错就很难在评审里发现的约束变成机器检查。
 * 本脚本只读文件，不连库；真库验证由 bootstrap.sh --verify / db-migrate.sh 在部署环境执行。
 *
 * 权限模型（Lead 裁决 2026-11-04，按进程切）：
 *   market_app       => serving 全部表 SELECT；public.watchlist_items DML；audit.entitlement_events INSERT-only
 *   warehouse_loader => public 下 dwd_ 前缀与 dim_ 前缀表 DML；其余零权限；无 DDL/TRUNCATE
 * 注：H4/H5 的「写权限三分 + hold control 表」在 A5 DDL 落地后扩展断言（本检查先覆盖已交付文件）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const failures = [];
const passes = [];

function read(relPath) {
  try {
    return readFileSync(join(ROOT, relPath), 'utf8');
  } catch {
    failures.push(`${relPath}：文件不存在或不可读`);
    return '';
  }
}

function check(name, ok, detail = '') {
  if (ok) passes.push(name);
  else failures.push(detail ? `${name} —— ${detail}` : name);
}

function fileExists(relPath) {
  try {
    return statSync(join(ROOT, relPath)).isFile();
  } catch {
    return false;
  }
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ---- 1. 必需文件 ------------------------------------------------------------
const REQUIRED = [
  'warehouse/dwd/schema.sql',
  'warehouse/serving/schema.sql',
  'infra/db/bootstrap.sh',
  'infra/db/sql/10_roles.sql',
  'infra/db/sql/15_role_passwords.sql',
  'infra/db/sql/20_grants.sql',
  'infra/db/sql/90_verify_privileges.sql',
  'infra/scripts/db-migrate.sh',
  'docs/runbook/db-migration.md',
];
for (const relPath of REQUIRED) check(`存在 ${relPath}`, fileExists(relPath));

const bootstrap = read('infra/db/bootstrap.sh');
const dwd = read('warehouse/dwd/schema.sql');
const serving = read('warehouse/serving/schema.sql');
const roleSql = read('infra/db/sql/10_roles.sql');
const passwordSql = read('infra/db/sql/15_role_passwords.sql');
const grants = read('infra/db/sql/20_grants.sql');
const verifySql = read('infra/db/sql/90_verify_privileges.sql');
const migrate = read('infra/scripts/db-migrate.sh');

const MARKET_APP = 'market_app';
const LOADER = 'warehouse_loader';

// ---- 2. bootstrap 顺序与安全 -------------------------------------------------
if (bootstrap) {
  const idxDwd = bootstrap.indexOf('warehouse/dwd/schema.sql');
  const idxServing = bootstrap.indexOf('warehouse/serving/schema.sql');
  const idxRole = bootstrap.indexOf('10_roles.sql');
  const idxGrants = bootstrap.indexOf('20_grants.sql');
  check(
    'bootstrap 顺序：DWD → serving → 角色 → 授权',
    idxDwd >= 0 && idxServing > idxDwd && idxRole > idxServing && idxGrants > idxRole,
    `indices dwd=${idxDwd} serving=${idxServing} role=${idxRole} grants=${idxGrants}`,
  );
  check('bootstrap 使用 --single-transaction', bootstrap.includes('--single-transaction'));
  check('bootstrap 使用 ON_ERROR_STOP=1', bootstrap.includes('ON_ERROR_STOP=1'));
  check(
    'bootstrap 生产门禁 ALLOW_PRODUCTION_BOOTSTRAP',
    bootstrap.includes('ALLOW_PRODUCTION_BOOTSTRAP'),
  );
  check('bootstrap 生产门禁 APPROVAL_REF', bootstrap.includes('APPROVAL_REF'));
  check('bootstrap 先跑静态自检', bootstrap.includes('check-db-bootstrap.mjs'));
  check('bootstrap 不自动建业务表', !/CREATE\s+TABLE[^;]*watchlist_items/i.test(bootstrap));
  check(
    'bootstrap 支持两个角色密码变量',
    bootstrap.includes('APP_DB_MARKET_PASSWORD') && bootstrap.includes('APP_DB_LOADER_PASSWORD'),
  );
  check(
    'bootstrap --verify 走 90_verify_privileges.sql',
    bootstrap.includes('90_verify_privileges.sql'),
  );
}

// ---- 3. DWD DDL -------------------------------------------------------------
if (dwd) {
  const creates = [...dwd.matchAll(/CREATE\s+(?:TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?/gi)];
  const idempotent = [...dwd.matchAll(/CREATE\s+(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+/gi)];
  check(
    'DWD 所有 CREATE TABLE/INDEX 均 IF NOT EXISTS',
    creates.length > 0 && creates.length === idempotent.length,
    `creates=${creates.length} idempotent=${idempotent.length}`,
  );
  check('DWD 无 DROP（迁移不可破坏性删除）', !/^\s*DROP\s+/im.test(dwd));
  check('DWD 无 GRANT（授权只在 infra/db/sql/）', !/^\s*GRANT\s+/im.test(dwd));
  const tables = new Set(
    [...dwd.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi)].map((m) => m[1]),
  );
  for (const t of [
    'dwd_stock_bar_daily',
    'dwd_adj_factor',
    'dim_instrument',
    'dwd_bar_revision',
    'dwd_suspended_daily',
    'dwd_fundamental_report',
  ]) {
    check(`DWD 表 ${t}`, tables.has(t));
  }
}

// ---- 4. serving schema -------------------------------------------------------
if (serving) {
  check(
    'serving 使用 CREATE SCHEMA IF NOT EXISTS',
    /CREATE\s+SCHEMA\s+IF\s+NOT\s+EXISTS\s+serving/i.test(serving),
  );
  const viewCreates = [...serving.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+/gi)];
  const replaceCreates = [...serving.matchAll(/CREATE\s+OR\s+REPLACE\s+VIEW\s+/gi)];
  check(
    'serving 所有 VIEW 均 CREATE OR REPLACE',
    viewCreates.length > 0 && viewCreates.length === replaceCreates.length,
    `views=${viewCreates.length} replace=${replaceCreates.length}`,
  );
  check('serving 无 GRANT（授权只在 infra/db/sql/）', !/^\s*GRANT\s+/im.test(serving));
  check('serving 声明执行顺序（DWD → serving）', /执行顺序|DWD[\s\S]*serving/.test(serving));
}

// ---- 5. 授权边界 -------------------------------------------------------------
if (grants) {
  check(
    'grants: market_app GRANT USAGE ON SCHEMA serving',
    new RegExp(`GRANT\\s+USAGE\\s+ON\\s+SCHEMA\\s+serving\\s+TO\\s+${MARKET_APP}`, 'i').test(
      grants,
    ),
  );
  check(
    'grants: serving 表 SELECT 给 market_app',
    new RegExp(
      `GRANT\\s+SELECT\\s+ON\\s+ALL\\s+TABLES\\s+IN\\s+SCHEMA\\s+serving\\s+TO\\s+${MARKET_APP}`,
      'i',
    ).test(grants),
  );
  check(
    'grants: serving 默认权限仅 SELECT',
    /ALTER\s+DEFAULT\s+PRIVILEGES\s+IN\s+SCHEMA\s+serving\s+GRANT\s+SELECT/i.test(grants),
  );
  check(
    'grants: serving schema 不向 PUBLIC 开放',
    /REVOKE\s+ALL\s+ON\s+SCHEMA\s+serving\s+FROM\s+PUBLIC/i.test(grants),
  );
  check(
    'grants: watchlist_items 给 market_app S/I/U/D',
    /GRANT\s+SELECT\s*,\s*INSERT\s*,\s*UPDATE\s*,\s*DELETE\s+ON\s+TABLE\s+public\.watchlist_items\s+TO\s+market_app/i.test(
      grants,
    ),
  );
  check(
    'grants: watchlist_items 有 to_regclass 判断（迁移前不炸）',
    /to_regclass\('public\.watchlist_items'\)/i.test(grants),
  );
  check(
    'grants: watchlist_items 收回 TRUNCATE/REFERENCES/TRIGGER',
    /REVOKE\s+TRUNCATE\s*,\s*REFERENCES\s*,\s*TRIGGER\s+ON\s+TABLE\s+public\.watchlist_items/i.test(
      grants,
    ),
  );
  check(
    'grants: market_app 对 events 为列级 INSERT（排除 event_id/prev_hash/hash/recorded_at）',
    /column_name NOT IN \('event_id', 'prev_hash', 'hash', 'recorded_at'\)/i.test(grants) &&
      /GRANT INSERT \(%s\) ON TABLE audit\.entitlement_events TO market_app/i.test(grants),
  );
  check(
    'grants: events 先 REVOKE ALL 再授权（含 SELECT/UPDATE/DELETE）',
    /REVOKE ALL ON TABLE audit\.entitlement_events FROM market_app/i.test(grants),
  );
  check(
    'grants: audit_reader 只 SELECT events/hold，无函数 EXECUTE',
    /GRANT SELECT ON TABLE audit\.entitlement_events TO audit_reader/i.test(grants) &&
      /GRANT SELECT ON TABLE audit\.entitlement_hold TO audit_reader/i.test(grants) &&
      /REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA audit FROM audit_reader/i.test(grants),
  );
  check(
    'grants: reconciler 只 raise_hold/mark_reconciled，无 clear_hold',
    /GRANT EXECUTE ON FUNCTION audit\.raise_hold\(text, text\) TO reconciler/i.test(grants) &&
      /GRANT EXECUTE ON FUNCTION audit\.mark_reconciled\(timestamptz\) TO reconciler/i.test(
        grants,
      ) &&
      /REVOKE EXECUTE ON FUNCTION audit\.clear_hold\(text, text, text\) FROM reconciler/i.test(
        grants,
      ),
  );
  check(
    'grants: human_hold_clear 只 clear_hold',
    /GRANT EXECUTE ON FUNCTION audit\.clear_hold\(text, text, text\) TO human_hold_clear/i.test(
      grants,
    ),
  );
  check(
    'grants: audit 表也有 to_regclass 判断',
    /to_regclass\('audit\.entitlement_events'\)/i.test(grants),
  );
  check(
    'grants: loader 仅 DML（S/I/U/D）于 dwd_*/dim_*',
    /GRANT\s+SELECT\s*,\s*INSERT\s*,\s*UPDATE\s*,\s*DELETE\s+ON\s+TABLE\s+%I\s+TO\s+warehouse_loader/i.test(
      grants,
    ),
  );
  check(
    'grants: loader 表循环只选 r/p 且 dwd_/dim_',
    /relkind\s+IN\s+\('r',\s*'p'\)/i.test(grants) &&
      /dwd\\_%/.test(grants) &&
      /dim\\_%/.test(grants),
  );
  check(
    'grants: loader 收回 TRUNCATE/REFERENCES/TRIGGER',
    /REVOKE\s+TRUNCATE\s*,\s*REFERENCES\s*,\s*TRIGGER\s+ON\s+TABLE\s+%I/i.test(grants),
  );
  check('grants: 无 GRANT ALL', !/GRANT\s+ALL\s+ON\b/i.test(grants));
  check(
    'grants: 不对 DWD/DIM 直接 GRANT 给 market_app',
    !new RegExp(
      `GRANT\\s+[^;]*ON\\s+(?:TABLE\\s+)?(?:dwd_|dim_)[a-z_]*[^;]*TO\\s+${MARKET_APP}`,
      'i',
    ).test(grants),
  );
  check(
    'grants: market_app 不能 CREATE public/serving',
    new RegExp(`REVOKE\\s+CREATE\\s+ON\\s+SCHEMA\\s+public\\s+FROM\\s+${MARKET_APP}`, 'i').test(
      grants,
    ) &&
      new RegExp(`REVOKE\\s+CREATE\\s+ON\\s+SCHEMA\\s+serving\\s+FROM\\s+${MARKET_APP}`, 'i').test(
        grants,
      ),
  );
  check(
    'grants: loader 不给 serving 任何权限',
    new RegExp(`REVOKE\\s+ALL\\s+ON\\s+SCHEMA\\s+serving\\s+FROM\\s+${LOADER}`, 'i').test(grants),
  );
  check(
    'grants: 默认权限对两角色都收回（未来表默认不可见）',
    (grants.match(/ALTER\s+DEFAULT\s+PRIVILEGES[\s\S]{0,160}REVOKE\s+ALL\s+ON\s+TABLES/gi) || [])
      .length >= 2,
  );
}

// ---- 6. 角色属性 -------------------------------------------------------------
if (roleSql) {
  for (const role of [
    'warehouse_loader',
    'market_app',
    'ci_deploy_writer',
    'reconciler',
    'human_hold_clear',
  ]) {
    check(`角色 ${role} 已声明`, new RegExp(`['"]${role}['"]`, 'i').test(roleSql));
  }
  check(
    '人工角色 human_hold_clear 为 NOLOGIN',
    /human_hold_clear[\s\S]{0,200}?NOLOGIN/i.test(roleSql),
  );
  check('进程角色 LOGIN（数组声明 + LOGIN 拼装）', /LOGIN[^;]*NOCREATEDB/i.test(roleSql));
  for (const attr of ['NOSUPERUSER', 'NOCREATEDB', 'NOCREATEROLE', 'NOBYPASSRLS']) {
    check(`角色属性 ${attr}`, roleSql.includes(attr));
  }
  check(
    '角色幂等（DO 块按 pg_roles 判断）',
    /pg_roles/i.test(roleSql) && /DO\s+\$\$/i.test(roleSql),
  );
  check(
    '全部角色互不继承（DO 循环 REVOKE granted FROM member）',
    /REVOKE\s+%I\s+FROM\s+%I/i.test(roleSql) && /FOREACH\s+member_role/i.test(roleSql),
  );
}

// ---- 7. 运行时断言 -----------------------------------------------------------
if (verifySql) {
  check(
    'verify: 断言 market_app 在 DWD/DIM 零授权',
    /market_app[\s\S]{0,400}?dwd\\_%|dwd\\_%[\s\S]{0,400}?market_app/i.test(verifySql) &&
      /RAISE\s+EXCEPTION/i.test(verifySql),
  );
  check(
    'verify: 断言 market_app serving 仅 SELECT',
    /table_schema\s*=\s*'serving'\s*AND\s*privilege_type\s*<>\s*'SELECT'/i.test(verifySql),
  );
  check(
    'verify: 断言 market_app watchlist 有 DML 且无 DDL',
    /has_table_privilege\('market_app',\s*'public\.watchlist_items'/i.test(verifySql) &&
      /TRUNCATE/i.test(verifySql),
  );
  check(
    'verify: 断言 market_app audit 仅有 INSERT',
    /has_table_privilege\('market_app',\s*'audit\.entitlement_events',\s*'INSERT'\)/i.test(
      verifySql,
    ) &&
      /SELECT',\s*'UPDATE',\s*'DELETE',\s*'TRUNCATE',\s*'REFERENCES',\s*'TRIGGER'/.test(verifySql),
  );
  check(
    'verify: 断言 loader 有 DWD/DIM DML',
    /warehouse_loader[\s\S]{0,600}?(SELECT|INSERT|UPDATE|DELETE)/i.test(verifySql) &&
      /has_table_privilege\('warehouse_loader'/i.test(verifySql),
  );
  check(
    'verify: 断言 loader 在 serving/watchlist/audit 零权限',
    /warehouse_loader[\s\S]{0,1200}?'serving'|'serving'[\s\S]{0,1200}?warehouse_loader/i.test(
      verifySql,
    ) && /warehouse_loader[\s\S]{0,1600}?watchlist_items/i.test(verifySql),
  );
  check('verify: 校验角色属性', /rolsuper|rolbypassrls/i.test(verifySql));
  check('verify: 断言角色不得拥有关系', /relowner/i.test(verifySql));
}

// ---- 8. 迁移 runner ----------------------------------------------------------
if (migrate) {
  check('migrate: ledger 表 meta.schema_migrations', /meta\.schema_migrations/i.test(migrate));
  check('migrate: 记录 sha256', /sha256/i.test(migrate));
  check('migrate: 并发锁 pg_advisory', /pg_advisory/i.test(migrate));
  check('migrate: 生产需 APPROVAL_REF', migrate.includes('APPROVAL_REF'));
  check('migrate: 生产先备份（pg_dump）', /pg_dump/i.test(migrate));
  check('migrate: ON_ERROR_STOP', migrate.includes('ON_ERROR_STOP=1'));
  check(
    'migrate: 校验历史文件未被篡改（checksum 不一致即失败）',
    /checksum|sha256/i.test(migrate) && /(mismatch|篡改|不一致)/i.test(migrate),
  );
  check('migrate: 支持 infra/db/migrations/', migrate.includes('infra/db/migrations'));
  check(
    'migrate: 迁移后重跑授权与断言',
    migrate.includes('20_grants.sql') && migrate.includes('90_verify_privileges.sql'),
  );
}

// ---- 9. 迁移幂等 -------------------------------------------------------------
const migrationFiles = [];
for (const svc of safeReaddir(join(ROOT, 'services'))) {
  if (!svc || svc.startsWith('.')) continue;
  for (const file of safeReaddir(join(ROOT, 'services', svc, 'migrations'))) {
    if (file.endsWith('.sql')) migrationFiles.push(join('services', svc, 'migrations', file));
  }
}
for (const file of safeReaddir(join(ROOT, 'infra', 'db', 'migrations'))) {
  if (file.endsWith('.sql')) migrationFiles.push(join('infra', 'db', 'migrations', file));
}
check('存在至少一个迁移文件', migrationFiles.length > 0, `count=${migrationFiles.length}`);
const stripSqlComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

for (const relPath of migrationFiles) {
  const sql = read(relPath);
  const body = stripSqlComments(sql);
  const creates = [
    ...body.matchAll(
      /CREATE\s+(?:TABLE|INDEX|UNIQUE\s+INDEX|SCHEMA)\s+(?:IF\s+NOT\s+EXISTS\s+)?/gi,
    ),
  ];
  const idempotent = [
    ...body.matchAll(/CREATE\s+(?:TABLE|INDEX|UNIQUE\s+INDEX|SCHEMA)\s+IF\s+NOT\s+EXISTS\s+/gi),
  ];
  const idempotentAlters = [
    ...body.matchAll(/ALTER\s+TABLE\s+[\w."]+\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/gi),
  ];
  check(
    `${relPath} 幂等`,
    creates.length + idempotentAlters.length > 0 && creates.length === idempotent.length,
    `creates=${creates.length} idempotent=${idempotent.length} add_column_if_not_exists=${idempotentAlters.length}`,
  );
  check(`${relPath} 无 DROP TABLE`, !/DROP\s+TABLE/i.test(body));
}

// ---- 10. 密码不得硬编码 ------------------------------------------------------
for (const [name, sql] of [
  ['10_roles.sql', roleSql],
  ['15_role_passwords.sql', passwordSql],
  ['20_grants.sql', grants],
]) {
  check(
    `${name} 无硬编码密码`,
    !/PASSWORD\s+'(?!market_app_password|warehouse_loader_password)[^']*'/i.test(sql),
  );
}

// ---- 11. 授权审计 canonical DDL（A5 单写者；A13 只做授权/断言/seed） --------
// 2026-11-04 真库执行发现两份 DDL 冲突（A13 初版 vs A5 完整版），已删 A13 重复文件，
// 保留 services/compliance/... 为唯一真源；这里只校验 canonical 文件别再被复制。
const auditMigrationRel = 'services/compliance/migrations/001_audit_entitlement_events.sql';
check('存在授权审计 canonical 迁移（A5）', fileExists(auditMigrationRel));
check(
  'infra/db/migrations 未复制审计 DDL（唯一真源）',
  !['001_entitlement_audit.sql', '001_audit_entitlement_events.sql'].some((name) =>
    fileExists(`infra/db/migrations/${name}`),
  ),
);
const auditMigration = read(auditMigrationRel);
if (auditMigration) {
  check(
    'audit: 建 entitlement_events',
    /CREATE TABLE IF NOT EXISTS audit\.entitlement_events/i.test(auditMigration),
  );
  check(
    'audit: 事件表含可举证列（tier/expires/doc_sha/clause/valid_until/rule_version）',
    [
      'effective_tier',
      'configured_tier',
      'expires_at',
      'authorization_doc_sha256',
      'clause_locator',
      'authorization_valid_until',
      'rule_version',
    ].every((col) => new RegExp(`\\b${col}\\b`).test(auditMigration)),
  );
  check(
    'audit: 建 entitlement_hold 且 PK=1 单行',
    /CREATE TABLE IF NOT EXISTS audit\.entitlement_hold/i.test(auditMigration) &&
      /CHECK \(id = 1\)/i.test(auditMigration),
  );
  check(
    'audit: hold seed（ON CONFLICT DO NOTHING）',
    /INSERT INTO audit\.entitlement_hold[\s\S]{0,300}?ON CONFLICT \(id\) DO NOTHING/i.test(
      auditMigration,
    ),
  );
  check(
    'audit: 只读视图 entitlement_hold_state',
    /CREATE OR REPLACE VIEW audit\.entitlement_hold_state/i.test(auditMigration),
  );
  check(
    'audit: event_key 唯一索引',
    /CREATE UNIQUE INDEX IF NOT EXISTS[^;]*event_key[^;]*/i.test(auditMigration),
  );
  check(
    'audit: 9 类 event_type CHECK（含 clause_review）',
    /'entitlement_expired'/.test(auditMigration) &&
      /'entitlement_flip'/.test(auditMigration) &&
      /'tier_state_observed'/.test(auditMigration) &&
      /'unauthorized_config'/.test(auditMigration) &&
      /'deploy'/.test(auditMigration) &&
      /'tier_switch'/.test(auditMigration) &&
      /'hold_set'/.test(auditMigration) &&
      /'hold_clear'/.test(auditMigration) &&
      /'clause_review'/.test(auditMigration),
  );
  check(
    'audit: 链触发器 advisory lock + SECURITY DEFINER',
    /entitlement_events_before_insert[\s\S]{0,800}?pg_advisory_xact_lock[\s\S]{0,400}?SECURITY DEFINER|SECURITY DEFINER[\s\S]{0,1200}?pg_advisory_xact_lock/i.test(
      auditMigration,
    ),
  );
  check(
    'audit: append-only（拒绝 UPDATE/DELETE 的触发器函数）',
    /entitlement_events_no_update/.test(auditMigration) &&
      /entitlement_events_no_delete/.test(auditMigration),
  );
  for (const fn of ['raise_hold', 'clear_hold', 'mark_reconciled']) {
    check(
      `audit: 函数 ${fn} SECURITY DEFINER`,
      new RegExp(`FUNCTION audit\\.${fn}[\\s\\S]{0,500}?SECURITY DEFINER`, 'i').test(
        auditMigration,
      ),
    );
  }
  check(
    'audit: 函数记录 session_user（不是 current_user 伪执行者）',
    /session_user/i.test(auditMigration) && !/DEFAULT\s+current_user/i.test(auditMigration),
  );
  check(
    'audit: clear_hold 校验 ticket/signer/doc_sha 非空',
    /clear_hold[\s\S]{0,1200}?p_ticket[\s\S]{0,400}?p_signer[\s\S]{0,400}?p_doc_sha[\s\S]{0,600}?RAISE EXCEPTION/i.test(
      auditMigration,
    ),
  );
  check(
    'audit: hash payload 覆盖 tier/fingerprint/doc_sha（不只 old/new/reason）',
    /authorization_doc_sha256/.test(auditMigration) &&
      /config_fingerprint/.test(auditMigration) &&
      /effective_tier/.test(auditMigration) &&
      /entitlement_event_canonical/.test(auditMigration),
  );
  check(
    'audit: 撤销 PUBLIC 权限（具体角色由 20_grants 授）',
    /REVOKE ALL ON audit\.entitlement_events FROM PUBLIC/i.test(auditMigration),
  );
}

// ---- 002_audit_gap（A5 m…，H4 的 gap 判定依赖）--------------------------------
const auditGapPath = 'services/compliance/migrations/002_audit_gap.sql';
const auditGap = existsSync(resolve(ROOT, auditGapPath))
  ? readFileSync(resolve(ROOT, auditGapPath), 'utf8')
  : '';
check('audit_gap: 002 迁移存在', auditGap.length > 0);
if (auditGap) {
  check(
    'audit_gap: 新增 recorded_at 且触发器强制 now()',
    /ADD COLUMN IF NOT EXISTS recorded_at/i.test(auditGap) && /now\(\)/.test(auditGap),
  );
  check(
    'audit_gap: 第 10 类事件 audit_gap 已加入 CHECK',
    /audit_gap/.test(auditGap) && /event_type/i.test(auditGap),
  );
  check(
    'audit_gap: schema_version 放宽为 1/2 共存',
    /schema_version/i.test(auditGap) && /1.*2|2.*1/s.test(auditGap),
  );
  check(
    'audit_gap: 不修改 001（canonical hash 不变）',
    !/UPDATE audit\.entitlement_events SET hash/i.test(auditGap),
  );
}

// ---- 输出 ---// ---- 输出 -------------------------------------------------------------------
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ok: failures.length === 0, passes, failures }, null, 2));
} else {
  for (const p of passes) console.log(`  ✓ ${p}`);
  if (failures.length > 0) {
    console.error('');
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error(`\nDB bootstrap 静态校验失败：${failures.length} 项`);
  } else {
    console.log(
      `\nDB bootstrap 静态校验通过：${passes.length} 项（真库执行由 bootstrap.sh --verify 负责，本检查不连接数据库）`,
    );
  }
}
process.exit(failures.length === 0 ? 0 : 1);
