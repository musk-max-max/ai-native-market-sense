/**
 * A19 对抗测试工具库：起隔离真栈、发 HTTP、驱动 Playwright、记录证据。
 *
 * 只做基础设施，不含攻击判定逻辑（判定在 cases/*.mjs）。
 * 隔离边界：只连 127.0.0.1 上 A19 自己起的 API/web 端口，以及本地 PG 的
 * market_sense_a19 独立库（provision-db.sh 从当前 warehouse schema 建库）；
 * 不碰 lead 的 8081/3000、不碰生产、不碰真实用户数据。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
/** tests/adversarial/entitlement-bypass → workspace 根 */
export const WORKSPACE = path.resolve(HERE, '..', '..', '..');
export const ARTIFACTS_DIR = path.join(HERE, 'artifacts');

// Playwright 装在 tests/e2e（A12 owns），从该目录解析，避免在 A19 目录再装一份浏览器依赖。
const requireE2E = createRequire(path.join(WORKSPACE, 'tests', 'e2e', 'package.json'));
export const { chromium } = requireE2E('@playwright/test');

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export async function portInUse(port) {
  const net = await import('node:net');
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (used) => {
      socket.destroy();
      resolve(used);
    };
    socket.setTimeout(500);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * 启动子进程并把 stdout/stderr 写入日志文件。返回句柄，cleanup() 负责回收。
 * 不使用 detached/进程组：API 与 web 都是单进程 node。
 */
export function spawnService({ name, command, args, cwd, env, logFile }) {
  ensureDir(path.dirname(logFile));
  const out = fs.openSync(logFile, 'w');
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', out, out],
  });
  fs.closeSync(out);
  const handle = {
    name,
    child,
    logFile,
    exited: false,
    async cleanup() {
      if (handle.exited) return;
      handle.exited = true;
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      const started = Date.now();
      while (child.exitCode === null && Date.now() - started < 5000) await sleep(100);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
  child.once('exit', () => {
    handle.exited = true;
  });
  return handle;
}

export async function waitFor(label, fn, { timeoutMs = 30_000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  const suffix = lastError ? `；最后错误: ${lastError.message}` : '';
  throw new Error(`等待超时（${timeoutMs}ms）: ${label}${suffix}`);
}

export async function waitHttpOk(url, { timeoutMs = 30_000, label = url } = {}) {
  return waitFor(
    label,
    async () => {
      const res = await fetch(url, { redirect: 'manual' });
      return res.status >= 200 && res.status < 500;
    },
    { timeoutMs },
  );
}

/**
 * 发一个 HTTP 请求并读取完整响应。不抛非 2xx（攻击结果本身就是状态码）。
 * 返回值：{ status, headers（小写 key 的普通对象）, text, json, url }
 */
export async function http(url, { method = 'GET', headers = {}, body } = {}) {
  const init = { method, headers, redirect: 'manual' };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const headerMap = {};
  res.headers.forEach((value, key) => {
    headerMap[key.toLowerCase()] = value;
  });
  return { status: res.status, headers: headerMap, text, json, url };
}

/** 统一的证据条目。status: PASS（攻击被挡住/断言成立）| FAIL（被打穿）| INFO（事实记录，不判定）。 */
export function addCheck(results, entry) {
  const check = {
    id: entry.id,
    title: entry.title,
    clause: entry.clause ?? [],
    attempt: entry.attempt,
    expectation: entry.expectation,
    observed: entry.observed,
    status: entry.status,
    severity: entry.severity ?? null,
    evidence: entry.evidence ?? null,
  };
  results.push(check);
  const icon = check.status === 'PASS' ? '✓' : check.status === 'FAIL' ? '✗' : 'i';
  const line = `  ${icon} [${check.status}] ${check.id} ${check.title}`;
  console.log(line);
  if (check.status === 'FAIL') {
    console.log(`      observed: ${JSON.stringify(check.observed)}`);
  }
  return check;
}

export function summarize(results) {
  const count = (status) => results.filter((r) => r.status === status).length;
  const failures = results.filter((r) => r.status === 'FAIL');
  return {
    total: results.length,
    pass: count('PASS'),
    fail: count('FAIL'),
    info: count('INFO'),
    verdict: failures.length === 0 ? 'NO_BYPASS' : 'BYPASS_FOUND',
    failures: failures.map((r) => ({ id: r.id, title: r.title, severity: r.severity, observed: r.observed })),
  };
}

/** 读 web/h5/src 下所有 .ts/.tsx 文件内容（静态审计用）。 */
export function readSourceFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(full);
      } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
        out.push({ path: full, content: fs.readFileSync(full, 'utf8') });
      }
    }
  };
  walk(dir);
  return out;
}

export function rel(file) {
  return path.relative(WORKSPACE, file);
}

export function isoNow() {
  return new Date().toISOString();
}
