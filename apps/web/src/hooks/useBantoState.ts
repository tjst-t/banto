import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchState } from '../lib/api';
import type { StateResponse } from '../lib/types';

const POLL_MS = 4000;

/**
 * `/api/state` はスレッド一覧・判断待ちの「いま」を畳んだものを返す
 * （host 側で毎回イベントログから作り直している）。ここでは定期的に
 * 取り直すだけで、取った値を加工したり別の形で覚えたりしない（規則3）。
 *
 * 取得に失敗しても空にフォールバックしない——直前の値を残したまま
 * エラーを添えて返す。呼び手が画面に出す（規則2）。
 */
export function useBantoState() {
  const [data, setData] = useState<StateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refetch = useCallback(async () => {
    try {
      const next = await fetchState();
      setData(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
    timer.current = setInterval(() => void refetch(), POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [refetch]);

  return { data, error, loading, refetch };
}
