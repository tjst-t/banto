/**
 * 別タブで開く1枚の宛先（spec-file-browser §5.8.4・PO要望 2026-08-09）。
 *
 * **別タブは `file.raw` ではなく、整形して読む1枚へ送る。** raw は md も ts も
 * `text/plain`（§5.8.2）で配るので、面の中では整形で読めていたものが別タブでは原文に
 * 戻っていた——PO報告「マークダウンとかを別タブで開いたときにソースファイル表示になる」。
 *
 * 描いた結果（React）はここでは見られないので、**位置の組み立てと読み取り**を見る。
 * 特に読み取りは砦でもある：到達先を URL に載せる以上、外を指す値を弾けていることが要る。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  filePageUrl,
  parseFilePageTarget,
} from "../../packages/banto-web/src/views/filePage.js";

describe("別タブの1枚: 位置の組み立て", () => {
  it("組み立てたものをそのまま読み戻せる", () => {
    const url = filePageUrl("/", "/api/workspace", "書斎", "reports/2026-08-09-調べもの.md");
    const target = parseFilePageTarget(url.slice(url.indexOf("?")));
    assert.deepEqual(target, {
      endpoint: "/api/workspace",
      place: "書斎",
      path: "reports/2026-08-09-調べもの.md",
    });
  });

  it("配られている経路の下に置く（中継の下でも効く）", () => {
    const url = filePageUrl("/env/e-12/", "/api/workspace", "demo", "a.md");
    assert.ok(url.startsWith("/env/e-12/?"), url);
  });

  it("`#` や `?` を含む名前でも壊れない", () => {
    const url = filePageUrl("/", "/api/workspace", "demo", "notes/a?b#c.md");
    const target = parseFilePageTarget(url.slice(url.indexOf("?")));
    assert.equal(target?.path, "notes/a?b#c.md");
  });
});

describe("別タブの1枚: 位置の読み取り（砦）", () => {
  it("欠けていれば「別タブの位置ではない」（いつもの画面を出す）", () => {
    assert.equal(parseFilePageTarget(""), undefined);
    assert.equal(parseFilePageTarget("?view=history"), undefined);
    assert.equal(parseFilePageTarget("?file=a.md&place=demo"), undefined);
    assert.equal(parseFilePageTarget("?file=a.md&ep=/api/workspace"), undefined);
  });

  /**
   * **これが本丸。** 到達先は `file.read` を POST する先になる。外を指せるなら、
   * 細工した1本のリンクで「Banto の画面が、別のオリジンへPOのセッションで問い合わせる」
   * ことになる。`/` 始まりというだけでは足りない——`//host` はプロトコル相対。
   */
  it("自分のオリジンの外を指す到達先は認めない", () => {
    for (const ep of [
      "//evil.example/api",
      "https://evil.example/api",
      "http://127.0.0.1:9/api",
      "\\\\evil.example/api",
      "/\\evil.example/api",
      "api/workspace",
    ]) {
      assert.equal(
        parseFilePageTarget(`?file=a.md&place=demo&ep=${encodeURIComponent(ep)}`),
        undefined,
        ep
      );
    }
  });

  it("自分のオリジンの中なら通す", () => {
    const target = parseFilePageTarget("?file=a.md&place=demo&ep=%2Fapi%2Fworkspace");
    assert.equal(target?.endpoint, "/api/workspace");
  });
});
