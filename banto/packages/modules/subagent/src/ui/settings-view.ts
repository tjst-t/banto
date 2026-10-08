// サブエージェントの設定画面（ブラウザで動く。`config-app.ts` がこの JS を HTML に埋める）。
// banto 全体の設定の「Module ごとの設定」に出る。MCP Apps の約束だけで親と話す。
//
// エージェントごとに1枚のカード。本体のログインを使うもの（Claude Code）は使わせ方の案内だけ、鍵を使うもの
// （OpenCode）は変数ごとに1行——どこの鍵か・入っているか・取り込む／貼る／置き換える／消す。
// **値は画面に出さない**（入力欄は password、保存したら空にする）。

interface KeyRow { env: string; alias: string; set: boolean; importable: boolean }
interface AgentCredentials {
  id: string; title: string; importLabel?: string;
  /** 本体の Claude ログインを使う（使わせるかは Project ごとの設定——決定・2026-09-27） */
  sharesHostLogin?: true;
  keys?: KeyRow[];
}
interface ToolResult { content?: { type: string; text?: string }[]; isError?: boolean }

let nextId = 1;
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
function send(message: Record<string, unknown>): void {
  window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
}
function request<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const id = nextId++;
  send({ id, method, params });
  return new Promise<T>((resolve, reject) => waiting.set(id, { resolve: resolve as (v: unknown) => void, reject }));
}
/** host（banto）の明暗と色・段を当てる——開くときと、明暗が変わって渡し直されたとき（v4-frontend.md §6.27） */
interface Appearance { theme?: string; styles?: { variables?: Record<string, string | undefined> } }
function applyAppearance(ctx: Appearance): void {
  if (ctx.theme) document.documentElement.dataset.theme = ctx.theme;
  for (const [k, v] of Object.entries(ctx.styles?.variables ?? {})) {
    if (k.startsWith("--") && typeof v === "string") document.documentElement.style.setProperty(k, v);
  }
}
window.addEventListener("message", (event: MessageEvent) => {
  const msg = event.data as { jsonrpc?: string; id?: number; method?: string; result?: unknown; error?: { message?: string }; params?: unknown };
  if (!msg || msg.jsonrpc !== "2.0") return;
  if (msg.id !== undefined && waiting.has(msg.id)) {
    const w = waiting.get(msg.id)!;
    waiting.delete(msg.id);
    if (msg.error) w.reject(new Error(msg.error.message || "呼び出しに失敗しました"));
    else w.resolve(msg.result);
    return;
  }
  if (msg.method === "ui/notifications/host-context-changed") applyAppearance(msg.params as Appearance);
});
async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await request<ToolResult>("tools/call", { name, arguments: args });
  const text = result.content?.[0]?.text ?? "";
  if (result.isError) throw new Error(text || `${name} が失敗しました`);
  return JSON.parse(text) as T;
}
function reportSize(): void {
  send({ method: "ui/notifications/size-changed", params: { height: document.documentElement.scrollHeight } });
}

type Child = Node | string | false | null | undefined;
function h(tag: string, attrs: Record<string, string | undefined> = {}, children: Child[] = []): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    if (k === "text") e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c) e.append(c);
  return e;
}

/** どこの鍵か（変数名だけでは分かりにくいので、人に通じる名前を添える） */
const KEY_SOURCE: Record<string, string> = {
  OPENCODE_API_KEY: "OpenCode Go・Zen",
  ANTHROPIC_API_KEY: "Anthropic",
  OPENAI_API_KEY: "OpenAI",
  OPENROUTER_API_KEY: "OpenRouter",
  CLAUDE_CODE_OAUTH_TOKEN: "Claude",
  FAKE_AGENT_TOKEN: "試験用",
};

const app = document.getElementById("app")!;
const state: { agents: AgentCredentials[]; editing: string | null; message?: { tone: "ok" | "danger"; text: string }; busy: boolean } = {
  agents: [], editing: null, busy: false,
};

async function act(words: [string, string, string], fn: () => Promise<unknown>): Promise<void> {
  state.busy = true;
  state.message = { tone: "ok", text: `${words[0]}…` };
  render();
  try {
    await fn();
    state.agents = (await call<{ agents: AgentCredentials[] }>("getCredentials")).agents;
    state.editing = null;
    state.message = { tone: "ok", text: words[1] };
  } catch (err) {
    state.message = { tone: "danger", text: `${words[2]}：${(err as Error).message}` };
  }
  state.busy = false;
  render();
}

function keyRow(agent: AgentCredentials, key: KeyRow): HTMLElement {
  const editing = state.editing === `${agent.id}:${key.env}`;
  const actions: Child[] = [];
  if (key.importable) {
    // 見えている文字と、読み上げの名前を揃える（設定済みなら「取り込み直す」）
    const b = h("button", { type: "button", class: key.set ? "btn" : "btn btn-primary", text: key.set ? "取り込み直す" : `${agent.importLabel ?? "この機械"}から取り込む` });
    b.addEventListener("click", () => act([`${key.env} を取り込んでいます`, `${key.env} を取り込みました`, `${key.env} を取り込めませんでした`], () => call("importCredential", { agent: agent.id, env: key.env })));
    actions.push(b);
  }
  if (!editing) {
    const paste = h("button", { type: "button", class: "btn", text: key.set ? "置き換える" : "鍵を貼る" });
    paste.addEventListener("click", () => { state.editing = `${agent.id}:${key.env}`; state.message = undefined; render(); app.querySelector<HTMLInputElement>(".paste input")?.focus(); });
    actions.push(paste);
  }
  if (key.set) {
    const del = h("button", { type: "button", class: "btn btn-quiet btn-danger", text: "消す" });
    del.addEventListener("click", () => act([`${key.env} を消しています`, `${key.env} を消しました`, `${key.env} を消せませんでした`], () => call("deleteCredential", { agent: agent.id, env: key.env })));
    actions.push(del);
  }
  for (const a of actions) if (a instanceof HTMLElement && state.busy) a.setAttribute("disabled", "");

  const row = h("div", { class: "key", "data-role": "credential", "data-agent": agent.id, "data-env": key.env }, [
    h("div", { class: "key-name" }, [
      h("code", { class: "mono", text: key.env }),
      KEY_SOURCE[key.env] ? h("span", { class: "muted", text: KEY_SOURCE[key.env] }) : null,
    ]),
    h("span", { class: "pill", "data-tone": key.set ? "ok" : undefined, "data-role": "state" }, [h("span", { class: "dot" }), key.set ? "設定済み" : "未設定"]),
    h("div", { class: "key-actions" }, actions),
  ]);
  if (editing) {
    const input = h("input", { type: "password", placeholder: key.set ? "新しい鍵" : "鍵", "aria-label": `${key.env} の鍵`, autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
    const save = h("button", { type: "submit", class: "btn btn-primary", text: key.set ? "貼り付けて置き換える" : "貼り付けて保存" });
    const cancel = h("button", { type: "button", class: "btn btn-quiet", text: "やめる" });
    cancel.addEventListener("click", () => { state.editing = null; render(); });
    const form = h("form", { class: "paste" }, [input, save, cancel]);
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const value = input.value;
      input.value = "";
      void act([`${key.env} を保存しています`, `${key.env} を保存しました`, `${key.env} を保存できませんでした`], () => call("setCredential", { agent: agent.id, env: key.env, value }));
    });
    row.append(form);
  }
  return row;
}

function card(agent: AgentCredentials): HTMLElement {
  if (agent.sharesHostLogin) {
    return h("section", { class: "card", "data-agent": agent.id }, [
      h("header", { class: "card-head" }, [
        h("h2", { class: "card-title", text: agent.title }),
        h("span", { class: "pill", "data-tone": "ok" }, [h("span", { class: "dot" }), "本体のログイン"]),
      ]),
      h("p", {
        class: "card-note", "data-role": "host-login", "data-agent": agent.id,
        text: "banto 本体の Claude ログインを使います。入れるものはありません。使わせるかどうかと、使った回数は Project 設定の「Claude のログイン」で見ます。",
      }),
    ]);
  }
  const keys = agent.keys ?? [];
  const setCount = keys.filter((k) => k.set).length;
  return h("section", { class: "card", "data-agent": agent.id }, [
    h("header", { class: "card-head" }, [
      h("h2", { class: "card-title", text: agent.title }),
      h("span", { class: "pill", "data-tone": setCount ? "ok" : "warn" }, [h("span", { class: "dot" }), setCount ? `鍵 ${setCount}件` : "鍵なし"]),
    ]),
    h("p", { class: "card-note", text: "鍵は banto 全体の Vault に置き、どの Project でも使います。サブエージェントのシェルから読めるので、渡してよいものだけを入れてください。" }),
    h("div", { class: "keys" }, keys.map((k) => keyRow(agent, k))),
  ]);
}

function render(): void {
  const focused = (document.activeElement as HTMLElement | null)?.getAttribute("aria-label");
  app.replaceChildren(
    ...state.agents.map(card),
    state.message ? h("p", { class: `message message-${state.message.tone}`, role: "status", text: state.message.text }) : "",
  );
  if (focused) app.querySelector<HTMLElement>(`[aria-label="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  reportSize();
}

(async () => {
  try {
    const init = await request<{ hostContext?: { theme?: string; styles?: { variables?: Record<string, string | undefined> } } }>("ui/initialize", {
      protocolVersion: "2026-01-26",
      appInfo: { name: "banto-subagent-config", version: "0.2.0" },
      appCapabilities: { availableDisplayModes: ["inline"] },
    });
    const ctx = init.hostContext ?? {};
    applyAppearance(ctx);
    send({ method: "ui/notifications/initialized", params: {} });
    state.agents = (await call<{ agents: AgentCredentials[] }>("getCredentials")).agents;
  } catch (err) {
    state.message = { tone: "danger", text: `設定を開けませんでした：${(err as Error).message}` };
  }
  render();
  new ResizeObserver(() => reportSize()).observe(document.body);
})();
