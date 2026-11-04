/**
 * 本地一口气跑完 CI 的「零依赖」门禁（不需要 pnpm install 即可运行）。
 * CI 里各 job 分开跑；本地用这个快速自检。耗时较长的是 contract-diff（redocly）。
 * 用法：pnpm ci:all
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const steps = [
  ['写域注册表校验', ['infra/ci/path-guard.mjs', '--validate-registry']],
  ['path guard 自检（13 项）', ['infra/ci/path-guard.mjs', '--self-test']],
  ['仓库存量探测', ['infra/ci/has.mjs']],
  ['告警 / runbook 绑定', ['infra/ci/check-runbooks.mjs']],
  ['DB bootstrap 静态校验', ['infra/ci/check-db-bootstrap.mjs']],
  ['授权配置 fail-closed', ['infra/ci/check-entitlement-config.mjs']],
  ['网络边界 / ingress 暴露面', ['infra/ci/check-network-policy.mjs']],
  ['仓库卫生（秘密/状态/超大文件）', ['infra/ci/check-repo-hygiene.mjs']],
  ['契约词表（厂商标识）', ['infra/ci/check-source-vocabulary.mjs']],
  ['契约 lint + 破坏性 diff', ['infra/ci/contract-diff.mjs']],
];

const failed = [];
for (const [label, args] of steps) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) failed.push(label);
}

if (failed.length > 0) {
  console.error(`\n❌ CI 自检失败：${failed.join('、')}`);
  process.exit(1);
}
console.log('\n✅ CI 自检全部通过');
