// Module 宣言の**重ね方**（決定・2026-09-07、ユーザー指摘が起点）。
//
// **既定を写さない。変えたところだけを持つ。**
// 以前は Project ごとに宣言の一覧を**丸ごと写して**いた。すると既定を改良しても
// 写しを持つ Project には届かず、「そこだけ動かない」が起きる（実測・2026-09-07
// ——設定の置き場を足したのに、写しを持つ Project だけ保存できなかった）。
//
// **やり方は VS Code に倣う**（規則12——名前のある問題は既知の答えを使う）：
//   - 既定はプログラムが持ち、設定ファイルには**変えた項目だけ**が入る
//   - 「プリミティブと配列は**置換**、オブジェクトは**マージ**」
//     （https://code.visualstudio.com/docs/configure/settings）
// banto では command（文字列）と args（配列）は置換、env と meta はキー単位でマージ。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MODULE_DECLARATIONS } from "./declaration.js";
import { applyModuleOverlay, diffFromDefaults } from "./overlay.js";

/** 既定の filesystem（比較の基準として何度も使う）。 */
const defaultFilesystem = DEFAULT_MODULE_DECLARATIONS.find((d) => d.name === "filesystem")!;

test("差分が無ければ、既定そのまま", () => {
  assert.deepEqual(applyModuleOverlay(DEFAULT_MODULE_DECLARATIONS, []), DEFAULT_MODULE_DECLARATIONS);
  assert.deepEqual(applyModuleOverlay(DEFAULT_MODULE_DECLARATIONS, undefined), DEFAULT_MODULE_DECLARATIONS);
});

test("**env はキー単位でマージ**——差分に無いキーは既定のまま", () => {
  // これが今回の事故の本体。env を丸ごと置き換えていたので、**あとから既定に
  // 足したキーが、差分を持つ Project にだけ届かなかった**
  const merged = applyModuleOverlay(DEFAULT_MODULE_DECLARATIONS, [
    { name: "filesystem", launch: { env: { EXTRA: "1" } } },
  ]);
  const fs = merged.find((d) => d.name === "filesystem")!;

  assert.equal(fs.launch.env?.EXTRA, "1", "足したキーが入っていない");
  assert.equal(
    fs.launch.env?.BANTO_PROJECT_ROOT,
    defaultFilesystem.launch.env?.BANTO_PROJECT_ROOT,
    "**既定のキーが消えた**（丸ごと置き換えてしまっている）",
  );
});

test("command（文字列）と args（配列）は置換", () => {
  const merged = applyModuleOverlay(DEFAULT_MODULE_DECLARATIONS, [
    { name: "filesystem", launch: { command: "/usr/bin/other", args: ["a"] } },
  ]);
  const fs = merged.find((d) => d.name === "filesystem")!;
  assert.equal(fs.launch.command, "/usr/bin/other");
  assert.deepEqual(fs.launch.args, ["a"]);
  // 触っていない env はそのまま
  assert.deepEqual(fs.launch.env, defaultFilesystem.launch.env);
});

test("meta もキー単位でマージ——書いていない項目は既定のまま", () => {
  const merged = applyModuleOverlay(DEFAULT_MODULE_DECLARATIONS, [
    { name: "filesystem", meta: { handlesSecrets: true } },
  ]);
  const fs = merged.find((d) => d.name === "filesystem")!;
  const meta = fs.meta as Record<string, unknown>;
  assert.equal(meta.handlesSecrets, true);
  assert.deepEqual(meta.satisfies, ["filesystem"], "既定の項目が消えた");
  assert.ok(meta.confinement, "**閉じ込めの宣言が消えた**（安全側が落ちる）");
});

test("既定に無い Module は、そのまま足される", () => {
  const merged = applyModuleOverlay(DEFAULT_MODULE_DECLARATIONS, [
    {
      name: "python-demo",
      launch: { command: "/usr/bin/python3", args: ["server.py"] },
      meta: { satisfies: ["demo"], dependsOn: [], isolation: "subprocess", scope: "instance" },
    },
  ]);
  assert.equal(merged.length, DEFAULT_MODULE_DECLARATIONS.length + 1);
  assert.ok(merged.find((d) => d.name === "python-demo"));
});

test("**丸ごとの写しは、差分に圧縮できる**（いま Config に入っている古い形の移行）", () => {
  // 既定と同じ値は落ち、変えたところだけが残る
  const wholeCopy = DEFAULT_MODULE_DECLARATIONS.map((d) =>
    d.name === "filesystem"
      ? { ...d, launch: { ...d.launch, env: { ...d.launch.env, EXTRA: "1" } } }
      : d,
  );
  const diff = diffFromDefaults(DEFAULT_MODULE_DECLARATIONS, wholeCopy);

  assert.deepEqual(diff, [{ name: "filesystem", launch: { env: { EXTRA: "1" } } }]);
  // 圧縮しても、重ねた結果は変わらない
  assert.deepEqual(applyModuleOverlay(DEFAULT_MODULE_DECLARATIONS, diff), wholeCopy);
});

test("圧縮は冪等——差分をもう一度圧縮しても同じ", () => {
  const diff = [{ name: "filesystem", launch: { env: { EXTRA: "1" } } }];
  const applied = applyModuleOverlay(DEFAULT_MODULE_DECLARATIONS, diff);
  assert.deepEqual(diffFromDefaults(DEFAULT_MODULE_DECLARATIONS, applied), diff);
});

test("既定と何も変わらない写しは、空の差分になる", () => {
  assert.deepEqual(diffFromDefaults(DEFAULT_MODULE_DECLARATIONS, [...DEFAULT_MODULE_DECLARATIONS]), []);
});

test("**既定にあって写しに無い Module は「外した」と記録する**——黙って戻さない", () => {
  // 丸ごとの写しから Module を1つ消していたなら、それは意図した「外した」。
  // 差分にしたとき、それが消えてしまうと**外したはずの Module が復活する**
  const without = DEFAULT_MODULE_DECLARATIONS.filter((d) => d.name !== "shell");
  const diff = diffFromDefaults(DEFAULT_MODULE_DECLARATIONS, without);

  assert.ok(
    diff.some((d) => d.name === "shell" && d.enabled === false),
    `外したことが差分に残っていない: ${JSON.stringify(diff)}`,
  );
  assert.deepEqual(
    applyModuleOverlay(DEFAULT_MODULE_DECLARATIONS, diff).map((d) => d.name),
    without.map((d) => d.name),
  );
});
