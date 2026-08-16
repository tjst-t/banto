/**
 * 面（canvas）とホストのあいだで交わす言葉と、それを CDP へ写す純関数。
 *
 * **ここは全部純関数**。WebSocket もブラウザも知らない——面から来た1件を CDP の
 * コマンド列へ直すだけで、送るのは `session.ts` の仕事。試験で固定したいのはこの写しと
 * 座標の直し方なので、外へ触る部分と混ぜない（D5）。
 *
 * 変換の対応（2026-08-15 の実測どおり）：
 *   - クリック → `Input.dispatchMouseEvent`（mouseMoved → mousePressed → mouseReleased）
 *   - ホイール → `Input.dispatchMouseEvent`（mouseWheel）
 *   - 文字入力 → `Input.insertText`（**日本語もこれで通る。IME は要らない**）
 *   - 特殊キー → `Input.dispatchKeyEvent`（keyDown → keyUp）
 */

/** 面に描いている大きさ（CSS px）。 */
export interface ViewerSize {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** `Page.screencastFrame` の `metadata`（使うものだけ）。 */
export interface ScreencastMetadata {
  /** フレームの実寸（DIP）。 */
  deviceWidth?: number;
  deviceHeight?: number;
  /** フレームの上端が、可視域のどこから始まるか（DIP）。 */
  offsetTop?: number;
  /** ピンチ拡大率。CSS px = DIP ÷ これ。 */
  pageScaleFactor?: number;
  scrollOffsetX?: number;
  scrollOffsetY?: number;
}

/** CDP へ送る1件。 */
export interface CdpCall {
  method: string;
  params: Record<string, unknown>;
}

/** 正の有限数だけを採り、それ以外は既定へ落とす（0 で割らないため）。 */
function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * 面の座標 → ページの実座標（CSS px）。**ここが縦串の要**。
 *
 * 面は受け取った JPEG を自分の表示サイズへ伸ばして描くので、面の座標とページの座標は
 * 一致しない。直し方は DevTools の ScreencastView と同じ順で：
 *
 *   1. 面の表示サイズ → フレームの実寸（DIP）へ、幅と高さそれぞれの比で伸ばす
 *   2. `offsetTop`（フレームの上端の位置）を引く
 *   3. `pageScaleFactor`（ピンチ拡大）で割って CSS px へ戻す
 *
 * 実寸や表示サイズが 0・欠落のときは倍率 1 として扱う——**座標を NaN にして
 * 「押したのに何も起きない」を作らない**（I2）。
 */
export function toPageCoordinates(
  point: Point,
  view: ViewerSize,
  metadata: ScreencastMetadata = {}
): Point {
  const viewWidth = positive(view.width, 0);
  const viewHeight = positive(view.height, 0);
  const deviceWidth = positive(metadata.deviceWidth, 0);
  const deviceHeight = positive(metadata.deviceHeight, 0);

  const scaleX = viewWidth > 0 && deviceWidth > 0 ? deviceWidth / viewWidth : 1;
  const scaleY = viewHeight > 0 && deviceHeight > 0 ? deviceHeight / viewHeight : 1;
  const pageScale = positive(metadata.pageScaleFactor, 1);
  const offsetTop = finite(metadata.offsetTop, 0);

  return {
    x: (finite(point.x, 0) * scaleX) / pageScale,
    y: (finite(point.y, 0) * scaleY - offsetTop) / pageScale,
  };
}

// ── 面から来る言葉 ───────────────────────────────────────────────────────────

export type MouseButton = "left" | "middle" | "right";

export type ViewerInput =
  | {
      type: "click";
      x: number;
      y: number;
      view: ViewerSize;
      button?: MouseButton;
      clickCount?: number;
      modifiers?: number;
    }
  | {
      type: "wheel";
      x: number;
      y: number;
      view: ViewerSize;
      deltaX?: number;
      deltaY?: number;
      modifiers?: number;
    }
  | { type: "text"; text: string }
  | {
      type: "key";
      key: string;
      code?: string;
      text?: string;
      windowsVirtualKeyCode?: number;
      modifiers?: number;
    };

/** ホストから面へ流すもの。 */
export type ViewerMessage =
  | { type: "frame"; data: string; metadata: ScreencastMetadata }
  | { type: "status"; state: "running" | "stopped" }
  | { type: "error"; message: string };

/** マウスボタンのビットマスク（CDP の `buttons`）。 */
const BUTTON_MASK: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 };

function readSize(raw: unknown): ViewerSize {
  const v = (raw ?? {}) as { width?: unknown; height?: unknown };
  return { width: finite(v.width, 0), height: finite(v.height, 0) };
}

/**
 * 面から来た JSON を読む。
 *
 * I2: 知らない型・欠けた項目は黙って捨てず、理由を添えて失敗させる
 * （面は理由を受け取って画面に出せる）。
 */
export function parseViewerInput(raw: unknown): ViewerInput {
  const msg = (raw ?? {}) as Record<string, unknown>;
  const type = msg["type"];

  if (type === "click" || type === "wheel") {
    const view = readSize(msg["view"]);
    const base = {
      x: finite(msg["x"], 0),
      y: finite(msg["y"], 0),
      view,
      ...(typeof msg["modifiers"] === "number" ? { modifiers: msg["modifiers"] } : {}),
    };
    if (type === "click") {
      const button = msg["button"];
      return {
        type: "click",
        ...base,
        ...(button === "left" || button === "middle" || button === "right" ? { button } : {}),
        ...(typeof msg["clickCount"] === "number" ? { clickCount: msg["clickCount"] } : {}),
      };
    }
    return {
      type: "wheel",
      ...base,
      deltaX: finite(msg["deltaX"], 0),
      deltaY: finite(msg["deltaY"], 0),
    };
  }

  if (type === "text") {
    const text = msg["text"];
    if (typeof text !== "string" || text.length === 0) {
      throw new Error("text には空でない文字列が要ります。");
    }
    return { type: "text", text };
  }

  if (type === "key") {
    const key = msg["key"];
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("key には空でない文字列が要ります。");
    }
    return {
      type: "key",
      key,
      ...(typeof msg["code"] === "string" ? { code: msg["code"] } : {}),
      ...(typeof msg["text"] === "string" ? { text: msg["text"] } : {}),
      ...(typeof msg["windowsVirtualKeyCode"] === "number"
        ? { windowsVirtualKeyCode: msg["windowsVirtualKeyCode"] }
        : {}),
      ...(typeof msg["modifiers"] === "number" ? { modifiers: msg["modifiers"] } : {}),
    };
  }

  throw new Error(`知らない操作です: ${JSON.stringify(type)}`);
}

/**
 * 面から来た1件を、CDP へ送るコマンド列へ写す。
 *
 * クリックが3件になるのは実測どおり——`mouseMoved` を先に送らないと、hover 前提の
 * 要素（メニュー等）が反応しない。
 */
export function toCdpCalls(input: ViewerInput, metadata: ScreencastMetadata = {}): CdpCall[] {
  if (input.type === "text") {
    return [{ method: "Input.insertText", params: { text: input.text } }];
  }

  if (input.type === "key") {
    const common: Record<string, unknown> = {
      key: input.key,
      ...(input.code ? { code: input.code } : {}),
      ...(input.windowsVirtualKeyCode !== undefined
        ? {
            windowsVirtualKeyCode: input.windowsVirtualKeyCode,
            nativeVirtualKeyCode: input.windowsVirtualKeyCode,
          }
        : {}),
      ...(input.modifiers !== undefined ? { modifiers: input.modifiers } : {}),
    };
    return [
      {
        method: "Input.dispatchKeyEvent",
        params: {
          ...common,
          // 文字を伴うキーは keyDown、伴わないキーは rawKeyDown（CDP の作法）
          type: input.text ? "keyDown" : "rawKeyDown",
          ...(input.text ? { text: input.text } : {}),
        },
      },
      { method: "Input.dispatchKeyEvent", params: { ...common, type: "keyUp" } },
    ];
  }

  const point = toPageCoordinates({ x: input.x, y: input.y }, input.view, metadata);
  const modifiers = input.modifiers ?? 0;

  if (input.type === "wheel") {
    return [
      {
        method: "Input.dispatchMouseEvent",
        params: {
          type: "mouseWheel",
          x: point.x,
          y: point.y,
          deltaX: input.deltaX ?? 0,
          deltaY: input.deltaY ?? 0,
          modifiers,
        },
      },
    ];
  }

  const button = input.button ?? "left";
  const clickCount = input.clickCount ?? 1;
  const buttons = BUTTON_MASK[button];
  return [
    {
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseMoved", x: point.x, y: point.y, button: "none", buttons: 0, modifiers },
    },
    {
      method: "Input.dispatchMouseEvent",
      params: { type: "mousePressed", x: point.x, y: point.y, button, buttons, clickCount, modifiers },
    },
    {
      method: "Input.dispatchMouseEvent",
      params: {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button,
        buttons: 0,
        clickCount,
        modifiers,
      },
    },
  ];
}
