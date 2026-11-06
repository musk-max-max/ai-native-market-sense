/**
 * 用户可见文案的**单一来源**（H3 合规出口）。
 *
 * 规则：
 *  - 组件/页面不得自行拼写中文文案，一律引用本文件；新增文案先加在这里再引用；
 *  - 文案只描述事实，不美化数据时效：延时/降级/快照不得写成「实时」；
 *  - 不得出现内部标识：权限分层取值、来源内部 ID、渠道名、内部错误码原值、厂商名等；
 *  - 免责声明正文与版本来自服务端 meta.disclaimer，前端只展示、不改写（见 copy.disclaimer）；
 *  - 错误文案按 **HTTP status** 映射（不按内部错误码字符串），因此生产 bundle 里没有内部错误码；
 *  - 版本轴与后端 copy 成对记录在 docs/release/copy-version-manifest.md（append-only，ADR-006 D2）；
 *    本版本的全部文案快照见 docs/release/copy-snapshots/<version>.<hash12>.frontend.json（D3）。
 *
 * 版本：改动任何一条用户可见文案时递增，并重新生成本版本快照、在 manifest 追加一行。
 */
import type { SourceValue } from '@market-sense/api-client';

export const COPY_VERSION = '2026.11.5';

/** 缺失值统一占位：显式缺失，不用 0 冒充。 */
export const MISSING = '—';

/**
 * 数据缺口原因（受控枚举）。
 *
 * 缺口卡只按原因渲染文案，**禁止调用方传任意字符串**——否则「缺口卡」会变成
 * 绕过 copy.ts 的自定义文案通道（H3 单一来源）。
 */
export type GapReason =
  | 'pending_batch'
  | 'permission'
  | 'upstream_missing'
  | 'not_integrated'
  | 'no_coverage';

/** 数据来源标识 → 人可读标签（唯一来源；契约枚举漏映射会在 tsc 阶段失败）。 */
export const SOURCE_LABELS: Readonly<Record<SourceValue, string>> = {
  platform_realtime: '平台行情（实时）',
  platform_delayed: '平台行情（延时）',
  platform_eod: '平台行情（收盘）',
  platform_snapshot: '平台行情快照',
  platform_degraded: '平台行情（降级）',
  platform_watchlist: '平台自选数据',
  platform_fundamental: '平台财报数据',
};

/** 每个未命中的来源标识在 dev 模式只告警一次，避免同一页面重复刷屏。 */
const warnedUnmappedSources = new Set<string>();

/**
 * 来源标识 → 展示文案。
 *
 * 入参保留 string：JSON 运行时仍可能拿到契约外取值（旧前端 + 新 API）。此时原样返回是防线，
 * 但**静默**原样返回会让「契约加了档位、前端没跟上」无人知晓，因此 dev 模式打一次 warn。
 * 生产不输出：线上日志由服务端契约校验负责，前端不在用户设备上刷屏。
 */
export function sourceLabel(value: string): string {
  const raw = value.trim();
  const label = SOURCE_LABELS[raw as SourceValue];
  if (label !== undefined) return label;
  if (import.meta.env?.DEV && !warnedUnmappedSources.has(raw)) {
    warnedUnmappedSources.add(raw);
    console.warn(copy.debug.unmappedSourceWarning(raw));
  }
  return raw;
}

/** 错误文案：由 HTTP 状态码决定，不含内部错误码。 */
export interface ErrorCopy {
  readonly title: string;
  readonly message: string;
  readonly hint: string;
  /** 重试动作文案；null = 确定状态，不提供重试（如 403）。 */
  readonly retry: string | null;
}

const ERROR_HINT = '页面不会展示缺少免责声明或数据时点不明的价格，也不会用旧价格冒充当前行情。';
const RETRY_LABEL = '重新加载';

// 403 与 EntitlementNotice 共用同一份文案（H3：两套维护必漂）。
const UNAVAILABLE_TITLE = '数据暂不可用';
const UNAVAILABLE_BODY = '当前版本暂不提供该标的行情数据，本页不会展示任何价格数字。';
const UNAVAILABLE_HINT = '该数据在当前版本中不提供。';

const NETWORK_ERROR: ErrorCopy = {
  title: '网络连接不可用',
  message: '请检查网络连接后重试。',
  hint: ERROR_HINT,
  retry: RETRY_LABEL,
};

const UNKNOWN_ERROR: ErrorCopy = {
  title: '数据暂时不可用',
  message: '数据暂时不可用。',
  hint: ERROR_HINT,
  retry: RETRY_LABEL,
};

/**
 * 状态码 → 用户文案（四态基线：正常 / 403 / 429 / 断网）。
 *
 * 设计约束（H3）：
 *  - 403 只陈述「当前版本暂不提供」，不让用户知道「谁不让」以及「为什么」；
 *  - 429 不暴露限流原因，只给「稍后再试」；
 *  - 断网与「有网但服务不可用」文案不同，便于用户采取不同动作。
 */
export const ERROR_COPY: Readonly<Record<string, ErrorCopy>> = {
  status400: {
    title: '请求参数有误',
    message: '请检查证券代码格式后重试。',
    hint: ERROR_HINT,
    retry: RETRY_LABEL,
  },
  status401: {
    title: '登录状态已失效',
    message: '请重新登录后再试。',
    hint: ERROR_HINT,
    retry: RETRY_LABEL,
  },
  status403: {
    title: UNAVAILABLE_TITLE,
    message: UNAVAILABLE_BODY,
    hint: UNAVAILABLE_HINT,
    retry: null,
  },
  status404: {
    title: '未找到该证券',
    message:
      '未找到该证券的基础信息。请检查交易所前缀与代码（格式：交易所:代码，例如 SSE:600519）。',
    hint: ERROR_HINT,
    retry: RETRY_LABEL,
  },
  status429: {
    title: '请求暂时无法处理',
    message: '当前请求暂时无法完成，请稍后重试。',
    hint: ERROR_HINT,
    retry: RETRY_LABEL,
  },
  status5xx: {
    title: '服务暂时不可用',
    message: '行情数据暂时无法获取。',
    hint: ERROR_HINT,
    retry: RETRY_LABEL,
  },
  network: NETWORK_ERROR,
  unknown: UNKNOWN_ERROR,
};

/**
 * HTTP 状态码 → 用户文案。
 *
 * @param status 响应状态码；null/undefined 表示没有拿到响应（网络失败或响应结构不合法）
 * @param network 是否网络层失败（fetch 抛错 / 浏览器离线），与「有响应但结构异常」区分
 */
export function errorCopy(status: number | null | undefined, network: boolean = false): ErrorCopy {
  if (network) return NETWORK_ERROR;
  if (status === null || status === undefined) return UNKNOWN_ERROR;
  if (status >= 500) return ERROR_COPY.status5xx as ErrorCopy;
  const keyed = ERROR_COPY[`status${status}`];
  return keyed ?? UNKNOWN_ERROR;
}

export const copy = {
  app: {
    skipToMain: '跳到主要内容',
    // 与 index.html 的 <noscript> 逐字一致（JS 未启用时无 copy 可读）；合规测试校验两者相等。
    noscript:
      '本页需要启用 JavaScript 才能展示行情数据。数据均标注来源与截止时间，不构成投资建议。',
    brandAriaLabel: 'Market Sense 首页',
    brandName: 'Market Sense',
    brandTag: 'A 股数据',
    navAriaLabel: '底部导航',
    /** 5 个 Tab 的可见标签（docs/design/c-end-h5-v2.md §1.1）；路由映射见 components/TabBar.tsx。 */
    tabMarket: '行情',
    tabWatchlist: '自选',
    tabPortfolio: '组合',
    tabAi: 'AI',
    tabMe: '我的',
    footerDisclaimerTitle: '免责摘要',
    footerUnsubscribe: '退订入口',
    footerNote:
      '本平台为客观数据工具，展示市场公开披露数据与平台自有数据，不构成投资建议、要约或收益承诺。',
    footerMeta: '数据均标注来源与截止时间 · 免责声明由服务端版本化下发且不可关闭',
  },
  home: {
    eyebrow: 'A 股 · 数据工具',
    titleLine1: '行情与基本面，',
    titleLine2: '一页看清口径。',
    lede: '所有行情展示都标注数据来源与截止时间；数据可能延时，页面不会把快照说成实时，也不提供荐股或收益承诺。',
    searchLabel: '证券代码',
    searchPlaceholder: 'SSE:600519',
    searchSubmit: '查看',
    inputInvalid: '请输入「交易所:代码」格式，例如 SSE:600519。',
    inputHint: '格式：交易所:代码（上交所 SSE / 深交所 SZSE / 北交所 BSE）。',
    exampleLink: '查看示例标的 · SSE:600519',
    watchlistLink: '我的自选',
    reviewLink: '自选组合复盘',
    limitLink: '涨跌停概览',
    notesTitle: '数据说明',
    notes: [
      '行情为收盘快照，不做盘中实时推送；每处行情都显示 as_of 数据截止时间。',
      '数据来源标识（如平台行情源、降级快照）原样展示，不隐藏数据链路。',
      '基本面为报告期口径，与行情时点不同，页面分开标注。',
      '免责声明由服务端版本化下发，页面不提供关闭或折叠入口。',
    ],
  },
  stock: {
    breadcrumbAria: '面包屑',
    breadcrumbHome: '← 首页',
    breadcrumbSeparator: ' / ',
    exchange: {
      SSE: '上交所',
      SZSE: '深交所',
      BSE: '北交所',
    } as Readonly<Record<string, string>>,
    board: {
      main: '主板',
      gem: '创业板',
      star: '科创板',
      bse: '北交所',
    } as Readonly<Record<string, string>>,
    securityType: {
      stock: '股票',
      etf: 'ETF',
      index: '指数',
    } as Readonly<Record<string, string>>,
    listStatus: {
      listed: '已上市',
      delisted: '终止上市',
      pre_listed: '未上市',
    } as Readonly<Record<string, string>>,
    instrumentPrefix: '标的：',
    listDateLabel: '上市日期',
    footnote:
      '本页行情为收盘快照，非盘中实时；如上方出现「延时数据」标记，请以标记为准。数据口径与免责声明不可关闭。',
    incompleteTitle: '行情数据不完整',
    incompleteMessage:
      '响应缺少免责声明或数据时点，页面已停止展示行情数据，避免在缺少披露的情况下展示价格。',
    missingInstrumentMessage: '响应缺少证券基础信息，已停止展示。',
  },
  quote: {
    ariaTitle: '最新行情',
    caption: '最新价',
    captionSuffix: '收盘快照',
    changeLabel: '涨跌幅',
    suspended: '当前停牌，无最新成交价。',
    asOfLabel: '数据截止（北京时间）',
    sourceLabel: '数据来源',
    adjustmentLabel: '价格口径',
    tradeDateLabel: '交易日',
    stalePrefix: '延时数据 · 非实时（滞后约 ',
    staleSuffix: '）',
  },
  fundamental: {
    title: '基本面摘要',
    note: '财报为报告期口径，与上方行情时点不同，请勿混读。',
    periodLabel: '报告期',
    basisLabel: '口径',
    metrics: {
      revenue: '营业收入',
      netProfit: '归母净利润',
      revenueYoy: '营收同比',
      netProfitYoy: '净利同比',
      eps: '每股收益',
      roe: '净资产收益率',
      grossMargin: '毛利率',
      totalAssets: '总资产',
    },
    meta: {
      reportEnd: '报告期末',
      asOf: '财报数据截止',
      source: '来源',
      announced: '公告披露',
    },
    footnote: '「—」表示该字段数据缺失，未用 0 代替。',
    unavailable: '基本面数据暂时无法取得；页面不会用 0 或猜测值填充。',
    missing: '暂无该标的的已披露财报数据（未收录或尚未披露）。',
  },
  watchlist: {
    toggleAdd: '加入自选',
    toggleRemove: '移除自选',
    stateIn: '已自选',
    stateOut: '未自选',
    stateLoading: '自选状态加载中',
    stateAnonymous: '登录后可加自选',
    stateError: '自选状态不可用',
    noticeAnonymous: '登录后可使用自选功能。',
    noticeFailed: '操作未成功，请稍后重试。',
    pageTitle: '我的自选',
    loading: '正在加载自选列表…',
    anonymous: '登录后可查看和管理自选。当前为未登录状态，页面不会伪造自选数据。',
    error: '自选列表暂时无法加载，请稍后重试。',
    empty: '还没有自选标的。',
    emptyLink: '去看看示例标的',
  },
  ai: {
    sectionTitle: 'AI 解读',
    sectionNote:
      '五段结构（估值/成长/盈利质量/资金/风险）：本批只有成长、盈利质量两段展示已接入的确定性财报字段；估值、资金、风险无数据来源，用缺口卡显式标注；AI 文本尚待接入。',
    deterministicNote: '以下为确定性数据摘要，不是模型生成内容。',
    pendingText: 'AI 解读待接入，本段不展示模型生成文案。',
    segmentsAria: 'AI 解读分段落',
    segments: {
      valuation: '估值',
      growth: '成长',
      earningsQuality: '盈利质量',
      capitalFlow: '资金',
      risk: '风险',
    },
    gapTitle: '维度数据缺口',
    /** AI 文本、AI 标识与免责由服务端 P7 注入（ADR-007 D3）；前端不硬编码、不提供关闭入口。 */
    notGeneratedNote: '本段当前不含模型生成文本；AI 标识与免责仅在服务端注入后随内容展示。',
    quoteContext: '行情上下文',
    asOfLabel: '数据截止（北京时间）',
    sourceLabel: '数据来源',
  },
  /** 「AI」Tab（/ai）：AI 解读聚合入口；模型生成内容一律由服务端注入标识与免责（ADR-007 D3）。 */
  aiHome: {
    title: 'AI 解读',
    lede: '按标的聚合的 AI 解读入口；每条解读都带不可关闭的 AI 生成标识与免责声明。',
    aggregateTitle: '解读聚合',
    aggregateEmpty: '聚合列表尚未接入，本页不展示模型生成文案。',
  },
  /** 「我的」Tab（/me）：账户、权限、退订（置顶）、免责全文（docs/design/c-end-h5-v2.md §1.1）。 */
  me: {
    title: '我的',
    unsubscribeTitle: '退订',
    unsubscribeNote: '退订入口固定在本页顶部区域，不藏在三级页面里。',
    unsubscribePending: '退订通道尚未接入，本页不提供可点击的占位按钮。',
    accountTitle: '账户',
    accountAnonymous: '当前为未登录状态，本页不展示账户与自选数据，也不填充占位数值。',
    entitlementTitle: '数据权限',
    entitlementNote:
      '行情与基本面数据的展示范围以服务端下发的权限结果为准；无权展示时不出现任何数值。',
    disclaimerTitle: '免责声明全文',
    disclaimerNote:
      '免责声明由服务端版本化下发且不可关闭；本页展示常驻摘要，全文文案以服务端下发版本为准。',
  },
  gap: {
    title: '数据缺口',
    footnote: '缺口按受控类别显式标注，不用 0、样例值或推测值填充。',
    reasons: {
      pending_batch: '该维度数据计划在第 2 批接入，当前不展示。',
      permission: '当前版本不提供该维度数据。',
      upstream_missing: '上游尚未提供该维度数据。',
      not_integrated: '该功能尚未接入，本页不展示占位结果。',
      no_coverage: '该标的暂无已披露数据。',
    } as Readonly<Record<GapReason, string>>,
  },
  review: {
    portfolio: {
      title: '自选组合复盘',
      subtitle:
        '按自选列表等权汇总，固定模板；仅反映自选标的的组合表现，不代表真实持仓。',
      scopeNote: '自选组合绝对表现，非真实持仓；不等同于真实账户收益。',
      templateNote:
        '固定模板：区间涨跌、年化波动、最大回撤、等权组合表现；不包含选股或收益承诺。',
      periodLabel: '统计区间',
      periods: {
        '1m': '近 1 月',
        '3m': '近 3 月',
        '6m': '近 6 月',
        '1y': '近 1 年',
      } as Readonly<Record<string, string>>,
      metricsTitle: '组合表现',
      metrics: {
        periodReturn: '区间涨跌',
        volatility: '年化波动',
        maxDrawdown: '最大回撤',
        equalWeight: '等权组合表现',
        instrumentCount: '标的数量',
      },
      asOfLabel: '数据截止（北京时间）',
      sourceLabel: '数据来源',
      demoNote: '本地演示数据（mock），仅用于界面开发，不代表真实计算结果。',
      loading: '正在计算自选组合表现…',
      empty: '自选列表为空，先添加标的后再查看组合复盘。',
      emptyLink: '去添加自选',
      loginRequired: '登录后可查看自选组合复盘。当前为未登录状态，页面不会伪造组合数据。',
      unavailable: '自选组合复盘尚未接入汇总接口，本页不展示占位数值。',
      gapsTitle: '待接入维度',
      gaps: {
        benchmark: '相对基准对比',
        sector: '板块对比',
      },
      gapFootnote: '这两项依赖第 2 批研究数据，当前用缺口卡显式占位。',
      error: '组合复盘暂时无法加载。',
    },
    limits: {
      title: '涨跌停概览',
      subtitle:
        '按板块规则从日线汇总涨停/跌停家数与连板分布；只展示市场级计数，不含个股名单；ST 标的先排除并显式标注。',
      provisional:
        '涨跌停口径为临时近似规则（provisional），后续随数据校准调整；连板分布从首板（1 板）起逐档统计至最高连板，全部分段展示、不截断。',
      stExclusion: 'ST / *ST 标的已排除，不进入统计。',
      stExcludedLabel: '已排除数量',
      countUnit: '家',
      overviewTitle: '市场级汇总',
      counts: {
        up: '涨停家数',
        down: '跌停家数',
        maxStreak: '最高连板',
        distribution: '连板分布',
      },
      aggregateNote:
        '本页只展示市场级汇总计数，不展示个股名称、代码或排序名单；口径与排除规则见上方说明。',
      emptyList: '当前无可统计的涨跌停样本。',
      demoNote: '本地演示数据（mock），仅用于界面开发，不代表真实计算结果。',
      loading: '正在加载涨跌停概览…',
      unavailable: '涨跌停概览尚未接入汇总接口，本页不展示占位数值。',
      error: '涨跌停概览暂时无法加载。',
      caliberVersionLabel: '口径版本',
      streakUnit: '板',
    },
  },
  states: {
    loadingTitle: '正在加载行情数据…',
    loadingHint: '加载完成后会同时展示数据来源与数据截止时间。',
    errorHint: ERROR_HINT,
    retry: RETRY_LABEL,
  },
  disclaimer: {
    title: '免责声明',
    versionLabel: '版本',
    notClosable: '不可关闭',
    unavailable: '本次响应未携带免责声明元数据，当前版本暂不展示行情数据。',
  },
  entitlement: {
    title: UNAVAILABLE_TITLE,
    body: UNAVAILABLE_BODY,
    hint: UNAVAILABLE_HINT,
  },
  notFound: {
    title: '页面不存在',
    message: '该地址没有对应的页面。请从首页重新进入，或检查证券代码格式。',
    back: '返回首页',
  },
  units: {
    yuan: '元',
    yuanPerShare: '元/股',
    percent: '%',
    minutes: '分钟',
    hours: '小时',
    zeroMinutes: '0 分钟',
    separator: ' · ',
  },
  labels: {
    adjustment: {
      none: '不复权（快照）',
      qfq: '前复权',
      hfq: '后复权',
    } as Readonly<Record<string, string>>,
    statementBasis: {
      reported: '原始披露',
      restated: '追溯重述',
    } as Readonly<Record<string, string>>,
  },
  debug: {
    rootMountError: '缺少 #root 挂载点，index.html 与 main.tsx 不匹配',
    unmappedSourceWarning: (raw: string): string =>
      `[source] 未映射的数据来源标识：${JSON.stringify(raw)}。已原样展示；` +
      '请检查 contracts/shared SourceRef.source 是否新增枚举，并同步 SOURCE_LABELS。',
  },
} as const;

export type Copy = typeof copy;
