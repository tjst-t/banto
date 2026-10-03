// MCP Apps の約束（postMessage の JSON-RPC）で親と話す。**banto を知らない**
// ——この画面が知っているのは仕様の名前（`ui/initialize`・`tools/call`・
// `ui/notifications/size-changed` …）だけ。

export interface ContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: { uri: string; mimeType?: string; blob?: string; text?: string };
}

export interface CallToolResult {
  content?: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export type DisplayMode = "inline" | "fullscreen" | "pip";

export interface HostContext {
  displayMode?: DisplayMode;
  theme?: "light" | "dark";
  toolInfo?: unknown;
  styles?: { variables?: Record<string, string | undefined> };
}

export interface InitializeResult {
  hostContext?: HostContext;
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

