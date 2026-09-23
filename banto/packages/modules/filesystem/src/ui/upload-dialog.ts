// アップロードのダイアログ（モック `file-explorer-view.tsx` の UploadDialog と同じ形）。
// ドラッグするか押して選び、並べて確かめてから置く。**同じ名前があれば「上書き」と
// 先に見せる**——押したあとで気づくのでは遅い。

import { h, replaceChildren } from "./dom.js";
import { icon } from "./icons.js";
import { formatBytes } from "../view/preview-kind.js";
import { errorMessage } from "./protocol.js";

/** 1つのファイルの上限。中身は base64 にして tool の引数で運ぶので、大きすぎると重い。 */
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

export interface UploadDialogOptions {
  targetLabel: string;
  /** 置き先にすでにある名前（上書きになるものを先に示す） */
  existingNames: ReadonlySet<string>;
  /** 選んだファイルを置く。失敗したら例外（ダイアログは開いたまま、理由を出す） */
  upload: (files: File[]) => Promise<void>;
}

export function openUploadDialog(options: UploadDialogOptions): void {
  let files: File[] = [];
  let uploading = false;

  const input = h("input", { attrs: { type: "file", multiple: "", hidden: "" } });
  const list = h("div", { class: "file-list", data: { testid: "upload-list" } });
  const error = h("p", { class: "note error", attrs: { hidden: "" } });
  const cancel = h("button", { class: "btn", text: "キャンセル", attrs: { type: "button" } });
  const confirm = h("button", { class: "btn btn-primary", attrs: { type: "button" }, data: { testid: "upload-confirm" } });
  const dropzone = h(
    "div",
    { class: "dropzone", attrs: { role: "button", tabindex: "0" }, data: { testid: "upload-dropzone" } },
    icon("UploadCloud", "icon-lg"),
    h("span", { text: "ここにファイルをドラッグ、またはクリックして選択" }),
    h("span", { class: "sub", text: "複数ファイルをまとめて選べます" }),
  );
  const overlay = h(
    "div",
    { class: "overlay" },
    h(
      "div",
      { class: "dialog", attrs: { role: "dialog", "aria-modal": "true", "aria-label": "ファイルをアップロード" } },
      h(
        "div",
        {},
        h("h2", { text: "ファイルをアップロード" }),
        h("p", { class: "desc", text: `アップロード先：${options.targetLabel}` }),
      ),
      dropzone,
      input,
      list,
      error,
      h("div", { class: "dialog-foot" }, cancel, confirm),
    ),
  );

  function close(): void {
    if (uploading) return;
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  }
  function onKey(event: KeyboardEvent): void {
    if (event.key === "Escape") close();
  }

  function addFiles(picked: FileList | null): void {
    if (!picked) return;
    const names = new Set(files.map((f) => f.name));
    files = [...files, ...Array.from(picked).filter((f) => !names.has(f.name))];
    render();
  }

  function render(): void {
    list.hidden = files.length === 0;
    replaceChildren(
      list,
      ...files.map((file, index) => {
        const tooLarge = file.size > MAX_UPLOAD_BYTES;
        const flag = tooLarge
          ? h("span", { class: "flag error", text: `大きすぎます（上限 ${formatBytes(MAX_UPLOAD_BYTES)}）` })
          : options.existingNames.has(file.name)
            ? h("span", { class: "flag", text: "上書き" })
            : null;
        return h(
          "div",
          { class: "file-row" },
          icon("File", "icon muted"),
          h("span", { class: "name truncate", text: file.name }),
          flag,
          h("span", { class: "size", text: formatBytes(file.size) }),
          h(
            "button",
            {
              class: "icon-btn",
              title: "外す",
              attrs: { type: "button", "aria-label": `${file.name} を外す` },
              on: {
                click: () => {
                  files = files.filter((_f, i) => i !== index);
                  render();
                },
              },
            },
            icon("X"),
          ),
        );
      }),
    );
    const blocked = files.some((f) => f.size > MAX_UPLOAD_BYTES);
    confirm.disabled = files.length === 0 || uploading || blocked;
    cancel.disabled = uploading;
    replaceChildren(
      confirm,
      uploading ? icon("Loader2", "icon spin") : null,
      `アップロード${files.length > 0 ? `（${files.length}件）` : ""}`,
    );
  }

  dropzone.addEventListener("click", () => input.click());
  dropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      input.click();
    }
  });
  dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropzone.classList.add("over");
  });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("over"));
  dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropzone.classList.remove("over");
    addFiles(event.dataTransfer?.files ?? null);
  });
  input.addEventListener("change", () => {
    addFiles(input.files);
    input.value = "";
  });
  cancel.addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  confirm.addEventListener("click", () => {
    if (confirm.disabled) return;
    uploading = true;
    error.hidden = true;
    render();
    options
      .upload(files)
      .then(() => {
        uploading = false;
        close();
      })
      .catch((err: unknown) => {
        uploading = false;
        error.textContent = `アップロードできませんでした：${errorMessage(err)}`;
        error.hidden = false;
        render();
      });
  });
  document.addEventListener("keydown", onKey);

  render();
  document.body.appendChild(overlay);
}
