import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAdoptedFolder, parseFolderAdopterState } from "./canvas-folder-adopter.ts";

test("押せるかは ready と choice が読めたときだけ——形が違えば undefined（押せないことにする）", () => {
  assert.deepEqual(parseFolderAdopterState({ ready: true, choice: "github" }), { ready: true, choice: "github" });
  assert.deepEqual(parseFolderAdopterState({ ready: false, choice: "local", reason: " 確かめています " }), { ready: false, choice: "local", reason: "確かめています" });
  assert.equal(parseFolderAdopterState({ ready: "yes", choice: "github" }), undefined);
  assert.equal(parseFolderAdopterState({ ready: true, choice: "cloud" }), undefined);
  assert.equal(parseFolderAdopterState(undefined), undefined);
  // 長すぎる理由は添えない（押せるかは読める）
  assert.deepEqual(parseFolderAdopterState({ ready: false, choice: "github", reason: "あ".repeat(501) }), { ready: false, choice: "github" });
});

test("画面の結果は choice・summary と、作ったなら path、GitHub なら場所があるときだけ「できた」", () => {
  assert.deepEqual(parseAdoptedFolder({ choice: "none", summary: "作りませんでした" }), { choice: "none", summary: "作りませんでした" });
  assert.deepEqual(parseAdoptedFolder({ choice: "local", summary: "できました", path: "/home/u/banto/chats/x", initialized: true }), {
    choice: "local",
    summary: "できました",
    path: "/home/u/banto/chats/x",
  });
  assert.deepEqual(
    parseAdoptedFolder({ choice: "github", summary: "上げました", path: "/r", github: { owner: "me", name: "r", htmlUrl: "https://github.com/me/r" } }),
    { choice: "github", summary: "上げました", path: "/r", github: { owner: "me", name: "r", htmlUrl: "https://github.com/me/r" } },
  );
  // 開ける URL でなければ添えない
  assert.deepEqual(
    (parseAdoptedFolder({ choice: "github", summary: "s", path: "/r", github: { owner: "me", name: "r", htmlUrl: "javascript:alert(1)" } }) as { github: unknown }).github,
    { owner: "me", name: "r" },
  );
  assert.match((parseAdoptedFolder({ choice: "local", summary: "s" }) as { error: string }).error, /path/);
  assert.match((parseAdoptedFolder({ choice: "github", summary: "s", path: "/r" }) as { error: string }).error, /GitHub/);
  assert.match((parseAdoptedFolder({ choice: "local", path: "/r" }) as { error: string }).error, /summary/);
  assert.match((parseAdoptedFolder({}) as { error: string }).error, /choice/);
});
