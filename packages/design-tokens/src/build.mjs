#!/usr/bin/env node
/* global console, process */
/**
 * design-tokens 生成器（零依赖，Node 原生 ESM）。
 *
 * 单源：tokens.json → 三条消费路径
 *   dist/tokens.css      --ms-* 变量 + 旧名别名（自研 CSS 消费；h5/console）
 *   dist/antd-theme.mjs  antd 5 ThemeConfig 对象（中后台 ConfigProvider 消费）
 *   dist/adm-tokens.css  --adm-* 覆盖（antd-mobile 消费；无 theme API，唯一可行）
 *   dist/contrast-report.json  对比度断言结果（CI 门禁；任一 fail → exit 1）
 *
 * 设计：docs/design/system-v2.md §2–§6 + design/token-integration.md。
 * WCAG 公式内置，不引第三方色库。产物提交进仓库；CI 跑 `node build.mjs`
 * 后 `git diff --exit-code dist` 防手改产物。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(PKG, 'tokens.json');
const DIST = join(PKG, 'dist');

// ---------- WCAG ----------
const hexToRgb = (hex) => {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const srgbToLinear = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrastRatio = (a, b) => {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
};
const r2 = (n) => Math.round(n * 100) / 100;

// ---------- reference resolution ----------
// 支持两种引用：
//   "{primitive.gray-900}" / "{semantic.text.value.light}"  → 取值
//   "{semantic.brand-strong}"  → 语义层 light 档（简写）
//   "{radius.lg}" / "{shadow.card}" 等标量/对象
const tokens = JSON.parse(readFileSync(SRC, 'utf8'));

function lookup(path) {
  const parts = path.split('.');
  let node = tokens;
  for (const p of parts) {
    if (node === undefined || node === null) return undefined;
    node = node[p];
  }
  return node;
}

function resolveRef(ref) {
  const path = ref.slice(1, -1);
  let v = lookup(path);
  // "{semantic.brand-strong}" → 若该节点是语义 token，取 light 值
  if (typeof v === 'object' && v !== null && 'value' in v) v = v.value.light;
  if (typeof v === 'object' && v !== null && 'light' in v) v = v.light;
  if (typeof v === 'string' && v.startsWith('{')) return resolveRef(v);
  return v;
}

function resolveValue(v) {
  if (typeof v === 'string') {
    const m = v.match(/^\{[^}]+\}$/);
    if (m) return resolveValue(resolveRef(v));
    return v;
  }
  if (Array.isArray(v)) return v.map(resolveValue);
  if (typeof v === 'object' && v !== null) {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = resolveValue(val);
    return out;
  }
  return v;
}

// ---------- collect semantic tokens ----------
const semantic = tokens.semantic;
const semanticNames = Object.keys(semantic).filter((k) => !k.startsWith('_'));

// 需要进 CSS 的语义色（value.light / value.dark）
const cssSemantic = semanticNames
  .map((name) => ({ name, ...resolveValue(semantic[name]) }))
  .filter((t) => t.value && typeof t.value === 'object' && 'light' in t.value);

const shadowCard = resolveValue(tokens.shadow.card);
const legacy = tokens.legacyAlias; // 保持原始 {ref}，别名映射需引用名

// ---------- dist/tokens.css ----------
function buildTokensCss() {
  const lines = [];
  lines.push('/* 由 packages/design-tokens/src/build.mjs 生成，请勿手改。');
  lines.push('   单源：tokens.json；消费者：web/h5、web/console 自研 CSS。');
  lines.push('   规范名 --ms-*；末尾附旧名别名，切换零 JSX/CSS 改动。 */');
  lines.push(':root {');
  lines.push('  color-scheme: light dark;');
  lines.push('');
  lines.push('  /* 语义色 light */');
  for (const t of cssSemantic) lines.push(`  --ms-${t.name}: ${t.value.light};`);
  lines.push('');
  lines.push('  /* 字体 */');
  lines.push(`  --ms-font-sans: ${tokens.typography['font-sans']};`);
  lines.push(`  --ms-font-mono: ${tokens.typography['font-mono']};`);
  lines.push(`  --ms-font-numeric: ${tokens.typography['font-numeric']};`);
  lines.push('');
  lines.push('  /* 字号（H5） */');
  for (const [k, v] of Object.entries(tokens.typography.size)) {
    lines.push(`  --ms-font-${k}: ${v.h5};`);
  }
  lines.push('');
  lines.push('  /* 间距（8pt） */');
  for (const [k, v] of Object.entries(tokens.spacing)) {
    if (k === '_base' || typeof v !== 'string') continue;
    lines.push(`  --ms-${k}: ${v};`);
  }
  for (const [k, v] of Object.entries(tokens.spacing.h5)) {
    lines.push(`  --ms-page-${k.replace(/-/g, '-')}: ${v};`);
  }
  for (const [k, v] of Object.entries(tokens.spacing.console)) {
    lines.push(`  --ms-console-${k.replace(/-/g, '-')}: ${v};`);
  }
  lines.push('');
  lines.push('  /* 圆角（H5） */');
  lines.push(`  --ms-radius-lg: ${tokens.radius.lg.h5};`);
  lines.push(`  --ms-radius-sm: ${tokens.radius.sm.h5};`);
  lines.push(`  --ms-radius-pill: ${tokens.radius.pill};`);
  lines.push(`  --ms-radius-control: ${tokens.radius.control};`);
  lines.push('');
  lines.push('  /* 阴影（仅一档，克制） */');
  lines.push(`  --ms-shadow: ${shadowCard.light};`);
  lines.push('');
  lines.push('  /* 动效（只做状态反馈，禁涨跌闪烁/脉冲/老虎机/方向性弹跳） */');
  lines.push(`  --ms-motion-duration-fast: ${tokens.motion['duration-fast']};`);
  lines.push(`  --ms-motion-duration-base: ${tokens.motion['duration-base']};`);
  lines.push(`  --ms-motion-duration-mid: ${tokens.motion['duration-mid']};`);
  lines.push(`  --ms-motion-duration-slow: ${tokens.motion['duration-slow']};`);
  lines.push(`  --ms-easing-standard: ${tokens.motion['easing-standard']};`);
  lines.push(`  --ms-easing-emphasized: ${tokens.motion['easing-emphasized']};`);
  lines.push('');
  lines.push('  /* AI 标识 / 免责 / as_of（合规一等公民，≥13px ≥4.5:1，无关闭/折叠/透明度；视觉规格待 H3 签发） */');
  lines.push(`  --ms-ai-badge-bg: ${resolveValue(tokens.aiContent['ai-badge-bg']).value.light};`);
  lines.push(`  --ms-ai-badge-contrast: ${resolveValue(tokens.aiContent['ai-badge-contrast']).value.light};`);
  lines.push(`  --ms-ai-label-text: ${resolveValue(tokens.aiContent['ai-label-text']).value.light};`);
  lines.push(`  --ms-disclaimer-text: ${resolveValue(tokens.aiContent['disclaimer-text']).value.light};`);
  lines.push(`  --ms-as-of-text: ${resolveValue(tokens.aiContent['as-of-text']).value.light};`);
  lines.push('');
  lines.push('  /* ── 旧名别名（legacy）：生成，不手写；下一轮删除前 grep 必须为 0 ── */');
  const semanticNameSet = new Set(semanticNames);
  for (const [old, ref] of Object.entries(legacy)) {
    if (old.startsWith('_')) continue;
    const target = ref.replace(/^\{/, '').replace(/\}$/, '');
    const parts = target.split('.');
    let aliasVar;
    if (parts[0] === 'semantic' && semanticNameSet.has(parts[1])) {
      aliasVar = `--ms-${parts[1]}`;
    } else if (target === 'shadow.card') {
      aliasVar = '--ms-shadow';
    } else if (target === 'radius.lg') {
      aliasVar = '--ms-radius-lg';
    } else if (target === 'radius.sm') {
      aliasVar = '--ms-radius-sm';
    } else if (target === 'radius.pill') {
      aliasVar = '--ms-radius-pill';
    } else if (target === 'typography.font-sans') {
      aliasVar = '--ms-font-sans';
    } else if (target === 'typography.font-mono') {
      aliasVar = '--ms-font-mono';
    } else if (target === 'spacing.h5.max-width') {
      aliasVar = '--ms-page-max-width';
    } else {
      aliasVar = `--ms-${parts.join('-')}`;
    }
    lines.push(`  --${old}: var(${aliasVar});`);
  }
  lines.push('}');
  lines.push('');
  lines.push('/* 深色：统一挂 html[data-prefers-color-scheme="dark"]（antd-mobile 内建深色开关同源） */');
  lines.push('html[data-prefers-color-scheme="dark"] {');
  for (const t of cssSemantic) lines.push(`  --ms-${t.name}: ${t.value.dark};`);
  // 深色档专项覆盖：border-control 在 #131a22 上需更亮才达 3:1
  for (const t of cssSemantic) {
    if (t.darkOverride) lines.push(`  --ms-${t.name}: ${t.darkOverride};`);
  }
  lines.push(`  --ms-shadow: ${shadowCard.dark};`);
  lines.push(`  --ms-ai-badge-bg: ${resolveValue(tokens.aiContent['ai-badge-bg']).value.dark};`);
  lines.push(`  --ms-ai-label-text: ${resolveValue(tokens.aiContent['ai-label-text']).value.dark};`);
  lines.push(`  --ms-disclaimer-text: ${resolveValue(tokens.aiContent['disclaimer-text']).value.dark};`);
  lines.push(`  --ms-as-of-text: ${resolveValue(tokens.aiContent['as-of-text']).value.dark};`);
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

// ---------- dist/antd-theme.mjs ----------
function buildAntdTheme() {
  const a = resolveValue(tokens.component.antd);
  const dark = (v) => {
    const ref = v.match(/^\{semantic\.([\w-]+)\.value\.light\}$/);
    if (ref) {
      const t = resolveValue(semantic[ref[1]]);
      return t.value.dark;
    }
    return v;
  };
  const darkToken = {};
  for (const [k, v] of Object.entries(a)) {
    if (k.startsWith('_')) continue;
    if (typeof v === 'string') darkToken[k] = dark(v);
    else darkToken[k] = v;
  }
  // 显式覆盖算法派生色（不依赖算法再算一遍）
  Object.assign(darkToken, {
    colorPrimary: resolveValue(semantic['brand-strong']).value.dark,
    colorLink: resolveValue(semantic['brand-strong']).value.dark,
    colorError: resolveValue(semantic['danger-text']).value.dark,
    colorSuccess: resolveValue(semantic['success-text']).value.dark,
    colorInfo: resolveValue(semantic['brand-strong']).value.dark,
    colorText: resolveValue(semantic.text).value.dark,
    colorTextSecondary: resolveValue(semantic['text-muted']).value.dark,
    colorTextTertiary: resolveValue(semantic['text-muted']).value.dark,
    colorTextQuaternary: resolveValue(semantic['text-disabled']).value.dark,
    colorBgBase: '#0b0f14',
    colorBgLayout: resolveValue(semantic.bg).value.dark,
    colorBgContainer: resolveValue(semantic.surface).value.dark,
    colorBorder: resolveValue(semantic.border).value.dark,
    colorBorderSecondary: resolveValue(semantic['surface-2']).value.dark,
  });

  const controls = ['Input', 'Select', 'DatePicker', 'InputNumber'];
  const components = {
    Layout: { headerBg: '#ffffff', siderBg: '#ffffff', bodyBg: a.colorBgLayout, headerHeight: 56 },
    Menu: { itemHeight: 40, itemSelectedBg: resolveValue(semantic['brand-weak']).value.light, itemSelectedColor: a.colorPrimary, itemActiveBg: a.colorBorderSecondary, itemBorderRadius: 6 },
    Table: { headerBg: a.colorBgLayout, rowHoverBg: '#f0f4f8', cellPaddingBlock: 12, borderColor: a.colorBorderSecondary, headerSplitColor: 'transparent' },
    Button: { fontWeight: 500, primaryShadow: 'none', defaultShadow: 'none', dangerShadow: 'none' },
    Modal: { titleColor: a.colorText, contentBg: '#ffffff', headerBg: '#ffffff' },
    Breadcrumb: { itemColor: a.colorTextSecondary, lastItemColor: a.colorText },
    Pagination: { itemSize: 32, itemActiveBg: resolveValue(semantic['brand-weak']).value.light },
  };
  for (const c of controls) components[c] = { colorBorder: tokens.component.antd._inputBorder ? resolveValue(tokens.component.antd._inputBorder) : '#8a929c' };

  const darkComponents = JSON.parse(JSON.stringify(components));
  const darkControlBorder = resolveValue(semantic['border-control']).darkOverride || resolveValue(semantic['border-control']).value.dark;
  for (const c of controls) darkComponents[c] = { colorBorder: darkControlBorder };

  const L = [];
  L.push('// 由 packages/design-tokens/src/build.mjs 生成，请勿手改。');
  L.push('// 中后台（antd 5）消费：console 根节点 <ConfigProvider theme={lightTheme}>。');
  L.push('// 静态方法 message/Modal.confirm 拿不到 theme，必须用 App.useApp()。');
  L.push("import { theme as antdTheme } from 'antd';");
  L.push('');
  L.push('export const lightTheme = {');
  L.push('  cssVar: true,');
  L.push('  hashed: false,');
  L.push('  token: ' + JSON.stringify(a, (k, v) => (k.startsWith("_") ? undefined : v), 2).replace(/"([^"]+)":/g, "$1:") + ',');
  L.push('  components: ' + JSON.stringify(components, null, 2) + ',');
  L.push('};');
  L.push('');
  L.push('export const darkTheme = {');
  L.push('  ...lightTheme,');
  L.push('  algorithm: antdTheme.darkAlgorithm,');
  L.push('  token: ' + JSON.stringify(darkToken, null, 2).replace(/"([^"]+)":/g, "$1:") + ',');
  L.push('  components: ' + JSON.stringify(darkComponents, null, 2) + ',');
  L.push('};');
  L.push('');
  L.push('export default { lightTheme, darkTheme };');
  L.push('');
  return L.join('\n');
}

// ---------- dist/adm-tokens.css ----------
function buildAdmTokens() {
  const adm = resolveValue(tokens.component.adm);
  const lines = [];
  lines.push('/* 由 packages/design-tokens/src/build.mjs 生成，请勿手改。');
  lines.push('   C 端（antd-mobile 5.43）消费：无 theme API，--adm-* 覆盖是唯一主题方式。');
  lines.push('   必须在 antd-mobile 全局样式之后 import（后导入者胜）。');
  lines.push('   顺序：antd-mobile/es/global → tokens.css → adm-tokens.css → app.css */');
  lines.push(':root {');
  for (const [k, v] of Object.entries(adm)) {
    if (k.startsWith('_')) continue;
    // 组件级变量映射到 --ms-* 的，用 var() 保持单源；纯值直出
    const mapToMs = {
      'color-primary': '--ms-brand-strong',
      'color-success': '--ms-success-text',
      'color-danger': '--ms-danger-text',
      'color-text': '--ms-text',
      'color-text-secondary': '--ms-text-muted',
      'color-weak': '--ms-text-muted',
      'color-light': '--ms-border-strong',
      'color-border': '--ms-border',
      'color-background': '--ms-surface',
      'color-box': '--ms-bg',
      'radius-m': '--ms-radius-sm',
      'radius-l': '--ms-radius-lg',
      'font-family': '--ms-font-sans',
      'font-size-main': '--ms-font-body',
    };
    if (mapToMs[k]) lines.push(`  --adm-${k}: var(${mapToMs[k]});`);
    else lines.push(`  --adm-${k}: ${v};`);
  }
  lines.push('}');
  lines.push('');
  lines.push('html[data-prefers-color-scheme="dark"] {');
  lines.push('  --adm-color-primary: var(--ms-brand);');
  lines.push('  --adm-color-text: var(--ms-text);');
  lines.push('  --adm-color-text-secondary: var(--ms-text-muted);');
  lines.push('  --adm-color-weak: var(--ms-text-muted);');
  lines.push('  --adm-color-background: var(--ms-surface);');
  lines.push('  --adm-color-box: var(--ms-bg);');
  lines.push('  --adm-color-border: var(--ms-border);');
  lines.push('  --adm-color-danger: var(--ms-danger-text);');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

// ---------- dist/contrast-report.json ----------
// surface-dark：深色卡片底 #131a22，用于深色档非文本断言
const SURFACES = {
  light: { surface: resolveValue(semantic.surface).value.light, bg: resolveValue(semantic.bg).value.light, 'surface-2': resolveValue(semantic['surface-2']).value.light },
  dark: { surface: resolveValue(semantic.surface).value.dark, bg: resolveValue(semantic.bg).value.dark, 'surface-2': resolveValue(semantic['surface-2']).value.dark },
};

function buildContrastReport() {
  const results = [];
  for (const t of cssSemantic) {
    const c = t.contrast;
    if (!c || c.min === 0 || !c.against || c.against.length === 0) continue;
    for (const mode of ['light', 'dark']) {
      const fg = t.value[mode];
      for (const bgName of c.against) {
        const bg = SURFACES[mode][bgName];
        if (!bg) continue;
        const effFg = mode === 'dark' && t.darkOverride ? t.darkOverride : fg;
        const ratio = r2(contrastRatio(effFg, bg));
        const min = mode === 'dark' && c.kind === 'text' ? c.min : c.min;
        const pass = ratio >= min;
        results.push({
          token: `--ms-${t.name}`, mode, fg, against: bgName, bg, ratio, min,
          kind: c.kind, pass,
          note: c.note || undefined,
        });
      }
    }
  }
  // 黑名单回归：必须失败的组合（token-integration.md §7.2）
  const blacklist = [
    ['#00a854', '#ffffff', 3.12], ['#00a854', '#e6f6ec', 2.79], ['#00804a', '#e6f6ec', 4.48],
    ['#d92b20', '#fdecea', 4.25], ['#e63e31', '#ffffff', 4.12], ['#1677ff', '#e8f1ff', 3.61],
    ['#6b7280', '#f4f6f8', 4.46], ['#6b7280', '#eef1f5', 4.27], ['#999999', '#ffffff', 2.85],
    ['#8c8c8c', '#ffffff', 3.36], ['#d7dde5', '#ffffff', 1.37], ['#808080', '#1a1a1a', 4.41],
  ];
  const blacklistResults = blacklist.map(([fg, bg, expected]) => {
    const ratio = r2(contrastRatio(fg, bg));
    return { fg, bg, ratio, expected, match: Math.abs(ratio - expected) <= 0.05 };
  });
  const failed = results.filter((r) => !r.pass);
  const blMismatch = blacklistResults.filter((r) => !r.match);
  return {
    generatedAt: new Date().toISOString(),
    source: 'tokens.json',
    wcag: tokens.$meta.wcag,
    summary: {
      total: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      blacklistChecked: blacklistResults.length,
      blacklistMismatch: blMismatch.length,
    },
    results,
    failed,
    blacklistRegression: { expected: '全部 match=true（证明断言能抓到违规）', results: blacklistResults, mismatch: blMismatch },
  };
}

// ---------- main ----------
function main() {
  if (!existsSync(SRC)) {
    console.error(`[design-tokens] 未找到单源 ${SRC}`);
    process.exit(1);
  }
  mkdirSync(DIST, { recursive: true });
  const files = {
    'tokens.css': buildTokensCss(),
    'antd-theme.mjs': buildAntdTheme(),
    'adm-tokens.css': buildAdmTokens(),
  };
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(DIST, name), content);
    console.log(`[design-tokens] 生成 dist/${name}（${Buffer.byteLength(content)} bytes）`);
  }
  const report = buildContrastReport();
  writeFileSync(join(DIST, 'contrast-report.json'), JSON.stringify(report, null, 2) + '\n');
  const { summary } = report;
  console.log(`[design-tokens] 对比度断言：${summary.passed}/${summary.total} pass，黑名单回归 ${summary.blacklistChecked} 组 mismatch=${summary.blacklistMismatch}`);
  if (summary.failed > 0) {
    console.error('[design-tokens] FAIL：以下语义 token 不达标 ——');
    for (const f of summary.failed ? report.failed : []) {
      console.error(`  ${f.token}(${f.mode}) 对 ${f.against}: ${f.ratio} < ${f.min}`);
    }
    process.exit(1);
  }
  if (summary.blacklistMismatch > 0) {
    console.error('[design-tokens] FAIL：黑名单回归比值与预期不符（WCAG 公式或色值漂移）——');
    for (const m of report.blacklistRegression.mismatch) {
      console.error(`  ${m.fg}/${m.bg}: got ${m.ratio} expected ${m.expected}`);
    }
    process.exit(1);
  }
  console.log('[design-tokens] PASS');
}

main();