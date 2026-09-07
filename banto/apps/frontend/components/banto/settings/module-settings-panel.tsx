"use client";

// Module 自身の設定画面（MCP Apps の設定 Canvas、§6.2、決定・2026-09-07）。
//
// **iOS でアプリの設定が OS の設定アプリに出てくるのと同じ形。**
// banto は値を持たない——読み書きはその Module 自身の tool で、
// banto がやるのは「どこに出すか」を決めることだけ。
//
// **在るかもしれない、を試さない**（規則2）。Module が
// `dev.banto/canvas: "config"` と名乗った資源だけを出す。
// 1つも無ければ、その旨をはっきり出す——空の枠を残さない（規則13）。

import { useEffect, useState } from "react";
import { ModuleCanvas } from "@/components/banto/canvas/module-canvas";
import { listRealUiSettings, type RealCanvasOwner } from "@/lib/backend/client";

export type SettingsCanvas = { server: string; resourceUri: string; name?: string };

type State =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; canvases: SettingsCanvas[] };

/**
 * その相手の Module が名乗っている設定 Canvas の一覧を取る。
 * **左メニューに並べるのにも、右側を描くのにも同じものを使う**（規則3）。
 */
export function useModuleSettingsCanvases(owner: RealCanvasOwner): {
  canvases: SettingsCanvas[];
  error: string | null;
} {
  const [state, setState] = useState<{ canvases: SettingsCanvas[]; error: string | null }>({
    canvases: [],
    error: null,
  });
  const key = owner.kind === "instance" ? "instance" : owner.id;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const canvases = await listRealUiSettings(owner);
        if (!cancelled) setState({ canvases, error: null });
      } catch (err) {
        // **取れなかったことを「無い」と混同しない**（規則2）
        if (!cancelled) {
          setState({ canvases: [], error: err instanceof Error ? err.message : String(err) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner.kind, key]);

  return state;
}

/**
 * **1つの Module の設定を、右側いっぱいに出す**（決定・2026-09-07、ユーザー指摘）。
 * モックが決めた形——左メニューに Module が並び、選んだものを右側で開く。
 * 以前は全部を縦に積んでいて、モックと違っていた。
 */
export function ModuleSettingsPanel({
  owner,
  canvas,
}: {
  /** どちらの設定画面か。instance に1本の Module は全体、Project ごとの
   *  Module は Project——**置き場はその Module の scope が決める**（§6.2）。 */
  owner: RealCanvasOwner;
  canvas: SettingsCanvas;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="module-settings-panel">
      <div className="shrink-0">
        <h1 className="text-lg font-semibold text-foreground">{canvas.name ?? canvas.server}</h1>
        <p className="mt-0.5 mb-4 text-xs text-ink-3">
          {canvas.server} の設定。<strong>値は Module が持つ</strong>
          ——banto は場所を用意するだけで、変更はその Module に届く。
        </p>
      </div>
      <div
        className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border"
        data-testid="module-settings-canvas"
        data-module={canvas.server}
      >
        <ModuleCanvas
          owner={owner}
          server={canvas.server}
          resourceUri={canvas.resourceUri}
          displayMode="fullscreen"
        />
      </div>
    </div>
  );
}
