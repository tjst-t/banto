"use client";

// パネル層（Base Thread・Fork Thread・Canvas）の唯一の読み書き口。Project 切替だけがルート遷移で、
// それ以外（Fork を開く・Canvas を開く・受信箱・設定・パレット）は同じページ内の
// searchParams で駆動する——これにより assistant-ui の runtime が余計な場面で
// unmount されず、かつモバイルの「戻るボタンで1層畳む」が自然に実現する
// （計画 §3.1「Project はルート、パネル層は searchParams」）。

import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export type PanelRole = "primary" | "slim" | "spine";

export type PanelLayer =
  | { kind: "base"; role: PanelRole }
  | { kind: "fork"; threadId: string; role: PanelRole }
  | { kind: "canvas"; moduleId: string; viewId: string; role: "primary" };

export type OverlayKind = "inbox" | "palette" | "settings-project" | "archive" | null;

export interface PanelStackState {
  projectId: string;
  forkThreadId: string | null;
  canvas: { moduleId: string; viewId: string } | null;
  /** Canvas の display mode。仕様の fullscreen を banto は「Base・Fork を隠して全幅」に割り当てる（§6.2） */
  canvasFullscreen: boolean;
  overlay: OverlayKind;
  layers: readonly PanelLayer[];
}

export interface OpenPanelInput {
  fork?: string | null;
  canvas?: { moduleId: string; viewId: string } | null;
  canvasFullscreen?: boolean;
  overlay?: OverlayKind;
}

export interface UsePanelStackResult extends PanelStackState {
  open(next: OpenPanelInput): void;
  close(kind: "fork" | "canvas" | "overlay"): void;
}

/** canvas-window（別タブでの単独表示）でも同じ解釈をするために公開する（規則3） */
export function parseCanvasParam(
  canvasParam: string | null,
): { moduleId: string; viewId: string } | null {
  if (!canvasParam) return null;
  const sep = canvasParam.indexOf(":");
  if (sep === -1) return { moduleId: canvasParam, viewId: "default" };
  return { moduleId: canvasParam.slice(0, sep), viewId: canvasParam.slice(sep + 1) };
}

/**
 * 開いているものの組み合わせから、Base Thread・Fork Thread・Canvas それぞれの role を決める
 * （prototype の重なりの規則をそのまま関数にしたもの——幹は地、枝と面はその上に浮く紙）。
 *
 * Fork Thread と Canvas が両方開いているとき、Base は幅44pxの帯（spine）になる。
 * 文言は持たない——押すと Base に戻れる、という機能だけを残す（PO指摘：
 * 「banto そのもの」という文言に意味が無い。帯そのものは「地が続いている」ことを見せる）。
 */
function computeLayers(
  forkThreadId: string | null,
  canvas: { moduleId: string; viewId: string } | null,
  canvasFullscreen: boolean,
): PanelLayer[] {
  const hasFork = forkThreadId !== null;
  const hasCanvas = canvas !== null;

  if (hasCanvas && canvasFullscreen) {
    return [{ kind: "canvas", moduleId: canvas.moduleId, viewId: canvas.viewId, role: "primary" }];
  }
  if (!hasFork && !hasCanvas) {
    return [{ kind: "base", role: "primary" }];
  }
  if (hasFork && !hasCanvas) {
    return [
      { kind: "base", role: "primary" },
      { kind: "fork", threadId: forkThreadId, role: "primary" },
    ];
  }
  if (!hasFork && hasCanvas) {
    return [
      { kind: "base", role: "slim" },
      { kind: "canvas", moduleId: canvas.moduleId, viewId: canvas.viewId, role: "primary" },
    ];
  }
  // hasFork && hasCanvas
  return [
    { kind: "base", role: "spine" },
    { kind: "fork", threadId: forkThreadId as string, role: "slim" },
    { kind: "canvas", moduleId: canvas!.moduleId, viewId: canvas!.viewId, role: "primary" },
  ];
}

export function usePanelStack(projectId: string): UsePanelStackResult {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const forkThreadId = searchParams.get("fork");
  const canvasParam = searchParams.get("canvas"); // "<moduleId>:<viewId>"
  const canvasFullscreen = searchParams.get("fullscreen") === "1";
  const overlayParam = searchParams.get("overlay") as OverlayKind;

  const canvas = useMemo(() => parseCanvasParam(canvasParam), [canvasParam]);

  const layers = useMemo(
    () => computeLayers(forkThreadId, canvas, canvasFullscreen),
    [forkThreadId, canvas, canvasFullscreen],
  );

  const open = useCallback(
    (next: OpenPanelInput) => {
      const params = new URLSearchParams(searchParams.toString());

      if (next.fork !== undefined) {
        if (next.fork === null) params.delete("fork");
        else params.set("fork", next.fork);
      }
      if (next.canvas !== undefined) {
        if (next.canvas === null) {
          params.delete("canvas");
          // Canvas を閉じたら、全画面フラグも一緒に捨てる——残すと次に別の
          // Canvas を開いたときに前回の全画面状態が意図せず引き継がれる
          params.delete("fullscreen");
        } else {
          params.set("canvas", `${next.canvas.moduleId}:${next.canvas.viewId}`);
        }
      }
      if (next.canvasFullscreen !== undefined) {
        if (next.canvasFullscreen) params.set("fullscreen", "1");
        else params.delete("fullscreen");
      }
      if (next.overlay !== undefined) {
        if (next.overlay === null) params.delete("overlay");
        else params.set("overlay", next.overlay);
      }

      const qs = params.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname);
    },
    [pathname, router, searchParams],
  );

  const close = useCallback(
    (kind: "fork" | "canvas" | "overlay") => {
      if (kind === "fork") open({ fork: null });
      else if (kind === "canvas") open({ canvas: null });
      else open({ overlay: null });
    },
    [open],
  );

  return {
    projectId,
    forkThreadId,
    canvas,
    canvasFullscreen,
    overlay: overlayParam,
    layers,
    open,
    close,
  };
}
