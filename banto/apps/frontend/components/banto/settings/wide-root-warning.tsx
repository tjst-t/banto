"use client";

// **広い根を選んだことを、目に見えるところに出す**（決定・2026-09-11、ユーザー）。
//
// Project の根は、そのまま閉じ込めの範囲になる。home のような広い根を選ぶこと
// 自体は止めない——**AI にいろいろやらせたい**という使い方があるため。
// ただし**黙って通さない**（規則2・規則13）：何が見えるようになるのかを、
// 選ぶ場所（新しい Project）と、使う場所（この Project の Module）の
// **2箇所**に出す。
//
// 判断は host が持つ（`/api/config/root-scope`）——画面が home の場所を推測しない。
import { useEffect, useRef, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { fetchRealRootScope, type RealRootScope } from "@/lib/backend/client";

export function useRootScope(path: string | undefined): RealRootScope | null {
  const [scope, setScope] = useState<RealRootScope | null>(null);
  // **開いた最初の1回は待たずに聞く**（改訂・2026-09-26）——待つのは打っている途中の連打を
  // 避けるためで、画面を開いたときに既に入っている値まで 250 ms 遅らせる理由は無い
  const asked = useRef(false);
  useEffect(() => {
    const trimmed = path?.trim();
    let cancelled = false;
    const delay = asked.current ? 250 : 0;
    asked.current = true;
    const timer = setTimeout(() => {
      if (!trimmed) {
        setScope(null);
        return;
      }
      fetchRealRootScope(trimmed)
        .then((next) => !cancelled && setScope(next))
        // **分からなかったら、何も言わない**——「安全です」とは言わない（規則2）
        .catch(() => !cancelled && setScope(null));
    }, delay); // 打っている途中で毎文字は聞かない
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [path]);
  return scope;
}

export function WideRootWarning({ scope }: { scope: RealRootScope | null }) {
  if (!scope?.wide) return null;
  return (
    <div
      data-testid="wide-root-warning"
      className="flex items-start gap-2 rounded-md bg-turn-soft px-3 py-2 text-xs text-foreground"
    >
      <ShieldAlert className="mt-0.5 size-4 shrink-0" />
      <div className="flex flex-col gap-1">
        {/* **語は普通のものにする**（改訂・2026-09-19、ユーザー指摘）。
            「根」「閉じ込め」は banto の中でしか通じない言い方だった（規則11） */}
        <p className="font-medium">このフォルダでは、サンドボックスがほぼ機能しません</p>
        <p className="text-ink-2">
          AI のシェルとファイル操作は、このフォルダ以下をすべて読み書きできます。
          この中には{scope.includes.join("・")}も含まれます。
        </p>
      </div>
    </div>
  );
}
