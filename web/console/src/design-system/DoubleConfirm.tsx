import { useEffect, useState } from 'react';
import type { ImpactItem } from '../domain/types';
import { ImpactPanel } from './ImpactPanel';
import { TESTIDS } from '../lib/testids';

export interface DoubleConfirmProps {
  open: boolean;
  title: string;
  description: string;
  /** 第二步需要手动输入的确认词（如「发布」「回滚」）。 */
  confirmWord: string;
  impacts?: readonly ImpactItem[];
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * 危险操作二次确认（硬约束：危险操作 = 批量删、全量发布、回滚）。
 * 第一步核对影响面，第二步必须手动输入确认词，避免误点。
 */
export function DoubleConfirm({
  open,
  title,
  description,
  confirmWord,
  impacts = [],
  busy = false,
  onCancel,
  onConfirm,
}: DoubleConfirmProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [text, setText] = useState('');

  useEffect(() => {
    if (open) {
      setStep(1);
      setText('');
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="c-modal-overlay">
      <div className="c-modal" role="dialog" aria-modal="true" aria-labelledby="double-confirm-title" data-testid={TESTIDS.doubleConfirm}>
        <h2 id="double-confirm-title">{title}</h2>
        <p className="c-muted">{description}</p>

        {step === 1 ? (
          <div className="c-modal-body">
            <ImpactPanel impacts={impacts} title="影响面（请逐条核对）" />
            <div className="c-alert is-warning">
              这一步只是核对影响面，下一步还需要手动输入确认词「{confirmWord}」。
            </div>
          </div>
        ) : (
          <div className="c-modal-body">
            <div className="c-alert is-danger">
              确认后将立即生效，并写入不可变 release 与审计日志。
            </div>
            <label className="c-field">
              <span className="c-field-label">
                请输入「{confirmWord}」以确认执行
              </span>
              <input
                className="c-input"
                value={text}
                autoFocus
                onChange={(event) => setText(event.target.value)}
                data-testid={TESTIDS.doubleConfirmInput}
              />
            </label>
          </div>
        )}

        <div className="c-modal-actions">
          <button type="button" className="c-btn" onClick={onCancel} data-testid={TESTIDS.doubleConfirmCancel}>
            取消
          </button>
          {step === 1 ? (
            <button
              type="button"
              className="c-btn is-primary"
              onClick={() => setStep(2)}
              data-testid={TESTIDS.doubleConfirmNext}
            >
              我已核对影响面，继续
            </button>
          ) : (
            <button
              type="button"
              className="c-btn is-danger"
              disabled={text !== confirmWord || busy}
              onClick={onConfirm}
              data-testid={TESTIDS.doubleConfirmSubmit}
            >
              {busy ? '执行中…' : '确认执行'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
