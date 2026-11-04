/**
 * 配置层探针：用 A3 真实 loadMarketConfig 解析进程 env，输出 JSON 结果。
 * 只读、无副作用；供 check_entitlement_expiry.py 做「配置层」断言（未设置 + tier!=internal_eval 必须拒绝启动）。
 */
import { loadMarketConfig } from '../../../services/market/src/config.ts';

try {
  const config = loadMarketConfig(process.env);
  process.stdout.write(
    `${JSON.stringify({ ok: true, tier: config.entitlementTier, expiresAt: config.entitlementExpiresAt ?? null })}\n`,
  );
} catch (error) {
  const err = error as Error;
  process.stdout.write(`${JSON.stringify({ ok: false, error: err.name, message: err.message })}\n`);
}
