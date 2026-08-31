"use client";

// Base Thread・Fork Thread・Canvas の3層描画。骨格はここが唯一の置き場所
// （§10 のうち D 群を決めるための、いちばんリスクの高い箇所）。
//
// ≥md: react-resizable-panels（prototype の `.grip` = ResizableHandle）。
//      ただし Fork Thread + Canvas が両方開いているときは例外——3枚の紙が
//      本当に重なって見えるよう、この構成だけは react-resizable-panels の
//      「各パネルが自分の幅ぶんの箱を持つ」モデルから外れて ThreeLayerStack が描く
// <md: base を常に表示し、Fork・Canvas は Base の上に重ねた全画面（MobileTopBar の下いっぱい）
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { type PanelLayer, usePanelStack } from "./use-panel-stack";
import { SpineTab } from "./spine-tab";

const SPINE_WIDTH = 32; // px。SpineTab の幅（w-8）と揃える

// Base Thread（一番下の紙）→ Fork Thread（その上）→ Canvas（さらに上）。
// 3枚とも結合領域の全幅（画面の右端）まで箱を伸ばし、上の紙が下の紙に重なって
// 見えるようにする——実際に見える範囲は、下の紙ほど狭い帯として残るだけ
// （PO指摘：横に並べて少し重なるだけでは「重なっている」ように見えない。
// Base の帯も一枚の紙として右端までつながってほしい）。
// 分割位置は境界のハンドルをドラッグして変える（react-resizable-panels は使わない
// ——Fork の箱を分割位置に関わらず全幅のまま保つ必要があり、あのライブラリの
// 「各パネルが自分の幅ぶんの箱を持つ」モデルとは相性が悪いため、自前で足す）
function ThreeLayerStack({
  onOpenBase,
  forkContent,
  canvasContent,
}: {
  onOpenBase: () => void;
  forkContent: ReactNode;
  canvasContent: ReactNode;
}) {
  const [canvasWidth, setCanvasWidth] = useState(480); // px。マウント後に画面の2/3へ補正する
  const containerRef = useRef<HTMLDivElement>(null);

  // Canvas を開くときは画面の2/3にする（PO指摘）。結合領域の幅はレイアウト後
  // でないと分からないので、マウント時に実測して補正する
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    setCanvasWidth(rect.width * (2 / 3));
  }, []);

  function onHandlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;

    function onMove(ev: PointerEvent) {
      const rect = container!.getBoundingClientRect();
      const width = rect.right - ev.clientX;
      const min = 240; // Canvas の最小幅
      const max = rect.width - SPINE_WIDTH - 240; // Base の帯・Fork の最小幅を残す
      setCanvasWidth(Math.min(max, Math.max(min, width)));
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <div ref={containerRef} className="relative h-full w-full">
      {/* Base の紙：一番下、結合領域の全幅（画面右端）まで伸ばす。
          実際に見えるのは Fork の下からのぞく 32px の帯だけ */}
      <div className="absolute inset-0 z-[1] overflow-hidden rounded-tl-lg bg-card">
        <div style={{ width: SPINE_WIDTH }} className="h-full">
          <SpineTab label="Base Thread" onOpen={onOpenBase} />
        </div>
      </div>
      {/* Fork の紙：Base の上に重ねる。Base の帯の分だけ左を空け、右端まで伸ばす。
          中身は Canvas に隠れない左側の列だけに収める */}
      <div
        className="absolute top-2.5 right-0 bottom-0 z-[2] overflow-hidden rounded-tl-lg bg-card shadow-panel-fork animate-panel-in motion-reduce:animate-none"
        style={{ left: SPINE_WIDTH }}
      >
        <div className="absolute inset-0 overflow-hidden" style={{ right: canvasWidth }}>
          {forkContent}
        </div>
      </div>
      {/* Canvas の紙：Fork の上にさらに重ねて右側に乗る */}
      <div
        className="absolute top-5 right-0 bottom-0 z-[3] overflow-hidden rounded-tl-lg bg-card shadow-panel-canvas animate-panel-in motion-reduce:animate-none"
        style={{ width: canvasWidth }}
      >
        {canvasContent}
      </div>
      {/* 分割位置のドラッグハンドル */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Fork Thread と Canvas の境界"
        className="group absolute inset-y-0 z-20 flex w-3 -translate-x-1/2 touch-none items-center justify-center [cursor:col-resize]"
        style={{ right: canvasWidth }}
        onPointerDown={onHandlePointerDown}
      >
        <div className="h-6 w-1 rounded-lg bg-border opacity-0 group-hover:opacity-100" />
      </div>
    </div>
  );
}

export function PanelStack({
  projectId,
  renderBase,
  renderFork,
  renderCanvas,
}: {
  projectId: string;
  renderBase: () => ReactNode;
  renderFork: (threadId: string) => ReactNode;
  renderCanvas: (moduleId: string, viewId: string) => ReactNode;
}) {
  const stack = usePanelStack(projectId);
  const isMobile = useIsMobile();
  const { canvas, forkThreadId, close } = stack;

  // Escape は前面の層だけを1枚閉じる（Canvas があれば Canvas、無ければ Fork）。
  // PC・モバイルの両方でここ1箇所だけが Escape を聞く——ヘッダ側の閉じるボタンと
  // 二重に持つと、両方開いているときに1回で2枚とも閉じてしまう
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (canvas) close("canvas");
      else if (forkThreadId) close("fork");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canvas, forkThreadId, close]);

  const content = (layer: PanelLayer): ReactNode => {
    if (layer.kind === "base") return renderBase();
    if (layer.kind === "fork") return renderFork(layer.threadId);
    return renderCanvas(layer.moduleId, layer.viewId);
  };

  const panels = stack.layers;

  // Base Thread（地）→ Fork Thread（10px 浮く紙）→ Canvas（20px 浮く紙）の重なり
  // （prototype 13-tsuzukima-kai の意匠）。角丸は左上だけ——右上も丸めると
  // 「そこで紙が終わっている」ように見えてしまう。紙は画面の右端の先まで続いていて、
  // いま見えているのはその一部、という体にする（PO指摘）。
  // Fork・Canvas が両方開いている構成は ThreeLayerStack が別に描くので、ここでは
  // 単独で開いているときの Fork・Canvas と、Base だけを扱う
  const floatClass = (kind: PanelLayer["kind"]): string => {
    if (panels.length === 1 || kind === "base") return "h-full";
    if (kind === "fork") {
      return "relative z-[2] mt-2.5 h-[calc(100%-0.625rem)] overflow-hidden rounded-tl-lg bg-card shadow-panel-fork animate-panel-in motion-reduce:animate-none";
    }
    return "relative z-[3] -ml-2.5 mt-5 h-[calc(100%-1.25rem)] overflow-hidden rounded-tl-lg bg-card shadow-panel-canvas animate-panel-in motion-reduce:animate-none";
  };

  if (isMobile) {
    const [front] = [...panels].reverse(); // 最前面
    const showOverlay = front && front.kind !== "base";

    return (
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1">{renderBase()}</div>
        {/* MobileTopBar の下いっぱいを使う全画面オーバーレイ。Drawer は使わない
            ——「banto そのもの」を覗かせるための帯を持たない分、表示に使える面積が増える */}
        {showOverlay ? (
          <div className="bg-background absolute inset-0 z-10 flex flex-col">
            {content(front)}
          </div>
        ) : null}
      </div>
    );
  }

  // Fork Thread + Canvas が両方開いている（spine + fork + canvas の3層）ときは、
  // react-resizable-panels の「各パネルが自分の幅ぶんの箱を持つ」モデルではなく
  // ThreeLayerStack が3枚の重なりを直接描く——spine 用の別パネルは持たない
  // （Base の紙も他の2枚と同じく全幅まで伸ばすため、3枚まとめて1つの領域に描く）
  const forkLayer = panels.find((p): p is Extract<PanelLayer, { kind: "fork" }> => p.kind === "fork");
  const canvasLayer = panels.find((p): p is Extract<PanelLayer, { kind: "canvas" }> => p.kind === "canvas");
  const hasSpine = panels.some((p) => p.kind === "base" && p.role === "spine");

  if (forkLayer && canvasLayer && hasSpine) {
    return (
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel className="!overflow-visible">
          <ThreeLayerStack
            onOpenBase={() => stack.close("fork")}
            forkContent={renderFork(forkLayer.threadId)}
            canvasContent={renderCanvas(canvasLayer.moduleId, canvasLayer.viewId)}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    );
  }

  // ≥md：react-resizable-panels。slim（Canvas 単体のときの Base）は画面の1/3、
  // Canvas がその残り2/3を占める（PO指摘：Canvas を開くときは画面の2/3にする）。
  // primary は残りを占める。
  return (
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
      {panels.map((layer, i) => {
        const key = layer.kind === "base" ? "base" : layer.kind === "fork" ? `fork:${layer.threadId}` : `canvas:${layer.moduleId}:${layer.viewId}`;
        const isLast = i === panels.length - 1;

        // defaultSize は数値だと px、パーセントにしたいときは文字列で渡す
        // （react-resizable-panels の仕様。実測で踏んだ——数値のままだと45px になる）
        const defaultSize = panels.length > 1 && layer.kind === "base" ? "45" : undefined;

        return (
          <Fragment key={key}>
            {layer.role === "slim" ? (
              <ResizablePanel defaultSize="33.33" minSize="20" maxSize="50" className="!overflow-visible">
                <div className={floatClass(layer.kind)}>{content(layer)}</div>
              </ResizablePanel>
            ) : (
              <ResizablePanel defaultSize={defaultSize} minSize="20" className="!overflow-visible">
                <div className={floatClass(layer.kind)}>{content(layer)}</div>
              </ResizablePanel>
            )}
            {/* 常時線を引かない。Fork・Canvas はすでに shadow-panel-* で境界が付くので、
                ハンドルの線はドラッグできることを示すためだけに hover/drag 時だけ出す */}
            {!isLast ? (
              <ResizableHandle
                withHandle
                className="bg-transparent data-[separator=drag]:bg-border data-[separator=hover]:bg-border"
              />
            ) : null}
          </Fragment>
        );
      })}
    </ResizablePanelGroup>
  );
}
