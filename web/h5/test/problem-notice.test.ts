import assert from 'node:assert/strict';
import test from 'node:test';

import { problemNoticeLines } from '../src/lib/problem.ts';

// H4 #5：403 notice 只允许出现 API Problem 的 title/detail 原文。
test('problemNoticeLines：title + detail 原样返回，顺序固定', () => {
  assert.deepEqual(
    problemNoticeLines({ title: '行情数据暂不可用', detail: '当前版本暂不提供该标的行情数据' }),
    ['行情数据暂不可用', '当前版本暂不提供该标的行情数据'],
  );
});

test('problemNoticeLines：detail 缺失时只返回 title，不补任何文案', () => {
  assert.deepEqual(problemNoticeLines({ title: '行情数据暂不可用', detail: null }), [
    '行情数据暂不可用',
  ]);
});

test('problemNoticeLines：不去改写文本（前后空白仅做 trim）', () => {
  assert.deepEqual(problemNoticeLines({ title: ' 标题 ', detail: ' 详情 ' }), ['标题', '详情']);
});
