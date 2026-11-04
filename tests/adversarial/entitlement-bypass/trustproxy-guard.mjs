/**
 * 条件 1 黑盒守卫：TRUST_PROXY 宽网段/回环必须"拒绝启动且不是 warn"。
 *
 * 用法：
 *   node tests/adversarial/entitlement-bypass/trustproxy-guard.mjs
 *
 * 对每个候选 CIDR 在独立端口起一个真实 API 实例（隔离库 market_sense_a19），
 * 外部观测：进程是否退出（exitCode 非空）、是否仍能 /healthz 200、日志是否只是 warn。
 * 判定：拒启（进程退出）且未监听 = PASS；启动成功/仅 warn = FAIL。
 *
 * 说明：写代码的人不能自证守卫，所以本脚本只从外部观测，不 import 产品源码。
 * 修复前跑出 FAIL 是预期基线（守卫尚未实现）；修复后用同一命令复跑即可对照。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  WORKSPACE, ARTIFACTS_DIR, ensureDir, spawnService, waitFor, http, portInUse,
  addCheck, summarize, isoNow, rel, sleep,
} from './lib.mjs';

const cfg = {
  workspace: WORKSPACE,
  dbUrl: process.env.A19_DATABASE_URL ?? 'postgresql://ms@localhost:55432/market_sense_a19',
  basePort: Number(process.env.A19_PORT_TRUSTPROXY_GUARD ?? 18190),
  cidrs: ['0.0.0.0/0', '::/0', '127.0.0.0/8', '10.0.0.0/8'],
};

function logDirFor() {
  const dir = path.join(ARTIFACTS_DIR, 'logs');
  ensureDir(dir);
  return dir;
}

async function probeCidr({ cidr, port, results, logDir }) {
  const tag = cidr.replace(/[^a-z0-9]/gi, '_');
  const logFile = path.join(logDir, `api-trustproxy-guard-${tag}.log`);
  const handle = spawnService({
    name: `api-trustproxy-guard-${tag}`,
    command: 'node',
    args: ['--import', 'tsx', 'src/server.ts'],
    cwd: path.join(cfg.workspace, 'services', 'api'),
    env: {
      HOST: '127.0.0.1',
      PORT: String(port),
      APP_PROFILE: 'test',
      E2E_MODE: '1',
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      ENTITLEMENT_TIER: 'internal_eval',
      DATABASE_URL: cfg.dbUrl,
      TRUST_PROXY: cidr,
    },
    logFile,
  });

  let exited = false;
  let healthy = false;
  let healthStatus = null;
  let listenedPort = false;
  try {
    // 等"退出"或"健康"先到；宽网段若被正确拒绝，进程应在监听前退出。
    const outcome = await waitFor(
      `TRUST_PROXY=${cidr} 启动结果`,
      async () => {
        if (handle.child.exitCode !== null) return 'exited';
        // "是否监听端口"的外部观测：每轮主动 connect 一次；只要曾连上就记 listenedPort。
        try {
          if (await portInUse(port)) listenedPort = true;
        } catch {
          // connect 失败 = 未监听
        }
        try {
          const res = await http(`http://127.0.0.1:${port}/healthz`);
          healthStatus = res.status;
          if (res.status === 200) return 'healthy';
        } catch {
          // 未监听：继续等
        }
        return null;
      },
      { timeoutMs: 25_000, intervalMs: 250 },
    ).catch(() => null);
    exited = handle.child.exitCode !== null;
    healthy = outcome === 'healthy' || healthStatus === 200;
    if (!listenedPort && await portInUse(port).catch(() => false)) listenedPort = true;
    if (exited && !healthy) {
      // 给进程退出日志一点落盘时间
      await sleep(200);
    }
  } finally {
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    await handle.cleanup().catch(() => {});
    const mentionsTrustProxy = /TRUST_PROXY/i.test(log);
    const exitFirstLine = log.split('\n').map((line) => line.trim()).find(Boolean) ?? null;
    const warnOnly = /(?:warn|warning)[^\n]*TRUST_PROXY|TRUST_PROXY[^\n]*warn/i.test(log);
    // 只把"配置层校验拒绝"记为 PASS：进程退出 + 日志点名 TRUST_PROXY + 从未监听。
    // 依赖库崩溃（如 @fastify/proxy-addr 对 0.0.0.0/0 抛 TypeError）虽然也退出，
    // 但不是启动校验，换个写法/依赖版本就可能重新放行——按 FAIL 记，避免自欺。
    const refusedByConfigGuard = exited && !healthy && !listenedPort && mentionsTrustProxy && !warnOnly;
    const incidentalCrash = exited && !healthy && !mentionsTrustProxy;
    addCheck(results, {
      id: `Q-${cidr}`,
      title: `TRUST_PROXY=${cidr} 必须被配置层拒绝启动（不允许 warn 后继续、不接受依赖崩溃式拒启）`,
      clause: ['lead R4 裁定-条件 1', 'decisions.md L28'],
      attempt: `APP_PROFILE=test TRUST_PROXY=${cidr} node --import tsx src/server.ts (port ${port})`,
      expectation: '进程退出 + 日志点名 TRUST_PROXY + 从未监听健康端口，三条同时成立；healthz 200、曾监听、仅 warn、依赖库 TypeError 崩溃均 FAIL',
      observed: {
        cidr,
        port,
        exited,
        exitCode: handle.child.exitCode,
        healthStatus,
        healthy,
        listenedPort,
        mentionsTrustProxy,
        warnOnly,
        refusedByConfigGuard,
        incidentalCrash,
        exitFirstLine,
        logTail: log.slice(-700),
      },
      status: refusedByConfigGuard ? 'PASS' : 'FAIL',
      severity: refusedByConfigGuard ? null : 'P2',
      evidence: { log: rel(logFile) },
    });
  }
}

async function main() {
  ensureDir(ARTIFACTS_DIR);
  const logDir = logDirFor();
  const results = [];
  const startedAt = isoNow();
  console.log(`条件 1 黑盒守卫（隔离库 ${cfg.dbUrl}；端口 ${cfg.basePort}–${cfg.basePort + cfg.cidrs.length - 1}）`);
  for (let i = 0; i < cfg.cidrs.length; i += 1) {
    await probeCidr({ cidr: cfg.cidrs[i], port: cfg.basePort + i, results, logDir });
  }
  const summary = summarize(results);
  const out = {
    meta: { startedAt, finishedAt: isoNow(), dbUrl: cfg.dbUrl, basePort: cfg.basePort, cidrs: cfg.cidrs, node: process.version },
    summary,
    checks: results,
  };
  const outFile = path.join(ARTIFACTS_DIR, 'trustproxy-guard.json');
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log('\n=== 条件 1 摘要 ===');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\n证据：${rel(outFile)}；日志：${rel(logDir)}/api-trustproxy-guard-*.log`);
  if (summary.fail > 0) {
    console.log('\n存在 FAIL：宽网段/回环未被拒绝启动（或只是 warn）。修复前基线属预期，修复后需复跑。');
    process.exitCode = 1;
  } else {
    console.log('\n四个候选 CIDR 均被拒绝启动（且非 warn-only）。');
  }
}

await main();
