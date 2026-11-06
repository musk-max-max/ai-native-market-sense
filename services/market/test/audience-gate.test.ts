import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FastifyRequest } from 'fastify';

import { principalStateFromShell } from '../src/auth.js';
import {
  EntitlementGate,
  type InternalAccessRecord,
} from '../src/domain/entitlement-gate.js';
import { configFingerprint, minReleaseTier, RELEASE_RANK } from '../src/domain/entitlement.js';

const EXPIRES = '2099-12-31T00:00:00.000Z';
const NOW = new Date('2026-11-06T00:00:00.000Z');

function parse(user: unknown) {
  return principalStateFromShell({ user } as unknown as FastifyRequest);
}

function gate(options: {
  tier?: 'c_end_display' | 'internal_eval' | 'research_only';
  audienceGateMode?: 'off' | 'shadow' | 'enforce';
  onInternalAccess?: (record: InternalAccessRecord) => void;
} = {}): EntitlementGate {
  const tier = options.tier ?? 'c_end_display';
  return new EntitlementGate(
    {
      entitlementTier: tier,
      entitlementExpiresAt: EXPIRES,
      entitlementExpectedSha256: configFingerprint(tier, EXPIRES),
    },
    null,
    () => NOW,
    {
      warn: () => {},
      ...(options.audienceGateMode !== undefined ? { audienceGateMode: options.audienceGateMode } : {}),
      ...(options.onInternalAccess !== undefined ? { onInternalAccess: options.onInternalAccess } : {}),
    },
  );
}

describe('ADR-008 D3：RELEASE_RANK 单点定义', () => {
  it('internal_eval < research_only < c_end_display，platform_user_data 不参与', () => {
    assert.equal(RELEASE_RANK.internal_eval, 0);
    assert.equal(RELEASE_RANK.research_only, 1);
    assert.equal(RELEASE_RANK.c_end_display, 2);
    assert.equal(minReleaseTier('c_end_display', 'research_only'), 'research_only');
    assert.equal(minReleaseTier('internal_eval', 'c_end_display'), 'internal_eval');
    assert.equal(minReleaseTier(), 'internal_eval');
  });
});

describe('ADR-008 D2/D3.2：claim 轴一致性 fail-closed', () => {
  it('c_end ↔ c_end_display；internal_active ↔ internal_eval/research_only', () => {
    assert.equal(parse({ userId: 'u1', userType: 'c_end', tier: 'c_end_display', sessionVersion: 1 }).kind, 'present');
    assert.equal(
      parse({ userId: 'u2', userType: 'internal_active', tier: 'research_only', sessionVersion: 1 }).kind,
      'present',
    );
    assert.equal(
      parse({ userId: 'u3', userType: 'internal_active', tier: 'internal_eval', sessionVersion: 1 }).kind,
      'present',
    );
  });

  it('轴不一致/未知档/非法 session 一律 invalid，不得降级成 c_end', () => {
    for (const bad of [
      { userId: 'u', userType: 'c_end', tier: 'research_only', sessionVersion: 1 },
      { userId: 'u', userType: 'c_end', tier: 'internal_eval', sessionVersion: 1 },
      { userId: 'u', userType: 'internal_active', tier: 'c_end_display', sessionVersion: 1 },
      { userId: 'u', userType: 'internal_pending', tier: 'research_only', sessionVersion: 1 },
      { userId: 'u', userType: 'c_end', tier: 'unknown', sessionVersion: 1 },
      { userId: 'u', userType: 'c_end', tier: 'c_end_display', sessionVersion: -1 },
    ]) {
      const parsed = parse(bad);
      assert.equal(parsed.kind, 'invalid', JSON.stringify(bad));
    }
  });

  it('只有完全无 user_type 的旧 token 才兼容 c_end；带非法 tier 不兼容', () => {
    const legacy = parse({ userId: 'u' });
    assert.equal(legacy.kind, 'present');
    if (legacy.kind === 'present') {
      assert.equal(legacy.principal.userType, 'c_end');
      assert.equal(legacy.principal.tier, 'c_end_display');
      assert.equal(legacy.principal.sessionVersion, 0);
    }
    assert.equal(parse({ userId: 'u', tier: 'internal_eval' }).kind, 'invalid');
    assert.equal(parse({ userId: 'u', userType: 'c_end' }).kind, 'invalid');
  });
});

describe('ADR-008 D3.2：双维度判别式联合', () => {
  it('C 端分支：只 releaseTier/displayAllowed；internal_active 访问 /v1/* 按 c_end 处理', async () => {
    const decision = await gate().evaluate(parse({ userId: 'u', userType: 'internal_active', tier: 'research_only', sessionVersion: 1 }));
    assert.equal(decision.audience.audience, 'c_end');
    if (decision.audience.audience === 'c_end') {
      assert.equal(decision.audience.releaseTier, 'c_end_display');
      assert.equal(decision.audience.displayAllowed, true);
      assert.equal('internalTier' in decision.audience, false);
    }
  });

  it('internal 分支：只 internalTier/internalAccessAllowed；c_end principal 拒绝', async () => {
    const g = gate();
    const internal = await g.evaluateAudience({
      audience: 'internal',
      principal: parse({ userId: 'u', userType: 'internal_active', tier: 'research_only', sessionVersion: 1 }),
    });
    assert.equal(internal.audience, 'internal');
    if (internal.audience === 'internal') {
      assert.equal(internal.internalTier, 'research_only');
      assert.equal(internal.internalAccessAllowed, true);
      assert.equal('releaseTier' in internal, false);
    }
    const denied = await g.evaluateAudience({
      audience: 'internal',
      principal: parse({ userId: 'u', userType: 'c_end', tier: 'c_end_display', sessionVersion: 1 }),
    });
    assert.equal(denied.blocked, true);
    if (denied.audience === 'internal') assert.equal(denied.internalAccessAllowed, false);
  });

  it('服务发布档 internal_eval：C 端 displayAllowed=false，内部 internal_eval 可访问', async () => {
    const g = gate({ tier: 'internal_eval' });
    const cEnd = await g.evaluate(parse({ userId: 'u', userType: 'c_end', tier: 'c_end_display', sessionVersion: 1 }));
    if (cEnd.audience.audience === 'c_end') assert.equal(cEnd.audience.displayAllowed, false);
    const internal = await g.evaluateAudience({
      audience: 'internal',
      principal: parse({ userId: 'u', userType: 'internal_active', tier: 'internal_eval', sessionVersion: 1 }),
    });
    if (internal.audience === 'internal') assert.equal(internal.internalAccessAllowed, true);
  });

  it('claim invalid 使 C 端 displayAllowed=false（fail-closed）', async () => {
    const decision = await gate().evaluate(parse({ userId: 'u', userType: 'c_end', tier: 'internal_eval', sessionVersion: 1 }));
    if (decision.audience.audience === 'c_end') assert.equal(decision.audience.displayAllowed, false);
    assert.equal(decision.audience.blocked, true);
  });
});

describe('ADR-008 D9：S2 shadow 不写 internal_access；S3 enforce 才写', () => {
  it('shadow 只记录，不调用审计回调', async () => {
    const records: InternalAccessRecord[] = [];
    const g = gate({ audienceGateMode: 'shadow', onInternalAccess: (r) => records.push(r) });
    await g.evaluateAudience({
      audience: 'internal',
      principal: parse({ userId: 'u', userType: 'internal_active', tier: 'internal_eval', sessionVersion: 7 }),
    });
    assert.equal(records.length, 0);
  });

  it('enforce 调用一次 internal_access 记录（含 user/audience/tier）', async () => {
    const records: InternalAccessRecord[] = [];
    const g = gate({ audienceGateMode: 'enforce', onInternalAccess: (r) => records.push(r) });
    await g.evaluateAudience({
      audience: 'internal',
      principal: parse({ userId: 'u', userType: 'internal_active', tier: 'internal_eval', sessionVersion: 7 }),
    });
    assert.equal(records.length, 1);
    assert.equal(records[0]?.userId, 'u');
    assert.equal(records[0]?.audience, 'internal');
    assert.equal(records[0]?.tier, 'internal_eval');
    assert.equal(records[0]?.allowed, true);
  });
});
