// 入口「バックグラウンドのコマンド」の画面（ブラウザで動く。`commands-app.ts` がこの JS を HTML に埋める）。
// banto を知らない——MCP Apps の約束（postMessage の JSON-RPC）だけで親と話す。
//
// 形（docs/specs/v4-modules.md §2.3「人の画面——バックグラウンドのコマンド」）：狭いとき（会話の隣）は「一覧 → 選ぶと中身」、
// 広いとき（720px〜）は左右2枚。呼ぶのは画面用の admin の道具だけ（listBackgroundCommands・readCommandOutput・stopBackgroundCommand）。
// **選んでいるコマンドは「見ている場所」**（`{ commandId }`）——banto が別の所（サイドバーの1件・会話のカード）からこの画面を
// その1件で開くときも、同じ形で届く

type Status = "running" | "exited" | "timedOut" | "cancelled" | "stopped" | "lost";
interface Command {
  commandId: string; command: string; label?: string; cwd: string; startedAt: string; status: Status;
  exitCode?: number | null; signal?: string | null; endedAt?: string; outputFile: string; cancelledBy?: "human";
  envSecrets?: Record<string, string>; timeoutSec?: number;
}
interface OutputRange { commandId: string; text: string; fromByte: number; toByte: number; size: number; capped: boolean }
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
  square: ["M6 6h12v12H6z"],
  back: ["m12 19-7-7 7-7", "M19 12H5"],
  terminal: ["m4 17 6-6-6-6", "M12 19h8"],
  copy: ["M8 8h12v12H8z", "M4 16V4h12"],
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
  for (const d of PATHS[name] ?? []) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

/** 呼び名——AI が付けた label、無ければコマンドの頭 80 字（会話のカードの題と同じ） */
const HEAD = 80;
function titleOf(c: Command): string {
  if (c.label) return c.label;
  const line = c.command.replace(/\s+/g, " ").trim();
  return line.length > HEAD ? `${line.slice(0, HEAD)}…` : line;
}
/** 状態の語（listCommands の語彙。人が止めたものは「人が止めました」）と色 */
function statusOf(c: Command): { label: string; tone?: string } {
  switch (c.status) {
    case "running":
      return { label: "動いています", tone: "accent" };
    case "exited":
      return c.exitCode === 0
        ? { label: "終わりました（0）", tone: "ok" }
        : { label: c.exitCode === null || c.exitCode === undefined ? `終わりました（信号 ${c.signal ?? "不明"}）` : `終わりました（${c.exitCode}）`, tone: "danger" };
    case "timedOut":
      return { label: "時間切れ", tone: "warn" };
    case "cancelled":
      return { label: c.cancelledBy === "human" ? "人が止めました" : "止めました" };
    case "stopped":
      return { label: "外から止められました", tone: "warn" };
    case "lost":
      return { label: "途中で終わりました", tone: "warn" };
  }
}
function duration(fromIso: string, toIso?: string): string {
  const s = Math.max(0, Math.round(((toIso ? Date.parse(toIso) : Date.now()) - Date.parse(fromIso)) / 1000));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${s % 60 ? `${s % 60}秒` : ""}`;
  return `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ""}`;
}
function ago(iso: string): string {
  const diff = Date.now() - Date.parse(iso);
  if (diff < 60_000) return "いま終わりました";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分前に終わりました`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}時間前に終わりました`;
  return `${Math.floor(diff / 86_400_000)}日前に終わりました`;
}
function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---- 出力 ------------------------------------------------------------------------------
//
// 開いたときは末尾 200 行。動いている間は 2 秒ごとに増えた分を読み足し、**一番下を見ているときだけ追いかける**。「もっと前を読む」で
// 256 KiB ずつ遡る。文字の切れ目は Module が切る。**行の頭に揃えるのはここ**——遡って読んだ分の最初の欠けた行は捨てる
// （頭はもっと前にある）。`\r` で書き直す進捗は最後の姿だけ
const TAIL_LINES = 200;
const CHUNK = 256 * 1024;
const enc = new TextEncoder();
const byteLength = (s: string) => enc.encode(s).length;
/** `\r` で書き直した行は、最後に見えている姿だけ */
const lastShape = (l: string) => {
  const t = l.replace(/\r+$/, "");
  return t.slice(t.lastIndexOf("\r") + 1);
};

class OutputView {
  readonly root: HTMLElement;
  readonly pre: HTMLElement;
  private readonly moreBtn: HTMLButtonElement;
  private readonly sizeEl: HTMLElement;
  private readonly cappedEl: HTMLElement;
  private end = 0;
  /** 出している一番前の行の頭（バイト） */
  private first = 0;
  private partial: HTMLElement | null = null;
  private partialText = "";
  private busy = false;
  closed = false;

  constructor(readonly commandId: string, outputFile: string) {
    this.pre = h("pre", { class: "out", "data-role": "output", tabindex: "0", "aria-label": "出力" });
    this.moreBtn = h("button", { type: "button", class: "link", "data-role": "output-older", hidden: "" }, ["もっと前を読む"]) as HTMLButtonElement;
    this.moreBtn.addEventListener("click", () => void this.older());
    this.sizeEl = h("span", { class: "size", "data-role": "output-size" });
    this.cappedEl = h("p", { class: "callout", "data-tone": "warn", "data-role": "output-capped", hidden: "" }, [
      "出力が保存の上限（64 MiB）を越えたので、越えた分はファイルに書いていません。",
    ]);
    const path = h("code", { class: "path selectable", "data-role": "output-file", text: outputFile });
    const copy = h("button", { type: "button", class: "link copy", "data-role": "copy-path" }, [icon("copy"), "パスをコピー"]);
    copy.addEventListener("click", () => {
      navigator.clipboard?.writeText(outputFile).then(
        () => { copy.lastChild!.textContent = "コピーしました"; },
        () => {
          // 埋め込みの画面ではクリップボードに書けないことがある——選んでおく（⌘C・Ctrl+C で写せる）
          const r = document.createRange();
          r.selectNodeContents(path);
          getSelection()?.removeAllRanges();
          getSelection()?.addRange(r);
          copy.lastChild!.textContent = "選びました（⌘C でコピー）";
        },
      );
    });
    this.root = h("div", { class: "out-box" }, [
      h("div", { class: "out-bar" }, [h("span", { text: "出力（stdout と stderr を出た順に）" }), this.moreBtn]),
      this.cappedEl,
      this.pre,
      h("div", { class: "out-foot" }, [path, copy, this.sizeEl]),
    ]);
  }

  private atBottom(): boolean {
    return this.pre.scrollHeight - this.pre.scrollTop - this.pre.clientHeight < 8;
  }

  private line(text: string): HTMLElement {
    return h("div", { class: "ln", text: lastShape(text) || " " });
  }

  private setPartial(text: string): void {
    this.partialText = text;
    this.partial?.remove();
    this.partial = text ? this.line(text) : null;
    if (this.partial) this.pre.append(this.partial);
  }

  private meta(r: OutputRange): void {
    this.sizeEl.textContent = bytes(r.size);
    if (r.capped) this.cappedEl.removeAttribute("hidden");
  }

  /** 開いたとき：末尾 200 行 */
  async open(): Promise<void> {
    const r = await call<OutputRange>("readCommandOutput", { commandId: this.commandId });
    if (this.closed) return;
    let text = r.text;
    let first = r.fromByte;
    if (first > 0) {
      const nl = text.indexOf("\n");
      if (nl !== -1) {
        first += byteLength(text.slice(0, nl + 1));
        text = text.slice(nl + 1);
      }
    }
    const lines = text.split("\n");
    const rest = lines.pop() ?? "";
    const dropped = Math.max(0, lines.length - TAIL_LINES);
    if (dropped > 0) first += byteLength(lines.slice(0, dropped).join("\n") + "\n");
    this.first = first;
    this.end = r.toByte;
    this.pre.replaceChildren(...lines.slice(dropped).map((l) => this.line(l)));
    this.setPartial(rest);
    this.pre.scrollTop = this.pre.scrollHeight;
    this.meta(r);
    this.updateMore();
  }

  /** 増えた分を読み足す */
  async poll(): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      for (let i = 0; i < 8; i++) {
        const r = await call<OutputRange>("readCommandOutput", { commandId: this.commandId, fromByte: this.end });
        if (this.closed) return;
        this.meta(r);
        if (r.text) {
          const follow = this.atBottom();
          const lines = (this.partialText + r.text).split("\n");
          const rest = lines.pop() ?? "";
          this.partial?.remove();
          this.partial = null;
          this.pre.append(...lines.map((l) => this.line(l)));
          this.setPartial(rest);
          if (follow) this.pre.scrollTop = this.pre.scrollHeight;
        }
        this.end = r.toByte;
        if (r.toByte >= r.size) break;
      }
    } finally {
      this.busy = false;
    }
  }

  /** 256 KiB 前を読む */
  async older(): Promise<void> {
    if (this.busy || this.first === 0) return;
    this.busy = true;
    this.moreBtn.setAttribute("disabled", "");
    try {
      const from = Math.max(0, this.first - CHUNK);
      const r = await call<OutputRange>("readCommandOutput", { commandId: this.commandId, fromByte: from, maxBytes: this.first - from });
      let text = r.text;
      let first = r.fromByte;
      if (first > 0) {
        const nl = text.indexOf("\n");
        // 1行が 256 KiB より長ければ、その切れ端のまま出す（捨てると先へ進めない）
        if (nl !== -1) {
          first += byteLength(text.slice(0, nl + 1));
          text = text.slice(nl + 1);
        } else {
          text = `…${text}`;
        }
      }
      const lines = text.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      // 前に足しても、見ていた行が動かないように
      const before = this.pre.scrollHeight;
      this.pre.prepend(...lines.map((l) => this.line(l)));
      this.pre.scrollTop += this.pre.scrollHeight - before;
      this.first = first;
    } catch (err) {
      state.error = `前の出力を読めませんでした：${(err as Error).message}`;
      render();
    } finally {
      this.busy = false;
      this.moreBtn.removeAttribute("disabled");
      this.updateMore();
    }
  }

  private updateMore(): void {
    if (this.first > 0) this.moreBtn.removeAttribute("hidden");
    else this.moreBtn.setAttribute("hidden", "");
  }
}

// ---- 状態 ------------------------------------------------------------------------------
const state: { commands: Command[]; loaded: boolean; selected: string | null; error?: string; confirmStop: boolean; stopping: boolean } = {
  commands: [], loaded: false, selected: null, confirmStop: false, stopping: false,
};
let output: OutputView | null = null;
const app = document.getElementById("app")!;
const wide = () => window.innerWidth >= 720;

// ---- 見ている場所（`{ commandId }`）——banto が URL に持つ。別の所からこの1件で開かれるときも同じ形で届く --------
const VIEW_STATE = "dev.banto/view-state";
let wanted: string | undefined;
function keepViewState(): void {
  send({ method: VIEW_STATE, params: { state: state.selected ? { commandId: state.selected } : {} } });
}

function select(id: string | null): void {
  state.selected = id;
  state.confirmStop = false;
  keepViewState();
  if (output && output.commandId !== id) {
    output.closed = true;
    output = null;
  }
  const c = state.commands.find((x) => x.commandId === id);
  if (id && c && !output) {
    output = new OutputView(id, c.outputFile);
    const mine = output;
    mine.open().catch((err) => {
      if (mine === output) {
        state.error = `出力を読めませんでした：${(err as Error).message}`;
        render();
      }
    });
  }
  render();
}

// ---- 描く ------------------------------------------------------------------------------
function statusPill(c: Command, role: string): HTMLElement {
  const s = statusOf(c);
  return h("span", { class: "pill", "data-tone": s.tone, "data-role": role, "data-status": c.status }, [h("span", { class: "dot" }), s.label]);
}
/** 動いている間の経った時間は、画面で1秒ごとに進める（`data-since`） */
function elapsed(c: Command, role: string): HTMLElement {
  return c.status === "running"
    ? h("span", { "data-role": role, "data-since": c.startedAt, text: duration(c.startedAt) })
    : h("span", { "data-role": role, text: c.endedAt ? duration(c.startedAt, c.endedAt) : "—" });
}

function renderRow(c: Command): HTMLElement {
  const row = h("button", {
    type: "button", class: "row", "data-role": "command", "data-command": c.commandId, "data-status": c.status, "data-focus": `cmd:${c.commandId}`,
    "aria-current": c.commandId === state.selected ? "true" : undefined,
  }, [
    h("span", { class: "row-top" }, [
      h("span", { class: "row-title", "data-role": "title", text: titleOf(c) }),
      h("span", { class: "row-when" }, [elapsed(c, "elapsed")]),
    ]),
    h("span", { class: "row-meta" }, [
      statusPill(c, "status"),
      c.status !== "running" && c.endedAt ? h("span", { class: "muted", "data-role": "ended", text: ago(c.endedAt) }) : null,
    ]),
  ]);
  row.addEventListener("click", () => select(c.commandId));
  return row;
}

function renderList(): HTMLElement {
  const list = h("section", { class: "list", "data-scroll-key": "list", "aria-label": "コマンドの一覧" });
  if (!state.loaded) return list;
  if (state.commands.length === 0) {
    list.append(
      h("div", { class: "empty", "data-role": "empty" }, [
        icon("terminal", "icon-md"),
        h("p", { class: "empty-title", text: "待たずに流したコマンドはありません" }),
        h("p", { class: "muted", text: "会話で「E2E を待たずに流して」のように頼むと、ここに並びます。" }),
      ]),
    );
    return list;
  }
  const running = state.commands.filter((c) => c.status === "running");
  const ended = state.commands.filter((c) => c.status !== "running");
  for (const [label, rows] of [["動いている", running], ["終わった", ended]] as const) {
    if (rows.length === 0) continue;
    list.append(h("h2", { class: "list-label" }, [label, h("span", { class: "count", text: String(rows.length) })]));
    for (const c of rows) list.append(renderRow(c));
  }
  return list;
}

function fact(label: string, value: Node | string, role?: string): HTMLElement {
  return h("div", { class: "fact" }, [h("dt", { text: label }), h("dd", { "data-role": role }, [value])]);
}

async function stop(id: string): Promise<void> {
  state.stopping = true;
  state.confirmStop = false;
  state.error = undefined;
  render();
  try {
    await call("stopBackgroundCommand", { commandId: id });
  } catch (err) {
    state.error = `止められませんでした：${(err as Error).message}`;
  } finally {
    state.stopping = false;
    await refresh();
    void output?.poll();
  }
}

function renderDetail(): HTMLElement {
  const pane = h("section", { class: "detail", "aria-label": "コマンドの中身" });
  const c = state.commands.find((x) => x.commandId === state.selected);
  if (!c) {
    if (wide() && state.commands.length) pane.append(h("div", { class: "empty" }, [h("p", { class: "muted", text: "左の一覧からコマンドを選ぶと、出力が出ます。" })]));
    return pane;
  }
  const stopBtn =
    c.status === "running" && !state.confirmStop
      ? (() => {
          const b = h("button", { type: "button", class: "btn", "data-role": "stop" }, [icon("square"), state.stopping ? "止めています…" : "止める"]);
          if (state.stopping) b.setAttribute("disabled", "");
          b.addEventListener("click", () => { state.confirmStop = true; render(); });
          return b;
        })()
      : null;
  const head = h("div", { class: "detail-head" }, [
    wide() ? null : (() => {
      const back = h("button", { type: "button", class: "btn btn-quiet back", "data-focus": "back" }, [icon("back"), "一覧に戻る"]);
      back.addEventListener("click", () => select(null));
      return back;
    })(),
    h("div", { class: "title-box" }, [h("span", { class: "detail-title", "data-role": "detail-title", text: titleOf(c) })]),
    statusPill(c, "detail-status"),
    stopBtn,
  ]);
  const confirm =
    c.status === "running" && state.confirmStop
      ? (() => {
          const yes = h("button", { type: "button", class: "btn btn-danger-solid", "data-role": "stop-confirm" }, ["止める"]);
          yes.addEventListener("click", () => void stop(c.commandId));
          const no = h("button", { type: "button", class: "btn btn-quiet", "data-role": "stop-cancel" }, ["やめる"]);
          no.addEventListener("click", () => { state.confirmStop = false; render(); });
          return h("div", { class: "confirm", "data-role": "stop-confirm-box", role: "alertdialog" }, [
            h("span", { class: "confirm-text", "data-role": "stop-confirm-text", text: "止めると、頼んだ会話に「人が画面で止めました」が届きます。" }),
            h("span", { class: "confirm-buttons" }, [yes, no]),
          ]);
        })()
      : null;
  const secrets = Object.entries(c.envSecrets ?? {});
  const body = h("div", { class: "detail-body", "data-role": "detail", "data-command": c.commandId }, [
    h("pre", { class: "command", "data-role": "detail-command", text: c.command }),
    h("dl", { class: "facts" }, [
      fact("始めた時刻", new Date(c.startedAt).toLocaleString("ja-JP"), "detail-started"),
      fact(c.status === "running" ? "経った時間" : "かかった時間", elapsed(c, "detail-elapsed")),
      fact("作業場所", c.cwd, "detail-cwd"),
      fact("終了コード", c.status === "running" ? "—" : c.exitCode === null || c.exitCode === undefined ? (c.signal ? `信号 ${c.signal}` : "—") : String(c.exitCode), "detail-exit"),
      c.timeoutSec !== undefined ? fact("時間の上限", `${c.timeoutSec}秒`, "detail-timeout") : null,
      fact("秘密", secrets.length ? secrets.map(([env, alias]) => `${env} ← ${alias}`).join("、") : "なし", "detail-secrets"),
    ]),
    output ? output.root : null,
  ]);
  pane.append(head, confirm ?? "", body);
  return pane;
}

function render(): void {
  const scrolled = new Map<string, number>();
  for (const el of app.querySelectorAll<HTMLElement>("[data-scroll-key]")) scrolled.set(el.dataset.scrollKey!, el.scrollTop);
  const outTop = output?.pre.scrollTop ?? 0;
  const outBottom = output ? output.pre.scrollHeight - output.pre.scrollTop - output.pre.clientHeight < 8 : true;
  const focus = (document.activeElement as HTMLElement | null)?.dataset.focus;
  const running = state.commands.filter((c) => c.status === "running").length;
  const split = wide() && state.commands.length > 0;
  const layout = h("div", { class: `layout${split ? " wide" : ""}${state.selected && !wide() ? " show-detail" : ""}` }, [renderList(), renderDetail()]);
  const header = h("header", { class: "top" }, [
    icon("terminal", "icon-md"),
    h("h1", { class: "title", text: "バックグラウンドのコマンド" }),
    running ? h("span", { class: "pill", "data-tone": "accent", "data-role": "running-count" }, [h("span", { class: "dot" }), `${running}件 動いています`]) : null,
  ]);
  app.replaceChildren(header, layout, state.error ? h("p", { class: "error", role: "status", "data-role": "error", text: state.error }) : "");
  for (const el of app.querySelectorAll<HTMLElement>("[data-scroll-key]")) {
    const top = scrolled.get(el.dataset.scrollKey!);
    if (top) el.scrollTop = top;
  }
  // 出力の枠は描き直しをまたいで同じもの——外して付け直すと位置が頭に戻るので戻す（一番下を見ていたら一番下）
  if (output) output.pre.scrollTop = outBottom ? output.pre.scrollHeight : outTop;
  if (focus) app.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focus)}"]`)?.focus({ preventScroll: true });
  reportSize();
}

// ---- 取り直す ---------------------------------------------------------------------------
let painted = "";
let timer: number | undefined;
async function refresh(): Promise<void> {
  window.clearTimeout(timer);
  const wasRunning = state.commands.find((c) => c.commandId === state.selected)?.status === "running";
  try {
    state.commands = (await call<{ commands: Command[] }>("listBackgroundCommands")).commands;
    state.loaded = true;
    if (wanted && state.commands.some((c) => c.commandId === wanted)) {
      const w = wanted;
      wanted = undefined;
      if (state.selected !== w) select(w);
    }
    if (state.selected && !state.commands.some((c) => c.commandId === state.selected)) select(null);
    // 広いときは、何も選んでいなければ一番上（動いているもの→新しいもの）を開いておく
    if (!state.selected && !wanted && wide() && state.commands[0]) select(state.commands[0].commandId);
    if (state.error?.startsWith("読み込めませんでした")) state.error = undefined;
  } catch (err) {
    state.error = `読み込めませんでした：${(err as Error).message}`;
  }
  // 見ているものが終わったら、最後の出力をもう一度だけ読み足す
  const now = state.commands.find((c) => c.commandId === state.selected);
  if (wasRunning && now && now.status !== "running") void output?.poll();
  const snapshot = JSON.stringify([state.commands, state.error, state.selected, state.confirmStop, state.stopping]);
  if (snapshot !== painted) {
    painted = snapshot;
    render();
  }
  // 動いているものがある間は細かく、そうでなければゆっくり取り直す（会話で新しく流されたものも拾う）
  timer = window.setTimeout(refresh, state.commands.some((c) => c.status === "running") ? 2000 : 5000);
}

window.addEventListener("resize", () => render());

(async () => {
  try {
    const init = await request<{ hostContext?: { theme?: string; displayMode?: string; styles?: { variables?: Record<string, string | undefined> }; [VIEW_STATE]?: unknown } }>("ui/initialize", {
      protocolVersion: "2026-01-26",
      appInfo: { name: "banto-shell-commands", version: "0.1.0" },
      appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    });
    const ctx = init.hostContext ?? {};
    applyAppearance(ctx);
    const commandId = (ctx[VIEW_STATE] as { commandId?: unknown } | undefined)?.commandId;
    if (typeof commandId === "string") wanted = commandId;
    document.body.dataset.mode = ctx.displayMode === "fullscreen" ? "fullscreen" : "inline";
    send({ method: "ui/notifications/initialized", params: {} });
  } catch (err) {
    app.textContent = `画面を始められませんでした：${(err as Error).message}`;
    return;
  }
  await refresh();
  // 動いているものの出力は 2 秒ごとに読み足す（遅れは最大でこの間隔）
  window.setInterval(() => {
    const c = state.commands.find((x) => x.commandId === state.selected);
    if (!output || c?.status !== "running") return;
    const mine = output;
    mine.poll().catch((err) => {
      if (mine === output) {
        state.error = `出力を読めませんでした：${(err as Error).message}`;
        render();
      }
    });
  }, 2000);
  // 経った時間を画面で進める
  window.setInterval(() => {
    for (const el of app.querySelectorAll<HTMLElement>("[data-since]")) el.textContent = duration(el.dataset.since!);
  }, 1000);
})();
