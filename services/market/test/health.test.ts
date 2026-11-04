/**
 * /healthz 数据就绪贡献值单测（A12 INGEST-ONCE-CONTRACT §4/§5）。
 *
 * 语义：栈活着与数据进来是两件事；报告缺失/损坏也只能 data_ready=false + reason，
 * 不允许抛错导致 /healthz 500（preflight 需要 200 才能区分 ENV_STACK_DOWN 与 DATA_NOT_READY）。
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  createDataReadinessContribution,
  parseIngestReport,
  readDataReadiness,
  resolveIngestReportPath,
  type DataReadiness,
} from '../src/health.js';

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'market-health-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function reportFile(name: string, content: unknown): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return path;
}

function envFor(path: string): NodeJS.ProcessEnv {
  return { INGEST_REPORT_PATH: path };
}

function assertNoReason(readiness: DataReadiness): void {
  assert.equal('data_ready_reason' in readiness, false, 'data_ready=true 不得携带 data_ready_reason');
}

const readyReport = {
  schema_version: 1,
  ready: true,
  failed_step: null,
  failed_reason: null,
  quality_level: 'green',
  quality_score: 0.98,
  counts: { dwd_rows: 34, serving_rows: 34 },
  checked_at: '2026-11-04T00:00:00Z',
};

describe('health：ingest-report.json → data_ready 三字段', () => {
  it('默认路径为 /state/ingest-report.json，可被 INGEST_REPORT_PATH 覆盖', () => {
    assert.equal(resolveIngestReportPath({} as NodeJS.ProcessEnv), '/state/ingest-report.json');
    assert.equal(resolveIngestReportPath(envFor('/tmp/x.json')), '/tmp/x.json');
    assert.equal(resolveIngestReportPath({ INGEST_REPORT_PATH: '  ' } as NodeJS.ProcessEnv), '/state/ingest-report.json');
  });

  it('ready=true → data_ready=true + data_quality，且不带 reason', async () => {
    const path = await reportFile('ready.json', readyReport);
    const readiness = await readDataReadiness(envFor(path));
    assert.deepEqual(readiness, { data_ready: true, data_quality: 'green' });
    assertNoReason(readiness);
  });

  it('ready=false + failed_step=load → INGEST_FAILED:load', async () => {
    const path = await reportFile('load-failed.json', {
      ...readyReport,
      ready: false,
      failed_step: 'load',
      failed_reason: null,
      quality_level: 'yellow',
    });
    assert.deepEqual(await readDataReadiness(envFor(path)), {
      data_ready: false,
      data_ready_reason: 'INGEST_FAILED:load',
      data_quality: 'yellow',
    });
  });

  it('report 带合法 failed_reason 时原样作为 reason（含 DETAIL）', async () => {
    const path = await reportFile('quota.json', {
      ...readyReport,
      ready: false,
      failed_step: 'ingest',
      failed_reason: 'INGEST_FAILED:ingest:QUOTA',
      quality_level: 'green',
    });
    assert.deepEqual(await readDataReadiness(envFor(path)), {
      data_ready: false,
      data_ready_reason: 'INGEST_FAILED:ingest:QUOTA',
      data_quality: 'green',
    });
  });

  it('quality_level=red → QUALITY_RED（即使 failed_step 是 load）', async () => {
    const path = await reportFile('red.json', {
      ...readyReport,
      ready: false,
      failed_step: 'load',
      failed_reason: 'INGEST_FAILED:load:QUALITY_RED',
      quality_level: 'red',
    });
    assert.deepEqual(await readDataReadiness(envFor(path)), {
      data_ready: false,
      data_ready_reason: 'QUALITY_RED',
      data_quality: 'red',
    });
  });

  it('报告缺失 → INGEST_REPORT_MISSING，绝不抛错', async () => {
    const readiness = await readDataReadiness(envFor(join(dir, 'no-such-report.json')));
    assert.deepEqual(readiness, { data_ready: false, data_ready_reason: 'INGEST_REPORT_MISSING' });
  });

  it('报告损坏（非 JSON / 非对象 / schema_version≠1）→ INGEST_REPORT_INVALID', async () => {
    for (const [name, content] of [
      ['broken.json', '{ not json'],
      ['array.json', []],
      ['v2.json', { ...readyReport, schema_version: 2 }],
    ] as const) {
      const path = await reportFile(name, content);
      assert.deepEqual(await readDataReadiness(envFor(path)), {
        data_ready: false,
        data_ready_reason: 'INGEST_REPORT_INVALID',
      });
    }
  });

  it('报告自相矛盾（ready=true 却带 failed_step/failed_reason/red）→ INVALID', async () => {
    for (const contradiction of [
      { ...readyReport, failed_step: 'ingest' },
      { ...readyReport, failed_reason: 'INGEST_FAILED:ingest' },
      { ...readyReport, quality_level: 'red' },
    ]) {
      assert.equal(parseIngestReport(JSON.stringify(contradiction)), null);
      const path = await reportFile('contradiction.json', contradiction);
      assert.deepEqual(await readDataReadiness(envFor(path)), {
        data_ready: false,
        data_ready_reason: 'INGEST_REPORT_INVALID',
      });
    }
  });

  it('ready=false 却没有 failed_step → INVALID', async () => {
    assert.equal(
      parseIngestReport(JSON.stringify({ ...readyReport, ready: false, failed_step: null })),
      null,
    );
  });

  it('contribution 返回普通对象且不抛错（外壳可直接合并进 /healthz）', async () => {
    const path = await reportFile('contribution.json', readyReport);
    const contribute = createDataReadinessContribution(envFor(path));
    const contribution = await contribute();
    assert.deepEqual(contribution, { data_ready: true, data_quality: 'green' });
    assert.equal(Object.getPrototypeOf(contribution), Object.prototype);
  });
});
