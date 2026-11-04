#!/usr/bin/env node
/**
 * infra/ci/check-entitlement-config.mjs —— 授权配置 fail-closed 门禁（H5 卡点）
 *
 * WHY：H5 抓到过一次真实的 fail-open：Helm values 没写 ENTITLEMENT_TIER/ENTITLEMENT_EXPIRES_AT，
 *      configmap 只透传已有 key，部署后服务按代码默认 c_end_display 展出 = C 端直接看行情。
 *      这类问题在评审里很难靠眼睛发现，必须在 CI 里把「默认值、必填校验、e2e 默认档」钉死。
 *
 * 检查：
 *   1. Helm values.yaml 显式声明 config.ENTITLEMENT_TIER=internal_eval、config.ENTITLEMENT_EXPIRES_AT
 *   2. configmap 模板 required + 非 internal_eval 必须给 expires（fail-closed）
 *   3. dev/preview values 显式 internal_eval（不得靠默认）
 *   4. Helm 渲染：默认档渲染出 internal_eval；tier=c_end_display 无 expires 必须渲染失败
 *   5. E2E compose 默认必须是 internal_eval，且透传 E2E_ENTITLEMENT_EXPIRES_AT
 *   6. 仓库内没有任何「默认 c_end_display」的痕迹（compose/values/helm 模板）
 *
 * 需要 helm 二进制（CI 的 iac job 已安装；本地可 HELM_BIN=/tmp/tools/helm）。
 * 无 helm 时：静态检查仍跑，渲染检查显式 skip 并列出未验证项（exit 0，但不伪装通过）。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HELM = process.env.HELM_BIN || 'helm';
const failures = [];
const passes = [];
const skips = [];

function read(rel) {
  try {
    return readFileSync(join(ROOT, rel), 'utf8');
  } catch {
    failures.push(`${rel}：不存在或不可读`);
    return '';
  }
}
function check(name, ok, detail = '') {
  if (ok) passes.push(name);
  else failures.push(detail ? `${name} —— ${detail}` : name);
}

const values = read('infra/helm/market-sense/values.yaml');
const valuesDev = read('infra/helm/market-sense/values-dev.yaml');
const valuesPreview = read('infra/helm/market-sense/values-preview.yaml');
const configmap = read('infra/helm/market-sense/templates/configmap.yaml');
const compose = read('tests/e2e/docker-compose.yml');

// 1. values 显式声明
check(
  'values.yaml 显式设置 ENTITLEMENT_TIER: "internal_eval"',
  /ENTITLEMENT_TIER:\s*"internal_eval"/.test(values),
);
check(
  'values.yaml 显式声明 ENTITLEMENT_EXPIRES_AT（空串）',
  /ENTITLEMENT_EXPIRES_AT:\s*""/.test(values),
);
check('values.yaml 注明 fail-closed 原因（F1 未落地）', /F1|fail-closed|未落地/i.test(values));

// 2. configmap fail-closed 校验
check(
  'configmap 使用 required 强制 ENTITLEMENT_TIER',
  /required[^}]*ENTITLEMENT_TIER/.test(configmap),
);
check(
  'configmap：tier != internal_eval 且无 expires 时 fail',
  /ne \(toString \$tier\) "internal_eval"/.test(configmap) &&
    /\(not \.Values\.config\.ENTITLEMENT_EXPIRES_AT\)/.test(configmap) &&
    /\{\{-? ?fail /.test(configmap),
);
check(
  'configmap 原样透传 ENTITLEMENT_EXPIRES_AT（不硬编码）',
  /ENTITLEMENT_EXPIRES_AT/.test(configmap),
);

// 3. dev/preview 显式档位
for (const [name, text] of [
  ['values-dev.yaml', valuesDev],
  ['values-preview.yaml', valuesPreview],
]) {
  check(
    `${name} 显式 ENTITLEMENT_TIER: "internal_eval"`,
    /ENTITLEMENT_TIER:\s*"internal_eval"/.test(text),
  );
}

// 4. E2E compose
check(
  'e2e compose 默认 ENTITLEMENT_TIER 为 internal_eval（可显式覆盖）',
  /ENTITLEMENT_TIER:\s*\$\{E2E_ENTITLEMENT_TIER:-internal_eval\}/.test(compose),
);
check('e2e compose 不得默认 c_end_display', !/ENTITLEMENT_TIER:[^\n]*c_end_display/.test(compose));
check('e2e compose 透传 E2E_ENTITLEMENT_EXPIRES_AT', /E2E_ENTITLEMENT_EXPIRES_AT/.test(compose));

// 5. 部署文件不得把 c_end_display 当默认值（注释/授权用例显式覆盖允许）
for (const [name, text] of [
  ['values.yaml', values],
  ['values-dev.yaml', valuesDev],
  ['values-preview.yaml', valuesPreview],
  ['configmap.yaml', configmap],
]) {
  check(`${name} 无默认 c_end_display`, !/c_end_display/.test(text));
}
const composeCode = compose
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');
check(
  'e2e compose 非注释配置行不出现默认 c_end_display',
  !/ENTITLEMENT_TIER[^\n]*c_end_display/.test(composeCode),
);

// 5b. APP_PROFILE（decisions.md L46）
// 缺省 prod；只有显式 dev/test/e2e 才允许测试后门。验证「没配会怎样」：
// values 缺 key、渲染缺值、e2e compose 留空继承，都必须失败。
check('values.yaml 显式 APP_PROFILE=prod', /APP_PROFILE:\s*["']?prod["']?/.test(values));
check('values-dev.yaml 显式 APP_PROFILE=prod', /APP_PROFILE:\s*["']?prod["']?/.test(valuesDev));
check(
  'values-preview.yaml 显式 APP_PROFILE=prod',
  /APP_PROFILE:\s*["']?prod["']?/.test(valuesPreview),
);
check(
  'e2e compose 的 api 显式 APP_PROFILE=e2e（禁止留空继承）',
  /APP_PROFILE:\s*["']?e2e["']?/.test(compose) && !/APP_PROFILE:\s*\$\{/.test(compose),
);

// 6. Helm 渲染验证
function helm(args) {
  return execFileSync(HELM, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
try {
  execFileSync(HELM, ['version', '--short'], { encoding: 'utf8' });
  const chart = 'infra/helm/market-sense';
  try {
    const rendered = helm(['template', 'ent-guard', chart, '-f', `${chart}/values-dev.yaml`]);
    check(
      'helm template dev 渲染出 internal_eval',
      /ENTITLEMENT_TIER:\s*"?internal_eval"?/.test(rendered),
    );
    check(
      'helm template dev 渲染出 ENTITLEMENT_EXPIRES_AT',
      /ENTITLEMENT_EXPIRES_AT:/.test(rendered),
    );
    check(
      'helm 渲染结果显式出现 APP_PROFILE=prod（缺失即失败，不允许继承 entrypoint）',
      /APP_PROFILE:\s*"?prod"?/.test(rendered),
    );
  } catch (err) {
    check('helm template dev 成功', false, String(err.stderr || err.message).slice(0, 400));
  }
  // 反向用例：c_end_display 无 expires 必须失败
  let failedAsExpected = false;
  let failureText = '';
  try {
    helm(['template', 'ent-guard', chart, '--set', 'config.ENTITLEMENT_TIER=c_end_display']);
  } catch (err) {
    failedAsExpected = true;
    failureText = String(err.stderr || '');
  }
  check(
    'helm：tier=c_end_display 且无 expires 必须渲染失败（fail-closed）',
    failedAsExpected && /ENTITLEMENT_EXPIRES_AT|fail-closed/.test(failureText),
    failedAsExpected
      ? '渲染失败了，但错误信息未提到 ENTITLEMENT_EXPIRES_AT/fail-closed'
      : '竟然渲染成功——fail-open 回归',
  );
} catch {
  skips.push(
    'helm 不可用：渲染层检查未执行（CI iac job 必须执行，本地可 HELM_BIN=/tmp/tools/helm）',
  );
}

// 输出
for (const p of passes) console.log(`  ✓ ${p}`);
for (const s of skips) console.log(`  ⏭ ${s}`);
if (failures.length) {
  console.error('');
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error(`\n授权配置 fail-closed 门禁失败：${failures.length} 项`);
} else if (skips.length) {
  console.log(`\n静态检查通过：${passes.length} 项；渲染检查 skip（见上）`);
} else {
  console.log(`\n授权配置 fail-closed 门禁通过：${passes.length} 项（含 Helm 正反渲染）`);
}
process.exit(failures.length === 0 ? 0 : 1);
