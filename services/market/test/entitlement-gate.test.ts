/**
 * 授权闸门单测（H4/H5 + Lead L27）：本地时间盒 → control 行（hold/新鲜度）→ env tier。
 *
 * 这里只测 gate 的判定与降级/熔断/缓存语义；PG 错误分类用带 pg code 的对象模拟，
 * 真实 SQL 与权限由 A13/A11 真栈验收。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { EntitlementControlRepo, EntitlementControlRow } from '../src/ports/entitlement.js';
import { BLOCKING_REASONS, EntitlementGate } from '../src/domain/entitlement-gate.js';

const BASE = new Date('2026-11-04T10:00:00+08:00');

interface Clock {
  now: Date;
}

function gateConfig(overrides: Partial<{ entitlementTier: 'c_end_display' | 'internal_eval'; entitlementExpiresAt?: string }> = {}) {
  return {
    entitlementTier: 'c_end_display' as const,
    entitlementExpiresAt: '2099-12-31T23:59:59+08:00',
    ...overrides,
  };
}

class FakeControl implements EntitlementControlRepo {
  row: EntitlementControlRow | null = {
    lastReconciledAt: new Date(BASE.getTime() - 60_000),
    hold: false,
    holdId: null,
    reason: null,
  };
  error: unknown = undefined;
  calls = 0;

  async fetchControl(): Promise<EntitlementControlRow | null> {
    this.calls += 1;
    if (this.error !== undefined) throw this.error;
    return this.row;
  }
}

type GateTestConfig = { entitlementTier: 'c_end_display' | 'internal_eval'; entitlementExpiresAt?: string };

function makeGate(
  config: GateTestConfig = gateConfig(),
  options: { clock?: Clock; repo?: FakeControl | null; warn?: (message: string) => void } = {},
) {
  const clockRef = options.clock ?? { now: BASE };
  const repo = options.repo === undefined ? new FakeControl() : options.repo;
  const gate = new EntitlementGate(config, repo, () => clockRef.now, {
    warn: options.warn ?? (() => undefined),
  });
  return { gate, clockRef, repo };
}

describe('EntitlementGate：control 行判定（fail-closed）', () => {
  it('L77：control 读永不 resolve（TCP 黑洞）→ ~1s 内返回 fail-closed，不挂起', async () => {
    const never: EntitlementControlRepo = {
      fetchControl: () => new Promise<EntitlementControlRow | null>(() => undefined),
    };
    const gate = new EntitlementGate(gateConfig(), never, () => BASE, {});
    const started = Date.now();
    const decision = await gate.evaluate();
    const elapsed = Date.now() - started;
    assert.equal(decision.resolution.blocked, true, '无证据必须阻断');
    assert.equal(decision.reason, 'control_unavailable');
    assert.ok(elapsed >= 900, `超时不能提前放行（实际 ${elapsed}ms）`);
    assert.ok(elapsed < 2000, `必须在 ~1s 返回而不是挂起（实际 ${elapsed}ms）`);
  });

  it('fresh 行且无 hold → 放行 c_end_display，不降级', async () => {
    const { gate } = makeGate();
    const decision = await gate.evaluate();
    assert.equal(decision.resolution.blocked, false);
    assert.equal(decision.resolution.effectiveTier, 'c_end_display');
    assert.equal(decision.degraded, false);
  });

  it('hold=true → 降为 internal_eval（hold_active），仍然 blocked', async () => {
    const repo = new FakeControl();
    repo.row = { lastReconciledAt: new Date(BASE.getTime() - 60_000), hold: true, holdId: 'h1', reason: 'human' };
    const { gate } = makeGate(gateConfig(), { repo });
    const decision = await gate.evaluate();
    assert.equal(decision.resolution.blocked, true);
    assert.equal(decision.resolution.effectiveTier, 'internal_eval');
    assert.equal(decision.reason, 'hold_active');
  });

  it('last_reconciled_at 超过 15 分钟 → internal_eval（reconciler 静默挂也是 fail-open）', async () => {
    const repo = new FakeControl();
    repo.row = { lastReconciledAt: new Date(BASE.getTime() - 16 * 60_000), hold: false, holdId: null, reason: null };
    const { gate } = makeGate(gateConfig(), { repo });
    const decision = await gate.evaluate();
    assert.equal(decision.resolution.blocked, true);
    assert.equal(decision.reason, 'control_stale');
  });

  it('control 行不存在（null）→ 按 hold=true 处理（control_missing），不 crash', async () => {
    const repo = new FakeControl();
    repo.row = null;
    const { gate } = makeGate(gateConfig(), { repo });
    const decision = await gate.evaluate();
    assert.equal(decision.resolution.blocked, true);
    assert.equal(decision.reason, 'control_missing');
  });

  it('本地时间盒已过期：不读 control，直接 blocked（expired）', async () => {
    const repo = new FakeControl();
    const { gate } = makeGate(gateConfig({ entitlementExpiresAt: '2026-11-01T00:00:00+08:00' }), { repo });
    const decision = await gate.evaluate();
    assert.equal(decision.resolution.blocked, true);
    assert.equal(decision.reason, 'expired');
    assert.equal(repo.calls, 0, '到期判定不得依赖 PG');
  });
});

describe('EntitlementGate：瞬态故障 / 确定性错误 / 缓存（L27）', () => {
  it('瞬态故障 → degraded（control_unavailable），5s 负缓存内不重复打 PG', async () => {
    const repo = new FakeControl();
    repo.error = Object.assign(new Error('connection refused'), { code: '08006' });
    const { gate, clockRef } = makeGate(gateConfig(), { repo });
    const first = await gate.evaluate();
    assert.equal(first.resolution.blocked, true);
    assert.equal(first.reason, 'control_unavailable');
    assert.equal(repo.calls, 1);
    // 5s 内第二次请求命中负缓存，不新增查询。
    clockRef.now = new Date(BASE.getTime() + 1_000);
    await gate.evaluate();
    assert.equal(repo.calls, 1);
    // 负缓存过期后允许重试（但熔断计数未到阈值）。
    clockRef.now = new Date(BASE.getTime() + 6_000);
    await gate.evaluate();
    assert.equal(repo.calls, 2);
  });

  it('连续 3 次瞬态失败 → 熔断 30s（期间不再打 PG）', async () => {
    const repo = new FakeControl();
    repo.error = Object.assign(new Error('ETIMEDOUT'), { code: '08006' });
    const { gate, clockRef } = makeGate(gateConfig(), { repo });
    for (let i = 0; i < 3; i += 1) {
      clockRef.now = new Date(BASE.getTime() + i * 6_000);
      await gate.evaluate();
    }
    const callsAfterFailures = repo.calls;
    clockRef.now = new Date(BASE.getTime() + 3 * 6_000 + 5_000);
    const decision = await gate.evaluate();
    assert.equal(decision.reason, 'control_unavailable');
    assert.equal(repo.calls, callsAfterFailures, '熔断窗口内不得再查询');
  });

  it('确定性配置错误（42P01 表不存在）→ 启动失败（crashloop），运行期按 fail-closed 降级', async () => {
    const repo = new FakeControl();
    repo.error = Object.assign(new Error('relation "audit.entitlement_hold" does not exist'), { code: '42P01' });
    const { gate } = makeGate(gateConfig(), { repo });
    await assert.rejects(gate.probeStartup(), /audit\.entitlement_hold/);
    const decision = await gate.evaluate();
    assert.equal(decision.resolution.blocked, true);
    assert.equal(decision.reason, 'config_mismatch');
  });

  it('control 行成功缓存 30s：窗口内不重复查询，过期后重新读取', async () => {
    const { gate, clockRef, repo } = makeGate();
    assert.ok(repo !== null);
    await gate.evaluate();
    assert.equal(repo.calls, 1);
    clockRef.now = new Date(BASE.getTime() + 10_000);
    await gate.evaluate();
    assert.equal(repo.calls, 1);
    clockRef.now = new Date(BASE.getTime() + 31_000);
    await gate.evaluate();
    assert.equal(repo.calls, 2);
  });

  it('hold 清除后恢复 env tier（恢复路径同样依赖 control fresh）', async () => {
    const repo = new FakeControl();
    repo.row = { lastReconciledAt: new Date(BASE.getTime() - 60_000), hold: true, holdId: 'h1', reason: 'human' };
    const { gate, clockRef } = makeGate(gateConfig(), { repo });
    const held = await gate.evaluate();
    assert.equal(held.resolution.blocked, true);
    repo.row = { lastReconciledAt: new Date(BASE.getTime() - 30_000), hold: false, holdId: null, reason: null };
    clockRef.now = new Date(BASE.getTime() + 31_000);
    const restored = await gate.evaluate();
    assert.equal(restored.resolution.blocked, false);
    assert.equal(restored.resolution.effectiveTier, 'c_end_display');
  });

  it('H5 m02456：确定性审计写失败 = 阻断，blocked reason 必须是阻断原因（不是 audit_write_failed）', async () => {
    const warnings: string[] = [];
    const { gate } = makeGate(gateConfig(), { warn: (m) => warnings.push(m) });
    gate.markWriteBlocked('audit_write_misconfigured');
    const decision = await gate.evaluate();
    assert.equal(decision.resolution.blocked, true);
    assert.equal(decision.reason, 'audit_write_misconfigured');
    assert.ok(BLOCKING_REASONS.has(decision.reason!));
    assert.ok(warnings.some((w) => w.includes('blocking":true') && w.includes('已阻断为 internal_eval')));
  });

  it('H5 m02456：非阻断审计写失败（audit_write_failed）日志明确“非阻断、仅降级”', async () => {
    const warnings: string[] = [];
    const repo = new FakeControl();
    const { gate } = makeGate(gateConfig(), { repo, warn: (m) => warnings.push(m) });
    gate.markDegraded('audit_write_failed');
    const decision = await gate.evaluate();
    // reconciler 已停摆时非阻断会升级为阻断（L60）；本用例给出 fresh 行，确认保持放行但 degraded。
    assert.equal(decision.resolution.blocked, false);
    assert.ok(warnings.some((w) => w.includes('blocking":false') && w.includes('非阻断')));
  });
});
