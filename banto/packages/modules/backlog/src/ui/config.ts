// 設定 Canvas——一覧の置き場（§4.4「Gist の置き場」。tasks.json＝リポジトリの一覧のブランチ・GitHub Gist（非公開）、
// 既定は tasks.json。見た目はモックの backlog-config-section.tsx）。tasks.json なら一覧を置くブランチ（§4.4「設定」。既定
// backlog、中は tasks.json 固定）と送るときに使う SSH 鍵（§4.4「Vault の SSH 鍵で送る」。選べるのは Vault の ssh-identity の
// alias、既定は使わない）。Gist なら Gist の id と、Gist に書くトークン（Vault の secret・oauth-token の alias）、それと
// 「新しい Gist を作る」。値は Module が持ち、読み書きはこの Module の tool（getSettings・setSettings・listSshIdentities・
// listGistTokens・createGist）を呼ぶ。保存したら、その置き場の様子も言う（無い・古い形・読める）——「保存できたのに一覧が
// 空」の理由がその場で分かるように。

import { h } from "./dom.js";
import { callTool, errorMessage, reportSize } from "./protocol.js";

type Backend = "tasks-json" | "gist";

interface Settings {
  backend: Backend;
  branch: string;
  /** 空なら使わない */
  sshIdentity: string;
  /** 空なら未設定 */
  gistId: string;
  gistToken: string;
}

function settingsOf(result: { structuredContent?: Record<string, unknown> }): Settings {
  const sc = result.structuredContent;
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  if (typeof sc?.branch !== "string" || (sc.backend !== "tasks-json" && sc.backend !== "gist")) throw new Error("設定を読み取れませんでした");
  return { backend: sc.backend, branch: sc.branch, sshIdentity: text(sc.sshIdentity), gistId: text(sc.gistId), gistToken: text(sc.gistToken) };
}

/** 選択肢（モックの BACKLOG_BACKEND_LABEL） */
const BACKEND_LABEL: Record<Backend, string> = {
  "tasks-json": "tasks.json（リポジトリの専用ブランチ）",
  gist: "GitHub Gist（非公開）",
};

/**
 * 鍵の選択肢を並べ直す。いま設定されている名前が目録に無い（消された・この Project から引けなくなった）ときも、
 * 黙って「使わない」に見せない——その名前を「見つかりません」として残す
 */
function fillKeys(select: HTMLSelectElement, names: string[], current: string, none = "使わない"): void {
  const options = [h("option", { text: none, attrs: { value: "" } })];
  for (const name of names) options.push(h("option", { text: name, attrs: { value: name } }));
  if (current && !names.includes(current)) options.push(h("option", { text: `${current}（Vault に見つかりません）`, attrs: { value: current } }));
  select.replaceChildren(...options);
  select.value = current;
}

async function describePlace(): Promise<string> {
  const board = (await callTool("getBoard")).structuredContent as
    | {
        state?: string;
        branch?: string;
        reason?: string;
        notRepository?: string;
        unavailable?: string;
        gist?: { id: string };
        doc?: { items?: unknown[] };
      }
    | undefined;
  if (!board) return "";
  if (board.notRepository) return board.notRepository;
  if (board.unavailable) return board.unavailable;
  if (board.gist) {
    if (board.state === "missing") return `Gist ${board.gist.id} に tasks.json はまだありません。最初の項目を足したときに作ります。`;
    if (board.state === "refused") return `Gist ${board.gist.id} の tasks.json は読めません：${board.reason ?? ""}`;
    return `Gist ${board.gist.id} に ${board.doc?.items?.length ?? 0} 件あります。`;
  }
  if (board.state === "missing") return `${board.branch} ブランチはまだありません。最初の項目を足したときに作ります。`;
  if (board.state === "refused") return `${board.branch} ブランチの tasks.json は読めません：${board.reason ?? ""}`;
  return `${board.branch} ブランチに ${board.doc?.items?.length ?? 0} 件あります。`;
}

export function mountConfig(root: HTMLElement): void {
  const backendSelect = h(
    "select",
    { attrs: { "aria-label": "一覧の置き場" }, data: { testid: "backlog-config-backend" } },
    ...(Object.keys(BACKEND_LABEL) as Backend[]).map((b) => h("option", { text: BACKEND_LABEL[b], attrs: { value: b } })),
  );
  const input = h("input", { attrs: { "aria-label": "一覧を置くブランチ", spellcheck: "false" }, data: { testid: "backlog-config-branch" } });
  const keySelect = h("select", { attrs: { "aria-label": "送るときに使う SSH 鍵" }, data: { testid: "backlog-config-ssh" } });
  const keyNote = h("p", { class: "note", data: { testid: "backlog-config-ssh-note" } });
  const gistInput = h("input", {
    attrs: { "aria-label": "Gist の id か URL", spellcheck: "false", placeholder: "https://gist.github.com/<owner>/<id>" },
    data: { testid: "backlog-config-gist-id" },
  });
  const tokenSelect = h("select", { attrs: { "aria-label": "Gist に書くトークン" }, data: { testid: "backlog-config-gist-token" } });
  const tokenNote = h("p", { class: "note", data: { testid: "backlog-config-gist-token-note" } });
  const create = h("button", { class: "btn", text: "新しい Gist を作る", attrs: { type: "button" }, data: { testid: "backlog-config-gist-create" } });
  const save = h("button", { class: "btn", text: "保存する", attrs: { type: "button" }, data: { testid: "backlog-config-save" } });
  const note = h("p", { class: "note", text: "読み込んでいます…", data: { testid: "backlog-config-note" } });
  const fileNote = h("p", { class: "note", data: { testid: "backlog-config-branch-state" } });
  const branchSection = h(
    "div",
    { class: "config", data: { testid: "backlog-config-branch-section" } },
    h("label", {}, "一覧を置くブランチ", h("span", { class: "field" }, input)),
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
  );
  const gistSection = h(
    "div",
    { class: "config", data: { testid: "backlog-config-gist-section" } },
    h("label", {}, "Gist に書くトークン", h("span", { class: "field" }, tokenSelect)),
    h("p", {
      class: "note",
      text: "Vault に置いた GitHub のトークン（classic の PAT なら gist、fine-grained なら Gists の Read and write）。使うたびに Vault から引きます。",
    }),
    tokenNote,
    h("label", {}, "Gist", h("span", { class: "field" }, gistInput)),
    h("p", {
      class: "note",
      text: "tasks.json を置く Gist の URL か id。無ければ「新しい Gist を作る」で、非公開の Gist を作ってここに置きます。Gist にほかのファイルがあっても消しません。",
    }),
    h("span", { class: "field" }, create),
  );
  root.replaceChildren(
    h(
      "div",
      { class: "config" },
      h("label", {}, "一覧の置き場", h("span", { class: "field" }, backendSelect)),
      h("p", {
        class: "note",
        text: "どちらも dependsOn・parent を含む今の Backlog のモデルをそのまま持ちます。複数の Project をまたぐ計画を持つ場所には Gist を選べます。",
      }),
      branchSection,
      gistSection,
      h("span", { class: "field" }, save),
      note,
      fileNote,
    ),
  );
  const showBackend = () => {
    const gist = backendSelect.value === "gist";
    branchSection.hidden = gist;
    gistSection.hidden = !gist;
    reportSize();
  };
  backendSelect.addEventListener("change", showBackend);
  const refreshFile = async () => {
    try {
      fileNote.textContent = await describePlace();
    } catch (err) {
      fileNote.textContent = `置き場の様子を読めませんでした：${errorMessage(err)}`;
    }
    reportSize();
  };
  const show = (saved: Settings) => {
    backendSelect.value = saved.backend;
    input.value = saved.branch;
    keySelect.value = saved.sshIdentity;
    gistInput.value = saved.gistId;
    tokenSelect.value = saved.gistToken;
    showBackend();
  };
  save.addEventListener("click", async () => {
    note.classList.remove("error");
    note.textContent = "保存しています…";
    reportSize();
    try {
      const saved = settingsOf(
        await callTool("setSettings", {
          backend: backendSelect.value,
          branch: input.value,
          sshIdentity: keySelect.value,
          gistId: gistInput.value,
          gistToken: tokenSelect.value,
        }),
      );
      show(saved);
      note.textContent =
        saved.backend === "gist"
          ? `保存しました（Gist ${saved.gistId}・トークン ${saved.gistToken}）`
          : `保存しました（${saved.branch}${saved.sshIdentity ? `・SSH 鍵 ${saved.sshIdentity}` : ""}）`;
      await refreshFile();
    } catch (err) {
      // **保存できたふりをしない**
      note.classList.add("error");
      note.textContent = `保存できませんでした：${errorMessage(err)}`;
    }
    reportSize();
  });
  create.addEventListener("click", async () => {
    note.classList.remove("error");
    if (!tokenSelect.value) {
      note.classList.add("error");
      note.textContent = "Gist を作るトークンを選んでください";
      reportSize();
      return;
    }
    note.textContent = "Gist を作っています…";
    create.disabled = true;
    reportSize();
    try {
      const result = await callTool("createGist", { gistToken: tokenSelect.value });
      show(settingsOf(result));
      note.textContent = result.content?.[0]?.text ?? "";
      await refreshFile();
    } catch (err) {
      note.classList.add("error");
      note.textContent = `Gist を作れませんでした：${errorMessage(err)}`;
    } finally {
      create.disabled = false;
    }
    reportSize();
  });
  for (const field of [input, gistInput]) {
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) save.click();
    });
  }
  /** Vault の目録から選択肢を埋める（読めなければ、選べないことを見せる。いまの設定はそのまま残る） */
  const loadAliases = async (tool: string, select: HTMLSelectElement, noteEl: HTMLElement, current: string, what: string, none: string) => {
    noteEl.textContent = `Vault の${what}を読んでいます…`;
    try {
      const listed = (await callTool(tool)).structuredContent as { names?: unknown; warning?: unknown } | undefined;
      const names = Array.isArray(listed?.names) ? listed.names.filter((n): n is string => typeof n === "string") : [];
      fillKeys(select, names, current, none);
      noteEl.classList.remove("error");
      noteEl.textContent = [names.length === 0 ? `この Project から使える${what}が Vault にありません。` : "", typeof listed?.warning === "string" ? listed.warning : ""]
        .filter(Boolean)
        .join(" ");
    } catch (err) {
      noteEl.classList.add("error");
      noteEl.textContent = `Vault の${what}を読めませんでした：${errorMessage(err)}`;
    }
  };
  void (async () => {
    try {
      const current = settingsOf(await callTool("getSettings"));
      fillKeys(keySelect, [], current.sshIdentity);
      fillKeys(tokenSelect, [], current.gistToken, "選んでください");
      show(current);
      note.textContent = "";
      await Promise.all([
        loadAliases("listSshIdentities", keySelect, keyNote, current.sshIdentity, "SSH 鍵（ssh-identity）", "使わない"),
        loadAliases("listGistTokens", tokenSelect, tokenNote, current.gistToken, "トークン（secret・oauth-token）", "選んでください"),
      ]);
      reportSize();
      await refreshFile();
    } catch (err) {
      note.classList.add("error");
      note.textContent = `いまの設定を読めませんでした：${errorMessage(err)}`;
    }
    reportSize();
  })();
}
