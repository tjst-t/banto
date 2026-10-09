// systemd の写しを作る（docs/specs/v4-modules.md §4.2）。マスターは Module の登録で、ここで作るものは写し。

import { join } from "node:path";
import { WORK_SERVICES_SLICE } from "@banto/module-contract";

export interface ServicePaths {
  /** systemd のユーザー単位の unit を置く所（コンテナの中の `~/.config/systemd/user`） */
  unitDir: string;
  /** サービスごとの置き場の親（コンテナの中のローカル。**host のディスクではない**——鍵の値を置くため） */
  stateDir: string;
}

export const UNIT_HEADER = "# banto の Service Module が作った写し";
export const unitHeaderFor = (moduleName: string) => `${UNIT_HEADER}（${moduleName}）`;

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
  /** envSecrets があるか（鍵のファイルが無ければ起動させない） */
  needsEnv?: boolean;
  /** どの Module の1本が作ったか（同じ Project に2本つけたとき、互いの写しを片付けないため） */
  moduleName?: string;
}): string {
  return [
    `${UNIT_HEADER}（${opts.moduleName ?? "service"}）。手で直しても、Module が登録に合わせて作り直す`,
    "[Unit]",
    `Description=banto Service ${opts.name}`,
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${escapePercent(opts.workingDirectory)}`,
    // 鍵の値はここ（0600、コンテナの中）。unit の本体には書かない。**鍵が要るものは `-` を付けない**
    // ——ファイルが無いまま秘密なしで黙って起きるより、起動に失敗して「落ちた」で見えるほうがよい
    `EnvironmentFile=${opts.needsEnv ? "" : "-"}${escapePercent(join(opts.dir, "env"))}`,
    `ExecStart=${quoteWord(opts.nodePath)} ${quoteWord(opts.wrapperPath)} ${quoteWord(opts.dir)}`,
    // 起こし直すのは異常終了のときだけ。上限は systemd の既定のまま（決定・2026-09-27）
    "Restart=on-failure",
    // **仕事の組の天井の中**（決定・2026-10-08、ユーザー。`docs/specs/v4-security.md` §1 の段2a）——丸ごとは止めず
    // （OOMPolicy は既定）、仕事（+500）より後に止められるよう一段守る
    `Slice=${WORK_SERVICES_SLICE}`,
    "OOMScoreAdjust=200",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** systemd の EnvironmentFile の1行。値は二重引用符で包み、C の書き方でエスケープする */
export function envLine(name: string, value: string): string {
  // 改行・CR は**生のまま**書く——systemd は二重引用符の中の生の改行をそのまま読み、`\\n` は
  // 「バックスラッシュ＋n」の2文字として読む（実測・2026-09-27、Fable のレビュー）
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$");
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
