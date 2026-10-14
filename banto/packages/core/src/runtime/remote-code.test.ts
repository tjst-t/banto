import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileHashCache,
  LAYER_KINDS,
  REMOTE_LAUNCHER_REL,
  REMOTE_NODE_REL,
  bundleDigest,
  collectCodeBundle,
  collectTreeEntries,
  estimateTarBytes,
  layerBytes,
  planLayers,
  remoteAssembleScript,
  remoteDigestCommand,
  remoteSwitchScript,
  splitLayers,
  tarList,
  type BundleEntry,
  type LayerKind,
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
  w("node_modules/big/package.json", JSON.stringify({ name: "big" }));
  // 外の依存が dependencies に挙げていても、動くときに読まないもの（typescript）は辿らない
  w("node_modules/opt/node_modules/typescript/package.json", JSON.stringify({ name: "typescript" }));
  w("node_modules/opt/node_modules/typescript/lib/typescript.js", "送らない\n");
  w("node_modules/opt/package.json", JSON.stringify({ name: "opt", dependencies: { typescript: "5" } }));
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

const extras = (root: string) => ({ nodePath: join(root, "bin-node"), launcherPath: join(root, "launcher.mjs") });

async function layersOf(root: string, cache: FileHashCache) {
  const split = splitLayers(collectCodeBundle(root, extras(root)));
  const out: Array<{ kind: LayerKind; entries: BundleEntry[]; digest: string }> = [];
  for (const kind of LAYER_KINDS) out.push({ kind, entries: split[kind], digest: await bundleDigest(split[kind], cache) });
  return out;
}

/** 向こうに、いまの塗りがそのまま置いてある形（名前→鍵） */
function remoteHaving(layers: ReadonlyArray<{ kind: LayerKind; digest: string }>): Map<string, string> {
  return new Map(planLayers(layers, new Map()).map((p, i) => [p.name, layers[i]!.digest]));
}

test("3つの塗りに分ける：依存は node_modules の下のファイル、node は bin/node、ほか（symlink・起動役を含む）はコード", () => {
  const root = workspace();
  try {
    const split = splitLayers(collectCodeBundle(root, extras(root)));
    assert.deepEqual(split.node.map((e) => e.rel), [REMOTE_NODE_REL]);
    assert.ok(split.deps.every((e) => e.kind === "file" && e.rel.startsWith("node_modules/")));
    assert.ok(split.deps.some((e) => e.rel === "node_modules/dep/node_modules/inner/i.js"));
    assert.ok(split.code.some((e) => e.rel === "node_modules/@x/contract" && e.kind === "link"));
    assert.ok(split.code.some((e) => e.rel === REMOTE_LAUNCHER_REL));
    assert.ok(split.code.every((e) => !e.rel.startsWith("node_modules/") || e.kind === "link"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("外の依存が dependencies に挙げていても typescript は送らない", () => {
  const root = workspace();
  try {
    const rels = collectCodeBundle(root, extras(root)).map((e) => e.rel);
    assert.ok(!rels.some((r) => r.includes("typescript")), rels.join("\n"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("コードだけを変えたら、送るのはコードの塗りだけ（分母もコードの分だけ）", async () => {
  const root = workspace();
  try {
    // 依存と node を大きくして、分母がコードの分だけになることを見分けられるようにする
    writeFileSync(join(root, "node_modules/dep/index.js"), "d".repeat(2_000_000));
    writeFileSync(join(root, "bin-node"), "n".repeat(3_000_000));
    const cache = new FileHashCache();
    const before = await layersOf(root, cache);
    const remote = remoteHaving(before);
    // 変えなければ何も送らない
    assert.deepEqual(planLayers(before, remote).filter((p) => p.send), []);
    writeFileSync(join(root, "packages/modules/a/dist/server.js"), "a2\n");
    const after = await layersOf(root, cache);
    const plan = planLayers(after, remote);
    assert.deepEqual(plan.filter((p) => p.send).map((p) => p.kind), ["code"]);
    const code = after.find((l) => l.kind === "code")!;
    const bytes = layerBytes(code.entries);
    assert.equal(bytes, estimateTarBytes(code.entries) + statSync(join(root, "launcher.mjs")).size);
    assert.ok(bytes < 100_000, `分母 ${bytes}`);
    assert.ok(code.entries.every((e) => !(e.kind === "file" && e.rel.includes("node_modules/"))));
    // 使う塗りの名前：依存と node は向こうにあるもの、コードは新しい鍵の1番
    assert.deepEqual(
      plan.map((p) => p.name),
      [`deps-${after[0]!.digest.slice(0, 16)}-1`, `node-${after[1]!.digest.slice(0, 16)}-1`, `code-${after[2]!.digest.slice(0, 16)}-1`],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("依存か node を変えたら、その塗りだけを送る", async () => {
  const root = workspace();
  try {
    const cache = new FileHashCache();
    const remote = remoteHaving(await layersOf(root, cache));
    writeFileSync(join(root, "node_modules/dep/node_modules/inner/i.js"), "inner2\n");
    const deps = await layersOf(root, cache);
    assert.deepEqual(planLayers(deps, remote).filter((p) => p.send).map((p) => p.kind), ["deps"]);
    assert.equal(layerBytes(deps[0]!.entries), estimateTarBytes(deps[0]!.entries));
    for (const [name, digest] of remoteHaving(deps)) remote.set(name, digest);
    writeFileSync(join(root, "bin-node"), "node2\n");
    const node = await layersOf(root, cache);
    assert.deepEqual(planLayers(node, remote).filter((p) => p.send).map((p) => p.kind), ["node"]);
    assert.equal(layerBytes(node[1]!.entries), "node2\n".length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("向こうの塗りが書き換えられていたら、新しい連番で送り直す", async () => {
  const root = workspace();
  try {
    const layers = await layersOf(root, new FileHashCache());
    const remote = remoteHaving(layers);
    const depsName = [...remote.keys()].find((n) => n.startsWith("deps-"))!;
    remote.set(depsName, "0".repeat(64));
    const plan = planLayers(layers, remote);
    assert.deepEqual(
      plan.filter((p) => p.send).map((p) => p.name),
      [depsName.replace(/-1$/, "-2")],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** 塗りを送ったのと同じ形で向こうの置き場（`code/layers/<名前>`）に置く */
function placeLayers(root: string, code: string, layers: ReadonlyArray<{ entries: BundleEntry[] }>, names: readonly string[]) {
  layers.forEach((l, i) => {
    const dir = join(code, "layers", names[i]!);
    mkdirSync(dir, { recursive: true });
    const tarred = l.entries.filter((e) => e.rel !== REMOTE_NODE_REL && e.rel !== REMOTE_LAUNCHER_REL);
    if (tarred.length > 0) execFileSync("sh", ["-c", `tar -C ${root} --null --no-recursion -cf - -T - | tar -C ${dir} -xf -`], { input: tarList(tarred) });
    for (const e of l.entries) {
      if (e.rel !== REMOTE_NODE_REL && e.rel !== REMOTE_LAUNCHER_REL) continue;
      mkdirSync(join(dir, e.rel, ".."), { recursive: true });
      writeFileSync(join(dir, e.rel), readFileSync((e as Extract<BundleEntry, { kind: "file" }>).abs));
    }
  });
}

test("塗りをハードリンクで写して組んだ版は、まとめて送ったのと同じ鍵・同じパスになり、使っていない塗りは消える", async () => {
  const root = workspace();
  const out = mkdtempSync(join(tmpdir(), "banto-remote-layers-"));
  const code = join(out, "code");
  try {
    const cache = new FileHashCache();
    const sh = (script: string) => execFileSync("sh", ["-c", script], { encoding: "utf8" });
    const all = collectCodeBundle(root, extras(root));
    const v1Layers = await layersOf(root, cache);
    const v1Names = planLayers(v1Layers, new Map()).map((p) => p.name);
    placeLayers(root, code, v1Layers, v1Names);
    // 塗りの置き場の鍵は、host の塗りの鍵と同じ（向こうでの照合）
    v1Names.forEach((name, i) => {
      assert.equal(sh(`printf '%s\\n' "$(${remoteDigestCommand(`'${join(code, "layers", name)}'`)})"`).trim(), v1Layers[i]!.digest);
    });
    // 塗りに分ける前の版（.layers が無い）がいまの版
    mkdirSync(join(code, "old-1"));
    writeFileSync(join(code, "current"), "old-1\n");
    const assemble = sh(remoteAssembleScript({ code, staging: ".incoming-a", layers: v1Names }));
    assert.equal(/^digest=(.*)$/m.exec(assemble)?.[1], await bundleDigest(all, cache));
    // パスは版のフォルダの中のまま（@x/contract の相対の symlink も、入れ子の node_modules もそのまま解ける）
    const staged = join(code, ".incoming-a");
    assert.equal(readFileSync(join(staged, "node_modules/@x/contract/dist/index.js"), "utf8"), "c\n");
    assert.equal(statSync(join(staged, "node_modules/dep/index.js")).ino, statSync(join(code, "layers", v1Names[0]!, "node_modules/dep/index.js")).ino);
    sh(remoteSwitchScript({ code, staging: ".incoming-a", next: "v1-1", cur: "old-1", layers: v1Names }));
    assert.equal(readFileSync(join(code, "current"), "utf8"), "v1-1\n");
    assert.equal(readFileSync(join(code, "previous"), "utf8"), "old-1\n");
    assert.deepEqual(readFileSync(join(code, "v1-1.layers"), "utf8").trim().split("\n"), v1Names);

    // コードだけ変えた版 v2、さらに v3：v1 だけが使っていたコードの塗りは消え、依存と node の塗りは残る
    const next = async (version: string, cur: string, body: string) => {
      writeFileSync(join(root, "packages/modules/a/dist/server.js"), body);
      const layers = await layersOf(root, cache);
      const names = planLayers(layers, remoteHaving(v1Layers)).map((p) => p.name);
      placeLayers(root, code, [layers[2]!], [names[2]!]);
      sh(remoteAssembleScript({ code, staging: ".incoming-b", layers: names }));
      sh(remoteSwitchScript({ code, staging: ".incoming-b", next: version, cur, layers: names }));
      return names;
    };
    const v2Names = await next("v2-1", "v1-1", "a2\n");
    assert.deepEqual(readdirSync(join(code, "layers")).sort(), [...new Set([...v1Names, ...v2Names])].sort());
    const v3Names = await next("v3-1", "v2-1", "a3\n");
    assert.deepEqual(readdirSync(join(code, "layers")).sort(), [...new Set([...v2Names, ...v3Names])].sort());
    assert.ok(!existsSync(join(code, "layers", v1Names[2]!)));
    assert.ok(!existsSync(join(code, "v1-1")) && !existsSync(join(code, "v1-1.layers")) && !existsSync(join(code, "old-1")));
    assert.ok(existsSync(join(code, "v2-1", "packages/modules/a/dist/server.js")));
    assert.equal(readFileSync(join(code, "v3-1", "packages/modules/a/dist/server.js"), "utf8"), "a3\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});
