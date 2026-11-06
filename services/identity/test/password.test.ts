/** 密码哈希：scrypt 自描述存储格式，校验常量时间；未知邮箱用 DUMMY 哈希等时响应。 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../src/auth/password.js';

test('hashPassword：格式 scrypt$N$r$p$salt$hash，且加盐不同', async () => {
  const a = await hashPassword('correct horse battery staple');
  const b = await hashPassword('correct horse battery staple');
  assert.match(a, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.equal(a.startsWith('scrypt$16384$8$1$'), true);
  assert.notEqual(a, b, '相同密码两次哈希必须不同（随机盐）');
});

test('verifyPassword：正确密码通过，错误密码失败', async () => {
  const stored = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('correct horse battery staple', stored), true);
  assert.equal(await verifyPassword('wrong password 123', stored), false);
});

test('verifyPassword：损坏/篡改的存储值 fail-closed（不抛异常）', async () => {
  assert.equal(await verifyPassword('x', ''), false);
  assert.equal(await verifyPassword('x', 'bcrypt$whatever'), false);
  assert.equal(await verifyPassword('x', 'scrypt$abc'), false);
  // 参数被篡改到内存爆炸（N 巨大）也必须拒绝而不是 OOM。
  assert.equal(await verifyPassword('x', 'scrypt$1073741824$8$1$AA$AA'), false);
});

test('DUMMY_PASSWORD_HASH：任何密码都不通过（仅用于等时消耗）', async () => {
  assert.equal(await verifyPassword('correct horse battery staple', DUMMY_PASSWORD_HASH), false);
});
