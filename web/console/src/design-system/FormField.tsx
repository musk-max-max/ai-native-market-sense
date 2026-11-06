import type { ConfigFieldDef, ConfigValue, ValidationIssue } from '../domain/types';
import { TESTIDS } from '../lib/testids';

export interface FormFieldProps {
  field: ConfigFieldDef;
  value: ConfigValue | undefined;
  onChange: (value: ConfigValue) => void;
  issues?: readonly ValidationIssue[];
  disabled?: boolean;
}

function controlValue(value: ConfigValue | undefined): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.join('\n');
  return String(value);
}

/** 配置字段控件（enum/boolean/number/text/string-list 共用一套）。 */
export function FormField({ field, value, onChange, issues = [], disabled = false }: FormFieldProps) {
  const fieldIssues = issues.filter((issue) => issue.field === field.key);
  const invalid = fieldIssues.length > 0;
  const describedBy = `field-help-${field.key}${invalid ? ` field-error-${field.key}` : ''}`;
  const inputId = `field-${field.key}`;

  return (
    <div className={`c-field${invalid ? ' is-error' : ''}`} data-testid={TESTIDS.formField(field.key)}>
      <label className="c-field-label" htmlFor={inputId}>
        {field.label}
        {field.required ? <span className="c-field-required" aria-hidden="true">*</span> : null}
      </label>

      {field.kind === 'boolean' ? (
        <label className="c-row">
          <input
            id={inputId}
            type="checkbox"
            checked={value === true}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked)}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
          />
          <span>{value === true ? '开启' : '关闭'}</span>
        </label>
      ) : field.kind === 'enum' ? (
        <select
          id={inputId}
          className="c-select"
          value={controlValue(value)}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
        >
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : field.kind === 'number' ? (
        <input
          id={inputId}
          className="c-input"
          type="number"
          inputMode="numeric"
          value={controlValue(value)}
          disabled={disabled}
          min={field.min}
          max={field.max}
          step={field.integer ? 1 : 'any'}
          onChange={(event) => {
            const raw = event.target.value;
            onChange(raw === '' ? null : Number(raw));
          }}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
        />
      ) : field.kind === 'string-list' ? (
        <textarea
          id={inputId}
          className="c-textarea"
          rows={4}
          value={controlValue(value)}
          disabled={disabled}
          onChange={(event) =>
            onChange(
              event.target.value
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.length > 0),
            )
          }
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
        />
      ) : (
        <input
          id={inputId}
          className="c-input"
          type="text"
          value={controlValue(value)}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
        />
      )}

      <div className="c-field-help" id={`field-help-${field.key}`}>
        {field.help}
      </div>
      {fieldIssues.map((issue) => (
        <div key={`${issue.code}-${issue.message}`} className="c-field-error" id={`field-error-${field.key}`} data-testid={TESTIDS.formError(field.key)}>
          {issue.message}
        </div>
      ))}
    </div>
  );
}
