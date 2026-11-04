#!/usr/bin/env node
// #3 受限/降级档 403 采样：quote / bars / fundamental-summary 各 N 次，断言 403 +
// ENTITLEMENT_RESTRICTED + no-store；输出 near-rank P95/max 与逐条样本（JSON）。
// 用法：node scripts/sample-restricted-403-p95.mjs <base-url> [instrument] [n]
const base = (process.argv[2] ?? 'http://127.0.0.1:18100').replace(/\/$/, '');
const instrument = process.argv[3] ?? 'SSE:600519';
const n = Number(process.argv[4] ?? 20);
const paths = [
  `/v1/instruments/${instrument}/quote`,
  `/v1/instruments/${instrument}/bars?limit=1`,
  `/v1/instruments/${instrument}/fundamental-summary`,
];
const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(0.95 * xs.length) - 1)];
const round = (x) => Math.round(x * 1000) / 1000;
const samples = [];
let failures = 0;
for (const path of paths) {
  for (let i = 0; i < n; i += 1) {
    const t0 = process.hrtime.bigint();
    let status = 0;
    let body = '';
    let cacheControl = '';
    try {
      const res = await fetch(base + path);
      status = res.status;
      cacheControl = res.headers.get('cache-control') ?? '';
      body = await res.text();
    } catch (error) {
      console.error(`request failed ${path}: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(2);
    }
    const ms = round(Number(process.hrtime.bigint() - t0) / 1e6);
    let code = null;
    try { code = JSON.parse(body)?.code ?? null; } catch { /* problem body required */ }
    const ok = status === 403 && code === 'ENTITLEMENT_RESTRICTED' && /no-store/.test(cacheControl);
    if (!ok) failures += 1;
    samples.push({ path, status, code, cache_control: cacheControl, ms, ok });
  }
}
const all = samples.map((s) => s.ms);
const byPath = paths.map((path) => {
  const xs = samples.filter((s) => s.path === path).map((s) => s.ms);
  return { path, n: xs.length, p95_ms: p95(xs), max_ms: Math.max(...xs) };
});
const report = {
  base_url_redacted: base.replace(/\/\/[^/]*@/, '//<redacted>@'),
  entitlement_tier: 'internal_eval',
  // 采样前提：internal_eval（gate blocked → 403 短路），且 test profile 下关闭 hold/audit 读库，
  // 否则采样会掺入 control 读的 1s 超时/事件写入，不是 #3 要测的受限 403 路径。
  profile: {
    APP_PROFILE: process.env.APP_PROFILE ?? null,
    ENTITLEMENT_HOLD_CHECK: process.env.ENTITLEMENT_HOLD_CHECK ?? null,
    ENTITLEMENT_AUDIT: process.env.ENTITLEMENT_AUDIT ?? null,
    RATE_LIMIT_IP_PER_MIN: process.env.RATE_LIMIT_IP_PER_MIN ?? null,
    RATE_LIMIT_IP_BURST: process.env.RATE_LIMIT_IP_BURST ?? null,
  },
  n_per_path: n,
  generated_at: new Date().toISOString(),
  node: process.version,
  all_403_no_store: failures === 0,
  p95_ms: p95(all),
  max_ms: Math.max(...all),
  by_path: byPath,
  samples,
};
console.log(JSON.stringify(report, null, 2));
process.exit(failures === 0 ? 0 : 1);
