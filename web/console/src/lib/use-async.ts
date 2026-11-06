import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from './errors';

export interface AsyncState<T> {
  data: T | undefined;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** 页面级只读数据加载（mock 同步返回，但保留 loading/error 以对齐真实网络）。 */
export function useAsync<T>(loader: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const alive = useRef(true);

  const reload = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    alive.current = true;
    setLoading(true);
    setError(null);
    loader()
      .then((result) => {
        if (alive.current) setData(result);
      })
      .catch((reason: unknown) => {
        if (alive.current) setError(errorMessage(reason));
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { data, loading, error, reload };
}
