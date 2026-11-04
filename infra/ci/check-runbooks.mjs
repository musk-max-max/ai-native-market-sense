/**
 * market-sense-h5 · 告警 ↔ runbook 绑定门禁
 *
 * 硬规则（A13 system_prompt 规则 ②）：每条告警必须绑 runbook；无 runbook 不许上线。
 * 本脚本把这条规则变成 CI 门禁：
 *   1. docs/runbook/*.md 必须包含六段：症状 / 影响 / 判断 / 止血 / 升级 / 复盘。
 *   2. infra/monitoring/alerts/*.yaml 中每条 alert 必须有 annotations.runbook_url，
 *      且指向存在的 runbook 文件（fragment 尽量校验）。
 *   3. 告警 labels.severity 必须属于 critical|warning|info；必须带 slo 或 service 之一。
 *   4. SLO 目录（infra/monitoring/slo.yaml）中每个 SLO 必须给出 runbook；
 *      告警引用的 slo id 必须在目录中存在。
 *   5. AI 四项监控（token 成本 / 输出异常率 / 人工接管率 / 模型漂移）必须各有告警，
 *      通过 annotations.ai_signal 标记。
 *   6. C2=A 专项：必须有「页面未标 stale 但数据已超 15min」的可检测告警（StalePageNotMarked）。
 *   7. S0 至少 3 篇 runbook。
 *
 * 空仓（既无 runbook 也无告警）→ skip；只有一边存在 → 失败（否则会半上线）。
 *
 * 用法：node infra/ci/check-runbooks.mjs [--json]
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from './lib/mini-yaml.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNBOOK_DIR = join(ROOT, 'docs', 'runbook');
const ALERT_DIR = join(ROOT, 'infra', 'monitoring', 'alerts');
const SLO_FILE = join(ROOT, 'infra', 'monitoring', 'slo.yaml');
const REQUIRED_SECTIONS = ['症状', '影响', '判断', '止血', '升级', '复盘'];
const SEVERITIES = new Set(['critical', 'warning', 'info']);
const AI_SIGNALS = ['token_cost', 'output_anomaly', 'human_takeover', 'model_drift'];

function listFiles(dir, filter) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && filter(entry.name))
      .map((entry) => join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function readYaml(file) {
  try {
    return parseYaml(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file}: YAML 解析失败：${error.message}`);
  }
}

function sectionPresent(markdown, section) {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^#{1,4}\\s*(?:\\d+[.、)]\\s*)?${escaped}`, 'm');
  const bold = new RegExp(`^\\*\\*${escaped}\\*\\*`, 'm');
  const inline = new RegExp(`${escaped}[:：]`, 'm');
  return heading.test(markdown) || bold.test(markdown) || inline.test(markdown);
}

function githubSlug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

function anchorExists(markdown, fragment) {
  if (!fragment) return true;
  let decoded = fragment;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    /* 保留原样 */
  }
  if (~decoded.indexOf('%')) return true; // 复杂编码，跳过精确校验
  const headings = [...markdown.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => githubSlug(match[1]));
  return headings.includes(decoded.toLowerCase());
}

function runbookPathFromUrl(url) {
  if (!url) return null;
  const text = String(url).trim();
  if (/^https?:\/\//.test(text)) {
    const match = text.match(/\/blob\/[^/]+\/(.+?)(?:#.*)?$/);
    return match ? match[1] : null;
  }
  return text;
}

function collectRunbooks() {
  const files = listFiles(RUNBOOK_DIR, (name) => name.endsWith('.md') && name !== 'README.md');
  return files.map((file) => ({
    file,
    name: file.slice(ROOT.length + 1),
    markdown: readFileSync(file, 'utf8'),
  }));
}

function collectAlerts() {
  const alerts = [];
  const files = listFiles(ALERT_DIR, (name) => name.endsWith('.yaml') || name.endsWith('.yml'));
  for (const file of files) {
    const doc = readYaml(file);
    const groups = Array.isArray(doc?.groups) ? doc.groups : [];
    for (const group of groups) {
      for (const rule of Array.isArray(group?.rules) ? group.rules : []) {
        if (rule.alert) {
          alerts.push({ ...rule, group: group.name, file: file.slice(ROOT.length + 1) });
        }
      }
    }
  }
  return { alerts, files };
}

function main() {
  const runbooks = collectRunbooks();
  const { alerts, files: alertFiles } = collectAlerts();
  const errors = [];
  const warnings = [];
  const info = [];

  if (runbooks.length === 0 && alertFiles.length === 0) {
    console.log('⏭ 告警/runbook 门禁 skipped：runbook 与告警规则都还不存在（空仓阶段）');
    return;
  }

  if (runbooks.length < 3) {
    errors.push(
      `runbook 只有 ${runbooks.length} 篇，S0 验收要求 ≥3 篇（数据源不可用/发布回滚/质量分红灯）`,
    );
  }

  const runbookIndex = new Map();
  for (const runbook of runbooks) {
    const missing = REQUIRED_SECTIONS.filter(
      (section) => !sectionPresent(runbook.markdown, section),
    );
    if (missing.length > 0) {
      errors.push(
        `${runbook.name}: 缺少必备段落 ${missing.join('、')}（症状/影响/判断/止血/升级/复盘）`,
      );
    }
    if (!/^#\s+/m.test(runbook.markdown)) {
      errors.push(`${runbook.name}: 缺少一级标题（# 标题）`);
    }
    runbookIndex.set(runbook.name, runbook);
  }

  const referencedRunbooks = new Set();
  const alertNames = new Set();
  for (const alert of alerts) {
    const label = `${alert.file}#${alert.group}/${alert.alert}`;
    if (alertNames.has(alert.alert)) errors.push(`重复告警名：${alert.alert}`);
    alertNames.add(alert.alert);
    if (!SEVERITIES.has(alert.labels?.severity)) {
      errors.push(`${label}: labels.severity 缺失或非法（需 critical|warning|info）`);
    }
    if (!alert.labels?.slo && !alert.labels?.service) {
      errors.push(`${label}: labels 必须至少包含 slo 或 service，便于路由与看板聚合`);
    }
    const url = alert.annotations?.runbook_url;
    if (!url) {
      errors.push(`${label}: 缺少 annotations.runbook_url（硬规则：无 runbook 不许上线）`);
      continue;
    }
    if (!alert.annotations?.summary) errors.push(`${label}: 缺少 annotations.summary`);
    const path = runbookPathFromUrl(url);
    if (!path) {
      errors.push(`${label}: runbook_url 无法解析（${url}）`);
      continue;
    }
    const [filePath, fragment] = path.split('#');
    const target = join(ROOT, filePath);
    if (!existsSync(target)) {
      errors.push(`${label}: runbook_url 指向不存在的文件 ${filePath}`);
      continue;
    }
    referencedRunbooks.add(filePath);
    const runbook = runbookIndex.get(filePath);
    if (runbook && fragment && !anchorExists(runbook.markdown, fragment)) {
      warnings.push(`${label}: runbook_url fragment #${fragment} 未匹配到标题（检查过时链接）`);
    }
  }

  if (alertFiles.length > 0 && alerts.length === 0) {
    errors.push(
      `存在告警规则文件但解析出 0 条 alert：${alertFiles.map((f) => f.slice(ROOT.length + 1)).join(', ')}`,
    );
  }

  // SLO 目录校验
  let sloIds = new Set();
  if (existsSync(SLO_FILE)) {
    const sloDoc = readYaml(SLO_FILE);
    const slos = Array.isArray(sloDoc?.slos) ? sloDoc.slos : [];
    if (slos.length === 0) errors.push('infra/monitoring/slo.yaml: slos 数组为空');
    for (const slo of slos) {
      if (!slo.id) {
        errors.push('infra/monitoring/slo.yaml: 存在缺少 id 的 SLO');
        continue;
      }
      if (sloIds.has(slo.id)) errors.push(`infra/monitoring/slo.yaml: SLO id 重复 ${slo.id}`);
      sloIds.add(slo.id);
      if (!slo.runbook) {
        errors.push(`SLO ${slo.id}: 缺少 runbook 字段`);
      } else if (!existsSync(join(ROOT, runbookPathFromUrl(slo.runbook).split('#')[0]))) {
        errors.push(`SLO ${slo.id}: runbook 文件不存在 ${slo.runbook}`);
      }
      if (!slo.target) errors.push(`SLO ${slo.id}: 缺少 target`);
      if (!slo.indicator) errors.push(`SLO ${slo.id}: 缺少 indicator（可计算指标）`);
    }
    const expected = [
      'availability_trading',
      'availability_offhours',
      'quote_latency',
      'asof_freshness',
      'agent_first_token',
      'agent_anomaly_rate',
      'agent_takeover_rate',
      'gray_stage_dwell',
      'rollback_duration',
    ];
    for (const id of expected) {
      if (!sloIds.has(id)) errors.push(`SLO 目录缺少约定的 SLO：${id}`);
    }
    for (const alert of alerts) {
      if (alert.labels?.slo && !sloIds.has(alert.labels.slo)) {
        errors.push(`${alert.file}#${alert.alert}: labels.slo=${alert.labels.slo} 不在 SLO 目录中`);
      }
    }
  } else if (alerts.length > 0) {
    errors.push('infra/monitoring/slo.yaml 不存在，告警却已上线');
  }

  // AI 四项
  const aiSignalsFound = new Set(
    alerts.map((alert) => alert.annotations?.ai_signal).filter(Boolean),
  );
  for (const signal of AI_SIGNALS) {
    if (!aiSignalsFound.has(signal)) {
      errors.push(`缺少 AI 监控项「${signal}」的告警（annotations.ai_signal=${signal}）`);
    }
  }

  // C2=A 专项
  if (alerts.length > 0 && !alerts.some((alert) => alert.alert === 'StalePageNotMarked')) {
    errors.push(
      '缺少 StalePageNotMarked 告警（C2=A 要求可检测「页面未标 stale 但数据已超 15min」）',
    );
  }

  for (const runbook of runbooks) {
    if (!referencedRunbooks.has(runbook.name))
      info.push(`${runbook.name}: 尚未被任何告警引用（可接受，演练/兜底手册）`);
  }

  for (const line of info) console.log(`ℹ ${line}`);
  for (const line of warnings) console.warn(`⚠ ${line}`);
  if (errors.length > 0) {
    console.error(`\n❌ 告警/runbook 门禁失败（${errors.length} 项）：`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(
    `\n✅ 告警/runbook 门禁通过：${runbooks.length} 篇 runbook，${alerts.length} 条告警，全部绑定 runbook；AI 四项 + StalePageNotMarked 齐备`,
  );
}

main();
