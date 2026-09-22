// **npm の配布物を取ってくる**（追加・2026-09-21、ユーザー要望
// 「ローカルならインストールして、つなぐまで、一貫してできる手段が欲しい」）。
//
// **なぜ host が取ってくるのか**（実測・2026-09-21）。`npx -y <pkg>` を宣言に
// 書けば起動時に取ってきてくれそうに見えるが、**閉じ込めの下では動かない**
// ——banto は Module を Landlock で包んで起動し、書ける場所は
// `moduleDataDir` と `/dev` だけ。`touch $HOME/.npm/… → Permission denied` を
// 実機で確認した（npm はキャッシュもログも書けない）。
//
// なので**取得は閉じ込めの外＝host がやる**。置き場は
// `<dataDir>/module-packages/<Module 名>/` で、起動時には**読み取り専用**で
// 渡す（`cli.ts` の `moduleInstallDirs`）。プログラムの置き場と状態の置き場を
// 分けるのは既存の作法どおり（`derive.ts`——`moduleInstallDirs` は READ_ONLY、
// `moduleDataDir` は READ_WRITE）。

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface NpmInstallRequest {
  /** パッケージ名（`@scope/name` も可）。 */
  identifier: string;
  /** **版は必ず指す**——`server.json` は範囲を禁じている。無ければ最新。 */
  version?: string;
  /** どこへ入れるか（`--prefix`）。 */
  dir: string;
  /** 既定以外の npm registry（`server.json` の `registryBaseUrl`）。 */
  registryBaseUrl?: string;
  /** 試験が差し替える。 */
  run?: (file: string, args: string[], opts: { cwd?: string; timeout: number }) => Promise<unknown>;
}

export interface InstalledEntry {
  /** 起動するスクリプト。**`dir` からの相対**——置き場ごと動かせるようにする。 */
  relativeScript: string;
  /** 実際に入った版（`package.json` から読む。自己申告ではなく実物）。 */
  version: string;
}

export class PackageInstallError extends Error {}

/**
 * 入れて、**起動するスクリプトの場所を返す**。
 *
 * **入ったことを npm の終了コードだけで判断しない**（規則1）——実際に
 * `package.json` を読んで、`bin` が指す先が在ることまで確かめる。
 */
export async function installNpmPackage(req: NpmInstallRequest): Promise<InstalledEntry> {
  const spec = req.version ? `${req.identifier}@${req.version}` : req.identifier;
  const args = [
    "install",
    "--prefix",
    req.dir,
    // **人の設定に左右されない**——`npm install` が devDependencies を黙って
    // 落とす／足す挙動は環境変数（`NODE_ENV`）で変わる。ここは実行に要るものだけ
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    // **勝手に package.json を作らない**（置き場は banto のもの）
    "--no-save",
    ...(req.registryBaseUrl ? ["--registry", req.registryBaseUrl] : []),
    spec,
  ];

  const run =
    req.run ??
    ((file: string, a: string[], opts: { cwd?: string; timeout: number }) =>
      execFileAsync(file, a, { timeout: opts.timeout, maxBuffer: 8 * 1024 * 1024 }));

  try {
    // 取得は時間がかかる。**上限は置く**——返らない取得で host を詰まらせない
    await run("npm", args, { timeout: 5 * 60_000 });
  } catch (err) {
    const detail =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr?: unknown }).stderr ?? "").trim().slice(-600)
        : err instanceof Error
          ? err.message
          : String(err);
    // **失敗を黙って飲まない**（規則2）——人が直せるように、npm の言い分を出す
    throw new PackageInstallError(`${spec} を取得できませんでした：${detail || "(理由が出ていません)"}`);
  }

  const pkgDir = join(req.dir, "node_modules", req.identifier);
  let manifest: { bin?: unknown; main?: unknown; version?: unknown };
  try {
    manifest = JSON.parse(await readFile(join(pkgDir, "package.json"), "utf8")) as typeof manifest;
  } catch (err) {
    // npm が 0 で終わっても入っていないことがある——**自己申告を信じない**（規則1）
    throw new PackageInstallError(
      `${spec} を取得しましたが、中身が見つかりません（${pkgDir}）：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const script = binScriptOf(manifest);
  if (!script) {
    throw new PackageInstallError(
      `${spec} には起動するプログラム（package.json の bin）がありません。MCP サーバではない可能性があります`,
    );
  }

  return {
    relativeScript: join("node_modules", req.identifier, script),
    version: typeof manifest.version === "string" ? manifest.version : (req.version ?? "unknown"),
  };
}

/**
 * `bin` が指すスクリプト。**1本に決まらないものは断る**（規則2）。
 *
 * `bin` は文字列（1本）か、名前→パスの表。表で2本以上あるときは、banto には
 * **どれが MCP サーバなのかを決める材料が無い**——推測で1本目を選ぶと、
 * 「立ったけれど喋らない」という分かりにくい壊れ方になる。
 */
function binScriptOf(manifest: { bin?: unknown; main?: unknown }): string | undefined {
  const { bin } = manifest;
  if (typeof bin === "string") return bin;
  if (bin && typeof bin === "object") {
    const entries = Object.values(bin as Record<string, unknown>).filter(
      (v): v is string => typeof v === "string",
    );
    if (entries.length === 1) return entries[0];
    // 2本以上——名前で選べないので、main に落ちる（それも無ければ諦める）
    if (entries.length > 1) return typeof manifest.main === "string" ? manifest.main : undefined;
  }
  return typeof manifest.main === "string" ? manifest.main : undefined;
}
