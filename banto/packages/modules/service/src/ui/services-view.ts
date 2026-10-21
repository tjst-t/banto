// 入口「サービス」の画面（ブラウザで動く。`services-app.ts` がこの JS を HTML に埋める）。
// banto を知らない——MCP Apps の約束（postMessage の JSON-RPC）だけで親と話す。
//
// 形（docs/specs/v4-modules.md §4.2「人の画面——サービス」）：狭いとき（会話の隣）は「一覧 → 選ぶと中身」、広いとき（720px〜）は
// 左右2枚。一覧・操作は AI と同じ tool（listServices・startService({name})・stopService・restartService・removeService）を
// 呼ぶ——host が人の管理操作と刻む。ログだけは画面用の readServiceLog（操作の列に並ばない）。

type State = "running" | "starting" | "restarting" | "crashed" | "exited" | "stopped" | "stopped-externally" | "not-started";
interface ExitRecord { at: string; code: number | null; signal: string | null; stopRequested: boolean }
interface Service {
  name: string; command: string; cwd: string; ports: number[]; envSecrets: Record<string, string>;
  desired: "running" | "stopped"; state: State; listening: number[]; notListening: number[]; restarts: number;
  startedAt?: string; lastExit?: ExitRecord; logFile: string; note?: string;
}
interface LogRange { text: string; fromByte: number; toByte: number; size: number; generation: string | null }
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
  play: ["M6 3l14 9-14 9V3z"],
  square: ["M6 6h12v12H6z"],
  restart: ["M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5"],
  trash: ["M3 6h18", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"],
  back: ["m12 19-7-7 7-7", "M19 12H5"],
  alert: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "M12 8v4", "M12 16h.01"],
  server: ["M4 2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z", "M4 14h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2Z", "M6 6h.01", "M6 18h.01"],
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

/** 状態の語（listServices の語彙）と色 */
const STATE_LABEL: Record<State, string> = {
  running: "動いています",
  starting: "起動の途中",
  restarting: "落ちて、起こし直しています",
  crashed: "落ちました（上限に当たった）",
  exited: "自分で終わりました",
  stopped: "止めました",
  "stopped-externally": "外から止められました",
  "not-started": "まだ起きていません",
};
const STATE_TONE: Record<State, string | undefined> = {
  running: "ok", starting: "accent", restarting: "warn", crashed: "danger", exited: undefined, stopped: undefined,
  "stopped-externally": "warn", "not-started": undefined,
};
const isUp = (s: State) => s === "running" || s === "starting" || s === "restarting";

function duration(fromIso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(fromIso)) / 1000));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `${hr}時間${m % 60 ? `${m % 60}分` : ""}`;
  return `${Math.floor(hr / 24)}日${hr % 24 ? `${hr % 24}時間` : ""}`;
}
const uptime = (s: Service) => (s.state === "running" && s.startedAt ? duration(s.startedAt) : "—");
function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
function exitText(e: ExitRecord): string {
  const what = e.stopRequested ? "止められた" : e.signal ? `信号 ${e.signal}` : String(e.code);
  return `${what}（${new Date(e.at).toLocaleString("ja-JP")}）`;
}

// ---- ログ ------------------------------------------------------------------------------
//
// 開いたときは末尾 200 行。2 秒ごとに増えた分を読み足し、**一番下を見ているときだけ追いかける**。「もっと前を読む」で
// 256 KiB ずつ遡り、`log` の頭まで来たら回した前の `log.1` へ。**世代が変わったら（回ったら）読み直す**。
// 文字の切れ目は Module が切る。**行の頭に揃えるのはここ**——遡って読んだ分の最初の欠けた行は捨てる（頭はもっと前にある）
const TAIL_LINES = 200;
const CHUNK = 256 * 1024;
const enc = new TextEncoder();
const byteLength = (s: string) => enc.encode(s).length;

class LogView {
  readonly root: HTMLElement;
  readonly pre: HTMLElement;
  private readonly moreBtn: HTMLButtonElement;
  private readonly note: HTMLElement;
  private gen: string | null = null;
  /** `log` のどこまで読んだか */
  private end = 0;
  /** 出している一番前の行の頭 */
  private first: { file: "log" | "log.1"; byte: number } = { file: "log", byte: 0 };
  private olderGen: string | null = null;
  private olderDone = false;
  private partial: HTMLElement | null = null;
  private partialText = "";
  private busy = false;
  closed = false;

  constructor(readonly name: string) {
    this.pre = h("pre", { class: "log", "data-role": "log", tabindex: "0", "aria-label": "ログ" });
    this.moreBtn = h("button", { type: "button", class: "link", "data-role": "log-older", hidden: "" }, ["もっと前を読む"]) as HTMLButtonElement;
    this.moreBtn.addEventListener("click", () => void this.older());
    this.note = h("span", { class: "muted", "data-role": "log-note" });
    this.root = h("div", { class: "log-box" }, [
      h("div", { class: "log-bar" }, [h("span", { text: "ログ（時刻つき。2 秒ごとに読み足す）" }), this.moreBtn, this.note]),
      this.pre,
    ]);
  }

  private atBottom(): boolean {
    return this.pre.scrollHeight - this.pre.scrollTop - this.pre.clientHeight < 8;
  }

  private line(text: string): HTMLElement {
    // 起動役が付けた「<ISO 時刻>[ [stderr]] 本文」を、手元の時刻と本文に分ける
    const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)( \[stderr\])? ?(.*)$/.exec(text);
    if (!m) return h("div", { class: "ln", text: text || " " });
    return h("div", { class: m[2] ? "ln err" : "ln", title: m[1] }, [h("span", { class: "ts", text: clock(m[1]!) }), m[3] || " "]);
  }

  /** 末尾から読み直す（開いたとき・回ったとき） */
  async reload(): Promise<void> {
    const r = await call<LogRange>("readServiceLog", { name: this.name, file: "log" });
    if (this.closed) return;
    this.pre.replaceChildren();
    this.partial = null;
    this.partialText = "";
    this.olderGen = null;
    this.olderDone = false;
    this.gen = r.generation;
    this.end = r.toByte;
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
    this.first = { file: "log", byte: first };
    this.pre.append(...lines.slice(dropped).map((l) => this.line(l)));
    this.setPartial(rest);
    this.pre.scrollTop = this.pre.scrollHeight;
    this.updateMore();
  }

  private setPartial(text: string): void {
    this.partialText = text;
    this.partial?.remove();
    this.partial = text ? this.line(text) : null;
    if (this.partial) this.pre.append(this.partial);
  }

  /** 増えた分を読み足す。回っていたら読み直す */
  async poll(): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      for (let i = 0; i < 8; i++) {
        const r = await call<LogRange>("readServiceLog", { name: this.name, file: "log", fromByte: this.end });
        if (this.closed) return;
        if (r.generation !== this.gen || r.size < this.end) {
          await this.reload();
          return;
        }
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

  /** 256 KiB 前を読む。`log` の頭まで来たら `log.1` の末尾から */
  async older(): Promise<void> {
    if (this.busy || this.olderDone) return;
    this.busy = true;
    this.moreBtn.setAttribute("disabled", "");
    try {
      let r: LogRange;
      let file = this.first.file;
      if (file === "log" && this.first.byte === 0) {
        file = "log.1";
        r = await call<LogRange>("readServiceLog", { name: this.name, file });
        if (r.generation === null || r.size === 0) {
          this.olderDone = true;
          return;
        }
        this.olderGen = r.generation;
      } else {
        const from = Math.max(0, this.first.byte - CHUNK);
        r = await call<LogRange>("readServiceLog", { name: this.name, file, fromByte: from, maxBytes: this.first.byte - from });
        if (file === "log.1" && r.generation !== this.olderGen) {
          // 遡っている間にもう一度回った——前のものはもう無い
          this.olderDone = true;
          this.note.textContent = "ログがもう一度回ったので、これより前は読めません";
          return;
        }
        if (file === "log" && r.generation !== this.gen) {
          this.busy = false;
          await this.reload();
          return;
        }
      }
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
      if (lines[lines.length - 1] === "") lines.pop();
      // 前に足しても、見ていた行が動かないように
      const before = this.pre.scrollHeight;
      this.pre.prepend(...lines.map((l) => this.line(l)));
      this.pre.scrollTop += this.pre.scrollHeight - before;
      this.first = { file, byte: first };
    } catch (err) {
      this.note.textContent = `前のログを読めませんでした：${(err as Error).message}`;
    } finally {
      this.busy = false;
      this.moreBtn.removeAttribute("disabled");
      this.updateMore();
    }
  }

  private updateMore(): void {
    const more = !this.olderDone && !(this.first.file === "log.1" && this.first.byte === 0);
    if (more) this.moreBtn.removeAttribute("hidden");
    else this.moreBtn.setAttribute("hidden", "");
    if (!more && !this.note.textContent) this.note.textContent = "ここが残っているログの頭です";
  }
}

// ---- 状態 ------------------------------------------------------------------------------
const state: {
  services: Service[]; loaded: boolean; selected: string | null; error?: string; flash?: string;
  confirmRemove: boolean; acting: string | null;
} = { services: [], loaded: false, selected: null, confirmRemove: false, acting: null };
let log: LogView | null = null;
const app = document.getElementById("app")!;
const wide = () => window.innerWidth >= 720;

// ---- 見ている場所（banto が URL に持つ）——開き直したときも同じサービスに戻る ----------------------
const VIEW_STATE = "dev.banto/view-state";
let wanted: string | undefined;
function keepViewState(): void {
  send({ method: VIEW_STATE, params: { state: state.selected ? { name: state.selected } : {} } });
}

function select(name: string | null): void {
  state.selected = name;
  state.confirmRemove = false;
  state.flash = undefined;
  keepViewState();
  if (log && log.name !== name) {
    log.closed = true;
    log = null;
  }
  if (name && !log) {
    log = new LogView(name);
    const mine = log;
    mine.reload().catch((err) => {
      if (mine === log) {
        state.error = `ログを読めませんでした：${(err as Error).message}`;
        render();
      }
    });
  }
  render();
}

/** 落ちたものは注意の色で一覧の上へ、あとは名前の順 */
function ordered(): Service[] {
  return [...state.services].sort((a, b) => Number(b.state === "crashed") - Number(a.state === "crashed") || a.name.localeCompare(b.name));
}

// ---- 描く ------------------------------------------------------------------------------
function statePill(s: State, role: string): HTMLElement {
  return h("span", { class: "pill", "data-tone": STATE_TONE[s], "data-role": role, "data-state": s }, [h("span", { class: "dot" }), STATE_LABEL[s]]);
}

function renderRow(s: Service): HTMLElement {
  const row = h("button", {
    type: "button", class: "row", "data-role": "service", "data-name": s.name, "data-state": s.state, "data-focus": `svc:${s.name}`,
    "aria-current": s.name === state.selected ? "true" : undefined,
  }, [
    h("span", { class: "row-top" }, [
      h("span", { class: "row-name mono", "data-role": "name", text: s.name }),
      h("span", { class: "row-when", "data-role": "uptime", text: uptime(s) }),
    ]),
    h("span", { class: "row-meta" }, [
      statePill(s.state, "state"),
      ...s.ports.map((p) =>
        h("span", { class: s.listening.includes(p) ? "port" : "port off", "data-role": "port", "data-listening": String(s.listening.includes(p)), text: `:${p}` }),
      ),
      s.restarts > 0 ? h("span", { class: "muted", text: `起こし直し ${s.restarts}回` }) : null,
    ]),
  ]);
  row.addEventListener("click", () => select(s.name));
  return row;
}

function renderList(): HTMLElement {
  const list = h("section", { class: "list", "data-scroll-key": "list", "aria-label": "サービスの一覧" });
  if (!state.loaded) return list;
  if (state.services.length === 0) {
    list.append(
      h("div", { class: "empty", "data-role": "empty" }, [
        icon("server", "icon-md"),
        h("p", { class: "empty-title", text: "まだサービスはありません" }),
        h("p", { class: "muted", text: "新しいサービスは AI に頼んで登録します（例「開発サーバを Service で動かして」）。" }),
      ]),
    );
    return list;
  }
  list.append(h("h2", { class: "list-label" }, ["この Project のサービス", h("span", { class: "count", text: String(state.services.length) })]));
  for (const s of ordered()) list.append(renderRow(s));
  list.append(
    h("p", { class: "list-foot muted", text: "新しいサービスは AI に頼んで登録します（例「開発サーバを Service で動かして」）。公開の URL は「公開」の画面にあります。" }),
  );
  return list;
}

function fact(label: string, value: Node | string, role?: string): HTMLElement {
  return h("div", { class: "fact" }, [h("dt", { text: label }), h("dd", { "data-role": role }, [value])]);
}

async function act(tool: string, name: string, doing: string, failed: string): Promise<void> {
  state.acting = doing;
  state.error = undefined;
  state.flash = undefined;
  render();
  try {
    const res = await call<{ unpublished?: { url: string }[]; note?: string }>(tool, { name });
    if (tool === "removeService") {
      select(null);
      state.flash = res.unpublished?.length ? `「${name}」を消しました。公開もやめました：${res.unpublished.map((u) => u.url).join("、")}` : `「${name}」を消しました`;
    } else if (res.note) {
      state.flash = res.note;
    }
  } catch (err) {
    state.error = `${failed}：${(err as Error).message}`;
  } finally {
    state.acting = null;
    await refresh();
  }
}

function button(label: string, iconName: string, onClick: () => void, attrs: Record<string, string> = {}): HTMLElement {
  const b = h("button", { type: "button", class: "btn", ...attrs }, [icon(iconName), label]);
  if (state.acting) b.setAttribute("disabled", "");
  b.addEventListener("click", onClick);
  return b;
}

function renderDetail(): HTMLElement {
  const pane = h("section", { class: "detail", "aria-label": "サービスの中身" });
  const s = state.services.find((x) => x.name === state.selected);
  if (!s) {
    if (wide() && state.services.length) pane.append(h("div", { class: "empty" }, [h("p", { class: "muted", text: "左の一覧からサービスを選ぶと、状態とログが出ます。" })]));
    return pane;
  }
  const actions = h("div", { class: "actions" }, [
    ...(isUp(s.state)
      ? [
          button("起こし直す", "restart", () => void act("restartService", s.name, "起こし直しています…", "起こし直せませんでした"), { "data-role": "restart" }),
          button("止める", "square", () => void act("stopService", s.name, "止めています…", "止められませんでした"), { "data-role": "stop" }),
        ]
      : [button("起動", "play", () => void act("startService", s.name, "起こしています…", "起こせませんでした"), { "data-role": "start" })]),
    button("消す", "trash", () => { state.confirmRemove = true; render(); }, { "data-role": "remove", class: "btn btn-quiet btn-danger" }),
  ]);
  const head = h("div", { class: "detail-head" }, [
    wide() ? null : (() => {
      const back = h("button", { type: "button", class: "btn btn-quiet back", "data-focus": "back" }, [icon("back"), "一覧に戻る"]);
      back.addEventListener("click", () => select(null));
      return back;
    })(),
    h("div", { class: "title-box" }, [
      h("span", { class: "detail-name mono", "data-role": "detail-name", text: s.name }),
      h("code", { class: "detail-command", "data-role": "detail-command", text: s.command }),
    ]),
    statePill(s.state, "detail-state"),
    actions,
  ]);
  const confirm = state.confirmRemove
    ? (() => {
        const yes = h("button", { type: "button", class: "btn btn-danger-solid", "data-role": "remove-confirm" }, ["消す"]);
        yes.addEventListener("click", () => { state.confirmRemove = false; void act("removeService", s.name, "消しています…", "消せませんでした"); });
        const no = h("button", { type: "button", class: "btn btn-quiet", "data-role": "remove-cancel" }, ["やめる"]);
        no.addEventListener("click", () => { state.confirmRemove = false; render(); });
        return h("div", { class: "confirm", "data-role": "remove-confirm-box", role: "alertdialog" }, [
          icon("alert"),
          h("span", { "data-role": "remove-confirm-text", text: `「${s.name}」を止めて登録を消します。ログも消えます。公開していれば、その公開もやめます。` }),
          h("span", { class: "confirm-buttons" }, [yes, no]),
        ]);
      })()
    : null;
  const secrets = Object.entries(s.envSecrets);
  const body = h("div", { class: "detail-body", "data-role": "detail", "data-name": s.name }, [
    s.state === "crashed"
      ? h("div", { class: "callout", "data-tone": "danger", "data-role": "crashed-note" }, [
          "起動してすぐ落ちるのを繰り返したので、起こし直しを止めました。ログの最後を見て直してから「起動」を押してください。",
        ])
      : null,
    s.note ? h("div", { class: "callout", "data-tone": "warn", "data-role": "detail-note", text: s.note }) : null,
    h("dl", { class: "facts" }, [
      fact(
        "ポート",
        s.ports.length === 0
          ? "なし"
          : h("span", {}, s.ports.map((p) => h("span", { class: "port-fact", "data-role": "detail-port" }, [String(p), h("span", { class: "muted", text: s.listening.includes(p) ? " 待ち受けています" : " 待ち受けていません" })]))),
        "detail-ports",
      ),
      fact("動いている時間", uptime(s), "detail-uptime"),
      fact("起こし直した回数", String(s.restarts), "detail-restarts"),
      fact("最後の終了コード", s.lastExit ? exitText(s.lastExit) : "—", "detail-exit"),
      fact("作業場所", s.cwd || ".", "detail-cwd"),
      fact("秘密", secrets.length ? secrets.map(([env, alias]) => `${env} ← ${alias}`).join("、") : "なし", "detail-secrets"),
    ]),
    log ? log.root : null,
  ]);
  pane.append(head, confirm ?? "", body);
  return pane;
}

function render(): void {
  const scrolled = new Map<string, number>();
  for (const el of app.querySelectorAll<HTMLElement>("[data-scroll-key]")) scrolled.set(el.dataset.scrollKey!, el.scrollTop);
  const logTop = log?.pre.scrollTop ?? 0;
  const logBottom = log ? log.pre.scrollHeight - log.pre.scrollTop - log.pre.clientHeight < 8 : true;
  const focus = (document.activeElement as HTMLElement | null)?.dataset.focus;
  const split = wide() && state.services.length > 0;
  const layout = h("div", { class: `layout${split ? " wide" : ""}${state.selected && !wide() ? " show-detail" : ""}` }, [renderList(), renderDetail()]);
  const header = h("header", { class: "top" }, [icon("server", "icon-md"), h("h1", { class: "title", text: "サービス" }), state.acting ? h("span", { class: "muted", "data-role": "acting", text: state.acting }) : null]);
  app.replaceChildren(
    header,
    layout,
    state.flash ? h("p", { class: "flash", role: "status", "data-role": "flash", text: state.flash }) : "",
    state.error ? h("p", { class: "error", role: "status", "data-role": "error", text: state.error }) : "",
  );
  for (const el of app.querySelectorAll<HTMLElement>("[data-scroll-key]")) {
    const top = scrolled.get(el.dataset.scrollKey!);
    if (top) el.scrollTop = top;
  }
  // ログの枠は描き直しをまたいで同じもの——外して付け直すと位置が頭に戻るので戻す（一番下を見ていたら一番下）
  if (log) log.pre.scrollTop = logBottom ? log.pre.scrollHeight : logTop;
  if (focus) app.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focus)}"]`)?.focus({ preventScroll: true });
  reportSize();
}

// ---- 取り直す ---------------------------------------------------------------------------
let painted = "";
async function refresh(): Promise<void> {
  try {
    state.services = (await call<{ services: Service[] }>("listServices")).services;
    state.loaded = true;
    if (wanted && state.services.some((s) => s.name === wanted)) {
      const w = wanted;
      wanted = undefined;
      if (state.selected !== w) select(w);
    }
    // 消えたものを見ていたら一覧へ
    if (state.selected && !state.services.some((s) => s.name === state.selected)) select(null);
    // 広いときは、何も選んでいなければ一番上を開いておく
    if (!state.selected && wide() && state.services[0]) select(ordered()[0]!.name);
    if (state.error?.startsWith("読み込めませんでした")) state.error = undefined;
  } catch (err) {
    state.error = `読み込めませんでした：${(err as Error).message}`;
  }
  const snapshot = JSON.stringify([state.services.map((s) => ({ ...s, startedAt: s.startedAt })), state.error, state.selected, state.flash, state.acting]);
  // 動いているものがあれば動いている時間が進むので、毎回描く
  if (snapshot !== painted || state.services.some((s) => s.state === "running")) {
    painted = snapshot;
    render();
  }
}

window.addEventListener("resize", () => render());

(async () => {
  try {
    const init = await request<{ hostContext?: { theme?: string; displayMode?: string; styles?: { variables?: Record<string, string | undefined> }; [VIEW_STATE]?: unknown } }>("ui/initialize", {
      protocolVersion: "2026-01-26",
      appInfo: { name: "banto-service-services", version: "0.1.0" },
      appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    });
    const ctx = init.hostContext ?? {};
    applyAppearance(ctx);
    const name = (ctx[VIEW_STATE] as { name?: unknown } | undefined)?.name;
    if (typeof name === "string") wanted = name;
    document.body.dataset.mode = ctx.displayMode === "fullscreen" ? "fullscreen" : "inline";
    send({ method: "ui/notifications/initialized", params: {} });
  } catch (err) {
    app.textContent = `画面を始められませんでした：${(err as Error).message}`;
    return;
  }
  await refresh();
  // 一覧は 5 秒ごと（listServices は登録と systemd の写しを突き合わせるので、細かくしない）、ログは 2 秒ごと
  window.setInterval(() => void refresh(), 5000);
  window.setInterval(() => {
    const mine = log;
    mine?.poll().catch((err) => {
      if (mine === log) {
        state.error = `ログを読めませんでした：${(err as Error).message}`;
        render();
      }
    });
  }, 2000);
})();
