import type {
  ConfigItemDef,
  ConfigLevel,
  ConfigValues,
  ConsoleDomain,
} from './types';

/**
 * 配置注册表（中后台唯一真源的一方）。
 *
 * ⚠️ TODO(A8/H6)：H6 配置边界共 16 项（C0–C4）。当前只落 4 个代表性可配置项，
 * 待 Lead/H6 定稿的 16 项清单到位后在此补齐（字段名与等级以 decisions.md H6 表为准）。
 * 界面只从 `configurableItems()` 取入口，锁定项永远不会生成路由/按钮/表单。
 */

export interface ConsoleDomainDef {
  id: ConsoleDomain;
  label: string;
  short: string;
  description: string;
}

export const CONSOLE_DOMAINS: readonly ConsoleDomainDef[] = [
  {
    id: 'ops',
    label: '运营配置 + 数据看板',
    short: '运营',
    description: '首页/信息流/运营位配置与配置态看板。',
  },
  {
    id: 'compliance',
    label: '合规中台',
    short: '合规',
    description: '锁定项、AI 内容标识与审计来源（只读）。',
  },
  {
    id: 'admin',
    label: '管理后台',
    short: '管理',
    description: '权限与流程审批：单条审批，人类终审。',
  },
  {
    id: 'crm',
    label: 'CRM',
    short: 'CRM',
    description: '客户跟进规则与名单（P2 占位）。',
  },
];

/** 不可配项：H6 明确「界面不渲染任何入口」。这里登记只用于合规中台只读展示。 */
export interface LockedConfigArea {
  id: string;
  title: string;
  lockedBy: string;
  reason: string;
}

export const LOCKED_CONFIG_AREAS: readonly LockedConfigArea[] = [
  {
    id: 'compliance.disclaimer',
    title: '免责声明',
    lockedBy: 'decisions.md H6（不可配）',
    reason: '合规文案由法务/A5 统一下发，中后台不提供任何配置入口。',
  },
  {
    id: 'ai.label',
    title: 'AI 标识',
    lockedBy: 'decisions.md H6 + ADR-007',
    reason: 'AI 生成内容必须带「AI 生成·仅供参考」，不允许被配置关闭或弱化。',
  },
  {
    id: 'market.as_of',
    title: 'as_of 行情时间戳',
    lockedBy: 'decisions.md H6 + C2=A',
    reason: '由数据链路按 tushare 口径生成，页面只读展示，不提供人工覆盖入口。',
  },
  {
    id: 'unsubscribe.entry',
    title: '退订入口',
    lockedBy: 'decisions.md H6',
    reason: '合规要求的用户退出路径，不允许被运营隐藏或降级。',
  },
  {
    id: 'risk.warning',
    title: '风险提示',
    lockedBy: 'decisions.md H6',
    reason: '风险提示文案与位置不可配置，避免被运营弱化。',
  },
  {
    id: 'copy.whitelist',
    title: '话术白名单条目',
    lockedBy: 'decisions.md H6',
    reason: '话术白名单由合规单独维护，中后台不提供增删改入口。',
  },
];

const OPS_ITEM: ConfigItemDef = {
  id: 'ops.home-feed',
  title: '首页信息流',
  domain: 'ops',
  level: 'C2',
  editable: true,
  requireHumanApproval: true,
  fields: [
    {
      key: 'rank_strategy',
      label: '排序策略',
      level: 'C2',
      kind: 'enum',
      options: ['热度优先', '时效优先', '均衡'],
      help: 'C 端首页信息流排序口径；影响全部访问首页的用户。',
      affects: ['H5 首页 /feed'],
    },
    {
      key: 'page_size',
      label: '每页条数',
      level: 'C1',
      kind: 'number',
      help: '单页返回条数，过大会增加首屏耗时。',
      min: 1,
      max: 50,
      integer: true,
      affects: ['H5 首页 /feed'],
    },
    {
      key: 'pinned_count',
      label: '置顶条数',
      level: 'C1',
      kind: 'number',
      help: '置顶卡片数量，0 表示不置顶。',
      min: 0,
      max: 10,
      integer: true,
      affects: ['H5 首页 /feed'],
    },
    {
      key: 'enable_quick_watchlist',
      label: '快捷自选入口',
      level: 'C1',
      kind: 'boolean',
      help: '是否在信息流卡片展示「加自选」快捷入口。',
      affects: ['H5 首页 /feed', 'H5 自选 /watchlist'],
    },
  ],
};

const BANNER_ITEM: ConfigItemDef = {
  id: 'ops.home-banner',
  title: '运营 Banner',
  domain: 'ops',
  level: 'C3',
  editable: true,
  requireHumanApproval: true,
  fields: [
    {
      key: 'title',
      label: 'Banner 文案',
      level: 'C3',
      kind: 'text',
      help: '运营位文案，发布后对全部 C 端用户可见。',
      required: true,
      affects: ['H5 首页顶部'],
    },
    {
      key: 'link_url',
      label: '跳转链接',
      level: 'C3',
      kind: 'text',
      help: '站内相对路径或 https 链接；发布前需人工核对。',
      required: true,
      allowedPrefixes: ['/', 'https://'],
      affects: ['H5 首页顶部'],
    },
    {
      key: 'enabled',
      label: '是否上线',
      level: 'C3',
      kind: 'boolean',
      help: '关闭后 Banner 立即从首页移除。',
      affects: ['H5 首页顶部'],
    },
    {
      key: 'start_at',
      label: '生效开始（ISO8601）',
      level: 'C2',
      kind: 'text',
      help: '与结束时间共同决定展示窗口。',
      required: true,
      affects: ['H5 首页顶部'],
    },
    {
      key: 'end_at',
      label: '生效结束（ISO8601）',
      level: 'C2',
      kind: 'text',
      help: '必须晚于开始时间。',
      required: true,
      affects: ['H5 首页顶部'],
    },
  ],
};

const SENTIMENT_ITEM: ConfigItemDef = {
  id: 'market.sentiment-thresholds',
  title: '市场情绪阈值',
  domain: 'ops',
  level: 'C1',
  editable: true,
  requireHumanApproval: false,
  fields: [
    {
      key: 'hot_threshold',
      label: '过热阈值',
      level: 'C1',
      kind: 'number',
      help: '情绪分高于该值标记为过热（仅提示，不构成投资建议）。',
      min: 0,
      max: 100,
      integer: true,
      affects: ['H5 市场情绪组件'],
    },
    {
      key: 'cold_threshold',
      label: '过冷阈值',
      level: 'C1',
      kind: 'number',
      help: '情绪分低于该值标记为过冷。',
      min: 0,
      max: 100,
      integer: true,
      affects: ['H5 市场情绪组件'],
    },
    {
      key: 'sample_window',
      label: '样本窗口',
      level: 'C1',
      kind: 'number',
      help: '计算情绪分的交易日窗口长度。',
      min: 5,
      max: 250,
      integer: true,
      affects: ['H5 市场情绪组件'],
    },
  ],
};

const CRM_ITEM: ConfigItemDef = {
  id: 'crm.followup',
  title: '客户跟进规则',
  domain: 'crm',
  level: 'C1',
  editable: true,
  requireHumanApproval: false,
  fields: [
    {
      key: 'remind_days',
      label: '跟进提醒间隔（天）',
      level: 'C1',
      kind: 'number',
      help: '内部 CRM 提醒频率，不影响 C 端。',
      min: 1,
      max: 30,
      integer: true,
      affects: ['中后台 CRM 跟进列表'],
    },
    {
      key: 'auto_archive_days',
      label: '自动归档（天）',
      level: 'C1',
      kind: 'number',
      help: '超过该天数无跟进记录自动归档。',
      min: 7,
      max: 365,
      integer: true,
      affects: ['中后台 CRM 客户列表'],
    },
    {
      key: 'tier',
      label: '客户分层',
      level: 'C1',
      kind: 'enum',
      options: ['标准', '重点', '观察'],
      help: 'CRM 内部分层，仅内部可见。',
      affects: ['中后台 CRM 客户列表'],
    },
  ],
};

export const CONFIG_ITEMS: readonly ConfigItemDef[] = [
  OPS_ITEM,
  BANNER_ITEM,
  SENTIMENT_ITEM,
  CRM_ITEM,
];

/** 初始 published 值（后续由 Config Service 提供；当前 mock 种子）。 */
export const DEFAULT_VALUES: Readonly<Record<string, ConfigValues>> = {
  [OPS_ITEM.id]: {
    rank_strategy: '均衡',
    page_size: 20,
    pinned_count: 2,
    enable_quick_watchlist: true,
  },
  [BANNER_ITEM.id]: {
    title: '收盘后 15 分钟，今日市场回顾',
    link_url: '/reports/daily',
    enabled: true,
    start_at: '2026-11-01T00:00:00Z',
    end_at: '2026-12-31T23:59:59Z',
  },
  [SENTIMENT_ITEM.id]: {
    hot_threshold: 80,
    cold_threshold: 20,
    sample_window: 20,
  },
  [CRM_ITEM.id]: {
    remind_days: 3,
    auto_archive_days: 14,
    tier: '标准',
  },
};

/** 可配置项：唯一合法的界面入口来源。锁定项不在此列表中。 */
export function configurableItems(): ConfigItemDef[] {
  return CONFIG_ITEMS.filter((item) => item.editable);
}

export function findConfigItem(itemId: string): ConfigItemDef | undefined {
  return CONFIG_ITEMS.find((item) => item.id === itemId);
}

/**
 * 服务端/适配层入口守卫：锁定项与未知项一律拒绝。
 * UI 不渲染入口只是第一道防线，适配层必须二次拒绝（测试覆盖）。
 */
export function assertConfigurable(itemId: string): ConfigItemDef {
  const item = findConfigItem(itemId);
  if (!item) {
    throw new LockedConfigError(itemId, '未知配置项');
  }
  if (!item.editable) {
    throw new LockedConfigError(itemId, item.lockedReason ?? '该项为合规锁定项');
  }
  return item;
}

export class LockedConfigError extends Error {
  readonly itemId: string;

  constructor(itemId: string, message: string) {
    super(`配置项 ${itemId} 不可配置：${message}`);
    this.name = 'LockedConfigError';
    this.itemId = itemId;
  }
}

export function levelRank(level: ConfigLevel): number {
  return Number(level.slice(1));
}
