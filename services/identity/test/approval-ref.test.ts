/**
 * 审批 id 契约（decisions.md L51）：
 *   - 形态 `apr_<uuidv7>`，可带 `prod:`/`staging:` 前缀；
 *   - UUIDv7 的 version nibble 必须为 7、variant 必须为 RFC 4122；
 *   - 生成点唯一且时间前缀单调不降（连续生成也不回退）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  APPROVAL_REF_PATTERN,
  approvalRefUuid,
  generateApprovalRef,
  isApprovalRef,
  uuidv7,
} from '../src/domain/approval-ref.js';

test('generateApprovalRef：形态符合 L51（apr_<uuidv7>）', () => {
  const ref = generateApprovalRef();
  assert.match(ref, APPROVAL_REF_PATTERN);
  assert.ok(isApprovalRef(ref));

  const uuid = approvalRefUuid(ref);
  assert.ok(uuid !== null);
  // 去掉连字符后的第 13 个 hex（version nibble）必须是 7；第 17 个（variant）必须是 8/9/a/b。
  const nibbles = uuid.replaceAll('-', '');
  assert.equal(nibbles[12], '7');
  assert.match(nibbles[16] ?? '', /[89ab]/);
});

test('generateApprovalRef：支持跨环境前缀且仍可校验', () => {
  const prod = generateApprovalRef({ env: 'prod' });
  const staging = generateApprovalRef({ env: 'staging' });
  assert.ok(prod.startsWith('prod:apr_'));
  assert.ok(staging.startsWith('staging:apr_'));
  assert.ok(isApprovalRef(prod));
  assert.ok(isApprovalRef(staging));
});

test('uuidv7：时间前缀单调不降（连续 N 条）', () => {
  let previous = -1;
  for (let i = 0; i < 200; i += 1) {
    const uuid = uuidv7();
    const timestamp = Number.parseInt(uuid.slice(0, 12), 16);
    assert.ok(timestamp >= previous, `时间前缀回退：${uuid}`);
    previous = timestamp;
  }
});

test('uuidv7：显式 nowMs 进入 48-bit 时间前缀', () => {
  const nowMs = Date.parse('2026-11-06T00:00:00.000Z');
  const uuid = uuidv7(nowMs);
  // v7 前缀是大端 48-bit 毫秒时间戳（前 12 个 hex，去掉连字符后）。
  assert.equal(Number.parseInt(uuid.replaceAll('-', '').slice(0, 12), 16), nowMs);
});

test('isApprovalRef：拒绝非法形态（非 v7 / 非 apr_ / 空串 / 大小写六段）', () => {
  assert.equal(isApprovalRef(''), false);
  assert.equal(isApprovalRef('apr_not-a-uuid'), false);
  // v4 UUID 形态但 version=4：必须拒绝（PG uuid 类型不会替我们校验 version）。
  assert.equal(isApprovalRef('apr_123e4567-e89b-42d3-a456-426614174000'), false);
  // variant 非法（第 17 位 c）。
  assert.equal(isApprovalRef('apr_01920000-0000-7000-c000-000000000000'), false);
  // 大写 hex：签名/引用统一小写。
  assert.equal(isApprovalRef('apr_01920000-0000-7000-8000-00000000000A'), false);
});

test('approvalRefUuid：剥离前缀，非法引用返回 null', () => {
  const ref = generateApprovalRef({ env: 'prod' });
  assert.equal(approvalRefUuid(ref), ref.slice('prod:'.length).slice('apr_'.length));
  assert.equal(approvalRefUuid('not-a-ref'), null);
});
