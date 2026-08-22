import { useEffect, useRef, useState } from 'react';

import type { ModuleViewProps } from './registry';

/**
 * **モジュールが持ち込む画面を、閉じ込めて走らせる**（要件 C1・C6、決定20）。
 *
 * ## 何で閉じ込めているか
 *
 * `sandbox="allow-scripts"` だけを渡し、**`allow-same-origin` を渡さない。**
 * これで iframe の生成元は不透明になり、中のコードは：
 *
 * - banto の cookie（合言葉）を読めない
 * - banto の DOM に触れない
 * - banto のオリジンへ fetch できない
 *
 * **1枚で守らない。** ホストは同じ HTML に CSP も付けている
 * ——片方が外れたときにもう片方が残る。
 *
 * ## 中身は押し込む。取りに行かせない
 *
 * 閉じ込めた側からは何も取りに行けないので、**親が postMessage で渡す。**
 * これは制約への妥協ではなく、**渡したものしか見えないという性質そのもの**である。
 *
 * 送るのは相手が `banto:ready` と言ってから。**先に送ると取りこぼす。**
 */
export function SandboxedView({
  moduleId,
  uri,
  text,
  mimeType,
}: ModuleViewProps & { readonly moduleId: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(160);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      // **送り主を確かめる。** どの窓からでも投げられるので、自分の iframe だけを見る。
      if (event.source !== frame.current?.contentWindow) return;
      const data: unknown = event.data;
      if (data === null || typeof data !== 'object') return;

      const kind = (data as { type?: unknown }).type;
      if (kind === 'banto:ready') {
        setReady(true);
        // 不透明な生成元へは `'*'` でしか送れない。**中身は渡してよいもの**——
        // このモジュールが持っている URI の中身そのものである。
        frame.current?.contentWindow?.postMessage(
          { type: 'banto:resource', uri, text, mimeType },
          '*',
        );
      }
      if (kind === 'banto:height') {
        const px = (data as { px?: unknown }).px;
        // **言われた高さを鵜呑みにしない。** 上限を置かないと画面を乗っ取れる。
        if (typeof px === 'number' && Number.isFinite(px)) {
          setHeight(Math.min(Math.max(px + 8, 80), 2000));
        }
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [uri, text, mimeType]);

  return (
    <div className="min-h-0 flex-1 overflow-auto" data-sandboxed-view={moduleId}>
      <iframe
        ref={frame}
        title={`${moduleId} の面`}
        src={`/api/modules/${encodeURIComponent(moduleId)}/view`}
        // **allow-same-origin を渡さない。** ここが閉じ込めの本体である。
        sandbox="allow-scripts"
        className="w-full border-0"
        style={{ height }}
      />
      {!ready && (
        <p className="px-3 py-2 text-xs text-ink-muted">{moduleId} の面を読み込んでいます…</p>
      )}
    </div>
  );
}
