/**
 * /healthz 的「数据就绪」贡献值（A3 域职责，Lead 2026-11-04 派单）。
 *
 * 语义（tests/e2e/docs/INGEST-ONCE-CONTRACT.md §4/§5）：
 *  - 栈起不来 ≠ 数据没进来。进程存活由 shell 的 /healthz 200 表达；本模块只回答「数据是否就绪」。
 *  - 数据来源是 ingest-once 产出的 `ingest-report.json`（path 由 INGEST_REPORT_PATH 指定）。
 *  - 报告缺失/损坏时 data_ready=false + 对应 reason，绝不抛错、绝不让 /healthz 500。
 *
 * 字段契约（A12 preflight 直接比对）：
 *  - data_ready: boolean，必现；
 *  - data_ready_reason: 仅 data_ready=false 时出现（true 时出现会被判 CONTRADICTION）；
 *  - data_quality: green|yellow|red，报告可读时出现。
 */

import { readFile } from 'node:fs/promises';

export type QualityLevel = 'green' | 'yellow' | 'red';

export interface DataReadiness {
  readonly data_ready: boolean;
  readonly data_ready_reason?: string;
  readonly data_quality?: QualityLevel;
}

export interface IngestReport {
  readonly schema_version: 1;
  readonly ready: boolean;
  readonly failed_step: 'ingest' | 'load' | 'quality' | null;
  readonly failed_reason: string | null;
  readonly quality_level: QualityLevel;
}

export const DEFAULT_INGEST_REPORT_PATH = '/state/ingest-report.json';
export const INGEST_REPORT_SCHEMA_VERSION = 1;

const QUALITY_LEVELS: readonly QualityLevel[] = ['green', 'yellow', 'red'];
const FAILED_STEPS = ['ingest', 'load', 'quality'] as const;
const FAILED_REASON_PATTERN = /^INGEST_FAILED:(ingest|load|quality)(?::[A-Z0-9_]+)?$/;

export function resolveIngestReportPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.INGEST_REPORT_PATH?.trim();
  return configured === undefined || configured === '' ? DEFAULT_INGEST_REPORT_PATH : configured;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 把报告 JSON 解析成强类型；任何与 §3 契约不一致都返回 null（由调用方判 INVALID）。 */
export function parseIngestReport(text: string): IngestReport | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  if (raw.schema_version !== INGEST_REPORT_SCHEMA_VERSION) return null;
  if (typeof raw.ready !== 'boolean') return null;

  const failedStep = raw.failed_step ?? null;
  if (failedStep !== null && !(FAILED_STEPS as readonly unknown[]).includes(failedStep)) return null;

  const quality = raw.quality_level;
  if (typeof quality !== 'string' || !(QUALITY_LEVELS as readonly string[]).includes(quality)) return null;

  const failedReason = raw.failed_reason ?? null;
  if (failedReason !== null && (typeof failedReason !== 'string' || failedReason === '')) return null;

  // 报告自相矛盾（ready=true 却带失败步骤/红质量/failed_reason）视为损坏：
  // 这与 preflight 的 CONTRADICTION 判定同源，宁可报 INVALID 也不让页面带病放行。
  if (raw.ready === true) {
    if (failedStep !== null || failedReason !== null || quality === 'red') return null;
  } else if (failedStep === null) {
    return null;
  }

  return {
    schema_version: INGEST_REPORT_SCHEMA_VERSION,
    ready: raw.ready,
    failed_step: failedStep as IngestReport['failed_step'],
    failed_reason: failedReason,
    quality_level: quality as QualityLevel,
  };
}

function readinessFromReport(report: IngestReport): DataReadiness {
  if (report.ready) {
    return { data_ready: true, data_quality: report.quality_level };
  }
  if (report.quality_level === 'red') {
    return { data_ready: false, data_ready_reason: 'QUALITY_RED', data_quality: 'red' };
  }
  const reason =
    report.failed_reason !== null && FAILED_REASON_PATTERN.test(report.failed_reason)
      ? report.failed_reason
      : `INGEST_FAILED:${report.failed_step ?? 'ingest'}`;
  return { data_ready: false, data_ready_reason: reason, data_quality: report.quality_level };
}

/**
 * 读取就绪报告；任何 IO/解析错误都收敛为 data_ready=false，不向上抛（/healthz 必须 200）。
 */
export async function readDataReadiness(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DataReadiness> {
  const path = resolveIngestReportPath(env);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { data_ready: false, data_ready_reason: 'INGEST_REPORT_MISSING' };
    return { data_ready: false, data_ready_reason: 'INGEST_REPORT_INVALID' };
  }
  const report = parseIngestReport(text);
  if (report === null) return { data_ready: false, data_ready_reason: 'INGEST_REPORT_INVALID' };
  return readinessFromReport(report);
}

export type HealthContribution = () => Promise<Record<string, unknown>>;

/** 绑定到某份 env 的就绪读取器（插件创建时确定，测试可传临时路径）。 */
export function createDataReadinessContribution(
  env: NodeJS.ProcessEnv = process.env,
): HealthContribution {
  return async () => ({ ...(await readDataReadiness(env)) });
}

/**
 * 域健康贡献 = 数据就绪（data_ready/data_ready_reason/data_quality）+ 授权判定状态。
 * H4 m00808：`data_ready`（数据没进来）与 `entitlement_degraded`（授权判不了）是两个维度，
 * A12 preflight 需要能区分；本函数永不抛错（/healthz 必须 200）。
 */
export interface EntitlementHealthStatus {
  readonly degraded: boolean;
  readonly reason?: string;
}

export function createMarketHealthContribution(
  env: NodeJS.ProcessEnv = process.env,
  entitlementStatus?: () => EntitlementHealthStatus,
): HealthContribution {
  return async () => {
    const readiness = await readDataReadiness(env);
    const status = entitlementStatus?.();
    return {
      ...readiness,
      entitlement_degraded: status?.degraded ?? false,
      ...(status?.reason !== undefined ? { entitlement_degraded_reason: status.reason } : {}),
    };
  };
}
