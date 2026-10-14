// 設定 Canvas——一覧を置くブランチ（§4.4「設定」。既定 backlog、中は tasks.json 固定）と、送るときに使う SSH 鍵
// （§4.4「Vault の SSH 鍵で送る」。選べるのは Vault の ssh-identity の alias、既定は使わない）。値は Module が持ち、
// 読み書きはこの Module の tool（getSettings・setSettings・listSshIdentities）を呼ぶ。保存したら、そのブランチの様子も
// 言う（無い・古い形・読める）——「保存できたのに一覧が空」の理由がその場で分かるように。

import { h } from "./dom.js";
import { callTool, errorMessage, reportSize } from "./protocol.js";

interface Settings {
  branch: string;
  /** 空なら使わない */
  sshIdentity: string;
}

function settingsOf(result: { structuredContent?: Record<string, unknown> }): Settings {
  const branch = result.structuredContent?.branch;
  const ssh = result.structuredContent?.sshIdentity;
  if (typeof branch !== "string") throw new Error("設定を読み取れませんでした");
  return { branch, sshIdentity: typeof ssh === "string" ? ssh : "" };
}

/**
 * 鍵の選択肢を並べ直す。いま設定されている名前が目録に無い（消された・この Project から引けなくなった）ときも、
 * 黙って「使わない」に見せない——その名前を「見つかりません」として残す
 */
function fillKeys(select: HTMLSelectElement, names: string[], current: string): void {
  const options = [h("option", { text: "使わない", attrs: { value: "" } })];
  for (const name of names) options.push(h("option", { text: name, attrs: { value: name } }));
  if (current && !names.includes(current)) options.push(h("option", { text: `${current}（Vault に見つかりません）`, attrs: { value: current } }));
  select.replaceChildren(...options);
  select.value = current;
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
  const keySelect = h("select", { attrs: { "aria-label": "送るときに使う SSH 鍵" }, data: { testid: "backlog-config-ssh" } });
  const keyNote = h("p", { class: "note", data: { testid: "backlog-config-ssh-note" } });
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
        h("span", { class: "field" }, input),
      ),
      h("p", {
        class: "note",
        text: "既定は backlog。コードの履歴とつながらないブランチに tasks.json を1つ置き、変更のたびにコミットして origin へ送ります。作業ツリーには触りません。",
      }),
      h("label", {}, "送るときに使う SSH 鍵", h("span", { class: "field" }, keySelect)),
      h("p", {
        class: "note",
        text:
          "Repositories が送れないとき（別のサーバの Project など）、選んだ鍵を Vault から借りて、このリポジトリの git で送ります。" +
          "秘密鍵は Vault の外に出ません。origin が ssh の URL（git@github.com:<owner>/<name>.git）のときだけ効きます。",
      }),
      keyNote,
      h("span", { class: "field" }, save),
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
      const saved = settingsOf(await callTool("setSettings", { branch: input.value, sshIdentity: keySelect.value }));
      input.value = saved.branch;
      keySelect.value = saved.sshIdentity;
      note.textContent = `保存しました（${saved.branch}${saved.sshIdentity ? `・SSH 鍵 ${saved.sshIdentity}` : ""}）`;
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
      const current = settingsOf(await callTool("getSettings"));
      input.value = current.branch;
      fillKeys(keySelect, [], current.sshIdentity);
      note.textContent = "";
      keyNote.textContent = "Vault の SSH 鍵を読んでいます…";
      try {
        const listed = (await callTool("listSshIdentities")).structuredContent as { names?: unknown; warning?: unknown } | undefined;
        const names = Array.isArray(listed?.names) ? listed.names.filter((n): n is string => typeof n === "string") : [];
        fillKeys(keySelect, names, current.sshIdentity);
        keyNote.classList.remove("error");
        keyNote.textContent = [
          names.length === 0 ? "この Project から使える SSH 鍵（ssh-identity）が Vault にありません。" : "",
          typeof listed?.warning === "string" ? listed.warning : "",
        ]
          .filter(Boolean)
          .join(" ");
      } catch (err) {
        // 選べないことを見せる（いまの設定はそのまま残る）
        keyNote.classList.add("error");
        keyNote.textContent = `Vault の SSH 鍵を読めませんでした：${errorMessage(err)}`;
      }
      await refreshFile();
    } catch (err) {
      note.classList.add("error");
      note.textContent = `いまの設定を読めませんでした：${errorMessage(err)}`;
    }
    reportSize();
  })();
}
