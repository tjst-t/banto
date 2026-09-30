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
// ≥md（決定・2026-09-02 の意匠）：Base Thread（地）→ Fork Thread（10px 浮く紙）→ Canvas（20px 浮く紙）。
//      角丸は左上だけ——紙は画面の右端の先まで続いている体。
//      Fork＋Canvas のときは Base が幅 32px の帯（spine）になり、押すと Base に戻る。
//      境界はつかんで動かせる（自前。react-resizable-panels は「各パネルが自分の幅ぶんの箱を持つ」
//      モデルで、組み合わせごとに木の形が変わるため使わない）。
// <md：3枚とも画面いっぱいに重ね、前面の1枚だけを見せる。
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { isOverlayOpen } from "@/lib/overlay-open";
import { cn } from "@/lib/utils";
import { usePanelStack } from "./use-panel-stack";
import { SpineTab } from "./spine-tab";

const SPINE_WIDTH = 32; // px。SpineTab の幅（w-8）と揃える
const FORK_LIFT = 10; // px。Fork の紙が浮く分（mt-2.5）
const CANVAS_LIFT = 20; // px。Canvas の紙が浮く分（mt-5）
const CANVAS_OVERLAP = 10; // px。Base の横に出る Canvas が Base に重なる分（-ml-2.5）
const MIN_PANEL = 240; // px。つかんで動かすときに残す最小幅

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
  contentRight,
}: {
  box: Box | "fill";
  visible: boolean;
  /** 下の紙の上に浮いている（角丸・影） */
  floating: boolean;
  shadow?: "fork" | "canvas";
  testId?: string;
  layer: string;
  children: ReactNode;
  /** 中身を右から何 px 空けるか（Fork＋Canvas のとき、Fork の中身は Canvas に隠れない列だけに収める） */
  contentRight?: number;
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
        floating && shadow === "fork" && "shadow-panel-fork",
        floating && shadow === "canvas" && "shadow-panel-canvas",
      )}
      style={style}
    >
      <div className="absolute inset-y-0 left-0 overflow-hidden" style={{ right: contentRight ?? 0 }}>
        {children}
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
  const { canvas, forkThreadId, canvasFullscreen, close } = stack;

  // Escape は前面の層だけを1枚閉じる（Canvas があれば Canvas、無ければ Fork）。
  // PC・モバイルの両方でここ1箇所だけが Escape を聞く——ヘッダ側の閉じるボタンと
  // 二重に持つと、両方開いているときに1回で2枚とも閉じてしまう。
  //
  // **上に何か開いていたら、Escape はそちらのもの**（修正・2026-09-10）。
  // 実測：Fork を開いた上で Command Palette を開いて Escape を押すと、
  // **前面のパネルは開いたまま、背面の Fork が閉じた**——見ていない層が消える。
  // 設定の面（`use-escape-leave-settings.ts`）も同じ検査をする（規則3——同じ判断を2通りに書かない）。
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (e.defaultPrevented) return;
      // Dialog / Sheet / Drawer / Command Palette / 設定の面が開いているなら、そちらが先
      if (isOverlayOpen()) return;
      if (canvas) close("canvas");
      else if (forkThreadId) close("fork");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canvas, forkThreadId, close]);

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

  // 境界の位置（割合）。Base＋Fork、Base＋Canvas、Fork＋Canvas でそれぞれ別に覚える（以前と同じ既定値）
  const [baseForkSplit, setBaseForkSplit] = useState(0.45);
  const [baseCanvasSplit, setBaseCanvasSplit] = useState(1 / 3);
  // Fork＋Canvas のときの Canvas の幅（割合）——Canvas を開くときは画面の2/3（PO指摘）
  const [canvasShare, setCanvasShare] = useState(2 / 3);

  const hasFork = forkThreadId !== null;
  const hasCanvas = canvas !== null;
  const fullscreen = hasCanvas && canvasFullscreen;

  // ---- 中身は1回ずつだけ描く。どの組み合わせでも同じ key・同じ親 ----
  const baseContent = renderBase();
  const forkContent = hasFork ? renderFork(forkThreadId) : null;
  const canvasContent = hasCanvas ? renderCanvas(canvas.moduleId, canvas.viewId) : null;
  const forkKey = hasFork ? `fork:${forkThreadId}` : "fork";
  const canvasKey = hasCanvas ? `canvas:${canvas.moduleId}:${canvas.viewId}` : "canvas";

  if (isMobile) {
    // 3枚とも画面いっぱいに重ねる。前面の1枚だけを見せ、下の紙は隠して残す
    const front = hasCanvas ? "canvas" : hasFork ? "fork" : "base";
    return (
      <div ref={containerRef} className="relative min-h-0 flex-1">
        <Layer key="base" layer="base" box="fill" visible={front === "base"} floating={false}>
          {baseContent}
        </Layer>
        {hasFork ? (
          // **前面の1枚**を指せるようにしておく（`data-testid`）。下の紙は隠してあるが DOM には残る
          // ——画面全体から文字を探すと背面にも当たる（規則14 の由来になった穴、2026-09-10）
          <Layer
            key={forkKey}
            layer="fork"
            testId={front === "fork" ? "panel-overlay" : undefined}
            box="fill"
            visible={front === "fork"}
            floating={false}
          >
            <div className="flex h-full flex-col bg-background">{forkContent}</div>
          </Layer>
        ) : null}
        {hasCanvas ? (
          <Layer key={canvasKey} layer="canvas" testId="panel-overlay" box="fill" visible floating={false}>
            <div className="flex h-full flex-col bg-background">{canvasContent}</div>
          </Layer>
        ) : null}
      </div>
    );
  }

  // ---- ≥md：組み合わせから、各紙の置き場所を決める ----
  const W = width;
  const clampFrac = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
  const toFrac = (clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    return (clientX - rect.left) / rect.width;
  };
  const minFrac = W > 0 ? MIN_PANEL / W : 0.2;

  // Base＋Fork のときの並び（Fork＋Canvas のときも、隠れた Base はこの大きさのまま残す——折り返しが
  // 変わると、戻ったとき読んでいた場所がずれる）
  const baseWhenForked = W * baseForkSplit;
  const baseWhenCanvas = W * baseCanvasSplit;
  const canvasWidthWithFork = Math.min(Math.max(W * canvasShare, MIN_PANEL), Math.max(MIN_PANEL, W - SPINE_WIDTH - MIN_PANEL));

  let baseBox: Box = { left: 0, width: W, top: 0 };
  let baseVisible = true;
  let forkBox: Box = { left: baseWhenForked, width: W - baseWhenForked, top: FORK_LIFT };
  let forkVisible = hasFork;
  let forkContentRight = 0;
  let canvasBox: Box = { left: 0, width: W, top: 0 };
  let canvasFloating = true;
  let spine = false;
  const handles: ReactNode[] = [];

  if (hasFork && hasCanvas) {
    // Fork＋Canvas：Base は帯。Fork は帯の右から右端まで（中身は Canvas に隠れない列だけ）、Canvas は右側に乗る
    spine = true;
    baseBox = { left: 0, width: baseWhenForked, top: 0 };
    baseVisible = false;
    forkBox = { left: SPINE_WIDTH, width: W - SPINE_WIDTH, top: FORK_LIFT };
    forkContentRight = canvasWidthWithFork;
    canvasBox = { left: W - canvasWidthWithFork, width: canvasWidthWithFork, top: CANVAS_LIFT };
    handles.push(
      <SplitHandle
        key="fork-canvas"
        x={W - canvasWidthWithFork}
        label="Fork Thread と Canvas の境界"
        onMove={(x) => {
          const f = toFrac(x);
          if (f !== null) setCanvasShare(clampFrac(1 - f, minFrac, 1 - (SPINE_WIDTH + MIN_PANEL) / Math.max(W, 1)));
        }}
        onKeyStep={(dir) => setCanvasShare((v) => clampFrac(v - dir * 0.02, minFrac, 0.9))}
      />,
    );
  } else if (hasFork) {
    baseBox = { left: 0, width: baseWhenForked, top: 0 };
    forkBox = { left: baseWhenForked, width: W - baseWhenForked, top: FORK_LIFT };
    handles.push(
      <SplitHandle
        key="base-fork"
        x={baseWhenForked}
        label="Base Thread と Fork Thread の境界"
        onMove={(x) => {
          const f = toFrac(x);
          if (f !== null) setBaseForkSplit(clampFrac(f, 0.2, 0.8));
        }}
        onKeyStep={(dir) => setBaseForkSplit((v) => clampFrac(v + dir * 0.02, 0.2, 0.8))}
      />,
    );
  } else if (hasCanvas) {
    // Base は細く（画面の1/3）、Canvas がその残りを占める（PO指摘：Canvas を開くときは画面の2/3）
    baseBox = { left: 0, width: baseWhenCanvas, top: 0 };
    canvasBox = { left: baseWhenCanvas - CANVAS_OVERLAP, width: W - baseWhenCanvas + CANVAS_OVERLAP, top: CANVAS_LIFT };
    handles.push(
      <SplitHandle
        key="base-canvas"
        x={baseWhenCanvas}
        label="Base Thread と Canvas の境界"
        onMove={(x) => {
          const f = toFrac(x);
          if (f !== null) setBaseCanvasSplit(clampFrac(f, 0.2, 0.5));
        }}
        onKeyStep={(dir) => setBaseCanvasSplit((v) => clampFrac(v + dir * 0.02, 0.2, 0.5))}
      />,
    );
  }

  if (fullscreen) {
    // Canvas を全画面に：下の紙はいまの場所・大きさのまま隠して残す
    baseVisible = false;
    forkVisible = false;
    spine = false;
    canvasBox = { left: 0, width: W, top: 0 };
    canvasFloating = false;
    handles.length = 0;
  }

  return (
    <div ref={containerRef} className="relative min-h-0 flex-1">
      <Layer key="base" layer="base" box={baseBox} visible={baseVisible} floating={false}>
        {baseContent}
      </Layer>
      {spine ? (
        // Base の紙：一番下、画面の右端まで。見えるのは Fork の下からのぞく 32px の帯だけ
        <div key="spine" className="absolute inset-0 overflow-hidden rounded-tl-lg bg-card">
          <div style={{ width: SPINE_WIDTH }} className="h-full">
            <SpineTab label="Base Thread" onOpen={() => stack.close("fork")} />
          </div>
        </div>
      ) : null}
      {hasFork ? (
        <Layer
          key={forkKey}
          layer="fork"
          box={forkBox}
          visible={forkVisible}
          floating
          shadow="fork"
          contentRight={forkContentRight}
        >
          {forkContent}
        </Layer>
      ) : null}
      {hasCanvas ? (
        <Layer key={canvasKey} layer="canvas" box={canvasBox} visible floating={canvasFloating} shadow="canvas">
          {canvasContent}
        </Layer>
      ) : null}
      {handles}
    </div>
  );
}
