import type { ConfigFieldDef, ConfigItemDef, ConfigValue, ConfigValues, ValidationIssue } from './types';

/**
 * 草稿校验（状态机「校验」一步）：类型/范围/必填/枚举/交叉字段。
 * 与 H5 不同，中后台的校验必须可被审批人复核，所以每条 issue 都带 field + code。
 */

function issue(code: string, message: string, field?: string): ValidationIssue {
  return { severity: 'error', code, message, field };
}

function validateField(field: ConfigFieldDef, value: ConfigValue | undefined): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (value === undefined || value === null || value === '') {
    if (field.required) {
      return [issue('required', `${field.label} 不能为空`, field.key)];
    }
    return issues;
  }

  switch (field.kind) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        issues.push(issue('type', `${field.label} 必须是数字`, field.key));
        break;
      }
      if (field.integer && !Number.isInteger(value)) {
        issues.push(issue('integer', `${field.label} 必须是整数`, field.key));
      }
      if (field.min !== undefined && value < field.min) {
        issues.push(issue('min', `${field.label} 不能小于 ${field.min}`, field.key));
      }
      if (field.max !== undefined && value > field.max) {
        issues.push(issue('max', `${field.label} 不能大于 ${field.max}`, field.key));
      }
      break;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        issues.push(issue('type', `${field.label} 必须是布尔值`, field.key));
      }
      break;
    }
    case 'enum': {
      if (typeof value !== 'string' || !(field.options ?? []).includes(value)) {
        issues.push(issue('enum', `${field.label} 的值不在允许范围内`, field.key));
      }
      break;
    }
    case 'text': {
      if (typeof value !== 'string') {
        issues.push(issue('type', `${field.label} 必须是文本`, field.key));
        break;
      }
      const prefixes = field.allowedPrefixes ?? [];
      if (prefixes.length > 0 && !prefixes.some((prefix) => value.startsWith(prefix))) {
        issues.push(
          issue('prefix', `${field.label} 必须以 ${prefixes.join(' 或 ')} 开头`, field.key),
        );
      }
      break;
    }
    case 'string-list': {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry === '')) {
        issues.push(issue('type', `${field.label} 必须是非空文本列表`, field.key));
      }
      break;
    }
    default: {
      const neverField: never = field.kind;
      issues.push(issue('unknown-kind', `未知字段类型 ${String(neverField)}`, field.key));
    }
  }

  return issues;
}

function parseTime(value: ConfigValue | undefined): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

export function validateValues(item: ConfigItemDef, values: ConfigValues): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const field of item.fields) {
    issues.push(...validateField(field, values[field.key]));
  }

  const hasStartEnd = item.fields.some((field) => field.key === 'start_at');
  if (hasStartEnd) {
    const start = parseTime(values['start_at']);
    const end = parseTime(values['end_at']);
    if (start === null) {
      issues.push(issue('datetime', '生效开始时间必须是合法 ISO8601 时间', 'start_at'));
    }
    if (end === null) {
      issues.push(issue('datetime', '生效结束时间必须是合法 ISO8601 时间', 'end_at'));
    }
    if (start !== null && end !== null && end <= start) {
      issues.push(issue('window', '生效结束时间必须晚于开始时间', 'end_at'));
    }
  }

  if (item.fields.some((field) => field.key === 'hot_threshold')) {
    const hot = values['hot_threshold'];
    const cold = values['cold_threshold'];
    if (typeof hot === 'number' && typeof cold === 'number' && hot <= cold) {
      issues.push(issue('threshold', '过热阈值必须大于过冷阈值', 'hot_threshold'));
    }
  }

  return issues;
}

export function hasBlockingIssues(issues: readonly ValidationIssue[]): boolean {
  return issues.some((entry) => entry.severity === 'error');
}
