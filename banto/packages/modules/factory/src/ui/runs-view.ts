// Factory の入口の画面（ブラウザで動く。`apps.ts` がこの JS を HTML に埋める）。banto を知らない——MCP Apps の約束
// （postMessage の JSON-RPC）だけで親と話す。形はモック（mock/components/banto/canvas/factory-view.tsx、決定・2026-10-07）：
//   - 一覧は1件ずつ。「あなたの答えを待っている」→「動いている」→「終わったもの」（畳む）
//   - 行の左に段の5目盛り。Factory が「長引いている」と判定した件（`long`。物差しは設定の longStageMinutes）は「長引いています」
//   - 行を押すと詳細。止まっていれば答える欄を一番上に。広ければ左右、狭ければ入れ替わる
// banto の「人の番の色」は Canvas に渡らない（MCP Apps の標準の名前だけ）——人を待つものは warning の色で出す。

interface ToolResult { content?: { type: string; text?: string }[]; isError?: boolean }
type Status = "queued" | "running" | "stopped" | "merging" | "done" | "dropped";
interface ItemSummary {
  item: string; number: number | null; title: string; status: Status; stage: string; stageSince: string;
  worktree: string; branch: string; stopped?: { reason: string; stage: string; since: string };
  subagentRunId?: string; lastTest?: { ok: boolean; code: number; at: string };
  lastReview?: { verdict: string; items: Array<{ what: string; where?: string; why: string }>; at: string };
  result?: string;
  /** Factory の判定（いまの段に居る時間が設定の物差しを越えた）。画面では決めない */
  long?: boolean; longSince?: string;
}
interface RunSummary { runId: string; createdAt: string; finishedAt?: string; items: ItemSummary[]; notifyErrors?: string[] }
interface Detail {
  runId: string; createdAt: string; finishedAt?: string;
  settings: { testCommand: string; targetBranch: string; limits: { testRetries: number; reviewRounds: number } };
  item: ItemSummary & { story?: string };
  lastTest?: { ok: boolean; code: number; tail: string; at: string };
  counts: { testFails: number; reviewChanges: number };
  journal: Array<{ at: string; stage: string; kind: string; text: string }>;
  diff?: { commits: number; files: Array<{ path: string; add: number | null; del: number | null }> };
}

const STAGES = ["始める", "実装", "テスト", "レビュー", "マージ"];

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
/**
 * banto の別の画面を開いてもらう（banto の拡張 `dev.banto/open-surface`）。押した直後だけ受けてもらえるので、ボタンの
 * click の中で呼ぶ。断られたら理由を出す（黙って何も起きない、にしない）
 */
function openSurface(params: Record<string, unknown>): void {
  request("dev.banto/open-surface", params).catch((err: Error) => {
    state.error = `開けませんでした：${err.message}`;
    render();
  });
}
const settingsButton = (label: string) => {
  const b = btn(label, "btn-quiet open-settings", () => openSurface({ surface: "settings" }), "Project の設定の「Factory」を開く");
  b.dataset.testid = "factory-open-settings";
  return b;
};

async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await request<ToolResult>("tools/call", { name, arguments: args });
  const text = result.content?.[0]?.text ?? "";
  if (result.isError) throw new Error(text || `${name} が失敗しました`);
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
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
const PATHS: Record<string, string[]> = {
  check: ["M20 6 9 17l-5-5"],
  back: ["m15 18-6-6 6-6"],
  hand: ["M18 11V6a2 2 0 0 0-4 0v1", "M14 10V4a2 2 0 0 0-4 0v2", "M10 10.5V6a2 2 0 0 0-4 0v8", "M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"],
  down: ["m6 9 6 6 6-6"],
  right: ["m9 18 6-6-6-6"],
  square: ["M6 6h12v12H6z"],
  branch: ["M6 3v12", "M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z", "M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z", "M15 6a9 9 0 0 0-9 9"],
};
function icon(name: string, cls = "icon"): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", class: cls, "aria-hidden": "true" })) {
    svg.setAttribute(k, v);
  }
  for (const d of PATHS[name] ?? []) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}
function btn(label: string, cls: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = h("button", { type: "button", class: `btn ${cls}`, text: label, title }) as HTMLButtonElement;
  b.addEventListener("click", onClick);
  return b;
}
const minutesSince = (iso: string) => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000));
function minutes(m: number): string {
  return m < 60 ? `${m}分` : `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ""}`;
}
const active = (s: Status) => s === "running" || s === "merging" || s === "queued";
const isLong = (i: ItemSummary) => i.long === true;
function stageIndex(stage: string): number {
  if (stage === "マージ待ち") return 4;
  if (stage === "終わった") return 5;
  return STAGES.indexOf(stage);
}
function ticks(i: ItemSummary, lg = false): HTMLElement {
  const at = stageIndex(i.stage);
  return h(
    "span",
    { class: lg ? "ticks lg" : "ticks", "aria-hidden": "true" },
    STAGES.map((_, n) =>
      h("span", {
        class: "tick",
        "data-s":
          i.status === "dropped" ? undefined : n < at ? "done" : n === at ? (i.status === "stopped" ? "human" : isLong(i) ? "long" : "now") : undefined,
      }),
    ),
  );
}

// ---- 状態 ----------------------------------------------------------------------------
const app = document.getElementById("app")!;
const state: {
  runs: RunSummary[];
  loaded: boolean;
  selected?: { runId: string; item: string };
  detail?: Detail;
  showDone: boolean;
  error?: string;
  busy: boolean;
  /** 答える欄の書きかけ（読み直しで消さない） */
  draft: { instruction: string; dropping: boolean; reason: string; menu: boolean };
} = { runs: [], loaded: false, showDone: false, busy: false, draft: { instruction: "", dropping: false, reason: "", menu: false } };

const wide = () => window.innerWidth >= 720;
const keyOf = (s?: { runId: string; item: string }) => (s ? `${s.runId}/${s.item}` : "");

function rows(): Array<{ run: RunSummary; item: ItemSummary }> {
  return state.runs.flatMap((run) => run.items.map((item) => ({ run, item })));
}

function select(runId: string, item: string): void {
  if (keyOf(state.selected) !== `${runId}/${item}`) state.draft = { instruction: "", dropping: false, reason: "", menu: false };
  state.selected = { runId, item };
  state.detail = undefined;
  render();
  void refresh(true);
}

// ---- 描く ----------------------------------------------------------------------------
function render(): void {
  // 書いている途中の欄に焦点があれば、描き直しで焦点を失わないよう、その欄の値を控える
  const focused = document.activeElement as HTMLTextAreaElement | null;
  const focusId = focused?.id;
  const caret = focused && "selectionStart" in focused ? focused.selectionStart : null;
  // 読み直すたびに丸ごと作り直すので、スクロールする枠（`data-scroll-key` を付けた所）とページの位置も控えて戻す
  // ——控えないと、動いているものがある間は3秒ごとに先頭へ戻される。印は1件ごとに変え、別の件を開いたら先頭から
  const scrolled = new Map<string, number>();
  for (const el of app.querySelectorAll<HTMLElement>("[data-scroll-key]")) scrolled.set(el.dataset.scrollKey!, el.scrollTop);
  const page = document.scrollingElement?.scrollTop ?? 0;
  app.replaceChildren();
  const all = rows();
  const human = all.filter((r) => r.item.status === "stopped");
  const moving = all.filter((r) => active(r.item.status));
  const closed = all.filter((r) => r.item.status === "done" || r.item.status === "dropped");

  app.append(
    h("header", { class: "top" }, [
      h("h1", { class: "title", text: "Factory" }),
      state.loaded
        ? h("span", { class: "muted", text: `${moving.length} 件が動いている${human.length ? `・${human.length} 件があなたの答えを待っている` : ""}` })
        : h("span", { class: "muted", text: "読み込んでいます…" }),
      settingsButton(wide() ? "Factory の設定を開く" : "設定"),
    ]),
  );

  if (state.loaded && all.length === 0) {
    app.append(
      h("div", { class: "empty" }, [
        h("p", { class: "lead", text: "まだ何も流していません" }),
        h("p", {
          class: "sub",
          text:
            "Backlog のタスクを Factory に流すのは、会話の AI に頼みます（例：「#42 を Factory に流して」）。テストを通ったものだけを取り込むので、" +
            "先に Project の設定の「Factory」でテストのコマンドを入れてください。",
        }),
        settingsButton("Factory の設定を開く"),
      ]),
    );
  } else {
    const layout = h("div", { class: `layout${wide() ? " wide" : ""}${state.selected ? " show-detail" : ""}` });
    const list = h("div", { class: "list", "data-scroll-key": "list" });
    const rowEl = ({ run, item }: { run: RunSummary; item: ItemSummary }) => {
      const sub =
        item.status === "stopped"
          ? item.stopped?.reason
          : item.status === "merging"
            ? "マージの列に並んでいる"
            : item.status === "queued"
              ? "同時に進める件数の空きを待っている"
              : item.result;
      const long = isLong(item);
      const b = h("button", { type: "button", class: "row", "data-testid": "factory-row", "data-item": item.item, "data-status": item.status, "aria-current": keyOf(state.selected) === `${run.runId}/${item.item}` ? "true" : undefined }, [
        ticks(item),
        h("span", { class: "row-main" }, [
          h("span", { class: "row-title" }, [
            h("span", { class: "num", text: item.number !== null ? `#${item.number}` : item.item }),
            h("span", { class: "row-name truncate", text: item.title }),
          ]),
          sub ? h("span", { class: "row-sub truncate", "data-tone": item.status === "stopped" ? "human" : undefined, text: sub }) : null,
        ]),
        h("span", { class: "row-side", "data-tone": item.status === "stopped" ? "human" : undefined }, [
          h("span", { text: item.stage }),
          item.status === "running" || item.status === "merging" || item.status === "stopped"
            ? h("span", { class: "t", "data-long": long ? "" : undefined, text: long ? `長引いています・${minutes(minutesSince(item.stageSince))}` : minutes(minutesSince(item.stageSince)) })
            : null,
        ]),
      ]);
      b.addEventListener("click", () => select(run.runId, item.item));
      return b;
    };
    if (human.length) {
      list.append(h("h2", { class: "sec-title", "data-tone": "human" }, [icon("hand"), "あなたの答えを待っている"]));
      human.forEach((r) => list.append(rowEl(r)));
    }
    list.append(h("h2", { class: "sec-title", text: "動いている" }));
    if (moving.length === 0) list.append(h("p", { class: "none", text: "いま動いているものはありません" }));
    moving.forEach((r) => list.append(rowEl(r)));
    if (closed.length) {
      const fold = h("button", { type: "button", class: "fold", "aria-expanded": String(state.showDone) }, [
        icon(state.showDone ? "down" : "right"),
        "終わったもの",
        h("span", { class: "count", text: String(closed.length) }),
      ]);
      fold.addEventListener("click", () => {
        state.showDone = !state.showDone;
        render();
      });
      list.append(fold);
      if (state.showDone) closed.forEach((r) => list.append(rowEl(r)));
    }
    layout.append(list);
    if (state.selected) layout.append(renderDetail());
    app.append(layout);
  }
  if (state.error) app.append(h("p", { class: "error", text: state.error }));

  for (const el of app.querySelectorAll<HTMLElement>("[data-scroll-key]")) {
    const top = scrolled.get(el.dataset.scrollKey!);
    if (top) el.scrollTop = top;
  }
  if (page && document.scrollingElement) document.scrollingElement.scrollTop = page;

  if (focusId) {
    const again = document.getElementById(focusId) as HTMLTextAreaElement | null;
    if (again) {
      again.focus();
      if (caret !== null) again.setSelectionRange(caret, caret);
    }
  }
}

function renderDetail(): HTMLElement {
  const pane = h("div", { class: "detail", "data-testid": "factory-detail" });
  const back = btn("", "btn-quiet", () => {
    state.selected = undefined;
    state.detail = undefined;
    render();
  });
  back.replaceChildren(icon("back"));
  back.setAttribute("aria-label", "一覧に戻る");
  const d = state.detail;
  const sum = rows().find((r) => keyOf(state.selected) === `${r.run.runId}/${r.item.item}`);
  pane.append(h("div", { class: "d-top" }, [back, h("span", { class: "truncate", text: d?.item.story ? `${d.item.story} の中の #${d.item.number ?? ""}` : sum?.item.number != null ? `#${sum.item.number}` : "" })]));
  if (!d) {
    pane.append(h("div", { class: "d-body muted", text: "読み込んでいます…" }));
    return pane;
  }
  const item = d.item;
  const key = `${d.runId}/${item.item}`;
  const body = h("div", { class: "d-body", "data-scroll-key": `detail:${key}` });
  const runAt = d.finishedAt ? `${minutes(minutesSince(d.finishedAt))}前に終わった実行` : `${minutes(minutesSince(d.createdAt))}前に流した実行`;
  body.append(
    h("h2", { class: "d-title", text: item.title }),
    h("p", { class: "d-meta", text: runAt }),
  );

  // 段
  const at = stageIndex(item.stage);
  const names = h("ol", { class: "stage-names" });
  STAGES.forEach((s, n) => {
    const here = n === at && item.status !== "done";
    const sub =
      s === "テスト" && d.counts.testFails > 0
        ? `落ちた ${d.counts.testFails} 回／上限 ${d.settings.limits.testRetries}`
        : s === "レビュー" && d.counts.reviewChanges > 0
          ? `差し戻し ${d.counts.reviewChanges} 回／上限 ${d.settings.limits.reviewRounds}`
          : undefined;
    const sName = h("span", { class: "stage-name", "data-s": n < at ? "done" : here ? (item.status === "stopped" ? "human" : "now") : undefined }, [
      n < at ? icon("check") : null,
      h("span", { class: "truncate", text: s }),
    ]);
    const li = h("li", {}, [sName]);
    if (sub) li.append(h("span", { class: "stage-sub truncate", text: sub }));
    if (here && (item.status === "running" || item.status === "stopped")) {
      li.append(h("span", { class: "stage-sub", "data-long": isLong(item) ? "" : undefined, text: minutes(minutesSince(item.stageSince)) }));
    }
    names.append(li);
  });
  body.append(h("div", { class: "stages" }, [ticks(item, true), names]));
  if (item.stage === "マージ待ち") body.append(h("p", { class: "d-meta", text: "マージの列に並んでいます——前の件が入ったら、rebase してテストし直してから入ります" }));

  if (item.status === "stopped" && item.stopped) body.append(renderAnswer(d));

  if (item.status === "running" && item.subagentRunId) {
    const role = item.stage === "レビュー" ? "レビュー役" : "実装役";
    body.append(
      h("div", { class: "now" }, [
        h("span", { class: "now-text" }, [
          h("span", { class: "who", text: `いま：${role}が働いている${isLong(item) ? `（この段に ${minutes(minutesSince(item.stageSince))}）` : ""}` }),
          h("span", { class: "what", text: "何をどの順にしているかは、Subagent の画面で見られます" }),
        ]),
        // 経過は Subagent の入口の画面にある——その仕事を選んだ状態で開いてもらう（Subagent は `{ runId }` で受ける）
        (() => {
          const runId = item.subagentRunId;
          const b = btn("経過を見る", "", () => openSurface({ surface: "launcher", server: "subagent", select: { runId } }), "Subagent の画面でこの仕事の経過を開く");
          b.dataset.testid = "factory-open-progress";
          return b;
        })(),
      ]),
    );
  }
  if (item.result) body.append(h("p", { class: "result", "data-testid": "factory-result", "data-tone": item.status === "done" ? "ok" : undefined, text: item.result }));

  if (d.lastTest) {
    const t = d.lastTest;
    const sec = h("section", { class: "d-sec" }, [
      h("h3", { "data-tone": t.ok ? "ok" : "danger", text: t.ok ? "最後のテスト：通った" : `最後のテスト：落ちた（終了コード ${t.code}）` }),
      h("p", { class: "cmd", text: d.settings.testCommand }),
      h("pre", { class: "out", "data-scroll-key": `test:${key}`, text: t.tail }),
    ]);
    body.append(sec);
  }
  if (item.lastReview) {
    const r = item.lastReview;
    const sec = h("section", { class: "d-sec" }, [
      h("h3", { "data-tone": r.verdict === "pass" ? "ok" : undefined, text: r.verdict === "pass" ? "レビュー：このまま取り込んでよい" : `レビュー：直すことが ${r.items.length} つ` }),
    ]);
    if (r.items.length) {
      sec.append(
        h(
          "ul",
          { class: "review-list" },
          r.items.map((x) => h("li", {}, [h("span", { text: x.what }), x.where ? h("span", { class: "where", text: x.where }) : null, h("span", { class: "why", text: x.why })])),
        ),
      );
    }
    body.append(sec);
  }
  if (d.diff) {
    body.append(
      h("section", { class: "d-sec" }, [
        h("h3", { text: `変更：コミット ${d.diff.commits}・ファイル ${d.diff.files.length}` }),
        h(
          "ul",
          { class: "files" },
          d.diff.files.map((f) =>
            h("li", {}, [
              h("span", { class: "path truncate", title: f.path, text: f.path }),
              h("span", { class: "add", text: f.add === null ? "バイナリ" : `+${f.add}` }),
              f.del === null ? null : h("span", { class: "del", text: `−${f.del}` }),
            ]),
          ),
        ),
      ]),
    );
  }
  if (d.journal.length) {
    body.append(
      h("section", { class: "d-sec" }, [
        h("h3", { text: "何が起きたか" }),
        h(
          "ol",
          { class: "journal" },
          d.journal.map((j) =>
            h("li", { "data-k": j.kind }, [
              h("span", { class: "when", text: `+${minutes(Math.max(0, Math.floor((Date.parse(j.at) - Date.parse(d.createdAt)) / 60000)))}` }),
              h("span", { class: "stage", text: j.stage }),
              h("span", { class: "text", text: j.text }),
            ]),
          ),
        ),
      ]),
    );
  }
  pane.append(body);

  const foot = h("div", { class: "d-foot" }, [icon("branch"), h("span", { class: "path truncate", title: item.worktree, text: item.worktree })]);
  if (active(item.status)) {
    const stop = btn("止める", "btn-danger", () => void act("cancelFactory", { runId: d.runId, item: item.item, reason: "人が画面から止めた" }), "サブエージェントとテストも止め、Backlog を「準備できた」に戻します。worktree は残します");
    stop.prepend(icon("square"));
    stop.disabled = state.busy;
    foot.append(stop);
  }
  pane.append(foot);
  return pane;
}

/** 答える欄。いちばんよく使う「続ける」を塗りにし、ほかは枠だけ。答えは AI の answerFactory と同じ4つ */
function renderAnswer(d: Detail): HTMLElement {
  const item = d.item;
  const box = h("div", { class: "callout-human" }, [
    h("p", { class: "why", "data-testid": "factory-stopped-reason" }, [icon("hand", "icon-md"), item.stopped!.reason]),
    h("p", { class: "note", text: "頼んだ会話にも知らせてあります。そちらで AI に答えさせても同じです" }),
  ]);
  const dr = state.draft;
  const answer = (args: Record<string, unknown>) => void act("answerFactory", { runId: d.runId, item: item.item, ...args });
  if (!dr.dropping) {
    const ta = h("textarea", { id: "instruction", "data-testid": "factory-instruction", placeholder: "実装役への指示を足す（任意）" }) as HTMLTextAreaElement;
    ta.value = dr.instruction;
    ta.addEventListener("input", () => {
      dr.instruction = ta.value;
      cont.textContent = ta.value.trim() ? "指示を足して続ける" : "このまま続ける";
    });
    const cont = btn(dr.instruction.trim() ? "指示を足して続ける" : "このまま続ける", "btn-human", () => answer({ action: "continue", ...(dr.instruction.trim() ? { instruction: dr.instruction } : {}) }));
    const actions = h("div", { class: "actions" }, [cont]);
    // 指摘を承知で取り込むのは、レビューで止まったときだけ意味がある
    if (item.stopped!.reason.startsWith("レビューで")) actions.append(btn("指摘を承知で取り込む", "", () => answer({ action: "accept" })));
    // やり直せるのは、もう通った段（記録に印がある段）から
    const retryStages = STAGES.slice(1, Math.min(stageIndex(item.stage), 4) + 1);
    const menu = h("div", { class: "menu" });
    const retry = btn("やり直す", "", () => {
      dr.menu = !dr.menu;
      render();
    });
    retry.append(icon("down"));
    retry.setAttribute("aria-expanded", String(dr.menu));
    menu.append(retry);
    if (dr.menu) {
      const list = h("ul", { class: "menu-list" });
      retryStages.forEach((s) => {
        const b = btn(`${s}からやり直す`, "", () => answer({ action: "retry", stage: s }));
        list.append(h("li", {}, [b]));
      });
      menu.append(list);
    }
    actions.append(retryStages.length ? menu : "", h("span", { class: "push" }), btn("やめる", "btn-quiet", () => {
      dr.dropping = true;
      render();
    }));
    for (const b of actions.querySelectorAll("button")) (b as HTMLButtonElement).disabled = state.busy;
    box.append(ta, actions);
  } else {
    box.append(h("p", { class: "note", text: "やめると Backlog は「準備できた」に戻ります。worktree とブランチは残します。" }));
    const ta = h("textarea", { id: "reason", placeholder: "やめる理由（任意）" }) as HTMLTextAreaElement;
    ta.value = dr.reason;
    ta.addEventListener("input", () => (dr.reason = ta.value));
    const actions = h("div", { class: "actions" }, [
      btn("やめる", "btn-danger", () => answer({ action: "drop", ...(dr.reason.trim() ? { reason: dr.reason } : {}) })),
      btn("戻る", "btn-quiet", () => {
        dr.dropping = false;
        render();
      }),
    ]);
    box.append(ta, actions);
  }
  return box;
}

async function act(tool: string, args: Record<string, unknown>): Promise<void> {
  state.busy = true;
  render();
  try {
    await call(tool, args);
    state.draft = { instruction: "", dropping: false, reason: "", menu: false };
    state.error = undefined;
  } catch (err) {
    state.error = `${tool === "cancelFactory" ? "止められませんでした" : "答えられませんでした"}：${(err as Error).message}`;
  } finally {
    state.busy = false;
  }
  await refresh(true);
}

// ---- 読み直す ------------------------------------------------------------------------
let timer: number | undefined;
let painted = "";
async function refresh(force = false): Promise<void> {
  if (timer) window.clearTimeout(timer);
  try {
    const got = await call<{ runs: RunSummary[] }>("getRuns");
    state.runs = got.runs;
    state.loaded = true;
    // 広いときは、何も選んでいなければ人を待っているもの→動いているものの一番上を開いておく
    if (!state.selected && wide()) {
      const first = rows().find((r) => r.item.status === "stopped") ?? rows().find((r) => active(r.item.status));
      if (first) state.selected = { runId: first.run.runId, item: first.item.item };
    }
    state.detail = state.selected ? await call<Detail>("getRunItem", { runId: state.selected.runId, item: state.selected.item }) : undefined;
    if (!state.busy) state.error = undefined;
  } catch (err) {
    state.error = `読み込めませんでした：${(err as Error).message}`;
  }
  const snapshot = JSON.stringify([state.runs, state.detail, state.error, state.selected]);
  const anyActive = rows().some((r) => active(r.item.status));
  // 書いている途中は描き直さない（答える欄の書きかけと焦点を守る）。経過の時刻は動いているものがあれば進める
  const typing = document.activeElement instanceof HTMLTextAreaElement;
  if (force || (!typing && (snapshot !== painted || anyActive))) {
    painted = snapshot;
    render();
  }
  timer = window.setTimeout(() => void refresh(), anyActive ? 3000 : 10000);
}

window.addEventListener("resize", () => render());

(async () => {
  try {
    const init = await request<{ hostContext?: { theme?: string; displayMode?: string; styles?: { variables?: Record<string, string | undefined> } } }>("ui/initialize", {
      protocolVersion: "2026-01-26",
      appInfo: { name: "banto-factory-runs", version: "0.1.0" },
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
  await refresh(true);
})();
