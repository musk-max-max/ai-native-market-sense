/**
 * TRUST_PROXY 配置层护栏（Lead m01809 / A19 R4）。
 *
 * 红队验收是黑盒的外部观测，但这里先把配置层的语义锁死：
 * 宽网段、回环、未指定地址、多段列表都必须在 loadConfig 阶段抛 ConfigError，
 * 错误信息必须点名 TRUST_PROXY，且错误发生在 buildApp/listen 之前。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConfigError, loadConfig } from '../src/config.js';

function load(trustProxy: string): void {
  loadConfig({ NODE_ENV: 'test', TRUST_PROXY: trustProxy });
}

const INVALID: readonly string[] = [
  '0.0.0.0/0',
  '::/0',
  '127.0.0.0/8',
  '127.0.0.1/32',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/24',
  'true',
  '10.0.0.0/24,10.0.1.0/24',
  'not-a-cidr',
];

for (const value of INVALID) {
  test(`TRUST_PROXY=${value} 在配置层被拒绝`, () => {
    assert.throws(
      () => load(value),
      (err: unknown) => err instanceof ConfigError && /TRUST_PROXY/.test(err.message),
    );
  });
}

test('TRUST_PROXY 合法窄网段被原样接受', () => {
  assert.deepEqual(loadConfig({ NODE_ENV: 'test', TRUST_PROXY: '10.0.0.0/24' }).trustProxy, [
    '10.0.0.0/24',
  ]);
  assert.deepEqual(loadConfig({ NODE_ENV: 'test', TRUST_PROXY: '203.0.113.7/32' }).trustProxy, [
    '203.0.113.7/32',
  ]);
  assert.deepEqual(loadConfig({ NODE_ENV: 'test', TRUST_PROXY: '2001:db8::/64' }).trustProxy, [
    '2001:db8::/64',
  ]);
  assert.equal(loadConfig({ NODE_ENV: 'test', TRUST_PROXY: 'false' }).trustProxy, false);
  assert.equal(loadConfig({ NODE_ENV: 'test' }).trustProxy, false);
});
