/**
 * L65：授权降级原因词表的机器守卫。
 *
 * 唯一真源是 `docs/reference/entitlement-reasons.json`（人读版同目录 .md），
 * 本测试直接读它做逐项相等断言——不在测试里抄名单（抄一遍＝把同一个 bug 写两次）。
 * 另设别名守卫：旧词一出现即红，防止"两个人两种叫法"回流。
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { loadMarketConfig } from '../src/config.js';

import {
  BLOCKING_REASONS,
  NON_BLOCKING_REASONS,
} from '../src/domain/entitlement-gate.js';

const SCAN_ROOTS = ['src', 'test'].map((dir) => fileURLToPath(new URL(`../${dir}`, import.meta.url)));

// 用拼接避免守卫文件本身命中（否则测试自证其罪）。
const FORBIDDEN_ALIASES = [
  'control_un' + 'reachable',
  'control_deterministic' + '_error',
  'hold' + '_stale',
  'reconciler' + '_stalled',
];

function filesUnder(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else if (extname(full) === '.ts') out.push(full);
  }
  return out;
}

describe('L65 授权降级词表守卫', () => {
  it('BLOCKING_REASONS / NON_BLOCKING_REASONS 与 docs/reference/entitlement-reasons.json 逐项相等', () => {
    const canonical = JSON.parse(
      readFileSync(new URL('../../../docs/reference/entitlement-reasons.json', import.meta.url), 'utf8'),
    ) as { blocking: string[]; non_blocking: string[] };
    assert.deepEqual([...BLOCKING_REASONS].sort(), [...canonical.blocking].sort());
    assert.deepEqual([...NON_BLOCKING_REASONS].sort(), [...canonical.non_blocking].sort());
    assert.equal(BLOCKING_REASONS.size + NON_BLOCKING_REASONS.size, 9);
  });

  it('旧别名在 src/test 无残留（见 entitlement-reasons.json 的 forbidden_legacy_aliases）', () => {
    const hits: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of filesUnder(root)) {
        const text = readFileSync(file, 'utf8');
        for (const alias of FORBIDDEN_ALIASES) {
          if (text.includes(alias)) hits.push(`${file}: ${alias}`);
        }
      }
    }
    assert.deepEqual(hits, []);
  });

  it('生产缺 DEPLOYMENT_UID 拒绝启动，非生产可缺省（L65）', () => {
    assert.throws(
      () =>
        loadMarketConfig({
          ENTITLEMENT_TIER: 'internal_eval',
        } as NodeJS.ProcessEnv),
      /DEPLOYMENT_UID/,
    );
    assert.doesNotThrow(() =>
      loadMarketConfig({
        APP_PROFILE: 'test',
        ENTITLEMENT_TIER: 'internal_eval',
      } as NodeJS.ProcessEnv),
    );
    assert.doesNotThrow(() =>
      loadMarketConfig({
        ENTITLEMENT_TIER: 'internal_eval',
        DEPLOYMENT_UID: 'deploy-prod-1',
      } as NodeJS.ProcessEnv),
    );
  });
});
