// 設定 Canvas——tasks.json の場所（§4.4「Backlog の設定で変えられる」）。値は Module が持ち、読み書きは
// この Module の tool（getSettings・setSettings）を呼ぶ。保存したら、その場所のファイルの様子も言う
// （無い・古い形・読める）——「保存できたのに一覧が空」の理由がその場で分かるように。

import { h } from "./dom.js";
import { callTool, errorMessage, reportSize } from "./protocol.js";

interface Settings {
  path: string;
}

function settingsOf(result: { structuredContent?: Record<string, unknown> }): Settings {
  const path = result.structuredContent?.path;
  if (typeof path !== "string") throw new Error("設定を読み取れませんでした");
  return { path };
}

async function describeFile(): Promise<string> {
  const board = (await callTool("getBoard")).structuredContent as
    | { state?: string; path?: string; reason?: string; doc?: { items?: unknown[] } }
    | undefined;
  if (!board) return "";
  if (board.state === "missing") return `${board.path} はまだありません。最初の項目を足したときに作ります。`;
  if (board.state === "refused") return `${board.path} は読めません：${board.reason ?? ""}`;
  return `${board.path} に ${board.doc?.items?.length ?? 0} 件あります。`;
}

export function mountConfig(root: HTMLElement): void {
  const input = h("input", { attrs: { "aria-label": "tasks.json の場所", spellcheck: "false" }, data: { testid: "backlog-config-path" } });
  const save = h("button", { class: "btn", text: "保存する", attrs: { type: "button" }, data: { testid: "backlog-config-save" } });
  const note = h("p", { class: "note", text: "読み込んでいます…", data: { testid: "backlog-config-note" } });
  const fileNote = h("p", { class: "note", data: { testid: "backlog-config-file" } });
  root.replaceChildren(
    h(
      "div",
      { class: "config" },
      h(
        "label",
        {},
        "tasks.json の場所（Project の根から）",
        h("span", { class: "field" }, input, save),
      ),
      h("p", { class: "note", text: "既定は docs/tasks.json。Project の根の外は指せません。" }),
      note,
      fileNote,
    ),
  );
  const refreshFile = async () => {
    try {
      fileNote.textContent = await describeFile();
    } catch (err) {
      fileNote.textContent = `ファイルの様子を読めませんでした：${errorMessage(err)}`;
    }
    reportSize();
  };
  save.addEventListener("click", async () => {
    note.classList.remove("error");
    note.textContent = "保存しています…";
    reportSize();
    try {
      const saved = settingsOf(await callTool("setSettings", { path: input.value }));
      input.value = saved.path;
      note.textContent = `保存しました（${saved.path}）`;
      await refreshFile();
    } catch (err) {
      // **保存できたふりをしない**
      note.classList.add("error");
      note.textContent = `保存できませんでした：${errorMessage(err)}`;
    }
    reportSize();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) save.click();
  });
  void (async () => {
    try {
      input.value = settingsOf(await callTool("getSettings")).path;
      note.textContent = "";
      await refreshFile();
    } catch (err) {
      note.classList.add("error");
      note.textContent = `いまの設定を読めませんでした：${errorMessage(err)}`;
    }
    reportSize();
  })();
}
