// **画面の HTML はテンプレート文字列の中**にある。そこに ` を書くと
// 文字列が途中で閉じてビルドが壊れる——**3回踏んだ**（2026-09-12・13・14）。
// コメントのつもりの ` も同じなので、機械で止める。
//
// あわせて、MCP Apps の初期化で **host が検査する名前**も押さえる
// （`capabilities` と書いて弾かれ、画面が出ないまま終わった・2026-09-14）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { REQUEST_APP_HTML } from "./index.js";

test("画面の HTML にバッククォートを混ぜない（テンプレート文字列が閉じる）", () => {
  assert.equal(REQUEST_APP_HTML.includes("`"), false, "バッククォートが混ざっている");
});

test("初期化は appCapabilities で名乗る（capabilities では弾かれる）", () => {
  assert.ok(REQUEST_APP_HTML.includes("appCapabilities:"), "appCapabilities を送っていない");
  assert.equal(
    /[^p]capabilities:\s*\{/.test(REQUEST_APP_HTML.replace("appCapabilities:", "")),
    false,
    "capabilities という名前で送っている（host に弾かれる）",
  );
});
