/**
 * 共有ブラウザの面（browser モジュール提供・2026-08-15 の判定）。
 *
 * **番頭と同じブラウザを、POがその場で見て触る。** 画面は CDP の `Page.startScreencast`
 * が送ってくる JPEG のフレームで、操作はこの面から WebSocket でホストへ返し、ホストが
 * `Input.*` へ写して CDP へ送る（VNC は使わない——公開の仕組みは L7 しか通さない）。
 *
 * 映るのは**ブラウザの窓の中だけ**。デスクトップ全体やブラウザ外のアプリは映らない。
 *
 * D5: 判断は無い。フレームを描き、押された場所と打たれた文字をそのまま送るだけ
 * ——座標をページの実座標へ直すのはホスト側（`viewer-protocol.ts` の純関数）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { callModuleTool } from "./useModuleTool.js";
import type { CanvasViewProps } from "./registry.js";
import { Button, ErrorNote, EmptyState, StatusDot, ViewBar, ViewShell, ViewTitle } from "./ui.js";

interface BrowserStatus {
  state: "running" | "stopped";
  launcher: string;
  webSocketDebuggerUrl?: string;
  viewers: number;
  streaming: boolean;
}

interface FrameMetadata {
  deviceWidth?: number;
  deviceHeight?: number;
  offsetTop?: number;
  pageScaleFactor?: number;
}

type HostMessage =
  | { type: "frame"; data: string; metadata: FrameMetadata }
  | { type: "status"; state: "running" | "stopped" }
  | { type: "error"; message: string };

/** モジュールの到達先（相対でも絶対でも来る）から、面が繋ぐ WS の URL を作る。 */
function viewerWsUrl(endpoint: string): string {
  const base = new URL(`${endpoint.replace(/\/$/, "")}/viewer`, window.location.href);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  return base.toString();
}

/** 面の中の座標と、いま映している大きさ。実座標への変換はホスト側の純関数がやる。 */
interface PointerPayload {
  x: number;
  y: number;
  view: { width: number; height: number };
}

/**
 * ホストが受け取る操作の形（`packages/banto-host/src/browser/viewer-protocol.ts` の
 * `ViewerInput` の写し）。banto-web からホストのパッケージは引けないので写しだが、
 * ここを union で置いておけば、面が送る言葉の綴り違い・欠けは型検査で落ちる
 * ——`Record<string, unknown>` のままだと何を送っても通ってしまう。
 */
type ViewerCommand =
  | (PointerPayload & {
      type: "click";
      button?: "left" | "middle" | "right";
      clickCount?: number;
      modifiers?: number;
    })
  | (PointerPayload & { type: "wheel"; deltaX?: number; deltaY?: number; modifiers?: number })
  | { type: "text"; text: string }
  | {
      type: "key";
      key: string;
      code?: string;
      text?: string;
      windowsVirtualKeyCode?: number;
      modifiers?: number;
    };

/** 面の中の座標。画像の実際の表示サイズも一緒に送る（実座標への変換はホスト側）。 */
function pointerPayload(event: { clientX: number; clientY: number }, img: HTMLImageElement): PointerPayload {
  const rect = img.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
    view: { width: rect.width, height: rect.height },
  };
}

export function BrowserViewer({ endpoint }: CanvasViewProps): React.ReactElement {
  const [status, setStatus] = useState<BrowserStatus>();
  const [frame, setFrame] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const wsUrl = useMemo(() => viewerWsUrl(endpoint), [endpoint]);

  const refresh = useCallback(async () => {
    try {
      setStatus(await callModuleTool<BrowserStatus>(endpoint, "browser.status"));
    } catch (err: unknown) {
      // I2: 取れなかったことを「停止中」に見せない
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [endpoint]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 起きているあいだだけ繋ぐ。落ちたら切る（死んだ面にフレームを待たせない）
  useEffect(() => {
    if (status?.state !== "running") {
      socketRef.current?.close();
      socketRef.current = null;
      setFrame(undefined);
      return;
    }
    const socket = new WebSocket(wsUrl);
    socketRef.current = socket;
    socket.onmessage = (event: MessageEvent<string>) => {
      let message: HostMessage;
      try {
        message = JSON.parse(event.data) as HostMessage;
      } catch {
        return;
      }
      if (message.type === "frame") setFrame(message.data);
      else if (message.type === "error") setError(message.message);
      else if (message.type === "status" && message.state === "stopped") void refresh();
    };
    socket.onclose = () => {
      if (socketRef.current === socket) socketRef.current = null;
    };
    return () => {
      socket.onclose = null;
      socket.close();
    };
  }, [status?.state, wsUrl, refresh]);

  const send = useCallback((message: ViewerCommand): void => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));
  }, []);

  const act = useCallback(
    async (tool: "browser.start" | "browser.stop") => {
      setBusy(true);
      setError(undefined);
      try {
        setStatus(await callModuleTool<BrowserStatus>(endpoint, tool));
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [endpoint]
  );

  const running = status?.state === "running";

  return (
    <ViewShell className="cv-browser">
      <ViewBar>
        <ViewTitle>ブラウザ</ViewTitle>
        <StatusDot tone={running ? "ok" : "neutral"} title={running ? "起きています" : "停止中"} />
        <span className="cv-muted">{running ? "起動中" : "停止中"}</span>
        <span style={{ flex: 1 }} />
        <Button small disabled={busy} onClick={() => void act(running ? "browser.stop" : "browser.start")}>
          {running ? "落とす" : "起こす"}
        </Button>
        <Button small variant="ghost" disabled={busy} onClick={() => void refresh()}>
          取り直す
        </Button>
      </ViewBar>

      {error && <ErrorNote onRetry={() => void refresh()}>{error}</ErrorNote>}

      {!running && (
        <EmptyState title="ブラウザが起きていません">
          「起こす」を押すと、番頭と同じブラウザがここに映ります。映るのはブラウザの窓の中だけです。
        </EmptyState>
      )}

      {running && (
        <div className="cv-browser-stage">
          {frame ? (
            <img
              ref={imgRef}
              className="cv-browser-frame"
              alt="共有ブラウザの画面"
              src={`data:image/jpeg;base64,${frame}`}
              onClick={(event) => {
                const img = imgRef.current;
                if (!img) return;
                send({ type: "click", ...pointerPayload(event, img), button: "left", clickCount: 1 });
              }}
              onWheel={(event) => {
                const img = imgRef.current;
                if (!img) return;
                send({
                  type: "wheel",
                  ...pointerPayload(event, img),
                  deltaX: event.deltaX,
                  deltaY: event.deltaY,
                });
              }}
            />
          ) : (
            <EmptyState title="画面が届くのを待っています">
              静止しているあいだはフレームが送られません。触ると流れ始めます。
            </EmptyState>
          )}

          {/**
           * 文字は**確定済みの文字列**として送る（`Input.insertText`）。日本語がこれで
           * 入ることは実測済みで、ブラウザ側の IME は要らない——変換はこの欄で済ませる。
           */}
          <form
            className="cv-browser-input"
            onSubmit={(event) => {
              event.preventDefault();
              if (typed.length === 0) return;
              send({ type: "text", text: typed });
              setTyped("");
            }}
          >
            <input
              type="text"
              value={typed}
              placeholder="ここに打って Enter で送る（日本語も可）"
              onChange={(event) => setTyped(event.target.value)}
            />
            <Button small type="submit" disabled={typed.length === 0}>
              送る
            </Button>
            <Button small variant="ghost" onClick={() => send({ type: "key", key: "Enter", code: "Enter", text: "\r" })}>
              Enter
            </Button>
            <Button
              small
              variant="ghost"
              onClick={() => send({ type: "key", key: "Backspace", code: "Backspace" })}
            >
              ⌫
            </Button>
          </form>
        </div>
      )}
    </ViewShell>
  );
}
