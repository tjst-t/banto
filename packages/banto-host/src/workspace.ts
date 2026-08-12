/**
 * 番頭が読んでよい範囲（ワークスペース）の解決。
 *
 * `file.*` / `git.*` は番頭にローカルの中身を見せる道具なので、範囲を1つのルートに
 * 閉じる。ルート外を指すパスは黙って読まずエラーにする——シンボリックリンクや `..` で
 * 外に出られると、番頭の閲覧範囲が事実上無制限になる。
 *
 * D6: node:path / node:fs のみ。
 * I2: 範囲外・存在しないパスはエラーにして返す。
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** ワークスペースのルート。BANTO_WORKSPACE で差し替えられる。 */
export function workspaceRoot(): string {
  return path.resolve(process.env["BANTO_WORKSPACE"] ?? process.cwd());
}

/**
 * ルート配下の実パスへ解決する。
 *
 * シンボリックリンクを解決した**後**に判定するので、リンク経由で外へ出ることもできない。
 * 存在しないパスはリンク解決できないため、存在する最も近い祖先まで遡って判定する。
 */
export function resolveInWorkspace(root: string, relativePath: string): string {
  const candidate = path.resolve(root, relativePath);

  // 実体のある一番近い祖先を探し、そこを実パスに直してから範囲を判定する
  let existing = candidate;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const realExisting = fs.existsSync(existing) ? fs.realpathSync(existing) : existing;
  const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
  const resolved = path.join(realExisting, path.relative(existing, candidate));

  if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) {
    // 根を書く（inc-0054）。「外です」だけでは、どこからの相対で書けば通るのかが分からない
    throw new Error(
      `Path "${relativePath}" is outside the workspace.` +
        ` — 根は ${realRoot} です。**そこからの相対パス**を渡してください（.. で外へは出られません）`
    );
  }
  return resolved;
}

/** 表示用に、ルートからの相対パスへ戻す。 */
export function toWorkspaceRelative(root: string, absolutePath: string): string {
  const rel = path.relative(root, absolutePath);
  return rel.length === 0 ? "." : rel;
}
