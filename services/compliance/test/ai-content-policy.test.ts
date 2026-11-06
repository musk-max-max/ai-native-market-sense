import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { AiPolicyConfigError } from "@market-sense/ai-policy";

import {
  AI_CONTENT_POLICY_RELATIVE_PATH,
  REDLINE_BASIS_RELATIVE_PATH,
  loadAiContentPolicy,
  loadRedlineBasis,
  resolveRepoRoot,
} from "../src/index.js";

test("loader 从仓库根加载 canonical 策略文件", () => {
  const repoRoot = resolveRepoRoot();
  assert.equal(resolve(repoRoot, AI_CONTENT_POLICY_RELATIVE_PATH).endsWith("rules/ai-content-policy.json"), true);
  const policy = loadAiContentPolicy();
  assert.equal(policy.policy_version, "ai-content-policy/1.1.2");
  assert.equal(policy.canonical_source_of_truth, AI_CONTENT_POLICY_RELATIVE_PATH);
  assert.equal(policy.categories.length, 12);
});

test("loader fail-closed：文件不存在/JSON 损坏/canonical 路径不符都抛错", () => {
  assert.throws(
    () => loadAiContentPolicy("/tmp/does-not-exist-ai-policy.json"),
    (error: unknown) => error instanceof AiPolicyConfigError,
  );

  assert.throws(
    () => loadAiContentPolicy("/dev/null"),
    (error: unknown) => error instanceof AiPolicyConfigError,
  );
});

test("redline loader 从仓库根加载 H3 依据并与 policy 双向对齐", () => {
  const policy = loadAiContentPolicy();
  const redlinePath = resolve(resolveRepoRoot(), REDLINE_BASIS_RELATIVE_PATH);
  const redlineRaw = JSON.parse(readFileSync(redlinePath, "utf8")) as {
    policy_version?: unknown;
    signed?: unknown;
  };
  if (redlineRaw.policy_version !== policy.policy_version) {
    // 每次 policy 升版签认后、redline 升版重绑前的窗口：loader 必须 fail-closed，
    // 直到 redline 的新版本绑定本次 policy 的两个 sha。
    assert.throws(() => loadRedlineBasis(policy));
    return;
  }
  const redline = loadRedlineBasis(policy);
  assert.equal(redline.rules.length, 12);
  assert.equal(redline.policy_version, policy.policy_version);
  // pending 1.0.1 在非生产可读；生产由 requireSigned 拒绝，签后此断言自然升级为 true。
  assert.equal(redline.signed, redlineRaw.signed === true);
});

test("redline loader fail-closed：文件不存在/JSON 损坏抛错", () => {
  const policy = loadAiContentPolicy();
  assert.throws(
    () => loadRedlineBasis(policy, "/tmp/does-not-exist-redline.json"),
    (error: unknown) => error instanceof AiPolicyConfigError,
  );
  assert.throws(
    () => loadRedlineBasis(policy, "/dev/null"),
    (error: unknown) => error instanceof AiPolicyConfigError,
  );
});
