/**
 * 映射覆盖测试：契约 `SourceRef.source` 的每个枚举成员都必须有展示文案。
 *
 * 这道测试与 `Record<SourceValue, string>` 的 tsc 检查互补：
 *  - tsc 保证「映射表不多不少」，但它依赖生成类型；若有人绕过类型写字符串，测试仍能抓住；
 *  - 本测试直接读生成产物里的 enum 字面量（契约派生的单一真源），断言每个成员命中映射，
 *    且映射结果不等于原标识（即真的翻译过，而不是落到原样显示的防线）。
 *
 * 运行：pnpm --filter @market-sense/h5 check:sources
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { SOURCE_LABELS, sourceLabel } from '../src/lib/copy.ts';

const GENERATED_SHARED = fileURLToPath(
  new URL('../../../packages/api-client/src/generated/shared.ts', import.meta.url),
);

/** 从 openapi-typescript 生成物里取出 `source: "a" | "b" | ...;` 的成员。 */
function readContractSourceMembers(): string[] {
  const text = readFileSync(GENERATED_SHARED, 'utf8');
  const match = /source:\s*("(?:[^"\\]|\\.)*"(?:\s*\|\s*"(?:[^"\\]|\\.)*")*)\s*;/.exec(text);
  assert.ok(match, '未能从生成类型中解析 SourceRef.source 的枚举字面量');
  const union = match[1] ?? '';
  return [...union.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '');
}

test('契约来源枚举的每个成员都有展示文案（单一来源：SOURCE_LABELS）', () => {
  const members = readContractSourceMembers();
  assert.ok(members.length > 0, '契约来源枚举不应为空');

  for (const member of members) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(SOURCE_LABELS, member),
      `${member} 缺少展示文案（请在 web/h5/src/lib/copy.ts 的 SOURCE_LABELS 补充）`,
    );
    assert.notEqual(sourceLabel(member), member, `${member} 未命中映射，落到了原样显示的防线`);
  }
});

test('未知标识原样返回，不伪装成已知来源', () => {
  assert.equal(sourceLabel('weird_source'), 'weird_source');
});
