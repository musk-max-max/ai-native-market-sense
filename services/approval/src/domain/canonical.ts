/**
 * 规范化 JSON / sha256 工具（哈希链、input_hash、diff_hash、content_hash 的单一实现）。
 */

import { createHash } from 'node:crypto';

/** 键排序的规范化 JSON（确定性序列化，用于一切哈希输入）。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const out: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      if (item !== undefined) {
        out[key] = sortValue(item);
      }
    }
    return out;
  }
  return value;
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/** 契约形态 `sha256:<hex>`。 */
export function sha256Ref(input: string | Uint8Array): string {
  return `sha256:${sha256Hex(input)}`;
}

export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
