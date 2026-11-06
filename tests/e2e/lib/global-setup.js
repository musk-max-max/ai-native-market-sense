// tests/e2e/lib/global-setup.js
// Playwright 全局前置：执行 preflight，把「READY / SKIP / FAIL」落成状态文件供用例读取。
// 注意：exit 1 = E2E 资产缺陷（compose/fixture/quarantine 坏了），在这里就让 CI 失败，
//       不要等 11 条用例各自超时；exit 78 = 环境/实现未就绪，交给用例 skip。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * ADR-008 S1 认证 token 供给：
 *   - E2E_AUTH_TOKEN 已给 → 用它；
 *   - 否则若 E2E_AUTH_AUTOSEED=1 → 调 seed_e2e_identity.py（restricted 造 internal_eval 夹具用户，
 *     normal 走 register/login），把 token 写进 .state 文件并注入 process.env（preflight 子进程继承）。
 * 不自动写库是默认行为：只有显式 AUTOSEED 才碰 identity 表。
 */
async function ensureAuthToken() {
  if (process.env.E2E_AUTH_TOKEN) return;
  if (process.env.E2E_AUTH_AUTOSEED !== '1') return;
  const matrix = (process.env.E2E_ENTITLEMENT_MATRIX || 'normal').toLowerCase();
  const apiBase = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
  const script = path.join(E2E_DIR, 'scripts', 'seed_e2e_identity.py');
  const result = spawnSync('python3', [script, '--matrix', matrix, '--api-base', apiBase], {
    env: { ...process.env, E2E_AUTH_AUTOSEED: '1' },
    encoding: 'utf8',
  });
  const token = (result.stdout || '').trim().split('\n').pop() || '';
  if (result.status !== 0 || !token) {
    throw new Error(`[global-setup] E2E_AUTH_AUTOSEED 失败（matrix=${matrix}）：${result.stderr || result.stdout}`);
  }
  process.env.E2E_AUTH_TOKEN = token;
  console.warn(`[global-setup] 已自动签发 identity token（matrix=${matrix}）`);
}

export default async function globalSetup() {
  await ensureAuthToken();
  if (process.env.E2E_SKIP_PREFLIGHT === '1') {
    // Lead 2026-11-04：bypass 必须留下显式 READY 状态，否则 harness 读不到文件会静默 skip 全部用例。
    const statusFile = process.env.E2E_STATUS_FILE || path.join(E2E_DIR, '.e2e-status.json');
    let replay = { ready: false, detail: '未探测' };
    try {
      const response = await fetch(`${process.env.E2E_REPLAY_URL || 'http://127.0.0.1:18081'}/__livez`,
        { signal: AbortSignal.timeout(2000) });
      replay = response.ok
        ? { ready: true, detail: 'replay /__livez 可达' }
        : { ready: false, detail: `replay /__livez ${response.status}` };
    } catch (err) {
      replay = { ready: false, detail: `replay 不可达：${err.message}` };
    }
    const recordingsDir = path.join(E2E_DIR, '..', 'fixtures', 'tushare', 'recordings');
    let recordings = 0;
    try { recordings = (await fs.readdir(recordingsDir)).filter((f) => f.endsWith('.json')).length; } catch { /* 空目录 */ }
    await fs.writeFile(statusFile, JSON.stringify({
      generated_at: new Date().toISOString(),
      decision: 'READY',
      exit_code: 0,
      preflight_bypassed: true,
      reasons: ['PREFLIGHT_BYPASSED: E2E_SKIP_PREFLIGHT=1（未做准入检查，仅用于已手工验证环境的排障）'],
      fixtures: { recordings },
      replay,
      checks: [],
    }, null, 2) + '\n', 'utf8');
    console.warn(`[global-setup] E2E_SKIP_PREFLIGHT=1：已写 READY（bypass）到 ${statusFile}；replay ready=${replay.ready}`);
    return;
  }
  const result = spawnSync(
    process.env.E2E_PYTHON || 'python3',
    [path.join(E2E_DIR, 'scripts', 'preflight.py'), '--json', process.env.E2E_STATUS_FILE || path.join(E2E_DIR, '.e2e-status.json')],
    { stdio: 'inherit', timeout: 120000 },
  );
  if (result.status === 1) {
    throw new Error('preflight FAIL：E2E 资产/配置有缺陷，见上方输出与 .e2e-status.json');
  }
}
