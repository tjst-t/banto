import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileHashCache,
  REMOTE_LAUNCHER_REL,
  REMOTE_NODE_REL,
  bundleDigest,
  collectCodeBundle,
  collectTreeEntries,
  computeLayers,
  estimateTarBytes,
  layerBytes,
  packageDirOf,
  planLayers,
  remoteAssembleScript,
  remoteDigestCommand,
  remoteSplitPackagesScript,
  remoteSwitchScript,
  sendBytes,
  splitLayers,
  tarList,
  type BundleEntry,
  type Layer,
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

const layersOf = (root: string, cache: FileHashCache) => computeLayers(collectCodeBundle(root, extras(root)), cache);

/** 向こうに、いまの塗りがそのまま置いてある形（名前→鍵） */
function remoteHaving(layers: readonly Layer[]): Map<string, string> {
  return new Map(planLayers(layers, new Map()).map((p, i) => [p.name, layers[i]!.digest]));
}

/** 送る塗りの一覧（`<種類>:<場所>`）と、それに沿った計画 */
function sending(layers: readonly Layer[], remote: ReadonlyMap<string, string>) {
  const plan = planLayers(layers, remote).map((p, i) => ({ ...p, ...layers[i]! }));
  const send = plan.filter((p) => p.send);
  return { plan, send, what: send.map((l) => `${l.kind}:${l.path}`) };
}

test("塗りに分ける：node・依存はパッケージごと（入れ子の node_modules は入れ子の場所ごと）・ほか（symlink・起動役を含む）はコード", () => {
  const root = workspace();
  try {
    const split = splitLayers(collectCodeBundle(root, extras(root)));
    assert.deepEqual(
      split.map((l) => `${l.kind}:${l.path}`),
      ["node:.", "pkg:node_modules/dep", "pkg:node_modules/dep/node_modules/inner", "pkg:node_modules/opt", "code:."],
    );
    const by = (path: string) => split.find((l) => l.path === path)!.entries.map((e) => e.rel).sort();
    assert.deepEqual(by("node_modules/dep"), ["node_modules/dep/index.js", "node_modules/dep/package.json"]);
    assert.deepEqual(by("node_modules/dep/node_modules/inner"), ["node_modules/dep/node_modules/inner/i.js", "node_modules/dep/node_modules/inner/package.json"]);
    const code = split.at(-1)!.entries;
    assert.ok(code.some((e) => e.rel === "node_modules/@x/contract" && e.kind === "link"));
    assert.ok(code.some((e) => e.rel === REMOTE_LAUNCHER_REL));
    assert.ok(code.every((e) => !e.rel.startsWith("node_modules/") || e.kind === "link"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("パッケージのフォルダ：@scope/名前 はその単位、いちばん奥の node_modules で決める", () => {
  assert.equal(packageDirOf("node_modules/@napi-rs/canvas/js/index.js"), "node_modules/@napi-rs/canvas");
  assert.equal(packageDirOf("node_modules/a/node_modules/@s/b/x.js"), "node_modules/a/node_modules/@s/b");
  assert.equal(packageDirOf("node_modules/a/lib/x.js"), "node_modules/a");
  assert.throws(() => packageDirOf("node_modules/x.js"), /パッケージのフォルダを決められません/);
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
    assert.deepEqual(sending(before, remote).what, []);
    writeFileSync(join(root, "packages/modules/a/dist/server.js"), "a2\n");
    const after = await layersOf(root, cache);
    const { plan, send, what } = sending(after, remote);
    assert.deepEqual(what, ["code:."]);
    const code = after.at(-1)!;
    assert.equal(sendBytes(send), estimateTarBytes(code.entries) + statSync(join(root, "launcher.mjs")).size);
    assert.ok(sendBytes(send) < 100_000, `分母 ${sendBytes(send)}`);
    // 使う塗りの名前：依存と node は向こうにあるもの、コードは新しい鍵の1番
    assert.deepEqual(
      plan.map((p) => p.name),
      after.map((l) => `${l.kind}-${l.digest.slice(0, 16)}-1`),
    );
    assert.deepEqual(
      plan.filter((p) => p.kind !== "code").map((p) => p.name),
      [...remote.keys()].filter((n) => !n.startsWith("code-")),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("依存を1つ足した版へ送り直すと、送るのはそのパッケージとコードの塗りだけ（分母もその分だけ）", async () => {
  const root = workspace();
  try {
    writeFileSync(join(root, "node_modules/dep/index.js"), "d".repeat(2_000_000));
    writeFileSync(join(root, "bin-node"), "n".repeat(3_000_000));
    const cache = new FileHashCache();
    const remote = remoteHaving(await layersOf(root, cache));
    // Module a が依存 added（とその依存 @s/sub）を足した
    writeFileSync(join(root, "packages/modules/a/package.json"), JSON.stringify({ name: "@x/a", dependencies: { "@x/contract": "*", dep: "1", added: "1" } }));
    mkdirSync(join(root, "node_modules/added"), { recursive: true });
    writeFileSync(join(root, "node_modules/added/package.json"), JSON.stringify({ name: "added", dependencies: { "@s/sub": "1" } }));
    writeFileSync(join(root, "node_modules/added/index.js"), "x".repeat(40_000));
    mkdirSync(join(root, "node_modules/@s/sub"), { recursive: true });
    writeFileSync(join(root, "node_modules/@s/sub/package.json"), JSON.stringify({ name: "@s/sub" }));
    const after = await layersOf(root, cache);
    const { send, what } = sending(after, remote);
    assert.deepEqual(what.sort(), ["code:.", "pkg:node_modules/@s/sub", "pkg:node_modules/added"]);
    const pkgEntries = send.filter((l) => l.kind === "pkg").flatMap((l) => l.entries);
    assert.deepEqual(pkgEntries.map((e) => e.rel).sort(), ["node_modules/@s/sub/package.json", "node_modules/added/index.js", "node_modules/added/package.json"]);
    // 分母：足したパッケージを1本の tar にした分と、コードの塗りの分だけ（2MB の dep・3MB の node を含まない）
    const code = send.find((l) => l.kind === "code")!;
    assert.equal(sendBytes(send), estimateTarBytes(pkgEntries) + layerBytes(code.entries));
    assert.ok(sendBytes(send) < 200_000, `分母 ${sendBytes(send)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("依存のパッケージか node を変えたら、その塗りだけを送る", async () => {
  const root = workspace();
  try {
    const cache = new FileHashCache();
    const remote = remoteHaving(await layersOf(root, cache));
    writeFileSync(join(root, "node_modules/dep/node_modules/inner/i.js"), "inner2\n");
    const deps = await layersOf(root, cache);
    assert.deepEqual(sending(deps, remote).what, ["pkg:node_modules/dep/node_modules/inner"]);
    for (const [name, digest] of remoteHaving(deps)) remote.set(name, digest);
    writeFileSync(join(root, "bin-node"), "node2\n");
    const node = await layersOf(root, cache);
    const { send, what } = sending(node, remote);
    assert.deepEqual(what, ["node:."]);
    assert.equal(sendBytes(send), "node2\n".length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("向こうのパッケージが書き換えられていたら、そのパッケージだけを新しい連番で送り直す", async () => {
  const root = workspace();
  try {
    const layers = await layersOf(root, new FileHashCache());
    const remote = remoteHaving(layers);
    const inner = layers.find((l) => l.path === "node_modules/dep/node_modules/inner")!;
    const innerName = `pkg-${inner.digest.slice(0, 16)}-1`;
    remote.set(innerName, "0".repeat(64));
    const { send } = sending(layers, remote);
    assert.deepEqual(
      send.map((p) => `${p.path}=${p.name}`),
      [`node_modules/dep/node_modules/inner=${innerName.replace(/-1$/, "-2")}`],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("同じ中身のパッケージが2箇所にあれば、塗りは1つで、送るのも1回", async () => {
  const root = workspace();
  try {
    // inner と同じ中身を、別の場所にも置く（hoist されずに2つの版で入っている形）
    writeFileSync(join(root, "packages/modules/b/package.json"), JSON.stringify({ name: "@x/b", dependencies: { dep: "1", inner: "1" } }));
    mkdirSync(join(root, "node_modules/inner"), { recursive: true });
    writeFileSync(join(root, "node_modules/inner/package.json"), JSON.stringify({ name: "inner" }));
    writeFileSync(join(root, "node_modules/inner/i.js"), "inner\n");
    const layers = await layersOf(root, new FileHashCache());
    const { plan, send } = sending(layers, new Map());
    const inners = plan.filter((p) => p.path.endsWith("/inner"));
    assert.equal(inners.length, 2);
    assert.equal(inners[0]!.name, inners[1]!.name);
    assert.equal(send.filter((p) => p.name === inners[0]!.name).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * 塗りを送ったのと同じ形で向こうの置き場（`code/layers/<名前>`）に置く。パッケージは1本の tar で `.incoming-*` に展開して
 * `remoteSplitPackagesScript` で分け、コードと node は塗りのフォルダにそのまま置く。返すのは分けたときの出力
 */
function placeLayers(root: string, code: string, layers: ReadonlyArray<Layer & { name: string }>): string {
  const sh = (script: string, input?: string) => execFileSync("sh", ["-c", script], { encoding: "utf8", ...(input !== undefined ? { input } : {}) });
  const L = join(code, "layers");
  mkdirSync(L, { recursive: true });
  const pkgs = layers.filter((l) => l.kind === "pkg");
  let out = "";
  if (pkgs.length > 0) {
    const incoming = ".incoming-pkgs";
    mkdirSync(join(L, incoming));
    sh(`tar -C ${root} --null --no-recursion -cf - -T - | tar -C ${join(L, incoming)} -xf -`, tarList(pkgs.flatMap((l) => l.entries)));
    out = sh(remoteSplitPackagesScript({ layersDir: L, incoming, packages: pkgs }));
  }
  for (const l of layers.filter((l) => l.kind !== "pkg")) {
    const dir = join(L, l.name);
    mkdirSync(dir, { recursive: true });
    const tarred = l.entries.filter((e) => e.rel !== REMOTE_NODE_REL && e.rel !== REMOTE_LAUNCHER_REL);
    if (tarred.length > 0) sh(`tar -C ${root} --null --no-recursion -cf - -T - | tar -C ${dir} -xf -`, tarList(tarred));
    for (const e of l.entries) {
      if (e.rel !== REMOTE_NODE_REL && e.rel !== REMOTE_LAUNCHER_REL) continue;
      mkdirSync(join(dir, e.rel, ".."), { recursive: true });
      writeFileSync(join(dir, e.rel), readFileSync((e as Extract<BundleEntry, { kind: "file" }>).abs));
    }
  }
  return out;
}

test("向こうでパッケージを1本の tar から分けると、塗りごとの鍵は host と同じ。書き換わって届いたものは名前を付けずに知らせる", async () => {
  const root = workspace();
  const out = mkdtempSync(join(tmpdir(), "banto-remote-split-"));
  try {
    const layers = await layersOf(root, new FileHashCache());
    const plan = planLayers(layers, new Map()).map((p, i) => ({ ...p, ...layers[i]! }));
    const pkgs = plan.filter((p) => p.kind === "pkg");
    assert.equal(placeLayers(root, out, pkgs), "");
    for (const p of pkgs) {
      const got = execFileSync("sh", ["-c", `printf '%s\\n' "$(${remoteDigestCommand(`'${join(out, "layers", p.name)}'`)})"`], { encoding: "utf8" }).trim();
      assert.equal(got, p.digest, p.path);
    }
    // 入れ子のパッケージは外のパッケージの塗りに入らない
    const dep = pkgs.find((p) => p.path === "node_modules/dep")!;
    assert.ok(!existsSync(join(out, "layers", dep.name, "node_modules/inner/i.js")));
    assert.deepEqual(readdirSync(join(out, "layers")).sort(), pkgs.map((p) => p.name).sort());

    // 届いた中身が違えば、その塗りは名前を付けずに bad= で知らせる（ほかは名前を付ける）
    const again = mkdtempSync(join(tmpdir(), "banto-remote-split-"));
    try {
      const wrong = pkgs.map((p) => (p.path === "node_modules/opt" ? { ...p, digest: "0".repeat(64) } : p));
      const reported = placeLayers(root, again, wrong);
      const optName = pkgs.find((p) => p.path === "node_modules/opt")!.name;
      assert.match(reported, new RegExp(`^bad=${optName}\\t[0-9a-f]{64}$`, "m"));
      assert.ok(!existsSync(join(again, "layers", optName)));
      assert.ok(existsSync(join(again, "layers", dep.name)));
      assert.ok(!readdirSync(join(again, "layers")).some((n) => n.startsWith(".incoming")));
    } finally {
      rmSync(again, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("塗りをハードリンクで写して組んだ版は、まとめて送ったのと同じ鍵・同じパスになり、いまの版と前の版が参照しない塗りは消える", async () => {
  const root = workspace();
  const out = mkdtempSync(join(tmpdir(), "banto-remote-layers-"));
  const code = join(out, "code");
  try {
    const cache = new FileHashCache();
    const sh = (script: string) => execFileSync("sh", ["-c", script], { encoding: "utf8" });
    const all = collectCodeBundle(root, extras(root));
    const v1Layers = await layersOf(root, cache);
    const v1 = planLayers(v1Layers, new Map()).map((p, i) => ({ ...p, ...v1Layers[i]! }));
    placeLayers(root, code, v1);
    // 塗りの置き場の鍵は、host の塗りの鍵と同じ（向こうでの照合）
    for (const l of v1) assert.equal(sh(`printf '%s\\n' "$(${remoteDigestCommand(`'${join(code, "layers", l.name)}'`)})"`).trim(), l.digest);
    // パッケージごとに分ける前の版（`.layers` は名前だけで、依存の塗りは1つ）がいまの版
    mkdirSync(join(code, "old-1"));
    mkdirSync(join(code, "layers", "deps-0000000000000000-1"));
    writeFileSync(join(code, "old-1.layers"), "deps-0000000000000000-1\n");
    writeFileSync(join(code, "current"), "old-1\n");
    const v1Refs = v1.map((l) => ({ name: l.name, path: l.path }));
    const assemble = sh(remoteAssembleScript({ code, staging: ".incoming-a", layers: v1Refs }));
    assert.equal(/^digest=(.*)$/m.exec(assemble)?.[1], await bundleDigest(all, cache));
    // パスは版のフォルダの中のまま（@x/contract の相対の symlink も、入れ子の node_modules もそのまま解ける）
    const staged = join(code, ".incoming-a");
    assert.equal(readFileSync(join(staged, "node_modules/@x/contract/dist/index.js"), "utf8"), "c\n");
    assert.equal(readFileSync(join(staged, "node_modules/dep/node_modules/inner/i.js"), "utf8"), "inner\n");
    const depName = v1.find((l) => l.path === "node_modules/dep")!.name;
    assert.equal(statSync(join(staged, "node_modules/dep/index.js")).ino, statSync(join(code, "layers", depName, "index.js")).ino);
    sh(remoteSwitchScript({ code, staging: ".incoming-a", next: "v1-1", cur: "old-1", layers: v1Refs }));
    assert.equal(readFileSync(join(code, "current"), "utf8"), "v1-1\n");
    assert.equal(readFileSync(join(code, "previous"), "utf8"), "old-1\n");
    assert.deepEqual(
      readFileSync(join(code, "v1-1.layers"), "utf8").trim().split("\n"),
      v1.map((l) => `${l.name}\t${l.path}`),
    );
    // 前の版がまだ参照している、分ける前の依存の塗りは残る
    assert.ok(existsSync(join(code, "layers", "deps-0000000000000000-1")));

    // v2：コードと inner を変えた版、v3：さらにコードを変え、opt を外した版
    const next = async (version: string, cur: string, change: () => void, remote: Map<string, string>) => {
      change();
      const layers = await layersOf(root, cache);
      const plan = planLayers(layers, remote).map((p, i) => ({ ...p, ...layers[i]! }));
      placeLayers(root, code, plan.filter((p) => p.send));
      const refs = plan.map((l) => ({ name: l.name, path: l.path }));
      const assembled = sh(remoteAssembleScript({ code, staging: ".incoming-b", layers: refs }));
      assert.equal(/^digest=(.*)$/m.exec(assembled)?.[1], await bundleDigest(collectCodeBundle(root, extras(root)), cache));
      sh(remoteSwitchScript({ code, staging: ".incoming-b", next: version, cur, layers: refs }));
      for (const l of plan) remote.set(l.name, l.digest);
      return plan.map((l) => l.name);
    };
    const remote = new Map(v1.map((l) => [l.name, l.digest]));
    const v2Names = await next(
      "v2-1",
      "v1-1",
      () => {
        writeFileSync(join(root, "packages/modules/a/dist/server.js"), "a2\n");
        writeFileSync(join(root, "node_modules/dep/node_modules/inner/i.js"), "inner2\n");
      },
      remote,
    );
    // 分ける前の依存の塗りは、どちらの版も参照しなくなったので消える
    assert.deepEqual(readdirSync(join(code, "layers")).sort(), [...new Set([...v1.map((l) => l.name), ...v2Names])].sort());
    const v3Names = await next(
      "v3-1",
      "v2-1",
      () => {
        writeFileSync(join(root, "packages/modules/a/dist/server.js"), "a3\n");
        writeFileSync(join(root, "packages/modules/b/package.json"), JSON.stringify({ name: "@x/b", dependencies: { dep: "1" } }));
      },
      remote,
    );
    assert.deepEqual(readdirSync(join(code, "layers")).sort(), [...new Set([...v2Names, ...v3Names])].sort());
    // v1 だけが使っていたコードと inner の塗りは消え、v2 が使う opt の塗りは残る
    const v1Inner = v1.find((l) => l.path === "node_modules/dep/node_modules/inner")!.name;
    assert.ok(!existsSync(join(code, "layers", v1Inner)));
    assert.ok(!existsSync(join(code, "layers", v1.at(-1)!.name)));
    assert.ok(existsSync(join(code, "layers", v1.find((l) => l.path === "node_modules/opt")!.name)));
    assert.ok(!existsSync(join(code, "v1-1")) && !existsSync(join(code, "v1-1.layers")) && !existsSync(join(code, "old-1")));
    assert.ok(existsSync(join(code, "v2-1", "packages/modules/a/dist/server.js")));
    assert.ok(!existsSync(join(code, "v3-1", "node_modules/opt")));
    assert.equal(readFileSync(join(code, "v3-1", "node_modules/dep/node_modules/inner/i.js"), "utf8"), "inner2\n");
    assert.ok(!existsSync(join(code, ".keep")));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});
