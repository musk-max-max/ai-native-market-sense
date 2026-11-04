import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadMarketConfig, MarketConfig, MarketConfigError } from '../src/config.js';
import { configFingerprint } from '../src/domain/entitlement.js';

// H5 m02707 / KD-ENT-01：启动矩阵至少 12 组合，证明 R1-R4 fail-closed 四条同时生效。
// tier × profile × HOLD_CHECK × AUDIT × EXPECTED_SHA256（+ L44/L73 prod 守卫）。

const EXPIRES = '2099-12-31T23:59:59+08:00';
const EXPIRES_UTC = '2099-12-31T15:59:59.000Z';
const SHA = configFingerprint('c_end_display', EXPIRES_UTC);

interface Case {
  readonly name: string;
  readonly env: Record<string, string>;
  readonly allowed: boolean;
  readonly error?: RegExp;
}

const fullControls = {
  ENTITLEMENT_HOLD_CHECK: '1',
  ENTITLEMENT_AUDIT: '1',
  ENTITLEMENT_CONFIG_EXPECTED_SHA256: SHA,
};

const cases: Case[] = [
  {
    name: '01 internal_eval + test + 不配 flags：允许（默认 fail-closed 开启）',
    env: { APP_PROFILE: 'test', ENTITLEMENT_TIER: 'internal_eval' },
    allowed: true,
  },
  {
    name: '02 internal_eval + e2e + E2E_MODE=1 + 不配 flags：允许，且 hold/audit 默认仍为 true（R2）',
    env: { APP_PROFILE: 'e2e', E2E_MODE: '1', ENTITLEMENT_TIER: 'internal_eval' },
    allowed: true,
  },
  {
    name: '03 internal_eval + test + HOLD=0/AUDIT=0：允许（显式 0 仅非 prod+internal）',
    env: {
      APP_PROFILE: 'test',
      ENTITLEMENT_TIER: 'internal_eval',
      ENTITLEMENT_HOLD_CHECK: '0',
      ENTITLEMENT_AUDIT: '0',
    },
    allowed: true,
  },
  {
    name: '04 internal_eval + prod + HOLD=0：拒绝（L73 prod 守卫）',
    env: {
      APP_PROFILE: 'prod',
      ENTITLEMENT_TIER: 'internal_eval',
      ENTITLEMENT_HOLD_CHECK: '0',
      DEPLOYMENT_UID: 'deploy-prod-1',
    },
    allowed: false,
    error: /生产禁止关闭 hold 检查/,
  },
  {
    name: '05 internal_eval + prod + E2E_MODE=1：拒绝（L44/L46）',
    env: {
      APP_PROFILE: 'prod',
      ENTITLEMENT_TIER: 'internal_eval',
      E2E_MODE: '1',
      DEPLOYMENT_UID: 'deploy-prod-1',
    },
    allowed: false,
    error: /E2E 模式在生产不可用/,
  },
  {
    name: '06 c_end_display + test + 不配三项：拒绝（R1 缺 hold/audit/sha）',
    env: { APP_PROFILE: 'test', ENTITLEMENT_TIER: 'c_end_display', ENTITLEMENT_EXPIRES_AT: EXPIRES },
    allowed: false,
    error: /ENTITLEMENT_HOLD_CHECK=1/,
  },
  {
    name: '07 c_end_display + test + 只配 HOLD=1：拒绝（缺 audit）',
    env: {
      APP_PROFILE: 'test',
      ENTITLEMENT_TIER: 'c_end_display',
      ENTITLEMENT_EXPIRES_AT: EXPIRES,
      ENTITLEMENT_HOLD_CHECK: '1',
    },
    allowed: false,
    error: /ENTITLEMENT_AUDIT=1/,
  },
  {
    name: '08 c_end_display + test + HOLD+AUDIT 配齐：拒绝（缺 expected sha）',
    env: {
      APP_PROFILE: 'test',
      ENTITLEMENT_TIER: 'c_end_display',
      ENTITLEMENT_EXPIRES_AT: EXPIRES,
      ENTITLEMENT_HOLD_CHECK: '1',
      ENTITLEMENT_AUDIT: '1',
    },
    allowed: false,
    error: /ENTITLEMENT_CONFIG_EXPECTED_SHA256/,
  },
  {
    name: '09 c_end_display + test + 显式 HOLD=0（带 audit/sha）：拒绝（R1 要求显式 1）',
    env: {
      APP_PROFILE: 'test',
      ENTITLEMENT_TIER: 'c_end_display',
      ENTITLEMENT_EXPIRES_AT: EXPIRES,
      ENTITLEMENT_HOLD_CHECK: '0',
      ENTITLEMENT_AUDIT: '1',
      ENTITLEMENT_CONFIG_EXPECTED_SHA256: SHA,
    },
    allowed: false,
    error: /ENTITLEMENT_HOLD_CHECK=1/,
  },
  {
    name: '10 c_end_display + e2e + E2E_MODE=1 + 三项配齐：允许（e2e 不再豁免，但显式配齐可跑）',
    env: {
      APP_PROFILE: 'e2e',
      E2E_MODE: '1',
      ENTITLEMENT_TIER: 'c_end_display',
      ENTITLEMENT_EXPIRES_AT: EXPIRES,
      ...fullControls,
    },
    allowed: true,
  },
  {
    name: '11 c_end_display + dev + 三项配齐：允许',
    env: {
      APP_PROFILE: 'dev',
      ENTITLEMENT_TIER: 'c_end_display',
      ENTITLEMENT_EXPIRES_AT: EXPIRES,
      ...fullControls,
    },
    allowed: true,
  },
  {
    name: '12 c_end_display + prod + 三项配齐 + DEPLOYMENT_UID：允许（prod L73 只拒后门/关开关）',
    env: {
      APP_PROFILE: 'prod',
      ENTITLEMENT_TIER: 'c_end_display',
      ENTITLEMENT_EXPIRES_AT: EXPIRES,
      DEPLOYMENT_UID: 'deploy-prod-1',
      ...fullControls,
    },
    allowed: true,
  },
  {
    name: '13 c_end_display + test + 缺 EXPIRES_AT：拒绝（时间盒仍必填）',
    env: {
      APP_PROFILE: 'test',
      ENTITLEMENT_TIER: 'c_end_display',
      ...fullControls,
    },
    allowed: false,
    error: /ENTITLEMENT_EXPIRES_AT/,
  },
  {
    name: '14 c_end_display + test + sha 非 64 hex：拒绝（parseSha256）',
    env: {
      APP_PROFILE: 'test',
      ENTITLEMENT_TIER: 'c_end_display',
      ENTITLEMENT_EXPIRES_AT: EXPIRES,
      ENTITLEMENT_HOLD_CHECK: '1',
      ENTITLEMENT_AUDIT: '1',
      ENTITLEMENT_CONFIG_EXPECTED_SHA256: 'not-a-sha',
    },
    allowed: false,
    error: /64 位小写 hex/,
  },
  {
    name: '15 未设 APP_PROFILE（=prod）+ E2E_MODE=1：拒绝（L46 不依赖"别忘了配"）',
    env: { ENTITLEMENT_TIER: 'internal_eval', E2E_MODE: '1', DEPLOYMENT_UID: 'deploy-prod-1' },
    allowed: false,
    error: /E2E 模式在生产不可用/,
  },
  {
    name: '16 APP_PROFILE=prodd（拼错）+ E2E_MODE=1：按 prod 拒绝',
    env: { APP_PROFILE: 'prodd', ENTITLEMENT_TIER: 'internal_eval', E2E_MODE: '1' },
    allowed: false,
    error: /E2E 模式在生产不可用/,
  },
  {
    name: '17 internal_eval + test + MARKET_NOW：允许（非 prod 可冻结时钟）',
    env: {
      APP_PROFILE: 'test',
      ENTITLEMENT_TIER: 'internal_eval',
      MARKET_NOW: '2026-11-04T10:00:00+08:00',
    },
    allowed: true,
  },
  {
    name: '18 internal_eval + prod + MARKET_NOW：拒绝（L73 固定时钟）',
    env: {
      APP_PROFILE: 'prod',
      ENTITLEMENT_TIER: 'internal_eval',
      MARKET_NOW: '2026-11-04T10:00:00+08:00',
      DEPLOYMENT_UID: 'deploy-prod-1',
    },
    allowed: false,
    error: /生产禁止固定时钟/,
  },
];

describe('H5 m02707 KD-ENT-01：授权控制启动矩阵（R1-R4）', () => {
  for (const testCase of cases) {
    it(testCase.name, () => {
      if (testCase.allowed) {
        let config: MarketConfig | undefined;
        assert.doesNotThrow(() => {
          config = loadMarketConfig(testCase.env as NodeJS.ProcessEnv);
        });
        assert.ok(config);
        if (config.entitlementTier === 'internal_eval') {
          // R2：E2E_MODE 不再把默认值改成关闭；缺省即 true。
          assert.equal(config.entitlementHoldCheck, testCase.env.ENTITLEMENT_HOLD_CHECK !== '0');
          assert.equal(config.entitlementAuditEnabled, testCase.env.ENTITLEMENT_AUDIT !== '0');
        }
      } else {
        assert.throws(
          () => loadMarketConfig(testCase.env as NodeJS.ProcessEnv),
          (error: unknown) => {
            assert.ok(error instanceof MarketConfigError, `预期 MarketConfigError，实际 ${String(error)}`);
            if (testCase.error) assert.match(error.message, testCase.error);
            return true;
          },
        );
      }
    });
  }
});
