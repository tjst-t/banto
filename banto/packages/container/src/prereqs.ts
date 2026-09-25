// コンテナの前提をホストで確かめる（`docs/tasks.json` container-host-prereqs）。
//
// 前提が欠けたまま Project の Module を起こそうとすると、分かりにくい所で落ちる——PoC 09 で全部踏んだ
// （`poc/09-project-container/README.md`）：Incus 6.0.0 だと中の Docker が AppArmor に止められる／subuid の
// 許可が無いとコンテナが起動しない。**足りないものを名指しし、直し方を添えて止める**（規則2——弱い道へ落ちない）。
//
// ここで見ないもの：コンテナから外へ出られるか（Docker が転送を止めているホスト）——root でないと
// 転送の規則を読めないので、コンテナを起こしたあとで実際に出てみて確かめる（container-lifecycle）。

import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { IncusMissingError, queryIncus, runIncus, type RunIncus } from "./incus.js";

/** 中の Docker が動く最小の版（上流 PR #2624 が入った 6.0 LTS）。6.1〜6.18 の系列は対象外にしない——6.19 で入った */
export const MIN_LTS = [6, 0, 6] as const;
export const MIN_FEATURE = [6, 19, 0] as const;

export type PrereqCode = "incus-missing" | "not-in-group" | "daemon-unreachable" | "incus-too-old" | "idmap-not-allowed";

export interface PrereqProblem {
  code: PrereqCode;
  /** 何が足りないか（人に出す文） */
  message: string;
  /** 直し方（そのまま打てるコマンドを含む） */
  fix: string;
}

export interface PrereqResult {
  ok: boolean;
  serverVersion?: string;
  problems: PrereqProblem[];
}

export interface PrereqDeps {
  runIncus: RunIncus;
  /** `/etc/subuid`・`/etc/subgid`・`/etc/group` を読む（試験で差し替える） */
  readText: (path: string) => Promise<string>;
  uid: number;
  /** このプロセスが持っているグループ（`process.getgroups()`） */
  groups: number[];
  userName: string;
}

function parseVersion(v: string): number[] {
  return v.split(/[.-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
}

function atLeast(v: number[], min: readonly number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if ((v[i] ?? 0) !== min[i]) return (v[i] ?? 0) > min[i]!;
  }
  return true;
}

/** 6.0.x は 6.0.6 以降、6.1 以降は 6.19 以降（PR #2624 が入った版） */
export function versionHasNestingFix(version: string): boolean {
  const v = parseVersion(version);
  if (v[0] === 6 && v[1] === 0) return atLeast(v, MIN_LTS);
  return atLeast(v, MIN_FEATURE);
}

/** `root:<start>:<count>` のどれかが uid を含むか（`/etc/subuid` の書式） */
export function rootMayMap(subidText: string, id: number): boolean {
  return subidText.split("\n").some((line) => {
    const [who, start, count] = line.trim().split(":");
    if (who !== "root" || start === undefined || count === undefined) return false;
    const s = Number(start);
    const c = Number(count);
    return Number.isInteger(s) && Number.isInteger(c) && id >= s && id < s + c;
  });
}

function groupId(groupText: string, name: string): number | undefined {
  for (const line of groupText.split("\n")) {
    const [n, , gid] = line.split(":");
    if (n === name && gid !== undefined) return Number(gid);
  }
  return undefined;
}

export async function checkContainerPrereqs(deps: PrereqDeps): Promise<PrereqResult> {
  const problems: PrereqProblem[] = [];
  let serverVersion: string | undefined;

  try {
    const info = await queryIncus<{ environment?: { server_version?: string } }>(deps.runIncus, "/1.0");
    serverVersion = info.environment?.server_version;
  } catch (err) {
    if (err instanceof IncusMissingError) {
      problems.push({
        code: "incus-missing",
        message: "Incus が入っていません。",
        fix: "Incus 6.0 LTS を Zabbly の lts-6.0 から入れてください（docs/specs/v4-security.md §1「ホストの前提」）。",
      });
    } else {
      const incusGid = groupId(await deps.readText("/etc/group").catch(() => ""), "incus");
      const inGroup = incusGid !== undefined && deps.groups.includes(incusGid);
      problems.push(
        inGroup
          ? {
              code: "daemon-unreachable",
              message: `Incus に繋がりません：${(err as Error).message}`,
              fix: "sudo systemctl status incus incus-user.socket で Incus が動いているか確かめてください。",
            }
          : {
              code: "not-in-group",
              message: `banto を動かしているプロセスが incus グループに入っていません（ユーザー ${deps.userName}）。`,
              fix: `sudo usermod -aG incus ${deps.userName} のあと、banto を起動し直してください（ログインし直すか sg incus -c '…' で起動する。グループは起動したときのものが効く）。`,
            },
      );
    }
    return { ok: false, problems };
  }

  if (!serverVersion || !versionHasNestingFix(serverVersion)) {
    problems.push({
      code: "incus-too-old",
      message: `Incus ${serverVersion ?? "（版が分からない）"} は古く、コンテナの中の Docker が AppArmor に止められます（6.0 LTS なら 6.0.6 以降が要る）。`,
      fix: "Zabbly の lts-6.0 から Incus を上げてください（sudo apt-get install --no-install-recommends incus）。",
    });
  }

  for (const file of ["/etc/subuid", "/etc/subgid"] as const) {
    const text = await deps.readText(file).catch(() => "");
    if (!rootMayMap(text, deps.uid)) {
      problems.push({
        code: "idmap-not-allowed",
        message: `${file} に root:${deps.uid}:1 がありません——Project のファイルの持ち主をホストと揃えられず、コンテナが起動しません。`,
        fix: `echo 'root:${deps.uid}:1' | sudo tee -a ${file} のあと sudo systemctl restart incus`,
      });
    }
  }

  return { ok: problems.length === 0, serverVersion, problems };
}

/** このプロセスの実際の値で確かめる（起動時の確認と `doctor` が使う） */
export function hostPrereqDeps(): PrereqDeps {
  return {
    runIncus,
    readText: (p) => readFile(p, "utf8"),
    uid: process.getuid?.() ?? -1,
    groups: process.getgroups?.() ?? [],
    userName: userInfo().username,
  };
}
