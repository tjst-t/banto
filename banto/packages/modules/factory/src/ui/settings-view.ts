// Factory の設定の画面（Project の設定の中に出る。`apps.ts` がこの JS を HTML に埋める）。形はモック
// （mock/components/banto/settings/factory-config-section.tsx、決定・2026-10-07）：
//   人が一番先に要るのはテストのコマンド——無いと流せない。それを一番上に。ほかは既定のままで動く。
//   保存しても、走っている実行は流し始めたときの設定のまま最後まで走る。

interface ToolResult { content?: { type: string; text?: string }[]; isError?: boolean }
interface AgentChoice { agent: string; model?: string; effort?: string }
interface Settings {
  testCommand: string;
  prepareCommand: string;
  targetBranch: string;
  implementer: AgentChoice;
  reviewer: AgentChoice;
  concurrency: number;
  limits: { testRetries: number; reviewRounds: number; rebaseRetries: number; noCommitRetries: number };
  testTimeoutMinutes: number;
}

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
  const msg = event.data as { jsonrpc?: string; id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: unknown };
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

const app = document.getElementById("app")!;
let saved: Settings | undefined;
let draft: Settings | undefined;
let agents: Array<{ id: string; title: string }> = [];
let agentsError: string | undefined;
let error: string | undefined;
let savedAt: string | undefined;
let saving = false;

const same = () => JSON.stringify(draft) === JSON.stringify(saved);

function textField(id: string, label: string, hint: string, value: string, set: (v: string) => void, opts: { lead?: boolean; placeholder?: string; need?: boolean } = {}): HTMLElement {
  const input = h("input", { id, "data-testid": id, type: "text", placeholder: opts.placeholder, "data-need": opts.need ? "" : undefined }) as HTMLInputElement;
  input.value = value;
  input.addEventListener("input", () => {
    set(input.value);
    paintSave();
  });
  return h("div", { class: "field" }, [
    h("label", { for: id, class: opts.lead ? "lead" : "name", text: label }),
    h("p", { class: "hint", text: hint }),
    input,
    opts.need ? h("p", { class: "need", text: "テストのコマンドを入れると、Factory に流せるようになります" }) : null,
  ]);
}

function numberField(id: string, label: string, value: number, min: number, max: number, set: (v: number) => void, hint?: string): HTMLElement {
  const input = h("input", { id, type: "number", min: String(min), max: String(max) }) as HTMLInputElement;
  input.value = String(value);
  input.addEventListener("input", () => {
    const n = Math.round(Number(input.value));
    if (Number.isFinite(n)) set(Math.min(max, Math.max(min, n)));
    paintSave();
  });
  return h("div", {}, [h("label", { for: id, class: "small-name", text: label }), hint ? h("p", { class: "hint", text: hint }) : null, input]);
}

function agentField(role: "implementer" | "reviewer", label: string, hint: string): HTMLElement {
  const value = draft![role];
  const select = h("select", { "aria-label": `${label}のエージェント`, "data-testid": `factory-config-${role}` }) as HTMLSelectElement;
  const known = agents.some((a) => a.id === value.agent) ? agents : [...agents, { id: value.agent, title: value.agent }];
  for (const a of known) {
    const o = h("option", { value: a.id, text: a.title }) as HTMLOptionElement;
    if (a.id === value.agent) o.selected = true;
    select.append(o);
  }
  select.addEventListener("change", () => {
    draft![role] = { ...draft![role], agent: select.value };
    paintSave();
  });
  const model = h("input", { type: "text", placeholder: "モデル（空ならエージェントの既定）", "aria-label": `${label}のモデル` }) as HTMLInputElement;
  model.value = value.model ?? "";
  model.addEventListener("input", () => {
    const m = model.value.trim();
    const next: AgentChoice = { agent: draft![role].agent, ...(m ? { model: m } : {}), ...(draft![role].effort ? { effort: draft![role].effort } : {}) };
    draft![role] = next;
    paintSave();
  });
  return h("div", {}, [h("span", { class: "name", text: label }), h("p", { class: "hint", text: hint }), h("div", { class: "agent-row" }, [select, model])]);
}

let saveRow: HTMLElement | undefined;
function paintSave(): void {
  if (!saveRow) return;
  const [save, revert, note] = saveRow.children as unknown as [HTMLButtonElement, HTMLButtonElement, HTMLElement];
  save.disabled = same() || saving;
  revert.hidden = same();
  note.textContent = `${savedAt && same() ? `${savedAt} に保存しました。` : ""}走っている実行は、流し始めたときの設定のまま進みます`;
  const test = document.getElementById("factory-test") as HTMLInputElement | null;
  if (test) {
    const need = !draft!.testCommand.trim();
    test.toggleAttribute("data-need", need);
    const msg = test.nextElementSibling as HTMLElement | null;
    if (need && !msg) test.after(h("p", { class: "need", text: "テストのコマンドを入れると、Factory に流せるようになります" }));
    if (!need && msg?.classList.contains("need")) msg.remove();
  }
}

function render(): void {
  app.replaceChildren();
  if (!draft) {
    app.append(h("p", { class: error ? "error" : "hint", text: error ?? "読み込んでいます…" }));
    reportSize();
    return;
  }
  const d = draft;
  app.append(
    textField("factory-test", "テストのコマンド", "worktree の中で走らせます。通ったものだけを取り込みます——空のままでは流せません", d.testCommand, (v) => (d.testCommand = v), {
      lead: true,
      placeholder: "npm test",
      need: !d.testCommand.trim(),
    }),
    textField("factory-prepare", "準備のコマンド（任意）", "worktree を作った直後に一度だけ。依存を写すなど", d.prepareCommand, (v) => (d.prepareCommand = v), { placeholder: "npm ci" }),
    h("div", { class: "field grid" }, [agentField("implementer", "実装役", "タスクを実装してコミットする"), agentField("reviewer", "レビュー役", "別の目で見るなら、実装役と別のものを")]),
    agentsError ? h("p", { class: "hint", text: `エージェントの一覧を Subagent から読めませんでした：${agentsError}` }) : "",
    h("div", { class: "field grid" }, [
      textFieldInline("factory-target", "取り込む先のブランチ", d.targetBranch, (v) => (d.targetBranch = v)),
      numberField("factory-concurrency", "同時に進める件数", d.concurrency, 1, 16, (v) => (d.concurrency = v), "テストを並べてコンテナを詰まらせない数に"),
    ]),
    h("fieldset", { class: "field", style: "border:0;padding:0;margin-left:0;margin-right:0" }, [
      h("legend", { class: "name", text: "止まって聞くまでの回数", style: "padding:0" }),
      h("p", { class: "hint", text: "越えたら止まって、頼んだ会話に知らせます" }),
      h("div", { class: "grid3" }, [
        numberField("factory-test-retries", "テストのやり直し", d.limits.testRetries, 0, 20, (v) => (d.limits.testRetries = v)),
        numberField("factory-review-rounds", "レビューの差し戻し", d.limits.reviewRounds, 0, 20, (v) => (d.limits.reviewRounds = v)),
        numberField("factory-rebase", "取り込みのやり直し", d.limits.rebaseRetries, 0, 20, (v) => (d.limits.rebaseRetries = v)),
      ]),
    ]),
    h("div", { class: "field" }, [numberField("factory-timeout", "テスト1回の上限（分）", d.testTimeoutMinutes, 1, 1440, (v) => (d.testTimeoutMinutes = v))]),
  );
  const save = h("button", { type: "button", class: "btn btn-primary", "data-testid": "factory-config-save", text: "設定を保存" }) as HTMLButtonElement;
  save.addEventListener("click", () => void doSave());
  const revert = h("button", { type: "button", class: "btn btn-quiet", text: "元に戻す" }) as HTMLButtonElement;
  revert.addEventListener("click", () => {
    draft = structuredClone(saved);
    render();
  });
  saveRow = h("div", { class: "save-row" }, [save, revert, h("span", { class: "save-note", "data-testid": "factory-config-note" })]);
  app.append(saveRow);
  if (error) app.append(h("p", { class: "error", text: error }));
  paintSave();
  reportSize();
}

function textFieldInline(id: string, label: string, value: string, set: (v: string) => void): HTMLElement {
  const input = h("input", { id, type: "text" }) as HTMLInputElement;
  input.value = value;
  input.addEventListener("input", () => {
    set(input.value.trim());
    paintSave();
  });
  return h("div", {}, [h("label", { for: id, class: "small-name", text: label }), input]);
}

async function doSave(): Promise<void> {
  saving = true;
  paintSave();
  try {
    const got = await call<{ settings: Settings }>("setSettings", { settings: draft });
    saved = got.settings;
    draft = structuredClone(got.settings);
    savedAt = new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
    error = undefined;
  } catch (err) {
    error = `保存できませんでした：${(err as Error).message}`;
  } finally {
    saving = false;
  }
  render();
}

(async () => {
  try {
    const init = await request<{ hostContext?: Appearance }>("ui/initialize", {
      protocolVersion: "2026-01-26",
      appInfo: { name: "banto-factory-config", version: "0.1.0" },
      appCapabilities: { availableDisplayModes: ["inline"] },
    });
    applyAppearance(init.hostContext ?? {});
    send({ method: "ui/notifications/initialized", params: {} });
  } catch (err) {
    app.textContent = `画面を始められませんでした：${(err as Error).message}`;
    return;
  }
  try {
    const got = await call<{ settings: Settings; agents?: Array<{ id: string; title: string }>; agentsError?: string }>("getSettings");
    saved = got.settings;
    draft = structuredClone(got.settings);
    agents = got.agents ?? [];
    agentsError = got.agentsError;
  } catch (err) {
    error = `設定を読めませんでした：${(err as Error).message}`;
  }
  render();
})();
