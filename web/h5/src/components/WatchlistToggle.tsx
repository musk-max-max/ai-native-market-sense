/**
 * 自选开关。
 *
 * E2E 交接（A12）：toggle 为 aria-pressed 双态；状态文案节点包含「已自选」；
 * 点击后调用 API（幂等 POST/DELETE），刷新后仍能从服务端读回。
 * 未登录/无 token 时不伪造成功状态，只提示登录后可用。
 *
 * 合规（H3）：所有用户可见文案来自 lib/copy.ts；错误不展示内部状态码/错误码。
 */
import { useCallback, useEffect, useState } from 'react';
import { gateway } from '../data';
import { readAuthToken } from '../lib/auth';
import { copy } from '../lib/copy';
import { TID } from '../lib/testids';

type WatchlistUi =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'error' }
  | { status: 'ready'; inWatchlist: boolean };

interface ToggleState {
  ui: WatchlistUi;
  pending: boolean;
  notice: string | null;
}

export function WatchlistToggle({ instrumentId }: { instrumentId: string }) {
  const [state, setState] = useState<ToggleState>({
    ui: { status: 'loading' },
    pending: false,
    notice: null,
  });

  useEffect(() => {
    let alive = true;
    setState({ ui: { status: 'loading' }, pending: false, notice: null });
    // 未登录时不发请求：避免匿名用户每次打开个股页都产生一条注定失败的请求，
    // 也不把「无 token」伪装成服务端返回的匿名态。
    if (!readAuthToken()) {
      setState({ ui: { status: 'anonymous' }, pending: false, notice: null });
      return () => {
        alive = false;
      };
    }
    void gateway.getWatchlist().then((result) => {
      if (!alive) return;
      if (result.kind === 'ready') {
        setState({
          ui: { status: 'ready', inWatchlist: result.instrumentIds.includes(instrumentId) },
          pending: false,
          notice: null,
        });
      } else if (result.kind === 'anonymous') {
        setState({ ui: { status: 'anonymous' }, pending: false, notice: null });
      } else {
        setState({ ui: { status: 'error' }, pending: false, notice: null });
      }
    });
    return () => {
      alive = false;
    };
  }, [instrumentId]);

  const toggle = useCallback(() => {
    if (state.ui.status !== 'ready' || state.pending) return;
    const target = !state.ui.inWatchlist;
    setState((current) => ({ ...current, pending: true, notice: null }));
    const action = target
      ? gateway.addToWatchlist(instrumentId)
      : gateway.removeFromWatchlist(instrumentId);
    void action.then((result) => {
      if (result.kind === 'ok') {
        setState({ ui: { status: 'ready', inWatchlist: target }, pending: false, notice: null });
      } else if (result.kind === 'anonymous') {
        setState({
          ui: { status: 'anonymous' },
          pending: false,
          notice: copy.watchlist.noticeAnonymous,
        });
      } else {
        setState((current) => ({
          ...current,
          pending: false,
          notice: copy.watchlist.noticeFailed,
        }));
      }
    });
  }, [instrumentId, state]);

  const pressed = state.ui.status === 'ready' ? state.ui.inWatchlist : false;
  const disabled = state.ui.status !== 'ready' || state.pending;
  const stateText =
    state.ui.status === 'ready'
      ? state.ui.inWatchlist
        ? copy.watchlist.stateIn
        : copy.watchlist.stateOut
      : state.ui.status === 'loading'
        ? copy.watchlist.stateLoading
        : state.ui.status === 'anonymous'
          ? copy.watchlist.stateAnonymous
          : copy.watchlist.stateError;

  return (
    <div className="watchlist">
      <button
        type="button"
        className="watchlist__toggle"
        data-testid={TID.watchlistToggle}
        aria-pressed={pressed}
        aria-busy={state.pending || undefined}
        disabled={disabled}
        onClick={toggle}
      >
        <span className="watchlist__icon" aria-hidden="true">
          {pressed ? '★' : '☆'}
        </span>
        {pressed ? copy.watchlist.toggleRemove : copy.watchlist.toggleAdd}
      </button>
      <span className="watchlist__state" data-testid={TID.watchlistState} aria-live="polite">
        {stateText}
      </span>
      {state.notice && (
        <span className="watchlist__notice" role="status">
          {state.notice}
        </span>
      )}
    </div>
  );
}

/** 自选页复用的列表读取（与开关分开，避免开关状态影响列表渲染）。 */
export function useWatchlistList():
  | { status: 'loading' }
  | { status: 'ready'; ids: string[] }
  | { status: 'anonymous' }
  | { status: 'error' } {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; ids: string[] }
    | { status: 'anonymous' }
    | { status: 'error' }
  >({
    status: 'loading',
  });

  useEffect(() => {
    let alive = true;
    if (!readAuthToken()) {
      setState({ status: 'anonymous' });
      return () => {
        alive = false;
      };
    }
    void gateway.getWatchlist().then((result) => {
      if (!alive) return;
      if (result.kind === 'ready') setState({ status: 'ready', ids: result.instrumentIds });
      else if (result.kind === 'anonymous') setState({ status: 'anonymous' });
      else setState({ status: 'error' });
    });
    return () => {
      alive = false;
    };
  }, []);

  return state;
}
