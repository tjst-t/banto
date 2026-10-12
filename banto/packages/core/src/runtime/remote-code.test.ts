import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileHashCache,
  REMOTE_LAUNCHER_REL,
  REMOTE_NODE_REL,
  bundleDigest,
  collectCodeBundle,
  collectTreeEntries,
  estimateTarBytes,
  remoteDigestCommand,
  tarList,
} from "./remote-code.js";

/** 小さなワークスペース：Module 2つ・ワークスペースの依存・外の依存（入れ子の node_modules・optional・入っていない optional） */
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "banto-remote-code-"));
  const w = (rel: string, body: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  w("package.json", JSON.stringify({ name: "ws", workspaces: ["packages/*", "packages/modules/*"] }));
  w("packages/modules/a/package.json", JSON.stringify({ name: "@x/a", dependencies: { "@x/contract": "*", dep: "1" } }));
  w("packages/modules/a/dist/server.js", "a\n");
  w("packages/modules/a/src/server.ts", "送らない\n");
  w("packages/modules/a/scripts/s.mjs", "s\n");
  w("packages/modules/b/package.json", JSON.stringify({ name: "@x/b", dependencies: { dep: "1" }, optionalDependencies: { opt: "1", missing: "1" } }));
  w("packages/modules/b/dist/server.js", "b\n");
  w("packages/modules/notjs/server.py", "送らない\n");
  w("packages/contract/package.json", JSON.stringify({ name: "@x/contract" }));
  w("packages/contract/dist/index.js", "c\n");
  w("packages/frontend/package.json", JSON.stringify({ name: "@x/frontend", dependencies: { big: "1" } }));
  w("node_modules/dep/package.json", JSON.stringify({ name: "dep", dependencies: { inner: "1" } }));
  w("node_modules/dep/index.js", "dep\n");
  w("node_modules/dep/node_modules/inner/package.json", JSON.stringify({ name: "inner" }));
  w("node_modules/dep/node_modules/inner/i.js", "inner\n");
  w("node_modules/opt/package.json", JSON.stringify({ name: "opt" }));
  w("node_modules/big/package.json", JSON.stringify({ name: "big" }));
  mkdirSync(join(root, "node_modules", "@x"), { recursive: true });
  symlinkSync("../../packages/contract", join(root, "node_modules", "@x", "contract"));
  // 動かすときに読まないもの（型定義・ソースマップ・ワークスペースの試験）は送らない
  w("packages/modules/a/dist/server.d.ts", "送らない\n");
  w("packages/modules/a/dist/server.js.map", "送らない\n");
  w("packages/modules/a/dist/server.test.js", "送らない\n");
  w("node_modules/dep/index.d.mts", "送らない\n");
  w("node_modules/dep/index.js.map", "送らない\n");
  w("bin-node", "node\n");
  w("launcher.mjs", "launcher\n");
  return root;
}

test("送るのは Module とそこから辿れる依存だけ（ワークスペースは dist・scripts・package.json、symlink はそのまま）", () => {
  const root = workspace();
  try {
    const entries = collectCodeBundle(root, { nodePath: join(root, "bin-node"), launcherPath: join(root, "launcher.mjs") });
    const rels = entries.map((e) => `${e.kind}:${e.rel}`).sort();
    assert.deepEqual(rels, [
      `file:${REMOTE_LAUNCHER_REL}`,
      `file:${REMOTE_NODE_REL}`,
      "file:node_modules/dep/index.js",
      "file:node_modules/dep/node_modules/inner/i.js",
      "file:node_modules/dep/node_modules/inner/package.json",
      "file:node_modules/dep/package.json",
      "file:node_modules/opt/package.json",
      "file:package.json",
      "file:packages/contract/dist/index.js",
      "file:packages/contract/package.json",
      "file:packages/modules/a/dist/server.js",
      "file:packages/modules/a/package.json",
      "file:packages/modules/a/scripts/s.mjs",
      "file:packages/modules/b/dist/server.js",
      "file:packages/modules/b/package.json",
      "link:node_modules/@x/contract",
    ]);
    // tar の一覧には node と起動役を入れない（別に送る）
    assert.ok(!tarList(entries).includes(REMOTE_NODE_REL));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tar に流れる大きさの見積もりは、実際の tar と同じ（長い名前・ハードリンクを含めて）", () => {
  const root = workspace();
  try {
    const deep = `node_modules/dep/${"long-directory-name/".repeat(6)}file-with-a-long-name.js`;
    mkdirSync(join(root, deep, ".."), { recursive: true });
    writeFileSync(join(root, deep), "x".repeat(70_000));
    // 同じ中身へのハードリンク（optional の別の版に入っている同じ実行ファイル、など）は2件目から中身を持たない
    linkSync(join(root, deep), join(root, "node_modules/dep/same.js"));
    const entries = collectCodeBundle(root, { nodePath: join(root, "bin-node"), launcherPath: join(root, "launcher.mjs") });
    const actual = execFileSync("sh", ["-c", `tar -C ${root} --null --no-recursion -cf - -T - | wc -c`], { input: tarList(entries), encoding: "utf8" });
    assert.equal(estimateTarBytes(entries), Number(actual.trim()));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("入っていない依存（dependencies）は送らずに止める", () => {
  const root = workspace();
  try {
    rmSync(join(root, "node_modules", "dep"), { recursive: true });
    assert.throws(
      () => collectCodeBundle(root, { nodePath: join(root, "bin-node"), launcherPath: join(root, "launcher.mjs") }),
      /依存 dep が入っていません/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("版の鍵は、向こうで coreutils が計算するものと同じ（送って展開した中身で確かめる）", async () => {
  const root = workspace();
  const out = mkdtempSync(join(tmpdir(), "banto-remote-code-out-"));
  try {
    const entries = collectCodeBundle(root, { nodePath: join(root, "bin-node"), launcherPath: join(root, "launcher.mjs") });
    const cache = new FileHashCache();
    const digest = await bundleDigest(entries, cache);
    // 送るのと同じ形：tar（NUL 区切りの一覧）で展開し、node と起動役を別に置く
    execFileSync("sh", ["-c", `tar -C ${root} --null --no-recursion -cf - -T - | tar -C ${out} -xf -`], { input: tarList(entries) });
    mkdirSync(join(out, "bin"), { recursive: true });
    writeFileSync(join(out, REMOTE_NODE_REL), "node\n");
    writeFileSync(join(out, REMOTE_LAUNCHER_REL), "launcher\n");
    // 呼び元と同じく `$(…)` の中で使う（外側に括弧があると `$((` が算術展開になる）
    const remote = execFileSync("sh", ["-c", `printf '%s\\n' "$(${remoteDigestCommand(`'${out}'`)})"`], { encoding: "utf8" }).trim();
    assert.equal(remote, digest);
    // 向こうで1バイト書き換えれば鍵が変わる
    writeFileSync(join(out, "packages/modules/a/dist/server.js"), "a\n// 書き換えた\n");
    assert.notEqual(execFileSync("sh", ["-c", remoteDigestCommand(`'${out}'`)], { encoding: "utf8" }).trim(), digest);
    // 覚えたハッシュは、中身が変われば読み直す
    writeFileSync(join(root, "packages/modules/a/dist/server.js"), "a2\n");
    assert.notEqual(await bundleDigest(entries, cache), digest);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("照合の形を崩す名前（\\・改行・タブ）は送らずに止める", () => {
  const root = mkdtempSync(join(tmpdir(), "banto-remote-code-name-"));
  try {
    writeFileSync(join(root, "a\tb"), "x");
    assert.throws(() => collectTreeEntries(root), /送れない名前/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
