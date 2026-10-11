// **core 自身が作る Unix ソケットの置き場**（追加・2026-10-11）。別のサーバへの SSH の接続の窓口（ControlPath）と、登録の
// ときに Vault に立ててもらう鍵の窓口（ssh-agent）が使う。
//
// Unix ソケットのパスは 107 バイトまで。ふつうは banto のデータの置き場の `s`（`~/.local/share/banto/s`）で収まるが、置き場が
// 深いと収まらない——Project のコンテナの Shell から E2E を流すと、置き場が Shell のホームの奥
// （`…/modules/shell-<Project>/home/.cache/banto-e2e/<回>/w0/data`）になり、登録の画面で「鍵の窓口のパスが長すぎて作れません」と
// 断られた（remote-runtime-registry.spec.ts:82、2026-10-11）。置き場の場所しだいで壊れないように、**収まらないときだけ**
// 短い場所へ逃がす。逃がし先はこのユーザーだけのもの（0700・自分の持ち物・リンクでない）でなければ断る。
//
// Module の置き場の中の窓口（コンテナに見せるもの）はここを使わない——中から同じパスで届く必要があるため。
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const SOCKET_PATH_LIMIT = 107;

/** 置き場の中に置くソケットの名前の長さの見込み（`/cm-xxxxxxxxxx` に ssh が足す一時の名前、`/a-xxxxxx`）の上限 */
export const SOCKET_NAME_ALLOWANCE = 40;

export interface SocketDirDeps {
  uid: number;
  /** `XDG_RUNTIME_DIR`（無ければ undefined） */
  runtimeDir: string | undefined;
  tmpDir: string;
}

const defaultDeps = (): SocketDirDeps => ({
  uid: process.getuid?.() ?? 0,
  runtimeDir: process.env["XDG_RUNTIME_DIR"],
  tmpDir: "/tmp",
});

/** 置き場の `s` に収まればそこ、収まらなければ短い場所。作って（0700）返す */
export function coreSocketDir(dataDir: string, deps: SocketDirDeps = defaultDeps()): string {
  const preferred = join(dataDir, "s");
  if (Buffer.byteLength(preferred) + SOCKET_NAME_ALLOWANCE <= SOCKET_PATH_LIMIT) {
    mkdirSync(preferred, { recursive: true, mode: 0o700 });
    return preferred;
  }
  const tag = createHash("sha256").update(dataDir).digest("hex").slice(0, 8);
  const dir =
    deps.runtimeDir && existsSync(deps.runtimeDir)
      ? join(deps.runtimeDir, `banto-${tag}`)
      : join(deps.tmpDir, `banto-${deps.uid}-${tag}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  // /tmp は誰でも作れる——先に別の人が作った・リンクを置いたものは使わない
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== deps.uid || (st.mode & 0o077) !== 0) {
    throw new Error(`ソケットの置き場 ${dir} がこのユーザーだけのものではないので使いません（0700・持ち主 ${deps.uid} にしてください）`);
  }
  return dir;
}
