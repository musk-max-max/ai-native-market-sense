#!/usr/bin/env node
// check-network-policy.mjs —— H5-R10 网络边界 + ingress 暴露面（渲染断言，不只看 YAML）
//
// 边界口径：/healthz、/metrics、/docs、/openapi.json、/readyz 一律不得进 ingress；
// 公网只暴露 /v1。NetworkPolicy 五条：默认拒绝 ingress、只放行 ingress-controller、
// 默认拒绝 egress、放行 DNS、放行监控（以及显式声明的 DB/Redis/外部队列）。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const chart = path.join(repo, 'infra/helm/market-sense');
const HELM = process.env.HELM_BIN || 'helm';

let failures = 0;
let skipped = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`✅ ${name}`);
  } else {
    failures++;
    console.log(`❌ ${name}${detail ? `：${detail}` : ''}`);
  }
}

const template = readFileSync(path.join(chart, 'templates/networkpolicy.yaml'), 'utf8');
const ingressTpl = readFileSync(path.join(chart, 'templates/ingress.yaml'), 'utf8');

// 静态（模板层）
check('ingress 模板不路由 /healthz', !/path:\s*\/healthz/.test(ingressTpl));
check('ingress 模板不含 path: / 全放', !/path:\s*\/\s*(\n|$)/.test(ingressTpl));
check('networkpolicy 模板含 default-deny-ingress', /default-deny-ingress/.test(template));
check('networkpolicy 模板含 default-deny-egress', /default-deny-egress/.test(template));

// 渲染层
const helmAvailable = (() => {
  try {
    execFileSync(HELM, ['version', '--short'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
if (!helmAvailable) {
  skipped++;
  console.log('⏭ helm 不可用：渲染断言跳过（静态断言已跑；CI 内 helm 固定 3.16.2）');
} else {
  for (const profile of ['values-dev.yaml', 'values-preview.yaml']) {
    const args = ['template', 'np-verify', chart, '-f', path.join(chart, profile)];
    if (profile === 'values-preview.yaml') args.push('--set', 'preview.prNumber=1');
    let rendered = '';
    try {
      rendered = execFileSync(HELM, args, { encoding: 'utf8' });
    } catch (err) {
      check(`${profile} 渲染成功`, false, String(err.stderr || err.message).slice(0, 300));
      continue;
    }
    const paths = [...rendered.matchAll(/^\s*-\s*path:\s*(\S+)\s*$/gm)].map((m) => m[1]);
    const ingressPaths = paths.filter((p) => p !== '/healthz' || true); // pods 探针也匹配，下面按 Ingress 块收紧
    const ingressDoc = rendered
      .split(/^---$/m)
      .filter((d) => /kind:\s*Ingress\b/.test(d))
      .join('\n');
    const exposed = [...ingressDoc.matchAll(/^\s*-\s*path:\s*(\S+)\s*$/gm)].map((m) => m[1]);
    check(
      `${profile} Ingress 仅暴露 /v1（实际 ${exposed.join(',') || '无'}）`,
      exposed.length === 1 && exposed[0] === '/v1',
    );
    for (const forbidden of [
      '/healthz',
      '/metrics',
      '/docs',
      '/openapi.json',
      '/readyz',
      '/internal',
    ]) {
      check(`${profile} Ingress 不暴露 ${forbidden}`, !exposed.includes(forbidden));
    }
    check(
      `${profile} 渲染出 5 个 NetworkPolicy（实际 ${(rendered.match(/kind: NetworkPolicy/g) || []).length}）`,
      (rendered.match(/kind: NetworkPolicy/g) || []).length === 5,
    );
    check(
      `${profile} NetworkPolicy 含 default-deny ingress/egress + DNS + monitoring`,
      /default-deny-ingress/.test(rendered) &&
        /default-deny-egress/.test(rendered) &&
        /allow-ingress-controller/.test(rendered) &&
        /allow-monitoring/.test(rendered) &&
        /port: 53/.test(rendered),
    );
    void ingressPaths;
  }
}

// 集群外 /healthz=404 的实测证据：本地无集群时只能显式未验证，不伪造绿。
if (process.env.PUBLIC_BASE_URL) {
  check(
    `集群外 /healthz 必须 404（PUBLIC_BASE_URL=${process.env.PUBLIC_BASE_URL}）`,
    false,
    '需要 curl 实测；CI 请用 release-gate 的 probe 步骤，本脚本不代跑网络',
  );
} else {
  skipped++;
  console.log(
    '⏭ 集群外 /healthz=404：未提供 PUBLIC_BASE_URL，未验证（release-gate 会在有入口时实测）',
  );
}

if (failures > 0) {
  console.error(`\n网络边界断言失败：${failures} 项`);
  process.exit(1);
}
console.log(`\n✅ 网络边界断言通过（${skipped} 项未验证，已在输出标明）`);
