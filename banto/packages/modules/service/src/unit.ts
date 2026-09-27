// systemd の写しを作る（docs/specs/v4-modules.md §4.2）。マスターは Module の登録で、ここで作るものは写し。

import { join } from "node:path";

export interface ServicePaths {
  /** systemd のユーザー単位の unit を置く所（コンテナの中の `~/.config/systemd/user`） */
  unitDir: string;
  /** サービスごとの置き場の親（コンテナの中のローカル。**host のディスクではない**——鍵の値を置くため） */
  stateDir: string;
}

export const unitName = (name: string) => `banto-${name}.service`;
export const unitPath = (paths: ServicePaths, name: string) => join(paths.unitDir, unitName(name));
export const serviceDir = (paths: ServicePaths, name: string) => join(paths.stateDir, name);

/** systemd の値の中の `%` は指定子になるので `%%` にする */
function escapePercent(s: string): string {
  return s.replace(/%/g, "%%");
}

/** ExecStart の1語。空白や引用符を含んでも1語として渡るよう、二重引用符で包む */
function quoteWord(s: string): string {
  return `"${escapePercent(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function renderUnit(opts: {
  name: string;
  workingDirectory: string;
  nodePath: string;
  wrapperPath: string;
  dir: string;
}): string {
  return [
    "# banto の Service Module が作った写し。手で直しても、Module が登録に合わせて作り直す",
    "[Unit]",
    `Description=banto Service ${opts.name}`,
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${escapePercent(opts.workingDirectory)}`,
    // 鍵の値はここ（0600、コンテナの中）。unit の本体には書かない
    `EnvironmentFile=-${escapePercent(join(opts.dir, "env"))}`,
    `ExecStart=${quoteWord(opts.nodePath)} ${quoteWord(opts.wrapperPath)} ${quoteWord(opts.dir)}`,
    // 起こし直すのは異常終了のときだけ。上限は systemd の既定のまま（決定・2026-09-27）
    "Restart=on-failure",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** systemd の EnvironmentFile の1行。値は二重引用符で包み、C の書き方でエスケープする */
export function envLine(name: string, value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\$/g, "\\$");
  return `${name}="${escaped}"`;
}

export function renderEnvFile(env: Record<string, string>): string {
  return (
    Object.keys(env)
      .sort()
      .map((k) => envLine(k, env[k]!))
      .join("\n") + "\n"
  );
}
