/**
 * file.browser のプレビューモード（epic-0011・task-0050〜0055）の受け入れテスト。
 *
 * UI コンポーネント（React ・トグル・レンダリング結果）は現状のテスト構成
 * （node:test・ブラウザなし）では回せないため、表示の判断ロジックを分離した純粋モジュール
 * （packages/banto-web/src/views/filePreview.ts）を検証する。
 * レンダリング結果そのもの（Markdown の描画・shiki の色・Mermaid の SVG・CSV テーブル・
 * トグル操作・スクロール復元）は手動確認が必要（UI 検証はブラウザ必須）。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyDiffLine,
  codeLangOfPath,
  extOfPath,
  kindOfPath,
  PREVIEW_MAX_LINES,
} from "../../packages/banto-web/src/views/filePreview.js";

describe("[epic-0011] ファイル種別の判定（提案の種別表）", () => {
  it("Markdown: .md → markdown（task-0050）", () => {
    assert.equal(kindOfPath("README.md"), "markdown");
    assert.equal(kindOfPath("docs/2026-01-01-note.md"), "markdown");
  });

  it("Mermaid: .mmd / .mermaid → mermaid（task-0053）", () => {
    assert.equal(kindOfPath("diagram.mmd"), "mermaid");
    assert.equal(kindOfPath("diagram.mermaid"), "mermaid");
  });

  it("CSV/TSV: .csv / .tsv → csv（task-0054）", () => {
    assert.equal(kindOfPath("data.csv"), "csv");
    assert.equal(kindOfPath("data.tsv"), "csv");
  });

  it("diff/patch: .diff / .patch → diff（task-0055）", () => {
    assert.equal(kindOfPath("change.diff"), "diff");
    assert.equal(kindOfPath("change.patch"), "diff");
  });

  it("ソースコード: 提案の表の拡張子 → code（task-0052）", () => {
    const exts = [
      "ts", "js", "py", "rs", "go", "java", "c", "h", "cpp", "hpp",
      "css", "scss", "json", "yaml", "yml", "xml", "sh", "toml", "rb",
      "php", "swift", "kt", "dart",
    ];
    for (const ext of exts) {
      assert.equal(kindOfPath(`a.${ext}`), "code", `.${ext}`);
    }
  });

  it("該当しない拡張子・拡張子なしは plain（source モード固定）", () => {
    assert.equal(kindOfPath("notes.txt"), "plain");
    assert.equal(kindOfPath("README"), "plain");
    assert.equal(kindOfPath(".gitignore"), "plain");
  });

  it("大文字拡張子も判定できる（.MD / .CSV 等）", () => {
    assert.equal(kindOfPath("README.MD"), "markdown");
    assert.equal(kindOfPath("DATA.CSV"), "csv");
  });
});

describe("[epic-0011/task-0052] コード種別 → shiki 言語ID", () => {
  it("拡張子が shiki の言語IDに写る", () => {
    assert.equal(codeLangOfPath("a.ts"), "typescript");
    assert.equal(codeLangOfPath("a.js"), "javascript");
    assert.equal(codeLangOfPath("a.py"), "python");
    assert.equal(codeLangOfPath("a.rs"), "rust");
    assert.equal(codeLangOfPath("a.go"), "go");
    assert.equal(codeLangOfPath("a.h"), "c");
    assert.equal(codeLangOfPath("a.hpp"), "cpp");
    assert.equal(codeLangOfPath("a.yml"), "yaml");
    assert.equal(codeLangOfPath("a.sh"), "shell");
  });

  it("code 以外の種別は言語を持たない", () => {
    assert.equal(codeLangOfPath("a.md"), undefined);
    assert.equal(codeLangOfPath("a.txt"), undefined);
    assert.equal(codeLangOfPath("a.csv"), undefined);
  });
});

describe("[epic-0011/task-0055] diff 行の色分け判定", () => {
  it("追加行（+）は gv-add。ただし +++ ヘッダは対象外", () => {
    assert.equal(classifyDiffLine("+const x = 1;"), "gv-add");
    assert.equal(classifyDiffLine("+++ b/file.ts"), undefined);
  });

  it("削除行（-）は gv-del。ただし --- ヘッダは対象外", () => {
    assert.equal(classifyDiffLine("-const x = 1;"), "gv-del");
    assert.equal(classifyDiffLine("--- a/file.ts"), undefined);
  });

  it("ハンクヘッダ（@@）は gv-hunk", () => {
    assert.equal(classifyDiffLine("@@ -1,3 +1,4 @@"), "gv-hunk");
  });

  it("diff --git ヘッダは gv-file、その他は無色", () => {
    assert.equal(classifyDiffLine("diff --git a/x b/x"), "gv-file");
    assert.equal(classifyDiffLine(" 共通行"), undefined);
  });
});

describe("[epic-0011/task-0050] 2000行ルールと拡張子切り出し", () => {
  it("PREVIEW_MAX_LINES は 2000（これを超えると preview 無効）", () => {
    assert.equal(PREVIEW_MAX_LINES, 2000);
  });

  it("extOfPath が末尾の拡張子を切り出す", () => {
    assert.equal(extOfPath("a/b/c.ts"), "ts");
    assert.equal(extOfPath("README"), "");
    assert.equal(extOfPath(".gitignore"), "");
    assert.equal(extOfPath("a.tar.gz"), "gz");
  });
});
