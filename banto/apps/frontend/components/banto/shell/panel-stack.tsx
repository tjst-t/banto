"use client";

// Base Thread・Fork Thread・Canvas の3層描画。骨格はここが唯一の置き場所。
//
// **開いている層は、組み合わせが変わっても作り直さない**（改訂・2026-09-28、ユーザー要望「基本的に全部
// 残してほしい」）。React は「木の同じ位置に同じ部品があるあいだだけ」状態を保つ
// （https://react.dev/learn/preserving-and-resetting-state）。以前は組み合わせごとに木の形が違った
// ——Base＋Fork／Base＋Canvas は react-resizable-panels、Fork＋Canvas は ThreeLayerStack、全画面の
// Canvas は Canvas だけ、携帯は前面の1枚だけ——ので、Fork と Canvas を両方開く・Canvas を全画面にする・
// 携帯で Fork の上に Canvas を開くたびに、見えなくなった会話が**捨てられ**、閉じると作り直されていた
// （入力欄・スクロール・カードの開閉・流れていた返事の読み取りを失う）。
//
// いまは3枚を**いつも同じ親の下に同じ key で並べ**、どこに・どの大きさで出すか、見せるか隠すかだけを
// 組み合わせで変える。隠すのは `visibility: hidden` と `inert`——DOM も effect も生きたまま（流れている
// 返事の読み取りも止めない）、位置も大きさも前のまま残す（折り返しが変わって読んでいた場所がずれない）。
// React の `<Activity>` は隠すと effect の後片づけが走り、流れの読み取りが止まるので使わない。
//
// **前面の会話は1枚だけ、面を全部使う**（改訂・2026-10-10、ユーザー「Fork を右に並べてもあまり意味が無い。
// Base も Fork も携帯と同じように右の面を全部使うほうが便利」）。前面の会話は Fork があれば Fork、無ければ Base。
// 隠れた Base は全幅のまま残す（戻ったとき折り返しが変わらず、読んでいた場所がずれない）。
// 以前の ≥md は Base の右に Fork を浮かせて並べ、Fork＋Canvas では Base を 32px の帯にしていた。
//
// ≥md：Canvas は前面の会話の横に浮く紙（20px）。会話は左の細い列（既定 1/3）に。境界はつかんで動かせる
//      （自前。react-resizable-panels は「各パネルが自分の幅ぶんの箱を持つ」モデルで、組み合わせごとに
//      木の形が変わるため使わない）。全画面の Canvas は Canvas だけ。
// <md：Canvas も画面いっぱいに重ね、前面の1枚だけを見せる。
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { isOverlayOpen } from "@/lib/overlay-open";
import { cn } from "@/lib/utils";
import { usePanelStack } from "./use-panel-stack";

const CANVAS_LIFT = 20; // px。Canvas の紙が浮く分（mt-5）
const CANVAS_OVERLAP = 10; // px。Base の横に出る Canvas が Base に重なる分（-ml-2.5）

type Box = { left: number; width: number; top: number };

/** 境界。つかんで左右に動かす。矢印キーでも動く */
function SplitHandle({
  x,
  label,
  onMove,
  onKeyStep,
}: {
  x: number;
  label: string;
  /** 画面の x 座標（clientX）を渡す */
  onMove: (clientX: number) => void;
  /** 矢印キー：-1（左）/ +1（右） */
  onKeyStep: (dir: -1 | 1) => void;
}) {
  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const move = (ev: PointerEvent) => onMove(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      className="group absolute inset-y-0 z-20 flex w-3 -translate-x-1/2 touch-none items-center justify-center [cursor:col-resize] focus-visible:outline-hidden"
      style={{ left: x }}
      onPointerDown={onPointerDown}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onKeyStep(-1);
        else if (e.key === "ArrowRight") onKeyStep(1);
        else return;
        e.preventDefault();
      }}
    >
      <div className="h-6 w-1 rounded-lg bg-border opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
    </div>
  );
}

/** 1枚の紙。隠すときも外さない（visibility と inert だけ変える） */
function Layer({
  box,
  visible,
  floating,
  shadow,
  testId,
  layer,
  children,
}: {
  box: Box | "fill";
  visible: boolean;
  /** 下の紙の上に浮いている（角丸・影） */
  floating: boolean;
  shadow?: "canvas";
  testId?: string;
  layer: string;
  children: ReactNode;
}) {
  const style: CSSProperties =
    box === "fill" ? { inset: 0 } : { left: box.left, width: box.width, top: box.top, bottom: 0 };
  return (
    <div
      data-testid={testId}
      data-layer={layer}
      aria-hidden={visible ? undefined : true}
      inert={!visible}
      className={cn(
        "absolute overflow-hidden",
        !visible && "invisible",
        floating && "rounded-tl-lg bg-card animate-panel-in motion-reduce:animate-none",
        floating && shadow === "canvas" && "shadow-panel-canvas",
      )}
      style={style}
    >
      <div className="absolute inset-0 overflow-hidden">{children}</div>
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
  const { canvas, forkThreadId, canvasFullscreen, close } = stack;

  // **Escape が閉じるのは Canvas だけ**（改訂・2026-10-10、ユーザー）。Fork は全面の「ページ」になったので、
  // Escape で Base へ飛ばさない——Fork から Base へは ← かサイドバーで戻る。
  // PC・モバイルの両方でここ1箇所だけが Escape を聞く。
  //
  // **上に何か開いていたら、Escape はそちらのもの**（修正・2026-09-10）。
  // 実測：Fork を開いた上で Command Palette を開いて Escape を押すと、
  // **前面のパネルは開いたまま、背面の層が閉じた**——見ていない層が消える。
  // 設定の面（`use-escape-leave-settings.ts`）も同じ検査をする（規則3——同じ判断を2通りに書かない）。
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (e.defaultPrevented) return;
      // Dialog / Sheet / Drawer / Command Palette / 設定の面が開いているなら、そちらが先
      if (isOverlayOpen()) return;
      if (canvas) close("canvas");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canvas, close]);

  // 並びの幅（px）。描く前に測る——測る前の1回は幅0で組むが、画面に出る前に測り直す
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(() => setWidth(el.getBoundingClientRect().width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [isMobile]);

  // 会話と Canvas の境界の位置（割合）。Canvas を開くときは画面の2/3（PO指摘）
  const [convCanvasSplit, setConvCanvasSplit] = useState(1 / 3);

  const hasFork = forkThreadId !== null;
  const hasCanvas = canvas !== null;
  const fullscreen = hasCanvas && canvasFullscreen;
  // 前面の会話
  const frontConv: "base" | "fork" = hasFork ? "fork" : "base";

  // ---- 中身は1回ずつだけ描く。どの組み合わせでも同じ key・同じ親 ----
  const baseContent = renderBase();
  const forkContent = hasFork ? renderFork(forkThreadId) : null;
  const canvasContent = hasCanvas ? renderCanvas(canvas.moduleId, canvas.viewId) : null;
  const forkKey = hasFork ? `fork:${forkThreadId}` : "fork";
  const canvasKey = hasCanvas ? `canvas:${canvas.moduleId}:${canvas.viewId}` : "canvas";

  // ---- 各紙の置き場所。携帯は全部いっぱい、≥md は Canvas があれば会話を左の列に ----
  const W = width;
  const sideBySide = !isMobile && hasCanvas && !fullscreen;
  const convWidth = sideBySide ? W * convCanvasSplit : W;
  const full: Box | "fill" = "fill";
  const convBox: Box | "fill" = sideBySide ? { left: 0, width: convWidth, top: 0 } : full;
  // 前面でない会話は全幅のまま隠す（戻ったとき折り返しが変わらない）
  const baseBox = frontConv === "base" ? convBox : full;
  const forkBox = frontConv === "fork" ? convBox : full;
  const convVisible = isMobile ? !hasCanvas : !fullscreen;
  const canvasBox: Box | "fill" = sideBySide
    ? { left: convWidth - CANVAS_OVERLAP, width: W - convWidth + CANVAS_OVERLAP, top: CANVAS_LIFT }
    : full;
  // 前面の1枚を指せるようにしておく（`data-testid`）。下の紙は隠してあるが DOM には残る
  // ——画面全体から文字を探すと背面にも当たる（規則14 の由来になった穴、2026-09-10）
  const frontTestId = (layer: "fork" | "canvas") =>
    layer === "canvas" ? "panel-overlay" : !hasCanvas || sideBySide ? "panel-overlay" : undefined;

  const clampFrac = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
  const toFrac = (clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    return (clientX - rect.left) / rect.width;
  };

  return (
    <div ref={containerRef} className="relative min-h-0 flex-1">
      <Layer key="base" layer="base" box={baseBox} visible={frontConv === "base" && convVisible} floating={false}>
        {baseContent}
      </Layer>
      {hasFork ? (
        <Layer
          key={forkKey}
          layer="fork"
          testId={frontTestId("fork")}
          box={forkBox}
          visible={convVisible}
          floating={false}
        >
          <div className="flex h-full flex-col bg-background">{forkContent}</div>
        </Layer>
      ) : null}
      {hasCanvas ? (
        <Layer
          key={canvasKey}
          layer="canvas"
          testId={frontTestId("canvas")}
          box={canvasBox}
          visible
          floating={sideBySide}
          shadow="canvas"
        >
          {isMobile ? <div className="flex h-full flex-col bg-background">{canvasContent}</div> : canvasContent}
        </Layer>
      ) : null}
      {sideBySide ? (
        <SplitHandle
          key="conv-canvas"
          x={convWidth}
          label={frontConv === "fork" ? "Fork Thread と Canvas の境界" : "Base Thread と Canvas の境界"}
          onMove={(x) => {
            const f = toFrac(x);
            if (f !== null) setConvCanvasSplit(clampFrac(f, 0.2, 0.5));
          }}
          onKeyStep={(dir) => setConvCanvasSplit((v) => clampFrac(v + dir * 0.02, 0.2, 0.5))}
        />
      ) : null}
    </div>
  );
}
