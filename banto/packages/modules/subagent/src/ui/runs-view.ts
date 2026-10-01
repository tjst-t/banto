// サブエージェントの入口の画面（ブラウザで動く。`runs-app.ts` がこの JS を HTML に埋める）。
// banto を知らない——MCP Apps の約束（postMessage の JSON-RPC）だけで親と話す。
//
// 形：狭いとき（会話の隣）は「一覧 → 選ぶと中身」、広いとき（720px〜）は左右2枚。
// **この画面の芯は「経過」**——サブエージェントが何をどの順に、いつしたかを縦の線でたどる。
// 会話の側では途中経過が見えないので、走っている間の様子（書きかけの返答まで）はここでしか見えない。

type Status = "running" | "done" | "cancelled" | "error";
interface Step { at: number; title: string; kind?: string }
interface Summary {
  id: string; agent: string; agentTitle: string; status: Status; startedAt: number; finishedAt?: number;
  lastProgress?: string; cost?: { amount: number; currency: string }; model?: string;
  promptHead: string; toolCount: number; lastStep?: Step;
}
interface RunRecord extends Omit<Summary, "promptHead" | "toolCount" | "lastStep"> {
  prompt: string; effort?: string; resumedFrom?: string; toolCalls: string[]; steps: Step[];
  sessionId?: string; stopReason?: string; text?: string; error?: string; notes?: string[];
  usage?: { inputTokens: number; outputTokens: number; cachedReadTokens?: number | null; cachedWriteTokens?: number | null };
  context?: { used: number; size: number };
  permissions?: { title: string; answer: string }[];
}
interface Agent {
  id: string; title: string;
  hostLogin?: { loggedIn: true; subscriptionType?: string } | { loggedIn: false; reason: string };
  keys?: string[]; keysError?: string;
}
interface ToolResult { content?: { type: string; text?: string }[]; isError?: boolean }

// ---- 親との話し方（MCP Apps） ------------------------------------------------------------
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
  // **失敗を成功に見せない**
  if (result.isError) throw new Error(text || `${name} が失敗しました`);
  return JSON.parse(text) as T;
}
function reportSize(): void {
  send({ method: "ui/notifications/size-changed", params: { height: document.documentElement.scrollHeight } });
}

// ---- 部品 ----------------------------------------------------------------------------
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
const SVG_NS = "http://www.w3.org/2000/svg";
/** lucide の線画（24 の座標系、線 2） */
const PATHS: Record<string, string[]> = {
  check: ["M20 6 9 17l-5-5"],
  x: ["M18 6 6 18", "m6 6 12 12"],
  square: ["M6 6h12v12H6z"],
  read: ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4", "M10 13h4", "M10 17h4"],
  edit: ["M21.17 6.81a1 1 0 0 0-3.98-3.98L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5Z"],
  delete: ["M3 6h18", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"],
  move: ["M5 12h14", "m12 5 7 7-7 7"],
  search: ["M21 21l-4.34-4.34", "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z"],
  execute: ["m4 17 6-6-6-6", "M12 19h8"],
  think: ["M12 3v2", "M12 19v2", "M5 12H3", "M21 12h-2", "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"],
  fetch: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "M2 12h20", "M12 2a15.3 15.3 0 0 1 0 20", "M12 2a15.3 15.3 0 0 0 0 20"],
  other: ["M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"],
  back: ["m15 18-6-6 6-6"],
  spark: ["M9.94 14.06 4 20", "M20 4l-5.94 5.94", "M12 2l1.5 5.5L19 9l-5.5 1.5L12 16l-1.5-5.5L5 9l5.5-1.5Z"],
};
function icon(name: string, cls = "icon"): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  for (const d of PATHS[name] ?? PATHS.other!) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}
const KIND_LABEL: Record<string, string> = {
  read: "読む", edit: "書く", delete: "消す", move: "動かす", search: "探す",
  execute: "実行", think: "考える", fetch: "取得", switch_mode: "切替", other: "ツール",
};
const STATUS_LABEL: Record<Status, string> = { running: "実行中", done: "完了", cancelled: "取り消し", error: "失敗" };
const STATUS_TONE: Record<Status, string | undefined> = { running: "accent", done: "ok", cancelled: undefined, error: "danger" };

function statusGlyph(status: Status): Element {
  if (status === "running") {
    const g = h("span", { class: "glyph glyph-running", "aria-hidden": "true" });
    return g;
  }
  const name = status === "done" ? "check" : status === "error" ? "x" : "square";
  return h("span", { class: `glyph glyph-${status}`, "aria-hidden": "true" }, [icon(name)]);
}

// ---- 数え方 ---------------------------------------------------------------------------
function duration(from: number, to?: number): string {
  const s = Math.max(0, Math.round(((to ?? Date.now()) - from) / 1000));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${s % 60 ? `${s % 60}秒` : ""}`;
  return `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ""}`;
}
function offset(from: number, at: number): string {
  const s = Math.max(0, Math.round((at - from) / 1000));
  return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function when(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 45_000) return "たった今";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}分前`;
  const d = new Date(ms);
  const hm = d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
/** 一覧ではモデルの提供元を外す（`opencode-go/qwen3.6-plus` → `qwen3.6-plus`）。中身では全部出す */
const shortModel = (model: string) => model.split("/").pop() ?? model;
const money = (c?: { amount: number; currency: string }) => (c ? `$${c.amount.toFixed(c.amount < 0.1 ? 3 : 2)}` : undefined);
const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

// ---- 状態 ------------------------------------------------------------------------------
/** 終わった仕事を一度に見せる数。「もっと見る」で同じだけ足す（決定・2026-10-01、ユーザー要望——増え続けても重くしない） */
const PAGE = 10;
const state: {
  agents: Agent[]; agentsError?: string; runs: Summary[]; selected: string | null; detail: RunRecord | null; error?: string; loaded: boolean;
  /** いま見せている終わった仕事の数と、Module が覚えている総数 */
  limit: number; finishedTotal: number;
} = {
  agents: [], runs: [], selected: null, detail: null, loaded: false, limit: PAGE, finishedTotal: 0,
};
const app = document.getElementById("app")!;
const wide = () => window.innerWidth >= 720;

// ---- 描く ------------------------------------------------------------------------------
function renderAgents(): HTMLElement {
  const box = h("div", { class: "agents" });
  for (const a of state.agents) {
    let tone = "ok";
    let label: string;
    if (a.hostLogin) {
      label = a.hostLogin.loggedIn ? `本体のログイン${a.hostLogin.subscriptionType ? `・${a.hostLogin.subscriptionType}` : ""}` : "本体が未ログイン";
      if (!a.hostLogin.loggedIn) tone = "danger";
    } else if (a.keysError) {
      label = "鍵を確かめられない";
      tone = "warn";
    } else {
      label = a.keys?.length ? `鍵 ${a.keys.join("・")}` : "鍵なし";
      if (!a.keys?.length) tone = "warn";
    }
    const title = a.hostLogin && !a.hostLogin.loggedIn ? a.hostLogin.reason : a.keysError ?? (a.keys ? "鍵は banto 全体の設定の「サブエージェント」で入れる" : undefined);
    box.append(
      h("span", { class: "agent", "data-role": "agent", "data-agent": a.id, "data-tone": tone, title }, [
        h("span", { class: "dot" }),
        h("span", { class: "agent-name", text: a.title }),
        h("span", { class: "agent-state", text: label }),
      ]),
    );
  }
  return box;
}

function renderRow(r: Summary): HTMLElement {
  const row = h("button", {
    type: "button", class: "run", "data-role": "run", "data-run": r.id, "data-status": r.status, "data-focus": `run:${r.id}`,
    "aria-current": r.id === state.selected ? "true" : undefined,
    "aria-label": `${STATUS_LABEL[r.status]}：${r.promptHead}`,
  }, [
    statusGlyph(r.status),
    h("span", { class: "run-main" }, [
      h("span", { class: "run-prompt", "data-role": "prompt", text: r.promptHead }),
      // 付帯情報は**ひとかたまりずつ折り返さない**（「ツ／ール」のように語の途中で折れない）
      h("span", { class: "run-meta" }, [
        h("span", { "data-role": "status", class: `status-word status-${r.status}`, text: STATUS_LABEL[r.status] }),
        ...[
          r.model ? `${r.agentTitle}（${shortModel(r.model)}）` : r.agentTitle,
          duration(r.startedAt, r.finishedAt),
          r.toolCount ? `ツール ${r.toolCount}回` : undefined,
          money(r.cost),
        ]
          .filter((x): x is string => Boolean(x))
          .flatMap((x) => [" · ", h("span", { class: "nowrap", text: x })]),
      ]),
      r.status === "running"
        ? h("span", { class: "run-live", "data-role": "progress" }, [
            icon(r.lastStep?.kind ?? "spark"),
            h("span", { class: "truncate", text: r.lastStep ? r.lastStep.title : (r.lastProgress ?? "起こしています…") }),
          ])
        : null,
    ]),
    h("span", { class: "run-when", text: when(r.startedAt) }),
  ]);
  row.addEventListener("click", () => select(r.id));
  return row;
}

function stopButton(id: string): HTMLElement {
  const b = h("button", { type: "button", class: "btn btn-quiet btn-danger stop", "data-focus": `stop:${id}`, title: "この仕事を止める" }, [icon("square"), "止める"]);
  b.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    b.setAttribute("disabled", "");
    try {
      await call("cancelRun", { id });
      await refresh();
    } catch (err) {
      state.error = `止められませんでした：${(err as Error).message}`;
      render();
    }
  });
  return b;
}

function renderList(): HTMLElement {
  const list = h("section", { class: "list", "aria-label": "頼んだ仕事" });
  if (!state.loaded) return list;
  if (state.runs.length === 0) {
    list.append(
      h("div", { class: "empty", "data-role": "empty" }, [
        icon("spark", "icon-md"),
        h("p", { class: "empty-title", text: "まだ頼んだ仕事はありません" }),
        h("p", { class: "muted", text: "会話で「Claude Code にテストを直させて」のように頼むと、ここに並びます。" }),
      ]),
    );
    return list;
  }
  const running = state.runs.filter((r) => r.status === "running");
  const finished = state.runs.filter((r) => r.status !== "running");
  for (const [label, rows] of [["実行中", running], ["終わった仕事", finished]] as const) {
    if (rows.length === 0) continue;
    list.append(h("h2", { class: "list-label" }, [label, h("span", { class: "count", text: String(label === "終わった仕事" ? state.finishedTotal : rows.length) })]));
    for (const r of rows) {
      const item = h("div", { class: "run-item", "data-role": "run-item", "data-run": r.id, "data-status": r.status }, [renderRow(r)]);
      if (r.status === "running") item.append(stopButton(r.id));
      list.append(item);
    }
  }
  const shownFinished = finished.length;
  if (state.finishedTotal > shownFinished) {
    const more = h("button", { type: "button", class: "btn btn-quiet more", "data-role": "more-runs", "data-focus": "more" }, [
      `もっと見る（残り ${state.finishedTotal - shownFinished} 件）`,
    ]);
    more.addEventListener("click", () => {
      state.limit += PAGE;
      void refresh();
    });
    list.append(more);
  }
  return list;
}

function fact(label: string, value: string | undefined, attrs: Record<string, string> = {}): HTMLElement | null {
  if (!value) return null;
  return h("div", { class: "fact" }, [h("dt", { text: label }), h("dd", { ...attrs, text: value })]);
}

/** **経過**——呼んだ tool を順に、始めてからの時刻と種類つきで。最後に結末（返答・失敗・取り消し・いま） */
function renderTrace(r: RunRecord): HTMLElement {
  const ol = h("ol", { class: "trace", "aria-label": "経過" });
  ol.append(
    h("li", { class: "step step-start" }, [
      h("span", { class: "node" }, [icon("spark")]),
      h("span", { class: "step-title", text: `${r.agentTitle} に頼んだ` }),
      h("span", { class: "step-at", text: new Date(r.startedAt).toLocaleTimeString("ja-JP") }),
    ]),
  );
  for (const s of r.steps) {
    ol.append(
      h("li", { class: "step", "data-role": "step", "data-kind": s.kind ?? "other" }, [
        h("span", { class: "node", title: KIND_LABEL[s.kind ?? "other"] ?? "ツール" }, [icon(s.kind ?? "other")]),
        h("span", { class: "step-kind", text: KIND_LABEL[s.kind ?? "other"] ?? "ツール" }),
        h("span", { class: "step-title mono", text: s.title }),
        h("span", { class: "step-at mono", text: offset(r.startedAt, s.at) }),
      ]),
    );
  }
  const end = h("li", { class: `step step-end step-${r.status}` });
  if (r.status === "running") {
    end.append(
      h("span", { class: "node node-live", "data-live": "" }),
      h("span", { class: "step-title", "data-role": "detail-progress", text: r.lastProgress?.startsWith("ツール：") ? "作業中" : (r.lastProgress ?? "起こしています…") }),
      h("span", { class: "step-at mono", text: offset(r.startedAt, Date.now()) }),
    );
  } else {
    end.append(
      h("span", { class: "node" }, [icon(r.status === "done" ? "check" : r.status === "error" ? "x" : "square")]),
      h("span", { class: "step-title", text: r.status === "done" ? "返答" : r.status === "error" ? "失敗" : "取り消し" }),
      h("span", { class: "step-at mono", text: r.finishedAt ? offset(r.startedAt, r.finishedAt) : "" }),
    );
  }
  ol.append(end);
  return ol;
}

function renderDetail(): HTMLElement {
  const pane = h("section", { class: "detail", "aria-label": "仕事の中身" });
  const r = state.detail;
  if (!r) {
    if (wide() && state.runs.length) pane.append(h("div", { class: "empty" }, [h("p", { class: "muted", text: "左の一覧から仕事を選ぶと、経過と返答が出ます。" })]));
    return pane;
  }
  const head = h("div", { class: "detail-head" }, [
    wide() ? null : (() => {
      const back = h("button", { type: "button", class: "btn btn-quiet back", "aria-label": "一覧に戻る", "data-focus": "back" }, [icon("back"), "一覧"]);
      back.addEventListener("click", () => { state.selected = null; state.detail = null; render(); });
      return back;
    })(),
    h("span", { class: "pill", "data-tone": STATUS_TONE[r.status], "data-role": "detail-status" }, [h("span", { class: "dot" }), STATUS_LABEL[r.status]]),
    h("span", { class: "detail-agent", text: `${r.agentTitle}${r.model ? `（${r.model}）` : ""}` }),
    h("span", { class: "grow" }),
    r.status === "running" ? stopButton(r.id) : null,
  ]);
  const body = h("div", { class: "detail-body", "data-role": "detail", "data-run": r.id }, [
    h("h2", { class: "section-label", text: "頼んだ内容" }),
    h("blockquote", { class: "prompt", "data-role": "detail-prompt", text: r.prompt }),
    h("h2", { class: "section-label", text: "経過" }),
    renderTrace(r),
    r.text !== undefined && r.text !== ""
      ? h("div", { class: `reply${r.status === "running" ? " reply-live" : ""}` }, [
          h("h2", { class: "section-label", text: r.status === "running" ? "書いている返答" : "返答" }),
          h("div", { class: "reply-body", "data-role": "detail-reply", text: r.text }),
        ])
      : r.status === "done"
        ? h("p", { class: "muted", "data-role": "detail-reply", text: "（返答はありませんでした）" })
        : null,
    r.error ? h("div", { class: "callout", "data-tone": "danger" }, [h("strong", { text: "失敗の理由" }), h("pre", { "data-role": "detail-error", text: r.error })]) : null,
    r.permissions?.length
      ? h("div", { class: "callout", "data-tone": "warn" }, [
          h("strong", { text: "断った確認" }),
          h("p", { class: "muted", text: "サブエージェントが人に確認を求めましたが、まだ人に聞く口が無いので断りました。" }),
          h("ul", {}, r.permissions.map((p) => h("li", { class: "mono", text: p.title }))),
        ])
      : null,
    r.notes?.length ? h("div", { class: "callout", "data-tone": "warn" }, [h("strong", { text: "注記" }), h("ul", { "data-role": "detail-notes" }, r.notes.map((n) => h("li", { text: n })))]) : null,
    h("dl", { class: "facts" }, [
      fact("始めた", new Date(r.startedAt).toLocaleString("ja-JP")),
      fact("かかった時間", duration(r.startedAt, r.finishedAt)),
      fact("使用量", r.usage ? `入力 ${tokens(r.usage.inputTokens)}・出力 ${tokens(r.usage.outputTokens)}${r.usage.cachedReadTokens ? `・キャッシュ ${tokens(r.usage.cachedReadTokens)}` : ""}` : undefined),
      fact("文脈", r.context ? `${tokens(r.context.used)} / ${tokens(r.context.size)}` : undefined),
      fact("費用", money(r.cost)),
      fact("session id", r.sessionId, { class: "mono selectable", "data-role": "detail-session" }),
      fact("続きの元", r.resumedFrom, { class: "mono selectable" }),
    ]),
  ]);
  pane.append(head, body);
  return pane;
}

/** 取り直しのたびに描き直すので、**見ていた場所と手元の焦点を持ち越す**——走っている間は1.5秒ごとに
 *  描き直す。持ち越さないと、読んでいる途中でスクロールが先頭へ戻り、キーボードの焦点も消える */
let renderedDetail: string | undefined;
const SPIN_MS = 900;
const PULSE_MS = 1400;
function render(): void {
  const keep = {
    list: app.querySelector<HTMLElement>(".list")?.scrollTop ?? 0,
    detail: app.querySelector<HTMLElement>(".detail-body")?.scrollTop ?? 0,
    focus: (document.activeElement as HTMLElement | null)?.dataset.focus,
  };
  paint();
  app.querySelector<HTMLElement>(".list")?.scrollTo({ top: keep.list });
  if (state.detail?.id === renderedDetail) app.querySelector<HTMLElement>(".detail-body")?.scrollTo({ top: keep.detail });
  renderedDetail = state.detail?.id;
  if (keep.focus) app.querySelector<HTMLElement>(`[data-focus="${CSS.escape(keep.focus)}"]`)?.focus({ preventScroll: true });
  // 動きの位相を時計に合わせる——描き直すたびに回転や脈が頭から始まって、ちらつくのを防ぐ
  const now = Date.now();
  for (const el of app.querySelectorAll<HTMLElement>(".glyph-running")) el.style.animationDelay = `-${now % SPIN_MS}ms`;
  for (const el of app.querySelectorAll<HTMLElement>("[data-live]")) el.style.animationDelay = `-${now % PULSE_MS}ms`;
  reportSize();
}

function paint(): void {
  const running = state.runs.filter((r) => r.status === "running").length;
  const header = h("header", { class: "top" }, [
    h("div", { class: "top-row" }, [
      h("h1", { class: "title", text: "サブエージェント" }),
      running ? h("span", { class: "pill", "data-tone": "accent", "data-role": "running-count" }, [h("span", { class: "dot", "data-live": "" }), `${running}件 実行中`]) : null,
    ]),
    state.agents.length ? renderAgents() : null,
  ]);
  // 左右2枚は、選べる仕事があるときだけ——空のうちに並べると、右の欄が何も無いまま空く
  const split = wide() && state.runs.length > 0;
  const layout = h("div", { class: `layout${split ? " wide" : ""}${state.detail && !wide() ? " show-detail" : ""}` }, [renderList(), renderDetail()]);
  app.replaceChildren(header, layout, state.error ? h("p", { class: "error", role: "status", text: state.error }) : "");
}

// ---- 取り直す ---------------------------------------------------------------------------
async function select(id: string): Promise<void> {
  state.selected = id;
  try {
    state.detail = await call<RunRecord>("getRun", { id });
    state.error = undefined;
  } catch (err) {
    state.error = `読めませんでした：${(err as Error).message}`;
  }
  render();
}

let timer: number | undefined;
/** 前に描いたときの中身——同じなら描き直さない（5秒ごとの取り直しで、変わっていない一覧を毎回組み直していた） */
let painted = "";
async function refresh(): Promise<void> {
  window.clearTimeout(timer);
  try {
    const page = await call<{ runs: Summary[]; finishedTotal?: number }>("listRuns", { limit: state.limit });
    state.runs = page.runs;
    // 前の版の Module は総数を返さない——そのときは受け取った分が全部
    state.finishedTotal = page.finishedTotal ?? page.runs.filter((r) => r.status !== "running").length;
    state.loaded = true;
    // 広いときは、何も選んでいなければ一番上（走っているもの→新しいもの）を開いておく
    if (!state.selected && wide() && state.runs[0]) state.selected = state.runs[0].id;
    state.detail = state.selected ? await call<RunRecord>("getRun", { id: state.selected }) : null;
    state.error = undefined;
  } catch (err) {
    state.error = `読み込めませんでした：${(err as Error).message}`;
  }
  const snapshot = JSON.stringify([state.runs, state.finishedTotal, state.detail, state.error, state.selected]);
  // 走っているものがあれば経過の時刻が進むので、毎回描く
  if (snapshot !== painted || state.runs.some((r) => r.status === "running")) {
    painted = snapshot;
    render();
  }
  // 走っている間は細かく、そうでなければゆっくり取り直す（会話で新しく頼まれた仕事も拾う）
  timer = window.setTimeout(refresh, state.runs.some((r) => r.status === "running") ? 1500 : 5000);
}

window.addEventListener("resize", () => render());

(async () => {
  try {
    const init = await request<{ hostContext?: { theme?: string; displayMode?: string; styles?: { variables?: Record<string, string | undefined> } } }>("ui/initialize", {
      protocolVersion: "2026-01-26",
      appInfo: { name: "banto-subagent-runs", version: "0.2.0" },
      appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    });
    const ctx = init.hostContext ?? {};
    applyAppearance(ctx);
    document.body.dataset.mode = ctx.displayMode === "fullscreen" ? "fullscreen" : "inline";
    send({ method: "ui/notifications/initialized", params: {} });
  } catch (err) {
    app.textContent = `画面を始められませんでした：${(err as Error).message}`;
    return;
  }
  // エージェントの状態は開いたときに1回だけ（Vault の目録を引くので、取り直しの輪には入れない）
  call<{ agents: Agent[] }>("listAgents")
    .then((d) => { state.agents = d.agents; render(); })
    .catch((err) => { state.error = `エージェントの状態を読めませんでした：${(err as Error).message}`; render(); });
  await refresh();
})();
