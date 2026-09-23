// editFile の結果を差分として描く（v4-modules.md §2.2「editFile の結果は行単位差分で
// inline カードに埋め込む」、モック `canvas-content.tsx` の FsEditDiffView）。
//
// **描くのは tool の結果（unified diff）だけ**——ファイルを読み直さない。記録から
// 組み直したとき、ファイルはもう別の中身かもしれない（その時点の差分が真実）。

import { h, replaceChildren } from "./dom.js";
import { icon } from "./icons.js";
import { reportSize, textOf, type CallToolResult } from "./protocol.js";
import { parseUnifiedDiff } from "../unified-diff.js";

export class EditDiffView {
  private path = "";
  private state: { kind: "waiting" } | { kind: "error"; message: string } | { kind: "cancelled" } | { kind: "done"; text: string } = {
    kind: "waiting",
  };

  constructor(private readonly root: HTMLElement) {
    this.render();
  }

  setToolInput(args: Record<string, unknown>): void {
    if (typeof args.path === "string") this.path = args.path;
    this.render();
  }

  setToolResult(result: CallToolResult): void {
    this.state = result.isError
      ? { kind: "error", message: textOf(result) || "編集できませんでした" }
      : { kind: "done", text: textOf(result) };
    this.render();
  }

  setCancelled(): void {
    if (this.state.kind === "waiting") this.state = { kind: "cancelled" };
    this.render();
  }

  private render(): void {
    const state = this.state;
    const parsed = state.kind === "done" ? parseUnifiedDiff(state.text) : undefined;
    const path = parsed?.path ?? this.path;
    const head = h(
      "div",
      { class: "diff-head" },
      h("span", { class: "badge truncate", text: path || "（ファイル）", data: { testid: "diff-path" } }),
      parsed
        ? h(
            "span",
            { class: "diff-stat", data: { testid: "diff-stat" } },
            h("span", { class: "add", text: `+${parsed.additions}` }),
            " ",
            h("span", { class: "del", text: `-${parsed.deletions}` }),
          )
        : null,
    );

    let body: HTMLElement;
    if (state.kind === "waiting") {
      body = h("div", { class: "state" }, icon("Loader2", "icon spin"), "編集の結果を待っています…");
    } else if (state.kind === "cancelled") {
      body = h("div", { class: "state" }, "取り消されました");
    } else if (state.kind === "error") {
      body = h("div", { class: "state error" }, icon("TriangleAlert"), `編集できませんでした：${state.message}`);
    } else if (!parsed || parsed.rows.length === 0) {
      body = h("div", { class: "state" }, "変更はありませんでした");
    } else {
      body = h(
        "div",
        { class: "diff-body", data: { testid: "diff-body" } },
        ...parsed.rows.map((row) => {
          if (row.kind === "hunk") return h("div", { class: "diff-row hunk", text: row.text });
          const sign = row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " ";
          return h(
            "div",
            { class: `diff-row ${row.kind}`, data: { kind: row.kind } },
            h("span", { class: "ln", text: row.oldNo !== undefined ? String(row.oldNo) : "" }),
            h("span", { class: "ln", text: row.newNo !== undefined ? String(row.newNo) : "" }),
            h("span", { class: "sign", text: sign }),
            h("span", { text: row.text }),
          );
        }),
      );
    }
    replaceChildren(this.root, h("div", { data: { testid: "edit-diff" } }, head, body));
    reportSize();
  }
}
