// MCP Apps の約束（postMessage の JSON-RPC）で親と話す。**banto を知らない**
// ——この画面が知っているのは仕様の名前（`ui/initialize`・`tools/call`・
// `ui/download-file` …）だけ。

export interface ContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: { uri: string; mimeType?: string; blob?: string; text?: string };
}

export interface CallToolResult {
  content?: ContentBlock[];
  isError?: boolean;
}

export type DisplayMode = "inline" | "fullscreen" | "pip";

/**
 * **画面の見ている場所**（banto の拡張、`dev.banto/view-state`、2026-09-23）。MCP Apps には
 * 「画面が自分の状態を host に預け、開き直したときに返してもらう」口が無い（OpenAI Apps SDK の
 * widget state にあたるもの）。banto は大きく開いた画面についてこれを URL に持ち、リロードや
 * 別タブで開き直したときに `hostContext` で返す。**banto 以外の host では来ないだけ**。
 */
export const VIEW_STATE_KEY = "dev.banto/view-state";

export interface HostContext {
  displayMode?: DisplayMode;
  theme?: "light" | "dark";
  toolInfo?: unknown;
  styles?: { variables?: Record<string, string | undefined> };
  [VIEW_STATE_KEY]?: unknown;
}

export interface InitializeResult {
  hostContext?: HostContext;
  hostCapabilities?: { downloadFile?: object };
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
}

let nextId = 1;
const waiting = new Map<number | string, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
const listeners = new Map<string, Array<(params: unknown) => void>>();

function post(message: JsonRpcMessage): void {
  window.parent.postMessage(message, "*");
}

export function request<T>(method: string, params?: object): Promise<T> {
  const id = nextId++;
  post({ jsonrpc: "2.0", id, method, params });
  return new Promise<T>((resolve, reject) => {
    waiting.set(id, { resolve: (value) => resolve(value as T), reject });
  });
}

export function notify(method: string, params: object = {}): void {
  post({ jsonrpc: "2.0", method, params });
}

export function onNotification(method: string, listener: (params: unknown) => void): void {
  const list = listeners.get(method) ?? [];
  list.push(listener);
  listeners.set(method, list);
}

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  // 親（サンドボックスの中継）からのものだけ。中に埋めたプレビューの iframe などは相手にしない
  if (event.source !== window.parent) return;
  const msg = event.data as JsonRpcMessage | null;
  if (!msg || msg.jsonrpc !== "2.0") return;
  if (msg.id !== undefined && msg.method === undefined) {
    const entry = waiting.get(msg.id);
    if (!entry) return;
    waiting.delete(msg.id);
    if (msg.error) entry.reject(new Error(msg.error.message || "呼び出しに失敗しました"));
    else entry.resolve(msg.result);
    return;
  }
  if (typeof msg.method !== "string") return;
  if (msg.id !== undefined) {
    // host からの要求。片付け（teardown）と ping にだけ答え、知らないものは知らないと返す
    if (msg.method === "ui/resource-teardown" || msg.method === "ping") post({ jsonrpc: "2.0", id: msg.id, result: {} });
    else post({ jsonrpc: "2.0", id: msg.id, error: { message: `Method not found: ${msg.method}` } });
    return;
  }
  for (const listener of listeners.get(msg.method) ?? []) listener(msg.params ?? {});
});

/** 見ている場所を host に預ける（受けない host では何も起きない）。 */
export function reportViewState(state: Record<string, unknown>): void {
  notify(VIEW_STATE_KEY, { state });
}

export function textOf(result: CallToolResult): string {
  return (result.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

/** 自分の Module の tool を呼ぶ。**失敗は例外にする**（`isError` を成功として扱わない、規則2）。 */
export async function callTool(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  const result = await request<CallToolResult>("tools/call", { name, arguments: args });
  if (!result) throw new Error(`${name} の結果が空でした`);
  if (result.isError) throw new Error(textOf(result) || `${name} に失敗しました`);
  return result;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 画面の高さを host に伝える（inline のカードはこれで高さが決まる）。 */
export function reportSize(): void {
  notify("ui/notifications/size-changed", { height: Math.ceil(document.documentElement.scrollHeight) });
}

/** 大きく出してほしいと**頼む**（決めるのは host、§6.2 の交渉モデル）。いまの mode が返る。 */
export async function requestDisplayMode(mode: DisplayMode): Promise<DisplayMode | undefined> {
  const result = await request<{ mode?: DisplayMode }>("ui/request-display-mode", { mode });
  return result?.mode;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * **ダウンロードは host に頼む**（MCP Apps の `ui/download-file`）。この画面は
 * サンドボックスの中にいて、自分ではファイルを保存させられない——仕様がそのための
 * 口を用意している（規則12）。断られたら例外にする。
 */
export async function downloadViaHost(uri: string, mimeType: string, base64: string): Promise<void> {
  const result = await request<{ isError?: boolean }>("ui/download-file", {
    contents: [{ type: "resource", resource: { uri, mimeType, blob: base64 } }],
  });
  if (result?.isError) throw new Error("ダウンロードできませんでした（取りやめたか、画面の外で断られました）");
}
