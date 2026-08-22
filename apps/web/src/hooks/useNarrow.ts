import { useEffect, useState } from 'react';

const QUERY = '(max-width: 767px)';

/**
 * 狭い画面かどうか（要件 E2・E3）。**この1点だけを見て、レイアウトの形を丸ごと変える**
 * ——サイドバーの向き・会話パネルと作業パネルの並べ方（重ねて分けるか、切り替えるか）が、
 * ここから枝分かれする。
 */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const onChange = (e: MediaQueryListEvent): void => setNarrow(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow;
}
