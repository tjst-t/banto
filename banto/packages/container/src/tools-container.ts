// **同梱の道具用のコンテナ**（決定・2026-10-15、`docs/specs/v4-security.md` §1 の4つ目の箱、`v4-modules.md` §2.2「変換役」）。
//
// 外から来た文書を開くような、banto 自身のコードだが banto 本体の権限で走らせたくない仕事を動かす1台。作り方は Project の
// コンテナと同じ（`ProjectContainers.ensure`）で、違うのは2つ：
//
// - **中で sudo できない**。土台のイメージは誰でもパスワード無しで sudo できる（`base-image.ts`）うえ、元のイメージの
//   `/etc/sudoers.d/90-incus` も `ubuntu`（uid 1000）にパスワード無しの sudo を許している（実測・2026-10-15）。パスワード
//   無しを許す行のファイルを消し、sudo の組からも外し、**できないことを確かめる**——できてしまったら用意を止める（fail closed）。
//   `sudo` のパッケージそのものは外せない（`dpkg --purge sudo` は依存で断られた、実測）
// - **要るパッケージは core が root で入れる**。宣言（`meta.toolsContainer.aptPackages`）が名乗ったものを、入っていなければ
//   入れる。入れる前に置き場の空き（2GiB 以上）を確かめる
//
// ここは Incus に1回ずつ頼む部品だけを持つ。同時に1本・失敗を覚えて毎回やり直さない、は呼ぶ側（`host-container.ts`）

import type { RunIncus } from "./incus.js";
import { ownerHash } from "./project-container.js";

/** 入れる前に要る置き場の空き（LibreOffice 一式で約 600MB——余裕を見て 2GiB、`v4-modules.md` §2.2） */
export const TOOLS_MIN_FREE_BYTES = 2 * 1024 ** 3;

/** apt を待つ上限（LibreOffice 一式は数分） */
const INSTALL_TIMEOUT_MS = 20 * 60_000;

/**
 * **同梱の道具用のコンテナ**の id。どの banto のものか（データの置き場）で分ける——E2E や検証用の banto が、人の banto の
 * コンテナを使わない（`instanceContainerId` と同じ）
 */
export function toolsContainerId(owner: string): string {
  return `tools-${ownerHash(owner)}`;
}

/** 中で走らせる。失敗は理由つきで投げる（黙って続けない、規則2） */
async function must(run: RunIncus, args: string[], what: string, timeoutMs = 60_000): Promise<string> {
  const r = await run(args, { timeoutMs });
  if (r.code !== 0) throw new Error(`${what}に失敗しました：${(r.stderr || r.stdout).trim().slice(-800) || `終了コード ${r.code}`}`);
  return r.stdout;
}

/**
 * **中で sudo できなくする**。毎回の用意で通す（何度通しても同じ形になる）。uid・gid は中の Module を動かすユーザー（host と同じ番号）。
 * 最後に、そのユーザーで `sudo -n true` が通らないことを確かめる
 */
export async function dropSudo(run: RunIncus, name: string, uid: number, gid: number): Promise<void> {
  const script = [
    // パスワード無しを許す行のファイルを消す（土台の banto・元のイメージの 90-incus）
    'for f in /etc/sudoers.d/*; do [ -f "$f" ] && grep -q NOPASSWD "$f" && rm -f "$f"; done',
    "if grep -Eq '^[^#].*NOPASSWD' /etc/sudoers; then echo 'sudoers に NOPASSWD の行があります' >&2; exit 1; fi",
    `user=$(getent passwd ${uid} | cut -d: -f1)`,
    'if [ -n "$user" ]; then for g in sudo admin wheel; do gpasswd -d "$user" "$g" >/dev/null 2>&1 || true; done; fi',
  ].join("\n");
  await must(run, ["exec", name, "--", "/bin/sh", "-c", script], `${name} で sudo を外すの`);
  const check = await run(["exec", name, "--user", String(uid), "--group", String(gid), "--", "sudo", "-n", "true"], { timeoutMs: 30_000 });
  if (check.code === 0) {
    throw new Error(`${name} の中で、まだ sudo できてしまいます——道具用のコンテナとしては使いません`);
  }
}

/** 入っていないパッケージ（名乗ったものの中で） */
export async function missingPackages(run: RunIncus, name: string, packages: readonly string[]): Promise<string[]> {
  if (packages.length === 0) return [];
  // 1つずつの状態を1行ずつ。知らない名前は dpkg-query が行を出さずに失敗するので、行の無いものは「入っていない」
  const r = await run(
    ["exec", name, "--", "dpkg-query", "-W", "-f=${Package} ${db:Status-Status}\\n", ...packages],
    { timeoutMs: 30_000 },
  );
  const installed = new Set(
    r.stdout
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .filter(([, status]) => status === "installed")
      .map(([pkg]) => pkg!.replace(/:.*$/, "")),
  );
  return packages.filter((p) => !installed.has(p));
}

/** 中の根の置き場の空き（バイト） */
export async function freeBytes(run: RunIncus, name: string): Promise<number> {
  const out = await must(run, ["exec", name, "--", "df", "-B1", "--output=avail", "/"], `${name} の空きを読むの`, 30_000);
  const n = Number(out.trim().split("\n").pop()?.trim());
  if (!Number.isFinite(n)) throw new Error(`${name} の空きを読めませんでした：${out.trim()}`);
  return n;
}

/** root で入れる（`base-image.ts` と同じ形） */
export async function installPackages(run: RunIncus, name: string, packages: readonly string[]): Promise<void> {
  await must(
    run,
    [
      "exec", name, "--env", "DEBIAN_FRONTEND=noninteractive", "--",
      "/bin/sh", "-c", 'apt-get update -q && apt-get install -y -q --no-install-recommends "$@" && apt-get clean', "banto-tools",
      ...packages,
    ],
    `${name} に ${packages.join("・")} を入れるの（コンテナから外へ出られるか確かめてください）`,
    INSTALL_TIMEOUT_MS,
  );
}
