/**
 * A19「前端绕过 403 / 未授权读到行情数字」对抗测试总入口。
 *
 * 用法：
 *   node tests/adversarial/entitlement-bypass/run.mjs
 *
 * 前置：本地 PG 16（127.0.0.1:55432）存在独立库 market_sense_a19（运行 ./provision-db.sh 创建），
 *       web/h5/dist 已由当前源码构建（vite build）。
 *
 * 隔离边界：只起 127.0.0.1 上的 18182-18186/3200/3201，只用 market_sense_a19；
 *           不碰 lead 的 8081/3000、不碰生产、不碰真实用户数据。
 *
 * 判定输出：artifacts/results.json + stdout 摘要；FAIL>0 时退出码 1。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import {
  WORKSPACE, ARTIFACTS_DIR, ensureDir, portInUse, spawnService, waitFor,
  http, addCheck, summarize, chromium, isoNow, rel, initRawLog, getHttpCount,
} from './lib.mjs';
import { runStaticAudit } from './cases/static.mjs';
import { runRestrictedApiMatrix, runValidPhaseApi, runExpiredApiMatrix, runRateLimitAttack, runTrustProxyCidrCheck, runBackdoorGuardChecks } from './cases/api.mjs';
import { runRestrictedClient, startTransition } from './cases/client.mjs';

const requireMarket = createRequire(path.join(WORKSPACE, 'services', 'market', 'package.json'));

const cfg = {
  workspace: WORKSPACE,
  dbUrl: process.env.A19_DATABASE_URL ?? 'postgresql://ms@localhost:55432/market_sense_a19',
  webDist: process.env.A19_WEB_DIST ?? path.join(WORKSPACE, 'web', 'h5', 'dist'),
  expiryLeadMs: Number(process.env.A19_EXPIRY_LEAD_MS ?? 120_000),
  ports: {
    restrictedApi: Number(process.env.A19_PORT_RESTRICTED_API ?? 18182),
    expiringApi: Number(process.env.A19_PORT_EXPIRING_API ?? 18183),
    limitedApi: Number(process.env.A19_PORT_LIMITED_API ?? 18184),
    trustProxyApi: Number(process.env.A19_PORT_TRUSTPROXY_API ?? 18185),
    trustProxyCidrApi: Number(process.env.A19_PORT_TRUSTPROXY_CIDR_API ?? 18186),
    backdoorApi: Number(process.env.A19_PORT_BACKDOOR_API ?? 18187),
    restrictedWeb: Number(process.env.A19_PORT_RESTRICTED_WEB ?? 3200),
    expiringWeb: Number(process.env.A19_PORT_EXPIRING_WEB ?? 3201),
  },
  apiBases: {},
  webBases: {},
};

async function preflight({ onlyR4 = false } = {}) {
  const problems = [];
  if (!onlyR4 && !fs.existsSync(path.join(cfg.webDist, 'index.html'))) {
    problems.push(`web dist 不存在：${rel(cfg.webDist)}/index.html（先 cd web/h5 && pnpm build）`);
  }
  let pg;
  try {
    pg = requireMarket('pg');
  } catch (error) {
    problems.push(`无法从 services/market 解析 pg：${error.message}`);
  }
  if (pg) {
    const pool = new pg.Pool({ connectionString: cfg.dbUrl, max: 1 });
    try {
      const { rows } = await pool.query('select display_safe from serving.serving_instrument limit 1');
      if (rows.length === 0) problems.push('market_sense_a19 的 dim_instrument 无数据');
    } catch (error) {
      problems.push(
        `隔离库不可用或 schema 漂移：${error.message}\n` +
          `  先执行 tests/adversarial/entitlement-bypass/provision-db.sh 重建 ${cfg.dbUrl}`,
      );
    } finally {
      await pool.end().catch(() => {});
    }
  }
  const portEntries = onlyR4 ? [['trustProxyCidrApi', cfg.ports.trustProxyCidrApi]] : Object.entries(cfg.ports);
  for (const [name, port] of portEntries) {
    if (await portInUse(port)) problems.push(`端口被占用：${name}=${port}`);
  }
  if (problems.length > 0) throw new Error(`preflight 失败：\n- ${problems.join('\n- ')}`);
}

function apiEnv(tier, extra = {}) {
  return {
    HOST: '127.0.0.1',
    NODE_ENV: 'test',
    // L44/L46：E2E 后门必须在显式非 prod profile 下才允许；缺省按 prod 拒绝启动。
    APP_PROFILE: 'test',
    E2E_MODE: '1',
    LOG_LEVEL: 'warn',
    DATABASE_URL: cfg.dbUrl,
    E2E_AUTH_TOKEN: 'dev-token',
    ENTITLEMENT_TIER: tier,
    ...extra,
  };
}

async function startWeb(name, port, apiPort, logDir) {
  const base = `http://127.0.0.1:${port}`;
  const handle = spawnService({
    name,
    command: 'node',
    args: ['server.mjs'],
    cwd: path.join(WORKSPACE, 'web', 'h5'),
    env: { HOST: '127.0.0.1', PORT: String(port), API_BASE_URL: `http://127.0.0.1:${apiPort}`, WEB_DIST_DIR: cfg.webDist, NODE_ENV: 'production' },
    logFile: path.join(logDir, `${name}.log`),
  });
  await waitFor(`${name} 可用`, async () => (await fetch(base)).status === 200, { timeoutMs: 30_000 });
  return { handle, base };
}

// 原始 HTTP transcript 自检：存在、非空、行数等于 http() 调用数、每行含 method/url/status/headers。
function rawLogEvidence(file) {
  const bytes = fs.statSync(file).size;
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n').filter(Boolean);
  const httpCalls = getHttpCount();
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const required = ['method', 'url', 'status', 'headers'];
  let missingFields = 0;
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { missingFields += 1; continue; }
    if (required.some((k) => !(k in obj))) missingFields += 1;
  }
  const evidence = { path: rel(file), bytes, lines: lines.length, httpCalls, sha256, missingFields };
  if (!(bytes > 0 && lines.length > 0 && missingFields === 0)) {
    throw new Error(`原始 HTTP transcript 自检失败：${JSON.stringify(evidence)}`);
  }
  if (lines.length !== httpCalls) {
    throw new Error(`原始 HTTP transcript 行数(${lines.length}) ≠ http() 调用数(${httpCalls})：${rel(file)}`);
  }
  return evidence;
}

async function main() {
  ensureDir(ARTIFACTS_DIR);

  // 单条复跑（lead 裁定后：修完只用同一 case 复跑 R4，不用全量）
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.slice('--only='.length).split(',').map((x) => x.trim().toUpperCase()).filter(Boolean) : null;
  if (only && !(only.length === 1 && only[0] === 'R4')) {
    console.error(`仅支持 --only=R4，收到：${only.join(',')}`);
    process.exit(2);
  }

  const startedAt = isoNow();
  const runId = startedAt.replace(/[^0-9TZ]/g, '');
  // 日志也 run-scoped：每次 run 一个新目录，不覆盖历史证据（L75/H5 m00606）。
  const logDir = path.join(ARTIFACTS_DIR, 'logs', runId + (only ? '-r4' : ''));
  ensureDir(logDir);
  const rawLog = initRawLog(path.join(ARTIFACTS_DIR, `http-attempts-${runId}${only ? '-r4' : ''}.jsonl`));
  const results = [];
  const handles = [];
  const meta = {
    startedAt,
    runId,
    node: process.version,
    platform: process.platform,
    dbUrl: cfg.dbUrl,
    webDist: cfg.webDist,
    ports: cfg.ports,
    expiryLeadMs: cfg.expiryLeadMs,
    rawHttpLog: rel(rawLog),
    distMtime: fs.existsSync(path.join(cfg.webDist, 'index.html')) ? fs.statSync(path.join(cfg.webDist, 'index.html')).mtime.toISOString() : null,
  };
  if (only) meta.mode = `only:${only.join(',')}`;

  let browser;
  try {
    await preflight({ onlyR4: Boolean(only) });
    if (only) {
      // R4 单条：只需 DB + TRUST_PROXY CIDR 实例（18186），不起 web/其他 API，不覆盖全量 results.json。
      console.log(`隔离目标：DB=${cfg.dbUrl}  API=${cfg.ports.trustProxyCidrApi}（R4 单条复跑）`);
      await runTrustProxyCidrCheck({ results, cfg, spawnLogDir: logDir, tag: 'R4' });
      const summary = summarize(results);
      meta.rawHttpLogEvidence = rawLogEvidence(rawLog);
      meta.finishedAt = isoNow();
      const outFile = path.join(ARTIFACTS_DIR, 'results-r4.json');
      fs.writeFileSync(outFile, JSON.stringify({ meta, summary, checks: results }, null, 2));
      console.log('\n=== R4 复跑摘要 ===');
      console.log(JSON.stringify(summary, null, 2));
      console.log(`\n原始 HTTP transcript 自检：${JSON.stringify(meta.rawHttpLogEvidence)}`);
      console.log(`\n证据：${rel(outFile)}；原始 HTTP：${rel(rawLog)}；实例日志：${rel(path.join(logDir, 'api-trustproxy-cidr.log'))}`);
      if (summary.fail > 0) {
        console.log('\nR4 仍为 FAIL：换桶仍成立（见上表 / results-r4.json）。');
        process.exitCode = 1;
      } else {
        console.log('\nR4 复跑通过（PASS=配置守卫拒绝启动或不换桶）。');
      }
      return;
    }
    console.log(`隔离目标：DB=${cfg.dbUrl}  API=${cfg.ports.restrictedApi}/${cfg.ports.expiringApi}  Web=${cfg.ports.restrictedWeb}/${cfg.ports.expiringWeb}`);
    cfg.apiBases = {
      restricted: `http://127.0.0.1:${cfg.ports.restrictedApi}`,
      expiring: `http://127.0.0.1:${cfg.ports.expiringApi}`,
      limited: `http://127.0.0.1:${cfg.ports.limitedApi}`,
    };
    cfg.webBases = {
      restricted: `http://127.0.0.1:${cfg.ports.restrictedWeb}`,
      expiring: `http://127.0.0.1:${cfg.ports.expiringWeb}`,
    };

    // 1) 受限 API + 默认限流 API + 两个 web（expiring API 稍后起，避免到期窗口被前置测试吃掉）
    const restrictedApi = spawnService({
      name: 'api-restricted',
      command: 'node',
      args: ['--import', 'tsx', 'src/server.ts'],
      cwd: path.join(WORKSPACE, 'services', 'api'),
      env: apiEnv('internal_eval', { PORT: String(cfg.ports.restrictedApi), RATE_LIMIT_IP_BURST: '5000', RATE_LIMIT_IP_PER_MIN: '60000' }),
      logFile: path.join(logDir, 'api-restricted.log'),
    });
    handles.push(restrictedApi);

    const limitedApi = spawnService({
      name: 'api-limited',
      command: 'node',
      args: ['--import', 'tsx', 'src/server.ts'],
      cwd: path.join(WORKSPACE, 'services', 'api'),
      env: apiEnv('internal_eval', { PORT: String(cfg.ports.limitedApi) }),
      logFile: path.join(logDir, 'api-limited.log'),
    });
    handles.push(limitedApi);

    const restrictedWeb = await startWeb('web-restricted', cfg.ports.restrictedWeb, cfg.ports.restrictedApi, logDir);
    handles.push(restrictedWeb.handle);
    const expiringWeb = await startWeb('web-expiring', cfg.ports.expiringWeb, cfg.ports.expiringApi, logDir);
    handles.push(expiringWeb.handle);

    await waitFor('restricted API 健康', async () => (await http(`${cfg.apiBases.restricted}/healthz`)).status === 200, { timeoutMs: 60_000 });
    await waitFor('limited API 健康', async () => (await http(`${cfg.apiBases.limited}/healthz`)).status === 200, { timeoutMs: 60_000 });

    browser = await chromium.launch({ headless: true });
    meta.browser = await browser.version();

    // 2) 静态审计（构建产物/源码/HTML）
    console.log('\n=== 静态审计（bundle / 源码 / SSR HTML） ===');
    await runStaticAudit({ results, cfg });

    // 3) 受限态 API 矩阵
    console.log('\n=== API 攻击矩阵（internal_eval 受限态） ===');
    await runRestrictedApiMatrix({ results, cfg });

    // 4) 限流与 trustProxy（默认限流独立实例）
    console.log('\n=== 限流桶 / trustProxy 攻击面 ===');
    await runRateLimitAttack({ results, cfg, spawnLogDir: logDir });

    // 4b) E2E 后门 guard：APP_PROFILE 漏配时，生产实例是否还会打开固定 dev 身份
    console.log('\n=== E2E 后门 guard（APP_PROFILE / dev-token） ===');
    await runBackdoorGuardChecks({ results, cfg, spawnLogDir: logDir });

    // 5) 受限态客户端攻击（注毒/重放/SW）
    console.log('\n=== 浏览器攻击（受限态：本地存储/URL/拦截/缓存） ===');
    // 有效态 body 用于重放。先起 expiring API（带 T+lead 到期时间），phaseA 后立刻跑受限客户端测试。
    const expiresAt = new Date(Date.now() + cfg.expiryLeadMs).toISOString();
    meta.expiresAt = expiresAt;
    const expiringApi = spawnService({
      name: 'api-expiring',
      command: 'node',
      args: ['--import', 'tsx', 'src/server.ts'],
      cwd: path.join(WORKSPACE, 'services', 'api'),
      env: apiEnv('c_end_display', {
        PORT: String(cfg.ports.expiringApi),
        ENTITLEMENT_EXPIRES_AT: expiresAt,
        RATE_LIMIT_IP_BURST: '5000',
        RATE_LIMIT_IP_PER_MIN: '60000',
      }),
      logFile: path.join(logDir, 'api-expiring.log'),
    });
    handles.push(expiringApi);
    await waitFor('expiring API 健康', async () => (await http(`${cfg.apiBases.expiring}/healthz`)).status === 200, { timeoutMs: 60_000 });

    console.log('\n=== 有效态基线 + 到期前（phase A） ===');
    const validBody = await runValidPhaseApi({ results, cfg });
    const transition = await startTransition({ results, cfg, browser, artifactsDir: ARTIFACTS_DIR });
    meta.transitionStartedAt = isoNow();

    console.log('\n=== 浏览器攻击（受限态：本地存储/URL/拦截/缓存） ===');
    await runRestrictedClient({ results, cfg, browser, validBody: validBody ?? transition.validBody, artifactsDir: ARTIFACTS_DIR });

    // 6) 等待到期（fail-closed 转换）
    console.log(`\n等待 entitlement 到期：${expiresAt}`);
    const waitStart = Date.now();
    await waitFor(
      '到期后 quote 变 403',
      async () => (await http(`${cfg.apiBases.expiring}/v1/instruments/SSE:600519/quote`)).status === 403,
      { timeoutMs: cfg.expiryLeadMs + 120_000, intervalMs: 2000 },
    );
    meta.expiredObservedAt = isoNow();
    meta.expiryWaitMs = Date.now() - waitStart;
    console.log(`到期已生效（等待 ${Math.round(meta.expiryWaitMs / 1000)}s）`);

    // 7) phase B：bfcache / 刷新 / 缓存 / DOM 残留
    console.log('\n=== 到期后（phase B：bfcache / 刷新 / 缓存 / DOM 残留） ===');
    await transition.phaseB();

    // 8) 到期态 API 矩阵
    console.log('\n=== API 攻击矩阵（c_end_display 已过期） ===');
    await runExpiredApiMatrix({ results, cfg });

    // 9) 输出
    const summary = summarize(results);
    meta.rawHttpLogEvidence = rawLogEvidence(rawLog);
    meta.finishedAt = isoNow();
    const out = { meta, summary, checks: results };
    fs.writeFileSync(path.join(ARTIFACTS_DIR, 'results.json'), JSON.stringify(out, null, 2));
    console.log('\n=== 结果摘要 ===');
    console.log(JSON.stringify(summary, null, 2));
    console.log(`\n原始 HTTP transcript 自检：${JSON.stringify(meta.rawHttpLogEvidence)}`);
    console.log(`\n证据：${rel(path.join(ARTIFACTS_DIR, 'results.json'))}；原始 HTTP：${rel(rawLog)}；截图/日志：${rel(ARTIFACTS_DIR)}/`);
    if (summary.fail > 0) {
      console.log('\n存在 FAIL：见上表与 results.json（按 lead 要求分档：BYPASS/LEAK/BLOCKED）');
      process.exitCode = 1;
    } else {
      console.log('\n全部攻击被挡住（NO_BYPASS）。');
    }
  } catch (error) {
    meta.error = String(error?.stack ?? error);
    meta.finishedAt = isoNow();
    fs.writeFileSync(path.join(ARTIFACTS_DIR, 'results.json'), JSON.stringify({ meta, summary: { verdict: 'HARNESS_ERROR' }, checks: results, error: meta.error }, null, 2));
    console.error(`\n运行失败：${error.message}`);
    console.error(meta.error);
    process.exitCode = 2;
  } finally {
    if (browser) await browser.close().catch(() => {});
    for (const handle of handles.reverse()) await handle.cleanup().catch(() => {});
  }
}

await main();
