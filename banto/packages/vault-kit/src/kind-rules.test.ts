// **登録画面は2枚ある**——会話の中の入力欄（`request-app`）と、窓口の管理
// Canvas（`vault-directory/manage-app`）。同じ規則を2箇所に書いていたせいで、
// **片方だけ直る**ということが実際に起きた（2026-09-13、ユーザー報告
// 「fullscreen の管理画面で ssh key pair なのに選択肢が出ていない」）。
//
// ここで押さえるのは「規則が1枚であること」そのもの。
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALIAS_KIND_RULES, ALIAS_KIND_RULES_JS, REQUEST_APP_HTML } from "./index.js";

test("種別ごとの規則は、種別の語彙と過不足なく一致する", () => {
  assert.deepEqual(Object.keys(ALIAS_KIND_RULES).sort(), ["file", "secret", "ssh-identity"]);
  // **鍵の強さは鍵の種類が決める**——SSH で「作る強さ」を聞かない
  assert.equal(ALIAS_KIND_RULES["ssh-identity"]!.strength, false);
  assert.equal(ALIAS_KIND_RULES.secret!.strength, true);
  // **ファイルの中身はランダムに作れない**
  assert.equal(ALIAS_KIND_RULES.file!.canGenerate, false);
  // **1行に入らないもの**は複数行の欄で受ける
  assert.equal(ALIAS_KIND_RULES["ssh-identity"]!.multiline, true);
  assert.equal(ALIAS_KIND_RULES.file!.multiline, true);
  assert.equal(ALIAS_KIND_RULES.secret!.multiline, false);
  // 公開鍵が返るのは鍵ペアだけ
  assert.equal(ALIAS_KIND_RULES["ssh-identity"]!.returnsPublicKey, true);
});

test("画面に渡す JS は、表と同じ中身を運ぶ（書き直していない）", () => {
  // **この断片は素の HTML の <script> に埋まる**ので、埋め込み先の
  // テンプレート文字列を壊す文字を含んではいけない（実際に一度壊した）
  assert.equal(ALIAS_KIND_RULES_JS.includes("`"), false, "バッククォートが混ざっている");
  assert.ok(ALIAS_KIND_RULES_JS.includes(JSON.stringify(ALIAS_KIND_RULES)), "表を書き直している");
  assert.ok(ALIAS_KIND_RULES_JS.includes("function kindRule("));
  assert.ok(ALIAS_KIND_RULES_JS.includes("function generatableKinds("));
});

test("会話の中の入力欄は、その表を実際に埋め込んでいる", () => {
  assert.ok(REQUEST_APP_HTML.includes("const ALIAS_KIND_RULES ="), "表が画面に入っていない");
  assert.ok(REQUEST_APP_HTML.includes("kindRule("), "表を使っていない（直書きに戻っている）");
});
