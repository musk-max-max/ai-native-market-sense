/**
 * 状态标签测试：`list_status` / 停牌的展示文案必须由字段值直接映射，且不得省略异常态。
 *
 * H3 m01536 / Lead m01541 的生效条件：
 *  - 标签一律由字段值直接映射，前端不得推断；
 *  - 异常态（终止上市/未上市/停牌）必须如实出现，不能只给正常态标签——那是选择性披露。
 *
 * 与 `SOURCE_LABELS` 同理，本测试直接读契约生成产物中的 enum 字面量，
 * 断言每个成员都有非空文案且互不相同（不能把异常态映射成正常态或空串）。
 *
 * 运行：pnpm --filter @market-sense/h5 test
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { copy } from '../src/lib/copy.ts';

const GENERATED_MARKET = fileURLToPath(
  new URL('../../../packages/api-client/src/generated/market.ts', import.meta.url),
);

/** 从 openapi-typescript 生成物里取出 `list_status: "a" | "b" | ...;` 的成员。 */
function readContractListStatusMembers(): string[] {
  const text = readFileSync(GENERATED_MARKET, 'utf8');
  const match = /list_status:\s*("(?:[^"\\]|\\.)*"(?:\s*\|\s*"(?:[^"\\]|\\.)*")*)\s*/.exec(text);
  assert.ok(match, '未能从生成类型中解析 Instrument.list_status 的枚举字面量');
  const union = match[1] ?? '';
  return [...union.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '');
}

test('list_status 的每个契约成员都有直接映射的展示文案', () => {
  const members = readContractListStatusMembers();
  assert.ok(members.length >= 3, `契约 list_status 成员过少：${members.join(',')}`);

  for (const member of members) {
    const label = copy.stock.listStatus[member];
    assert.equal(typeof label, 'string', `缺少 list_status=${member} 的展示文案`);
    assert.ok((label ?? '').trim().length > 0, `list_status=${member} 的文案为空`);
    assert.notEqual(label, member, `list_status=${member} 未翻译（不能原样显示枚举值）`);
  }

  assert.deepEqual(
    Object.keys(copy.stock.listStatus).sort(),
    [...members].sort(),
    '映射表与契约 list_status 枚举成员不一致（多出或漏掉都会导致状态被省略/误映射）',
  );
});

test('异常态不得映射成正常态或空串（选择性披露防线）', () => {
  const listed = copy.stock.listStatus.listed;
  assert.equal(listed, '已上市');
  for (const abnormal of ['delisted', 'pre_listed']) {
    const label = copy.stock.listStatus[abnormal];
    assert.ok((label ?? '').trim().length > 0, `${abnormal} 必须有独立文案，不能省略`);
    assert.notEqual(label, listed, `${abnormal} 不能复用正常上市文案`);
  }
  assert.equal(copy.stock.listStatus.delisted, '终止上市');
  assert.equal(copy.stock.listStatus.pre_listed, '未上市');

  // “正常”是评价性修饰，不得出现在状态标签里（H3 m01536）。
  for (const label of Object.values(copy.stock.listStatus)) {
    assert.ok(!label.includes('正常'), `状态标签不得含评价性修饰「正常」：${label}`);
  }
});

test('上市日期文案明确语义，停牌提示如实说明无最新成交价', () => {
  assert.equal(copy.stock.listDateLabel, '上市日期');
  assert.ok(copy.quote.suspended.includes('停牌'));
  assert.ok(copy.quote.suspended.includes('无最新成交价'));
});
