// 設定 Canvas——一覧を置くブランチ（§4.4「設定」。既定 backlog、中は tasks.json 固定）。値は Module が持ち、読み書きは
// この Module の tool（getSettings・setSettings）を呼ぶ。保存したら、そのブランチの様子も言う
// （無い・古い形・読める）——「保存できたのに一覧が空」の理由がその場で分かるように。

import { h } from "./dom.js";
import { callTool, errorMessage, reportSize } from "./protocol.js";

interface Settings {
  branch: string;
}

function settingsOf(result: { structuredContent?: Record<string, unknown> }): Settings {
  const branch = result.structuredContent?.branch;
  if (typeof branch !== "string") throw new Error("設定を読み取れませんでした");
  return { branch };
}

async function describeBranch(): Promise<string> {
  const board = (await callTool("getBoard")).structuredContent as
    | { state?: string; branch?: string; reason?: string; notRepository?: string; doc?: { items?: unknown[] } }
    | undefined;
  if (!board) return "";
  if (board.notRepository) return board.notRepository;
  if (board.state === "missing") return `${board.branch} ブランチはまだありません。最初の項目を足したときに作ります。`;
  if (board.state === "refused") return `${board.branch} ブランチの tasks.json は読めません：${board.reason ?? ""}`;
  return `${board.branch} ブランチに ${board.doc?.items?.length ?? 0} 件あります。`;
}

export function mountConfig(root: HTMLElement): void {
  const input = h("input", { attrs: { "aria-label": "一覧を置くブランチ", spellcheck: "false" }, data: { testid: "backlog-config-branch" } });
  const save = h("button", { class: "btn", text: "保存する", attrs: { type: "button" }, data: { testid: "backlog-config-save" } });
  const note = h("p", { class: "note", text: "読み込んでいます…", data: { testid: "backlog-config-note" } });
  const fileNote = h("p", { class: "note", data: { testid: "backlog-config-branch-state" } });
  root.replaceChildren(
    h(
      "div",
      { class: "config" },
      h(
        "label",
        {},
        "一覧を置くブランチ",
        h("span", { class: "field" }, input, save),
      ),
      h("p", {
        class: "note",
        text: "既定は backlog。コードの履歴とつながらないブランチに tasks.json を1つ置き、変更のたびにコミットして origin へ送ります。作業ツリーには触りません。",
      }),
      note,
      fileNote,
    ),
  );
  const refreshFile = async () => {
    try {
      fileNote.textContent = await describeBranch();
    } catch (err) {
      fileNote.textContent = `ブランチの様子を読めませんでした：${errorMessage(err)}`;
    }
    reportSize();
  };
  save.addEventListener("click", async () => {
    note.classList.remove("error");
    note.textContent = "保存しています…";
    reportSize();
    try {
      const saved = settingsOf(await callTool("setSettings", { branch: input.value }));
      input.value = saved.branch;
      note.textContent = `保存しました（${saved.branch}）`;
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
      input.value = settingsOf(await callTool("getSettings")).branch;
      note.textContent = "";
      await refreshFile();
    } catch (err) {
      note.classList.add("error");
      note.textContent = `いまの設定を読めませんでした：${errorMessage(err)}`;
    }
    reportSize();
  })();
}
