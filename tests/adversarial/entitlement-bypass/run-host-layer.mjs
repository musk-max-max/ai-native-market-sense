#!/usr/bin/env node
/**
 * A19 主机层 / 隧道类越权用例执行器（与 A9 对齐：EXC-<SURFACE>-<NN>，见 cases.yaml）。
 *
 * 用法：
 *   node tests/adversarial/entitlement-bypass/run-host-layer.mjs            # 本地隔离栈自检（默认）
 *   node tests/adversarial/entitlement-bypass/run-host-layer.mjs --target   # 真实目标（默认拒绝）
 *
 * 真实目标模式：必须同时满足
 *   A19_HOST_LAYER_APPROVED=1（H5 书面授权）+ A19_SSH_TARGET=<user@host>；
 * 否则直接 exit 2，不发起任何连接。切勿仅因开关存在就打开。
 *
 * 本地自检：只起 127.0.0.1:18188(API, internal_eval) / 3220(web) / 19088(relay)，
 * 用隔离库 market_sense_a19；不碰 ECS、不绑公网监听。
 *
 * 输出：artifacts/host-layer-<runId>.json + stdout；本地模式 oracle 命中 exit 0。
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  WORKSPACE, ARTIFACTS_DIR, ensureDir, portInUse, spawnService, waitFor,
  http, addCheck, summarize, isoNow, rel,
} from './lib.mjs';

const cfg = {
  dbUrl: process.env.A19_DATABASE_URL ?? 'postgresql://ms@localhost:55432/market_sense_a19',
  webDist: process.env.A19_WEB_DIST ?? path.join(WORKSPACE, 'web', 'h5', 'dist'),
  approved: process.env.A19_HOST_LAYER_APPROVED === '1',
  sshTarget: process.env.A19_SSH_TARGET ?? '',
  ports: { api: 18188, web: 3220, relay: 19088, tunnel: 19089, tunnelRelay: 19090 },
};
const targetMode = process.argv.includes('--target');
const runId = isoNow().replace(/[^0-9TZ]/g, '');
const results = [];
const handles = [];
const startedAt = isoNow();

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function psql(sql) {
  const r = spawnSync('psql', [cfg.dbUrl, '-tAc', sql], { encoding: 'utf8', timeout: 15_000 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim(), status: r.status };
}

function ssh(cmd) {
  const r = spawnSync(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=8', cfg.sshTarget, cmd],
    { encoding: 'utf8', timeout: 30_000 },
  );
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim(), status: r.status };
}

function startRelay(name, listenHost, listenPort, targetPort) {
  const sockets = new Set();
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, '127.0.0.1');
    sockets.add(client);
    sockets.add(upstream);
    const drop = () => { client.destroy(); upstream.destroy(); };
    client.on('error', drop);
    upstream.on('error', drop);
    client.pipe(upstream);
    upstream.pipe(client);
    client.on('close', () => sockets.delete(client) || upstream.destroy());
    upstream.on('close', () => sockets.delete(upstream) || client.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, listenHost, () => {
      const handle = {
        name,
        server,
        cleanup: () =>
          new Promise((res) => {
            for (const s of sockets) s.destroy();
            server.close(() => res());
            setTimeout(res, 500).unref?.();
          }),
      };
      handles.push(handle);
      resolve(handle);
    });
  });
}

async function waitPort(port, host = '127.0.0.1', timeoutMs = 30_000) {
  await waitFor(`port ${host}:${port}`, () =>
    new Promise((res) => {
      const s = net.connect(port, host);
      s.once('connect', () => { s.destroy(); res(true); });
      s.once('error', () => res(false));
      setTimeout(() => { s.destroy(); res(false); }, 500);
    }), { timeoutMs, intervalMs: 200 });
}

function apiEnv(extra = {}) {
  return {
    HOST: '127.0.0.1',
    NODE_ENV: 'test',
    APP_PROFILE: 'test',
    E2E_MODE: '1',
    LOG_LEVEL: 'warn',
    DATABASE_URL: cfg.dbUrl,
    E2E_AUTH_TOKEN: 'dev-token',
    ENTITLEMENT_TIER: 'internal_eval',
    RATE_LIMIT_IP_BURST: '5000',
    RATE_LIMIT_IP_PER_MIN: '60000',
    ...extra,
  };
}

async function startLocalStack(logDir) {
  const api = spawnService({
    name: 'api-restricted',
    command: 'node',
    args: ['--import', 'tsx', 'src/server.ts'],
    cwd: path.join(WORKSPACE, 'services', 'api'),
    env: apiEnv({ PORT: String(cfg.ports.api) }),
    logFile: path.join(logDir, 'api-restricted.log'),
  });
  handles.push(api);
  const web = spawnService({
    name: 'web-restricted',
    command: 'node',
    args: ['server.mjs'],
    cwd: path.join(WORKSPACE, 'web', 'h5'),
    env: {
      HOST: '127.0.0.1',
      PORT: String(cfg.ports.web),
      API_BASE_URL: `http://127.0.0.1:${cfg.ports.api}`,
      WEB_DIST_DIR: cfg.webDist,
      NODE_ENV: 'production',
    },
    logFile: path.join(logDir, 'web-restricted.log'),
  });
  handles.push(web);
  await waitFor('local API 健康', async () => (await http(`http://127.0.0.1:${cfg.ports.api}/healthz`)).status === 200, { timeoutMs: 60_000 });
  await waitFor('local web 可达', async () => (await http(`http://127.0.0.1:${cfg.ports.web}/`)).status === 200, { timeoutMs: 30_000 });
}

async function excHost01Local() {
  const quote = await http(`http://127.0.0.1:${cfg.ports.api}/v1/instruments/SSE:600519/quote`);
  const count = psql('select count(*) from serving.serving_quote_latest');
  const sample = psql('select instrument_id, close, as_of from serving.serving_quote_latest order by instrument_id limit 1');
  const audit = psql('select count(*) from audit.entitlement_events');
  const dbRows = Number.parseInt(count.out || '0', 10);
  const env = {
    entitlement_tier: 'internal_eval',
    entitlement_audit: process.env.ENTITLEMENT_AUDIT ?? '(unset → e2e 默认关闭)',
    entitlement_hold_check: process.env.ENTITLEMENT_HOLD_CHECK ?? '(unset → e2e 默认关闭)',
  };
  const auditCount = audit.ok ? Number.parseInt(audit.out || '0', 10) : null;
  // H5 m01276：audit_event_count=null 只能记 INCOMPLETE（audit 子结论不得算 PASS）。
  const auditGapStatus =
    auditCount === null ? 'INCOMPLETE' : auditCount === 0 ? 'CONFIRMED_GAP' : 'NO_GAP';
  const bypass = quote.status === 403 && dbRows > 0;
  addCheck(results, {
    id: 'EXC-HOST-01',
    title: '主机层→DB 直读（本地隔离栈自检；非 ECS 结果）',
    clause: 'C 端 403 不应能被宿主/DB 层绕过（R4/R6 已知面）',
    attempt: `API quote=${quote.status}；psql serving_quote_latest rows=${count.ok ? dbRows : 'ERR:' + count.err}；sample=${sample.out || 'n/a'}`,
    expectation: 'oracle: api_quote_status==403 AND db_quote_rows>0 => BYPASS（自检命中）；否则 INVALID。audit_event_count==null => audit_gap_status=INCOMPLETE（不得算 PASS）',
    observed: JSON.stringify({
      scope: 'local-isolated-fixture (market_sense_a19); NOT an ECS/production result',
      api_quote_status: quote.status,
      api_body_sha256: sha256(quote.text ?? ''),
      db_quote_rows: count.ok ? dbRows : null,
      db_sample: sample.ok ? sample.out : null,
      audit_event_count: auditCount,
      audit_gap_status: auditGapStatus,
      env,
    }),
    status: bypass ? 'FAIL' : 'PASS',
    severity: 'P2-known',
    evidence: bypass
      ? '本地自检命中：API 403 但 psql 可读非空行情（与 R4 主机层→DB 直读一致；真实目标需授权）'
      : '本地自检未命中（检查 DB schema / 数据）',
  });
  return { bypass, quoteStatus: quote.status, dbRows };
}

async function excTunnel01Local() {
  const relay = await startRelay('tunnel-relay', '127.0.0.1', cfg.ports.relay, cfg.ports.web);
  const viaRelay = await http(`http://127.0.0.1:${cfg.ports.relay}/`);
  const viaRelayQuote = await http(`http://127.0.0.1:${cfg.ports.relay}/v1/instruments/SSE:600519/quote`);
  await relay.cleanup();
  addCheck(results, {
    id: 'EXC-TUNNEL-01',
    title: '隧道二次转发（本地 relay 逻辑自检）',
    clause: '二次转发不得让第三人匿名读到未授权数据（A9 口径：第二 vantage 才构成跨主机证据）',
    attempt: `127.0.0.1:${cfg.ports.relay} -> 127.0.0.1:${cfg.ports.web}；GET /=${viaRelay.status}，quote=${viaRelayQuote.status}，relay 未注入任何凭据`,
    expectation: '自检仅证明 relay 逻辑可转发；跨主机第三人可达需第二 vantage，本轮不成立 → 记为 INFO/INCOMPLETE',
    observed: JSON.stringify({
      relay_bind: `127.0.0.1:${cfg.ports.relay}`,
      web_via_relay_status: viaRelay.status,
      quote_via_relay_status: viaRelayQuote.status,
      quote_cache_control: viaRelayQuote.headers['cache-control'] ?? null,
      client_identity_forwarded: false,
      second_vantage: 'not-established(local-loopback-only)',
    }),
    status: 'INFO',
    severity: 'informational',
    evidence: '本地 relay 自检通过；不构成第三人可达证据（A9 Q2 第 2 层以下）',
  });
}

function targetGuard() {
  const problems = [];
  if (!cfg.approved) problems.push('缺少 A19_HOST_LAYER_APPROVED=1（需 H5 书面授权）');
  if (!cfg.sshTarget) problems.push('缺少 A19_SSH_TARGET=<user@host>');
  if (problems.length > 0) {
    console.error(`真实目标模式拒绝执行：\n- ${problems.join('\n- ')}\n（当前 ECS 目标按 H5 m01196 为 blocked，不得因开关存在就打开）`);
    process.exit(2);
  }
}

async function excHost01Target(logDir) {
  const apiProbe = ssh(
    `curl -s -o /tmp/a19-quote.json -w '%{http_code}' http://127.0.0.1:8081/v1/instruments/SSE:600519/quote && echo && head -c 400 /tmp/a19-quote.json`,
  );
  const count = ssh(`docker exec market-sense-e2e-postgres-1 psql -U market -d market -tAc "select count(*) from serving.serving_quote_latest"`);
  const sample = ssh(`docker exec market-sense-e2e-postgres-1 psql -U market -d market -tAc "select instrument_id, close, as_of from serving.serving_quote_latest order by instrument_id limit 1"`);
  const audit = ssh(`docker exec market-sense-e2e-postgres-1 psql -U market -d market -tAc "select count(*) from audit.entitlement_events"`);
  const envProbe = ssh(`docker inspect market-sense-e2e-api-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E 'ENTITLEMENT_(TIER|AUDIT|HOLD_CHECK)='`);
  const apiStatus = Number.parseInt((apiProbe.out.match(/^(\d{3})/m) ?? [])[1] ?? '0', 10);
  const dbRows = Number.parseInt((count.out.match(/-?\d+/) ?? [])[0] ?? '0', 10);
  const bypass = apiStatus === 403 && dbRows > 0;
  addCheck(results, {
    id: 'EXC-HOST-01',
    title: '主机层→DB 直读（真实目标，授权执行）',
    clause: 'C 端 403 不应能被宿主/DB 层绕过',
    attempt: `ssh ${cfg.sshTarget}；API quote=${apiProbe.out.slice(0, 400)}；psql rows=${count.out}；sample=${sample.out}`,
    expectation: 'oracle: api_quote_status==403 AND db_quote_rows>0 => BYPASS',
    observed: JSON.stringify({
      api_quote_status: apiStatus,
      db_quote_rows: count.ok ? dbRows : null,
      db_sample: sample.out || null,
      audit_event_count: audit.out || null,
      env: envProbe.out || null,
    }),
    status: bypass ? 'FAIL' : 'PASS',
    severity: 'P1',
    evidence: bypass ? '真实目标 BYPASS：API 403 但 DB 可直读' : '真实目标 BLOCKED',
  });
}

async function excTunnel01Target(logDir) {
  const sshChild = spawnService({
    name: 'ssh-tunnel',
    command: 'ssh',
    args: ['-N', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-L', `${cfg.ports.tunnel}:127.0.0.1:3000`, cfg.sshTarget],
    cwd: WORKSPACE,
    env: {},
    logFile: path.join(logDir, 'ssh-tunnel.log'),
  });
  handles.push(sshChild);
  await waitPort(cfg.ports.tunnel);
  const web = await http(`http://127.0.0.1:${cfg.ports.tunnel}/`);
  const quote = await http(`http://127.0.0.1:${cfg.ports.tunnel}/v1/instruments/SSE:600519/quote`);
  const relay = await startRelay('tunnel-relay', '127.0.0.1', cfg.ports.tunnelRelay, cfg.ports.tunnel);
  const web2 = await http(`http://127.0.0.1:${cfg.ports.tunnelRelay}/`);
  await relay.cleanup();
  sshChild.cleanup?.();
  addCheck(results, {
    id: 'EXC-TUNNEL-01',
    title: '隧道二次转发（真实目标，授权执行）',
    clause: '二次转发不得让第三人匿名到达/读到；服务端应可区分原操作者与第三人',
    attempt: `ssh -L ${cfg.ports.tunnel}:127.0.0.1:3000 ${cfg.sshTarget}；web=${web.status}，quote=${quote.status}；relay->web=${web2.status}`,
    expectation: '第二 vantage 可达且服务端身份不可区分 => AMPLIFICATION；否则 BLOCKED/INCOMPLETE',
    observed: JSON.stringify({
      tunnel_web_status: web.status,
      tunnel_quote_status: quote.status,
      tunnel_quote_cache_control: quote.headers['cache-control'] ?? null,
      relay_web_status: web2.status,
      second_vantage: process.env.A19_TUNNEL_VANTAGE_URL ? 'configured-but-not-exercised' : 'not-established',
      server_identity_distinguishable: null,
      audit_event_count: null,
    }),
    status: 'INFO',
    severity: 'P2',
    evidence: '授权目标上隧道/relay 可达性已记录；第三人 vantage 与身份可区分性需按 cases.yaml 补齐',
  });
}

async function main() {
  ensureDir(ARTIFACTS_DIR);
  const logDir = path.join(ARTIFACTS_DIR, 'logs', `host-layer-${runId}`);
  ensureDir(logDir);

  if (targetMode) targetGuard();

  // preflight
  const problems = [];
  const portsToCheck = targetMode
    ? [cfg.ports.tunnel, cfg.ports.tunnelRelay]
    : [cfg.ports.api, cfg.ports.web, cfg.ports.relay];
  for (const port of portsToCheck) if (await portInUse(port)) problems.push(`端口被占用：${port}`);
  if (!targetMode) {
    if (!fs.existsSync(path.join(cfg.webDist, 'index.html'))) problems.push(`web dist 不存在：${rel(cfg.webDist)}/index.html`);
    const probe = psql('select count(*) from serving.serving_quote_latest');
    if (!probe.ok) problems.push(`隔离库不可用：${probe.err || probe.status}`);
  }
  if (problems.length > 0) {
    console.error(`preflight 失败：\n- ${problems.join('\n- ')}`);
    process.exit(2);
  }

  if (targetMode) {
    await excHost01Target(logDir);
    await excTunnel01Target(logDir);
  } else {
    await startLocalStack(logDir);
    await excHost01Local();
    await excTunnel01Local();
  }

  for (const h of handles.reverse()) {
    try { await h.cleanup?.(); } catch { /* ignore */ }
  }
  await new Promise((r) => setTimeout(r, 300));
  const listeners = [];
  for (const port of [cfg.ports.api, cfg.ports.web, cfg.ports.relay, cfg.ports.tunnel, cfg.ports.tunnelRelay]) {
    if (await portInUse(port)) listeners.push(port);
  }

  const finishedAt = isoNow();
  const out = {
    schema_version: '0.1',
    suite: 'host-layer',
    owner: 'A19',
    run_id: runId,
    mode: targetMode ? 'target' : 'local-self-check',
    authorized: cfg.approved,
    ssh_target: cfg.sshTarget || null,
    started_at: startedAt,
    finished_at: finishedAt,
    cleanup_listeners: listeners,
    checks: results,
    meta: {
      db_url: targetMode ? '(target)' : cfg.dbUrl,
      web_dist: targetMode ? '(target)' : rel(path.join(cfg.webDist, 'index.html')),
      note: targetMode
        ? '真实目标执行：需 H5 书面授权；只读 SELECT + 短窗口隧道'
        : '本地隔离栈自检：不碰 ECS、不绑公网监听；EXC-TUNNEL-01 仅 relay 逻辑，不构成第三人可达证据',
    },
  };
  const outFile = path.join(ARTIFACTS_DIR, `host-layer-${runId}.json`);
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n');
  const summary = summarize(results);
  console.log(`\nARTIFACT: ${rel(outFile)}`);
  console.log(`cleanup_listeners: ${JSON.stringify(listeners)}`);
  const host = results.find((r) => r.id === 'EXC-HOST-01');
  const detected = host?.status === 'FAIL';
  if (targetMode) process.exit(detected ? 1 : 0);
  process.exit(detected ? 0 : 1); // 本地模式：检测到已知绕过 = 自检通过
}

main().catch((error) => {
  console.error(`run-host-layer 失败：${error.stack ?? error.message}`);
  for (const h of handles.reverse()) { try { h.cleanup?.(); } catch { /* ignore */ } }
  process.exit(2);
});
