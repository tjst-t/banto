// **別のサーバに置く banto のコード**（決定・2026-10-08、`docs/specs/v4-security.md` §1「向こうに置くもの」）。
//
// 送るのは Module を起こすのに要る分だけ：Module のパッケージ（`packages/modules/*`）と、そこから辿れる依存。
// ワークスペースのパッケージは `package.json`・`dist`・`scripts`（Backlog が `../scripts` を読む）、外から入れた依存は
// フォルダごと（入れ子の `node_modules` は依存として辿ったときに足す）。`node_modules/@banto/*` の symlink はそのまま送る。
// **動かすときに読まないものは送らない**（追加・2026-10-12、Backlog #269）：型定義（`.d.ts`）・ソースマップ（`.map`）と、
// ワークスペースの `dist` の中の試験（`*.test.js`）。外から入れた依存の試験らしい名前は、動くときに読むものと見分けられないので送る。
// node（host と同じ版の実行ファイル）は `bin/node`、起動役は `banto-launcher.mjs` に置く。
//
// **版の鍵は送る中身のハッシュ**（commit ではない——開発中は作業ツリーが汚れていて commit と中身がずれる）。向こうでも
// 同じ形で計算して照合する（コードは向こうの AI が書き換えうる）。計算の形は coreutils で再現できるものにした：
//
//   { find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum
//     find . -type l -printf '%p\t%l\n' | LC_ALL=C sort; } | sha256sum
//
// host は同じ文字列を組み立てて SHA-256 を取る（ファイルごとのハッシュは、大きさ・更新時刻・inode が同じなら覚えたものを使う）。
//
// **3つの塗りに分けて、無い塗りだけを送る**（決定・2026-10-14、Backlog #298）：(1) コード（ワークスペースのパッケージ・根の
// `package.json`・起動役・symlink）、(2) 依存（`node_modules` の下のファイル）、(3) node。塗りごとに同じ形で鍵を取り、向こうの
// `code/layers/<塗り>-<鍵16>-<連番>` に置く。版のフォルダは3つの塗りを**ハードリンクで写して**組む（`cp -al`）——パスも
// realpath も今と同じなので、node の依存の解決（入れ子の `node_modules`・`@banto/*` の相対の symlink）が変わらない。

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, createReadStream } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { shq } from "./ssh.js";

/** 送るものの1件。`rel` は送る先の根からの相対パス（`./` は付けない） */
export type BundleEntry =
  | { kind: "file"; rel: string; abs: string }
  | { kind: "link"; rel: string; target: string };

/** 向こうの版の置き場での、node と起動役の置き場所 */
export const REMOTE_NODE_REL = "bin/node";
export const REMOTE_LAUNCHER_REL = "banto-launcher.mjs";

/** パッケージの中で送らないもの（ワークスペースのパッケージは決めたものだけを送るので、外から入れた依存にだけ効く） */
const SKIP_IN_DEPENDENCY = new Set(["node_modules", ".git"]);
/** ワークスペースのパッケージから送るもの */
const WORKSPACE_PARTS = ["package.json", "dist", "scripts"];
/** 動かすときに読まないファイル（型定義・ソースマップ） */
const NOT_RUNTIME = /(\.d\.[cm]?ts|\.map)$/;
/** ワークスペースの `dist` の中の試験（`tsc` が試験も書き出す） */
const WORKSPACE_TEST = /\.test\.[cm]?js$/;

/**
 * 外から入れた依存が `dependencies` に挙げていても、動くときに読まないもの（辿らない）。`@infisical/sdk` が `typescript`
 * （約 20MB）を挙げているが、`lib` のどこからも読んでいない（2026-10-14 に確かめた）。ワークスペースのパッケージの
 * `dependencies` に書いてあれば辿る（動くときに要るなら書いた側の意図を信じる）
 */
const NOT_RUNTIME_DEPENDENCY = new Set(["typescript"]);

/** sha256sum が逃がし字（`\`）を付ける名前・tar の一覧を壊す名前は、送らずに止める（照合の形がずれる） */
function assertPlainName(rel: string): void {
  if (/[\\\n\r\t\0]/.test(rel)) throw new Error(`送れない名前のファイルがあります（\\・改行・タブを含む）：${JSON.stringify(rel)}`);
}

/**
 * **送るものの一覧を作る**。`monorepoRoot` の下の Module のパッケージから、node の解決の順（自分の `node_modules` →
 * 親の `node_modules` …）で依存を辿る。入っていない optional の依存は飛ばす
 */
export function collectCodeBundle(monorepoRoot: string, extras: { nodePath: string; launcherPath: string }): BundleEntry[] {
  const root = realpathSync(monorepoRoot);
  const entries = new Map<string, BundleEntry>();
  const visited = new Set<string>();

  const add = (e: BundleEntry) => {
    assertPlainName(e.rel);
    entries.set(e.rel, e);
  };
  const relOf = (abs: string) => {
    const rel = relative(root, abs);
    if (rel.startsWith("..") || rel === "") throw new Error(`banto のコードの外を指しています：${abs}`);
    return rel.split(sep).join("/");
  };
  const addTree = (dir: string, skip: ReadonlySet<string>, skipFile: RegExp) => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) add({ kind: "link", rel: relOf(abs), target: readlinkSync(abs) });
      else if (st.isDirectory()) addTree(abs, new Set(), skipFile);
      else if (st.isFile() && !skipFile.test(name)) add({ kind: "file", rel: relOf(abs), abs });
    }
  };

  /** その場所（実のパス）から見た依存 `name` の在りか（`node_modules` を上へ辿る）。無ければ undefined */
  const resolveFrom = (fromDir: string, name: string): string | undefined => {
    for (let dir = fromDir; ; dir = dirname(dir)) {
      const candidate = join(dir, "node_modules", name);
      if (existsSync(candidate)) return candidate;
      if (dir === root || !dir.startsWith(root)) return undefined;
    }
  };

  const visit = (pkgDir: string) => {
    const real = realpathSync(pkgDir);
    if (visited.has(real)) return;
    visited.add(real);
    const manifest = JSON.parse(readFileSync(join(real, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const inNodeModules = relOf(real).split("/").includes("node_modules");
    if (inNodeModules) {
      addTree(real, SKIP_IN_DEPENDENCY, NOT_RUNTIME);
    } else {
      for (const part of WORKSPACE_PARTS) {
        const abs = join(real, part);
        if (!existsSync(abs)) continue;
        if (statSync(abs).isDirectory()) addTree(abs, new Set(), new RegExp(`${NOT_RUNTIME.source}|${WORKSPACE_TEST.source}`));
        else add({ kind: "file", rel: relOf(abs), abs });
      }
    }
    const names = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    for (const name of names) {
      if (inNodeModules && NOT_RUNTIME_DEPENDENCY.has(name)) continue;
      const found = resolveFrom(real, name);
      if (!found) {
        if (manifest.dependencies?.[name] !== undefined) {
          throw new Error(`${relOf(real)} の依存 ${name} が入っていません（npm install をしてください）`);
        }
        continue;
      }
      // 辿った道の symlink（`node_modules/@banto/module-shell` → `../../packages/modules/shell`）はそのまま送る
      const st = lstatSync(found);
      if (st.isSymbolicLink()) add({ kind: "link", rel: relOf(found), target: readlinkSync(found) });
      visit(found);
    }
  };

  const modulesDir = join(root, "packages", "modules");
  for (const name of readdirSync(modulesDir).sort()) {
    if (existsSync(join(modulesDir, name, "package.json"))) visit(join(modulesDir, name));
  }
  // ESM の判定（`"type": "module"`）はパッケージごとの package.json で決まるが、根のものも置いておく（ワークスペースの形のまま）
  add({ kind: "file", rel: "package.json", abs: join(root, "package.json") });
  add({ kind: "file", rel: REMOTE_NODE_REL, abs: extras.nodePath });
  add({ kind: "file", rel: REMOTE_LAUNCHER_REL, abs: extras.launcherPath });
  return [...entries.values()];
}

/** 塗り（向こうに別々に置き、変わったものだけを送る単位）。並びは送る順（大きいものから） */
export const LAYER_KINDS = ["deps", "node", "code"] as const;
export type LayerKind = (typeof LAYER_KINDS)[number];

/** その1件がどの塗りに入るか（依存は `node_modules` の下のファイル。symlink はコードに入れる——`@banto/*` を含む） */
export function layerOf(e: BundleEntry): LayerKind {
  if (e.rel === REMOTE_NODE_REL) return "node";
  if (e.kind === "file" && e.rel.split("/").includes("node_modules")) return "deps";
  return "code";
}

/** 送るものを塗りに分ける（塗りの中のパスは版のフォルダと同じ——向こうの塗りのフォルダで同じ鍵になる） */
export function splitLayers(entries: readonly BundleEntry[]): Record<LayerKind, BundleEntry[]> {
  const out: Record<LayerKind, BundleEntry[]> = { deps: [], node: [], code: [] };
  for (const e of entries) out[layerOf(e)].push(e);
  return out;
}

/** 向こうの塗りのフォルダの名前の頭（`<塗り>-<鍵16>-`。後ろに連番） */
export function layerPrefix(kind: LayerKind, digest: string): string {
  return `${kind}-${digest.slice(0, 16)}-`;
}

/**
 * **どの塗りを使い、どれを送るか**。`remote` は向こうにある塗りのフォルダ（名前→いまの中身の鍵）。鍵が合うものがあれば
 * それを使い、無ければ（無い・書き換えられていた）新しい連番の名前で送る
 */
export function planLayers(
  layers: ReadonlyArray<{ kind: LayerKind; digest: string }>,
  remote: ReadonlyMap<string, string>,
): Array<{ kind: LayerKind; name: string; send: boolean }> {
  return layers.map(({ kind, digest }) => {
    const prefix = layerPrefix(kind, digest);
    const same = [...remote.keys()].filter((name) => name.startsWith(prefix)).sort();
    const ok = same.find((name) => remote.get(name) === digest);
    if (ok) return { kind, name: ok, send: false };
    const n = Math.max(0, ...same.map((name) => Number(name.slice(prefix.length)) || 0)) + 1;
    return { kind, name: `${prefix}${n}`, send: true };
  });
}

/** 1つの塗りを送るときに流れる大きさの見積もり（tar で送る分と、そのまま流す node・起動役） */
export function layerBytes(entries: readonly BundleEntry[]): number {
  const loose = entries.filter((e) => e.rel === REMOTE_NODE_REL || e.rel === REMOTE_LAUNCHER_REL);
  const looseBytes = loose.reduce((sum, e) => sum + (e.kind === "file" ? statSync(e.abs).size : 0), 0);
  return (tarEntries(entries).length > 0 ? estimateTarBytes(entries) : 0) + looseBytes;
}

/**
 * 向こうで、塗りをハードリンクで写して版のフォルダ `staging` を組み、その中身の鍵を出す sh（`set -e`）。
 * `code`・`staging` は sh の式ではなく、そのまま引用して使うパス
 */
export function remoteAssembleScript(p: { code: string; staging: string; layers: readonly string[] }): string {
  return [
    "set -e",
    `c=${shq(p.code)}`,
    `s=${shq(`${p.code}/${p.staging}`)}`,
    `mkdir -p "$s"`,
    ...p.layers.map((name) => `cp -al -- "$c/layers"/${shq(name)}/. "$s"/`),
    `printf 'digest=%s\n' "$(${remoteDigestCommand('"$s"')})"`,
    "",
  ].join("\n");
}

/**
 * 向こうで、組んだ版に切り替え、いまの版（`cur`→前の版）と新しい版のほかを消す sh。塗りは、その2つの版が
 * 参照していない（`<版>.layers` に無い）ものを消す
 */
export function remoteSwitchScript(p: { code: string; staging: string; next: string; cur: string; layers: readonly string[] }): string {
  const { next, cur } = p;
  return [
    "set -e",
    `c=${shq(p.code)}`,
    `mv "$c"/${shq(p.staging)} "$c"/${shq(next)}`,
    `printf '%s\n' ${p.layers.map(shq).join(" ")} > "$c"/${shq(`${next}.layers`)}`,
    `printf '%s\n' ${shq(cur)} > "$c/previous"`,
    `printf '%s\n' ${shq(next)} > "$c/current.tmp" && mv "$c/current.tmp" "$c/current"`,
    `for d in "$c"/* "$c"/.incoming-*; do`,
    `  [ -d "$d" ] || continue`,
    `  n=$(basename "$d")`,
    `  [ "$n" = layers ] || [ "$n" = ${shq(next)} ] || [ "$n" = ${shq(cur)} ] || rm -rf -- "$d"`,
    "done",
    `for f in "$c"/*.layers; do`,
    `  [ -f "$f" ] || continue`,
    `  n=$(basename "$f" .layers)`,
    `  [ "$n" = ${shq(next)} ] || [ "$n" = ${shq(cur)} ] || rm -f -- "$f"`,
    "done",
    // 前の版が塗りを参照しない（塗りに分ける前の版）なら、新しい版の分だけを残す
    `keep=$(cat "$c"/${shq(`${next}.layers`)} ${cur ? `"$c"/${shq(`${cur}.layers`)} ` : ""}2>/dev/null || true)`,
    `for d in "$c/layers"/* "$c/layers"/.incoming-*; do`,
    `  [ -d "$d" ] || continue`,
    `  n=$(basename "$d")`,
    `  printf '%s\n' "$keep" | grep -qxF -- "$n" || rm -rf -- "$d"`,
    "done",
    "",
  ].join("\n");
}

/** ファイルごとのハッシュの覚え（大きさ・更新時刻・inode が同じなら同じ中身とみなす） */
export class FileHashCache {
  private readonly known = new Map<string, { size: number; mtimeMs: number; ino: number; sha: string }>();

  async sha256(abs: string): Promise<string> {
    const st = statSync(abs);
    const hit = this.known.get(abs);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs && hit.ino === st.ino) return hit.sha;
    const sha = await new Promise<string>((resolve, reject) => {
      const h = createHash("sha256");
      createReadStream(abs)
        .on("data", (chunk) => h.update(chunk))
        .on("error", reject)
        .on("end", () => resolve(h.digest("hex")));
    });
    this.known.set(abs, { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, sha });
    return sha;
  }
}

/** バイトの並びで比べる（`LC_ALL=C sort` と同じ順） */
function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** **版の鍵**（向こうの `remoteDigestScript` と同じ形で計算する） */
export async function bundleDigest(entries: readonly BundleEntry[], cache: FileHashCache): Promise<string> {
  const files = entries.filter((e): e is Extract<BundleEntry, { kind: "file" }> => e.kind === "file");
  const links = entries.filter((e): e is Extract<BundleEntry, { kind: "link" }> => e.kind === "link");
  const fileLines: string[] = [];
  for (const f of [...files].sort((a, b) => byteOrder(`./${a.rel}`, `./${b.rel}`))) {
    fileLines.push(`${await cache.sha256(f.abs)}  ./${f.rel}\n`);
  }
  const linkLines = links.map((l) => `./${l.rel}\t${l.target}\n`).sort(byteOrder);
  return createHash("sha256").update(fileLines.join("") + linkLines.join("")).digest("hex");
}

/**
 * 向こうで、フォルダ `dirExpr`（sh の式）の中身の版の鍵を出す sh の行。`cd` するので `$(…)` の中で使う
 * （外側に括弧を付けない——`$((` は算術展開として読まれる）
 */
export function remoteDigestCommand(dirExpr: string): string {
  return (
    `cd ${dirExpr} && { find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum; ` +
    `find . -type l -printf '%p\\t%l\\n' | LC_ALL=C sort; } | sha256sum | cut -d' ' -f1`
  );
}

/** tar に渡す一覧（NUL 区切り。node と起動役は別に送るので外す） */
export function tarList(entries: readonly BundleEntry[]): string {
  return tarEntries(entries)
    .map((e) => `${e.rel}\0`)
    .join("");
}

function tarEntries(entries: readonly BundleEntry[]): BundleEntry[] {
  return entries.filter((e) => e.rel !== REMOTE_NODE_REL && e.rel !== REMOTE_LAUNCHER_REL);
}

/**
 * **tar に流れる大きさの見積もり**（送っている間の進み具合の分母）。GNU tar の形：1件ごとに見出し 512 バイト（長い名前・
 * 長い symlink の先は、もう1つの見出しと名前の分）、中身は 512 バイトに切り上げ、終わりに 1024 バイト。同じ中身への
 * ハードリンク（inode が同じ）は2件目から中身を持たない。どの tar でも同じになるとは限らないので、見積もりとして使う
 */
export function estimateTarBytes(entries: readonly BundleEntry[]): number {
  const block = (n: number) => Math.ceil(n / 512) * 512;
  const seen = new Set<string>();
  let total = 1024;
  for (const e of tarEntries(entries)) {
    total += 512;
    if (Buffer.byteLength(e.rel) > 100) total += 512 + block(Buffer.byteLength(e.rel) + 1);
    if (e.kind === "link") {
      if (Buffer.byteLength(e.target) > 100) total += 512 + block(Buffer.byteLength(e.target) + 1);
      continue;
    }
    const st = statSync(e.abs);
    const key = `${st.dev}:${st.ino}`;
    if (st.nlink > 1 && seen.has(key)) continue;
    seen.add(key);
    total += block(st.size);
  }
  // 書き出しは 10240 バイト（20 ブロック）の単位で切り上がる
  return Math.ceil(total / 10240) * 10240;
}

/** フォルダの中身を一覧にする（registry から取ってきた配布物を送るとき。symlink はそのまま） */
export function collectTreeEntries(root: string): BundleEntry[] {
  const out: BundleEntry[] = [];
  const walk = (dir: string, rel: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, d.name);
      const r = rel ? `${rel}/${d.name}` : d.name;
      assertPlainName(r);
      if (d.isSymbolicLink()) out.push({ kind: "link", rel: r, target: readlinkSync(abs) });
      else if (d.isDirectory()) walk(abs, r);
      else if (d.isFile()) out.push({ kind: "file", rel: r, abs });
    }
  };
  walk(root, "");
  return out;
}
