import { createHash } from "node:crypto";

/**
 * 无 I/O 的 canonical JSON：对象键按 Unicode 码点升序递归排序，无空白；
 * 数组保持原序；不允许 undefined/function/symbol/bigint/非有限数。
 * 与 audit.canonical_json（001）的口径一致：UTF-8 原样、文件内容不转义非 ASCII。
 * 用途：A3 写入 audit.ai_generation_events 前计算 input_evidence_hash / output_hash，
 * A16 用同一函数复核；禁止各写一套序列化。
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, new Set<unknown>());
}

export function hashCanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function serialize(value: unknown, stack: Set<unknown>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: 非有限数字不允许");
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`canonicalJson: 不支持的类型 ${typeof value}`);
  }
  if (stack.has(value)) throw new TypeError("canonicalJson: 不允许循环引用");
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => serialize(item, stack)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonicalJson: 只允许 plain object");
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareCodePoints);
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${serialize(record[key], stack)}`)
      .join(",")}}`;
  } finally {
    stack.delete(value);
  }
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (char) => char.codePointAt(0) ?? 0);
  const b = Array.from(right, (char) => char.codePointAt(0) ?? 0);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = a[index]! - b[index]!;
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}
