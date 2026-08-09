/**
 * 同梱ドライバ（`process` / `docker`）が使う置き場の実体（`spec-environment` §5.2）。
 *
 * どちらも**プールのホスト上のディレクトリ**に置き、違うのは環境への繋ぎ方だけ
 * ——`process` は symlink、`docker` は bind mount。**同じものを2度書かない**ために
 * ここにまとめる（外のドライバは自分の流儀で持てばよい。VM なら追加ディスク、
 * k8s なら PVC）。
 *
 * 場所を決めるのは**プール**で、ドライバでも呼び出し側でもない（§6 の `dest` と同じ
 * 規則）。ドライバは渡された `cacheRoot` の下にだけ作る。
 *
 * D6: node:fs / node:path のみ。
 * I2: 消せなかったことを成功に見せない。
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** 「用意が最後まで終わった」印。**成功したときだけ**プールが書く（§5.2.2）。 */
export const PRIMED_MARKER = ".banto-primed";

/**
 * 鍵に対応する置き場を用意して、その場所を返す。
 *
 * `primed` は**印があるかどうか**。途中で死んだ半端な置き場は印を持たないので、
 * 「入っている」と誤判定しない。
 */
export function ensureCacheDir(
  cacheRoot: string,
  key: string
): { dir: string; primed: boolean } {
  // 鍵はこちらが作ったハッシュだが、経路として使う以上は素通しにしない
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, "");
  if (safe.length === 0) throw new Error(`置き場の鍵が空です: ${JSON.stringify(key)}`);
  const dir = path.join(path.resolve(cacheRoot), safe);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, primed: fs.existsSync(path.join(dir, PRIMED_MARKER)) };
}

/** そのドライバが持っている置き場の全部（`cache-list`）。 */
export function listCacheDirs(cacheRoot: string): Array<{ key: string; sizeBytes?: number }> {
  const root = path.resolve(cacheRoot);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ key: e.name }));
}

/**
 * 置き場を1つ消す（`cache-remove`）。**冪等必須**——既に無ければ成功扱い
 * （`teardown` と同じ規約）。
 */
export function removeCacheDir(cacheRoot: string, key: string): void {
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, "");
  if (safe.length === 0) return;
  const dir = path.join(path.resolve(cacheRoot), safe);
  // 根の外を消さない。鍵は濾してあるが、確かめてから消す（消す操作は取り返しがつかない）
  if (!dir.startsWith(`${path.resolve(cacheRoot)}${path.sep}`)) {
    throw new Error(`置き場の場所が根の外を指しています: ${dir}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
