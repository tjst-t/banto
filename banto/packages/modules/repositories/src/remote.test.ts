import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRemoteUrl, remoteHost, sameGithubLocation } from "./remote.js";

test("origin の URL から GitHub の owner/name を読む（https・scp・ssh・git、.git の有無）", () => {
  for (const url of [
    "https://github.com/tjst-t/banto.git",
    "https://github.com/tjst-t/banto",
    "https://github.com/tjst-t/banto/",
    "https://user@github.com/tjst-t/banto.git",
    "git@github.com:tjst-t/banto.git",
    "git@github.com:tjst-t/banto",
    "ssh://git@github.com/tjst-t/banto.git",
    "ssh://git@github.com:22/tjst-t/banto.git",
    "git://github.com/tjst-t/banto.git",
    "https://GitHub.com/tjst-t/banto.git",
  ]) {
    assert.deepEqual(parseRemoteUrl(url), { kind: "github", owner: "tjst-t", name: "banto" }, url);
  }
  // 名前に「.」を含むもの（.git だけを落とす）
  assert.deepEqual(parseRemoteUrl("git@github.com:o/my.site.git"), { kind: "github", owner: "o", name: "my.site" });
});

test("GitHub の外・読めない形は、URL のまま GitHub の外として扱う（捨てない）", () => {
  for (const url of [
    "git@gitlab.com:tjst-t/notes.git",
    "https://gitlab.com/tjst-t/notes",
    "https://github.com/tjst-t", // owner だけ
    "https://github.com/a/b/c", // 深すぎる
    "/srv/git/notes.git",
    "file:///srv/git/notes.git",
  ]) {
    assert.deepEqual(parseRemoteUrl(url), { kind: "elsewhere", url }, url);
  }
});

test("ホスト名だけを取り出す", () => {
  assert.equal(remoteHost("git@gitlab.com:tjst-t/notes.git"), "gitlab.com");
  assert.equal(remoteHost("https://gitlab.example.org/a/b"), "gitlab.example.org");
  assert.equal(remoteHost("/srv/git/notes.git"), "/srv/git/notes.git");
});

test("GitHub の場所は大文字小文字を区別せずに比べる", () => {
  assert.ok(sameGithubLocation({ owner: "TJST-T", name: "Banto" }, { owner: "tjst-t", name: "banto" }));
  assert.ok(!sameGithubLocation({ owner: "tjst-t", name: "banto" }, { owner: "work-org", name: "banto" }));
  assert.ok(sameGithubLocation(undefined, undefined));
  assert.ok(!sameGithubLocation(undefined, { owner: "a", name: "b" }));
});
