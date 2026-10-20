import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCloneSource } from "./clone-source.js";

const GH = { web: "https://github.com", ssh: "github.com" };

const reason = (text: string) => {
  const r = parseCloneSource(text, GH);
  assert.equal(r.kind, "invalid", text);
  return (r as { reason: string }).reason;
};

test("https・ssh・owner/repo は読む（GitHub は owner/name、外は URL のまま）", () => {
  assert.deepEqual(parseCloneSource("https://github.com/a/b.git", GH), { kind: "github", owner: "a", name: "b" });
  assert.deepEqual(parseCloneSource("a/b", GH), { kind: "github", owner: "a", name: "b" });
  assert.deepEqual(parseCloneSource("ssh://git@gitlab.com/g/x.git", GH), { kind: "elsewhere", url: "ssh://git@gitlab.com/g/x.git", host: "gitlab.com", name: "x" });
  assert.deepEqual(parseCloneSource("  https://git.example.org/a/b.git  ", GH), { kind: "elsewhere", url: "https://git.example.org/a/b.git", host: "git.example.org", name: "b" });
});

test("file・git・http・ext・- で始まる・資格情報入り・空白・改行・制御文字は断る（v4-frontend.md §6.49）", () => {
  assert.match(reason("file:///srv/x.git"), /file:\/\/ の URL は受けません/);
  assert.match(reason("git://example.org/a/b"), /暗号化されない/);
  assert.match(reason("http://example.org/a/b.git"), /http:\/\/ は暗号化されない/);
  assert.match(reason("ext::sh -c touch% /tmp/pwned"), /空白・改行・制御文字/);
  assert.match(reason("ext::sh"), /URL として読めません/);
  assert.match(reason("--upload-pack=x"), /URL として読めません/);
  assert.match(reason("https://user:token@example.org/a/b.git"), /資格情報を書かないで/);
  assert.match(reason("https://x-access-token@example.org/a/b.git"), /資格情報を書かないで/);
  assert.match(reason("https://example.org/a/b.git\n--upload-pack=x"), /空白・改行・制御文字/);
  assert.match(reason("https://example.org/a/b\tc.git"), /./);
  assert.match(reason("https://example.org/a/b\u0007.git"), /./);
  assert.match(reason("/srv/git/x.git"), /手元のフォルダは clone しません/);
});

test("http は行き先を替えた GitHub（試験の偽物）だけ受ける", () => {
  assert.deepEqual(parseCloneSource("http://127.0.0.1:4555/a/b.git", { web: "http://127.0.0.1:4555" }), { kind: "github", owner: "a", name: "b" });
  assert.match(reason("http://127.0.0.1:4555/a/b.git"), /http:\/\/ は暗号化されない/);
});
