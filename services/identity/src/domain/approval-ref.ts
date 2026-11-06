/**
 * 审批 id（`approval_ref`）形态与生成器 —— 依据 decisions.md L51。
 *
 * L51 裁定：`apr_<uuidv7>`，跨环境加 `prod:` / `staging:` 前缀；生成点唯一（审批 API
 * 「建单」事务内），状态流转不换 id；DB CHECK 拒绝非 UUIDv7 形态（不靠应用层自觉）。
 *
 * 本文件提供两件事：
 *   1. `uuidv7()` / `formatApprovalRef()`：给审批建单方（P1 的 approvals API）用；
 *   2. `APPROVAL_REF_PATTERN` / `isApprovalRef()`：给 identity 审批入口做**服务端**形态校验
 *      （DB 侧还有 identity.users.approval_ref 的 CHECK 兜底，见 migrations/001_identity.sql）。
 *
 * 为什么自己拼 UUIDv7 而不用 `crypto.randomUUID()`：`randomUUID()` 是 v4，单调性不足，
 * 且 decisions.md L1116 明确「PG `uuid` 类型不校验 version/variant」——形态必须由 CHECK 钉住。
 */

import { randomBytes } from 'node:crypto';

/** 48 位毫秒时间戳上限（UUIDv7 规范）。 */
const MAX_TIMESTAMP_MS = 2 ** 48 - 1;

/**
 * `apr_<uuidv7>`，可选 `prod:`/`staging:` 前缀。
 * 与 `services/compliance/migrations/001_audit_entitlement_events.sql:84` 的 approval_ref
 * CHECK（`^[A-Za-z0-9][A-Za-z0-9._:/-]{2,199}$`）兼容。
 */
export const APPROVAL_REF_PATTERN =
  /^(?:(?:prod|staging):)?apr_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isApprovalRef(value: unknown): value is string {
  return typeof value === 'string' && APPROVAL_REF_PATTERN.test(value);
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * 生成 UUIDv7（毫秒时间戳 + 密码学随机）。
 *
 * @param nowMs 时间戳（测试可注入；生产默认 `Date.now()`）。
 * @param entropy 10 字节随机数（测试可注入，便于断言形态）。
 */
export function uuidv7(nowMs: number = Date.now(), entropy: Uint8Array = randomBytes(10)): string {
  if (!Number.isInteger(nowMs) || nowMs < 0 || nowMs > MAX_TIMESTAMP_MS) {
    throw new RangeError(`uuidv7: 时间戳越界 ${nowMs}`);
  }
  if (entropy.length !== 10) {
    throw new RangeError('uuidv7: 需要 10 字节熵');
  }

  const bytes = new Uint8Array(16);
  // 48-bit big-endian unix_ts_ms
  bytes[0] = (nowMs / 2 ** 40) & 0xff;
  bytes[1] = (nowMs / 2 ** 32) & 0xff;
  bytes[2] = (nowMs / 2 ** 24) & 0xff;
  bytes[3] = (nowMs / 2 ** 16) & 0xff;
  bytes[4] = (nowMs / 2 ** 8) & 0xff;
  bytes[5] = nowMs & 0xff;

  const r0 = entropy[0] ?? 0;
  const r1 = entropy[1] ?? 0;
  const r2 = entropy[2] ?? 0;
  bytes[6] = 0x70 | (r0 & 0x0f); // version 7
  bytes[7] = r1;
  bytes[8] = 0x80 | (r2 & 0x3f); // variant 10xx
  for (let i = 0; i < 7; i += 1) {
    bytes[9 + i] = entropy[3 + i] ?? 0;
  }

  const hex = toHex(bytes);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

export type ApprovalEnv = 'prod' | 'staging';

/**
 * 审批建单专用：生成 `apr_<uuidv7>`（跨环境带前缀）。
 *
 * 调用点必须是审批 API 的建单事务内（L51「生成点唯一」），不得由申请人/A15 预填。
 */
export function generateApprovalRef(options: { env?: ApprovalEnv; nowMs?: number } = {}): string {
  const id = uuidv7(options.nowMs ?? Date.now());
  return options.env === undefined ? `apr_${id}` : `${options.env}:apr_${id}`;
}

/** 从形态上取回 UUID 部分（用于审计去重/日志，不参与授权）。 */
export function approvalRefUuid(ref: string): string | null {
  const match = /^(?:(?:prod|staging):)?apr_([0-9a-f-]{36})$/.exec(ref);
  return match?.[1] ?? null;
}
