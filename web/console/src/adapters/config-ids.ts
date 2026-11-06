/**
 * UI key（itemId，如 'ops.home-feed'）↔ 契约 config_id（如 'ops_home_feed'）映射。
 *
 * 契约硬要求（CONTRACT-MAP「config_id 映射」）：
 * - config_id pattern ^ops_[a-z0-9_]{3,48}$ 不允许点，UI key 不能直接当 config_id；
 * - adapter 必须用 listOpsConfigs 返回的 canonical config_id，本地维护 UI key→config_id 映射；
 * - seed ID 以 A14 registry 为准，不要自行推导。
 *
 * seed 值来源：A4 服务端 canonical registry 确认（A4→A6 消息，2026-11-06）：
 * ops.home-feed→ops_home_feed、ops.home-banner→ops_home_banner，按正式值使用。
 * 未在映射里的 config_id（服务端有、本地没有）：直接以 config_id 充当 itemId，
 * 不做任何猜测性改写。
 */

const SEED_CONFIG_ID_BY_ITEM_ID: Readonly<Record<string, string>> = {
  'ops.home-feed': 'ops_home_feed',
  'ops.home-banner': 'ops_home_banner',
};

const ITEM_ID_BY_CONFIG_ID: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(SEED_CONFIG_ID_BY_ITEM_ID).map(([itemId, configId]) => [configId, itemId]),
);

/** UI key → canonical config_id。未知 key：若形如合法 config_id 则原样通过，否则抛 NOT_FOUND。 */
export function configIdForItemId(itemId: string): string {
  const seeded = SEED_CONFIG_ID_BY_ITEM_ID[itemId];
  if (seeded) return seeded;
  if (/^ops_[a-z0-9_]{3,48}$/.test(itemId)) return itemId;
  throw new Error(`NOT_FOUND: 配置项「${itemId}」不在 UI key→config_id 映射里（seed 待 A14 registry 确认）`);
}

/** canonical config_id → UI key（审批单 subject.object_id 反查用）；未知则原样返回。 */
export function itemIdForConfigId(configId: string): string {
  return ITEM_ID_BY_CONFIG_ID[configId] ?? configId;
}
