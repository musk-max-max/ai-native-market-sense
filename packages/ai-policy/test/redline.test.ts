import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseAiContentPolicy,
  parseRedlineBasis,
  RedlineBasisError,
  REDLINE_RULE_IDS,
  type AiContentPolicy,
} from "../src/index.js";

const policyRaw = JSON.parse(
  readFileSync(new URL("../../../rules/ai-content-policy.json", import.meta.url), "utf8"),
) as unknown;
const redlineRaw = JSON.parse(
  readFileSync(new URL("../../../rules/redline-basis.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

const policy = parseAiContentPolicy(policyRaw);

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function cloneRedline(): Record<string, unknown> {
  const raw = clone(redlineRaw);
  // 1.1.2 待签期间 redline 文件仍绑定 1.1.1；单测只校验解析逻辑，用当前 policy 版本覆盖。
  raw.policy_version = policy.policy_version;
  return raw;
}

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof RedlineBasisError, `应抛 RedlineBasisError，实际 ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

test("redline-basis：12 条 C01..C12 与 policy 12 类双向对齐，signed 版可解析", () => {
  const redline = parseRedlineBasis(cloneRedline(), { policy, requireSigned: true });
  assert.equal(redline.version, "1.0.0");
  assert.equal(redline.rules.length, 12);
  assert.deepEqual(
    redline.rules.map((r) => r.rule_id).sort(),
    [...REDLINE_RULE_IDS].sort(),
  );
  assert.equal(new Set(redline.rules.map((r) => r.category)).size, 12);
  assert.deepEqual(
    new Set(redline.rules.map((r) => r.category)),
    new Set(policy.categories.map((c) => c.id)),
  );
});

test("红用例 1：rules 少一条（删 C12）→ fail-closed", () => {
  const raw = cloneRedline();
  (raw.rules as unknown[]).pop();
  expectCode(() => parseRedlineBasis(raw, { policy }), "invalid_rule_sequence");
});

test("红用例 1b：rule_id 重复/越界 → fail-closed", () => {
  const raw = cloneRedline();
  (raw.rules as Array<Record<string, unknown>>)[11]!.rule_id = "H3-C01";
  expectCode(() => parseRedlineBasis(raw, { policy }), "invalid_rule_sequence");
});

test("红用例 2：category 集合不等于 policy（改 C12）→ fail-closed", () => {
  const raw = cloneRedline();
  (raw.rules as Array<Record<string, unknown>>)[11]!.category = "investment_advice";
  expectCode(() => parseRedlineBasis(raw, { policy }), "invalid_category_set");
});

test("红用例 2b：policy category 无 H3-C 依据 → fail-closed", () => {
  const raw = cloneRedline();
  (raw.rules as Array<Record<string, unknown>>)[11]!.category = "unknown_category";
  expectCode(() => parseRedlineBasis(raw, { policy }), "invalid_category_set");
});

test("红用例 3：policy category default_action 非 block → fail-closed", () => {
  const badPolicy = clone(policy) as AiContentPolicy;
  const target = badPolicy.categories.find((c) => c.id === "target_price");
  assert.ok(target);
  target.default_action = "allow";
  expectCode(() => parseRedlineBasis(cloneRedline(), { policy: badPolicy }), "policy_category_not_block");
});

test("红用例 4：basis 档位未知 / PENDING_LEGAL 越权 / C12 未标 PENDING_LEGAL → fail-closed", () => {
  const unknownTier = cloneRedline();
  (unknownTier.rules as Array<Record<string, unknown>>)[0]!.basis = ["CSRC_40_DEF", "NOPE"];
  expectCode(() => parseRedlineBasis(unknownTier, { policy }), "invalid_basis_tier");

  const pendingOnC01 = cloneRedline();
  (pendingOnC01.rules as Array<Record<string, unknown>>)[0]!.basis = ["PENDING_LEGAL"];
  expectCode(() => parseRedlineBasis(pendingOnC01, { policy }), "invalid_basis_tier");

  const c12NotPending = cloneRedline();
  (c12NotPending.rules as Array<Record<string, unknown>>)[11]!.basis = ["CSRC_40_DEF"];
  expectCode(() => parseRedlineBasis(c12NotPending, { policy }), "invalid_basis_tier");
});

test("红用例 5：policy_version 或两个 policy sha 不匹配 → fail-closed（双 pin）", () => {
  const version = cloneRedline();
  version.policy_version = "ai-content-policy/9.9.9";
  expectCode(() => parseRedlineBasis(version, { policy }), "policy_version_mismatch");

  expectCode(
    () =>
      parseRedlineBasis(cloneRedline(), {
        policy,
        expectedPolicySignedContentSha256: "0".repeat(64),
      }),
    "policy_sha_mismatch",
  );
  expectCode(
    () =>
      parseRedlineBasis(cloneRedline(), {
        policy,
        expectedPolicyDeployedFileSha256: "f".repeat(64),
      }),
    "policy_sha_mismatch",
  );
});

test("红用例 6：生产 requireSigned 下 signed=false → fail-closed", () => {
  const raw = cloneRedline();
  raw.signed = false;
  expectCode(() => parseRedlineBasis(raw, { policy, requireSigned: true }), "not_signed");
  // 非生产（仅离线演练）允许 pending 解析，但版本不符仍拒绝
  assert.equal(parseRedlineBasis(cloneRedline(), { policy }).signed, true);
});

test("红用例 6b：redline 文件版本与期望不符 → fail-closed", () => {
  expectCode(
    () => parseRedlineBasis(cloneRedline(), { policy, expectedVersion: "1.0.1" }),
    "version_mismatch",
  );
});

test("红用例 5b：policy 的 reason_code 与 category id 不一致 → fail-closed", () => {
  const badPolicy = clone(policy) as AiContentPolicy;
  const target = badPolicy.categories.find((c) => c.id === "guarantee");
  assert.ok(target);
  target.reason_code = "legacy_guarantee";
  expectCode(() => parseRedlineBasis(cloneRedline(), { policy: badPolicy }), "reason_code_mismatch");
});

test("1.1.2 反向校验：policy category.basis 指向别的 Cxx → fail-closed", () => {
  const badPolicy = clone(policy) as AiContentPolicy;
  const target = badPolicy.categories.find((c) => c.id === "investment_advice");
  assert.ok(target);
  target.basis = "见 rules/redline-basis.json#H3-C02";
  expectCode(() => parseRedlineBasis(cloneRedline(), { policy: badPolicy }), "invalid_basis_ref");
});

test("1.1.2 反向校验：policy category.basis 不是引用式 → fail-closed", () => {
  const badPolicy = clone(policy) as AiContentPolicy;
  const target = badPolicy.categories.find((c) => c.id === "guarantee");
  assert.ok(target);
  target.basis = "L3：禁收益承诺";
  expectCode(() => parseRedlineBasis(cloneRedline(), { policy: badPolicy }), "invalid_basis_ref");
});
