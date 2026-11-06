import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// L130：被签认（或待签）的 rules 字节必须可按 sha256 取回；归档文件名 = 内容 sha256。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const archiveRoots = ["rules/archive/ai-content-policy", "rules/archive/redline-basis"] as const;

test("归档：AI policy / redline 的每个归档文件名等于文件内容 sha256", () => {
  let checked = 0;
  for (const archiveRoot of archiveRoots) {
    const absolute = resolve(root, archiveRoot);
    for (const entry of readdirSync(absolute)) {
      if (!entry.endsWith(".json")) continue;
      const digest = createHash("sha256").update(readFileSync(resolve(absolute, entry))).digest("hex");
      assert.equal(entry, `${digest}.json`, `${archiveRoot}/${entry} 内容 sha256=${digest}`);
      checked += 1;
    }
  }
  assert.ok(checked >= 2, "至少应归档当前 policy 与 redline 各一份");
});

test("归档：当前 policy 与 redline 的字节可在归档中取回", () => {
  const pairs: Array<[string, string]> = [
    ["rules/ai-content-policy.json", "rules/archive/ai-content-policy"],
    ["rules/redline-basis.json", "rules/archive/redline-basis"],
  ];
  for (const [file, archiveRoot] of pairs) {
    const digest = createHash("sha256").update(readFileSync(resolve(root, file))).digest("hex");
    const archived = readFileSync(resolve(root, archiveRoot, `${digest}.json`));
    assert.deepEqual(archived, readFileSync(resolve(root, file)), `${file} 应在归档中逐字节存在`);
  }
});
