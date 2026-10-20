// **実行場所「別のサーバ」の動かし方 `containers` の前提の確かめと、core が `sudo -n` で行う準備**（決定・2026-10-17、
// `docs/specs/v4-security.md` §1「別のサーバの中のコンテナ——1台に Project を複数置く」、Backlog #367。改訂・2026-10-19、
// 同 §1「足りないものは banto が入れる」）。
//
// `containers` では Project ごとに Incus のコンテナを立てる（SSH ユーザーの制限された区画 `user-<uid>` で）。そのための root の
// 要る準備——Incus そのもの（無い・古いなら Zabbly から入れる）・`incus-admin` から外して `incus` グループだけにする・ユーザーの
// systemd を新しいグループで起こし直す・区画の `restricted.devices.proxy=allow`・VM の uid/gid を区画とコンテナで揃える許可
// （`/etc/subuid`・`/etc/subgid` と区画の `restricted.idmap.uid/gid`）・置き場（pool）`banto`・linger——は、**core が登録と人の
// 「確かめ直す」のときだけ `sudo -n` で済ませる**。どれも「入っていれば何もしない」形（何度流しても同じ）。`sudo -n` が通らな
// ければ、足りないものと打つコマンドを名指しして断る。繋ぐたびには、準備が崩れていないことを確かめるだけで、sudo はしない。
//
// 向こうでのコマンドは1つずつ `VmAccess.run` で流す（1つごとに別の SSH の接続——替えたグループが次のコマンドから効く。試験では
// 偽の Incus・偽の sudo に差し替える）。Docker・tmux は VM には要らない（コンテナの中の話）。

import { BANTO_POOL, rootMayMap, versionHasNestingFix } from "@banto/container";
import { evaluateProbe, hostPlatform, probeBase, sshRun, type RuntimeCheck, type SshFiles, type SshResult, type SshTarget } from "./ssh.js";
import { execFile } from "node:child_process";
import {
  aptInstall,
  aptPrelude,
  AutoFixError,
  commonFixes,
  displayOf,
  markAutoFixes,
  preparedCheck,
  ROOT_COMMAND_MS,
  runFixes,
  runRootCommand,
  SUDO,
  WILL_FIX_ON_REGISTER,
  writeRootFile,
  type RanCommand,
  type RootCommand,
  type RootRun,
} from "./host-autoprep.js";

/** 向こうの SSH ユーザーと、そのユーザーとしてコマンドを1つ流す口 */
export interface VmAccess {
  user: string;
  uid: number;
  gid: number;
  /** そのユーザーとしてコマンドを流す（`["incus", …]`・`["/usr/bin/sudo", "-n", …]`・`["cat", …]` など）。見つからなければ 127 */
  run: RootRun;
  /** 向こうの OS（Incus を入れる道を選ぶ。分からなければ入れない）。`cloudinit` は cloud-init が居る（apt の前に待つ） */
  os?: { apt: boolean; id: string; version: string; codename: string; arch: string; cloudinit?: boolean };
  /** banto が向こうで打ったものを、banto のログに1行ずつ */
  log?: (line: string) => void;
}

/** 向こうの、準備に関わる様子 */
export interface ContainersHostState {
  incus:
    | { status: "missing" }
    | { status: "unreachable"; message: string }
    | { status: "ok"; version: string; project: string };
  /** `incus` グループに入っている（incus-user の口に繋げる） */
  inIncusGroup: boolean;
  /** `incus-admin` グループに入っている（制限の無い管理の口に繋いでしまう） */
  inIncusAdmin: boolean;
  /** 動いているユーザーの systemd（user@<uid>）のグループが、今のグループと食い違う（グループを替えたあと起こし直していない） */
  userManagerStale: boolean;
  /** 入っている incus の版（dpkg。区画に繋がらなくても分かる） */
  installedVersion?: string;
  /** Incus を初期化してある（default のプロファイルに root のディスクがある。root で見る——sudo が通らなければ分からないので true） */
  initialized: boolean;
  /** 自分の区画の設定（読めなければ undefined——区画がまだ無い・Incus に繋がらない） */
  projectConfig?: Record<string, string>;
  subuid: boolean;
  subgid: boolean;
  pool: boolean;
  sudo: boolean;
  linger: boolean;
}

export function projectNameOf(uid: number): string {
  return `user-${uid}`;
}

const sudoRun = (vm: VmAccess, args: string[], timeoutMs = ROOT_COMMAND_MS) => vm.run([SUDO, "-n", ...args], { timeoutMs });

/**
 * `/proc/<pid>/status` の Groups の行と `id -G`（頂が主のグループ）が同じ組か。主のグループは Groups に入らないことがあるので、
 * 両方から除いて補助のグループだけ比べる。読めなければ同じとみなす（起こし直さない）
 */
export function sameGroups(statusText: string, idG: string): boolean {
  const line = statusText.split("\n").find((l) => l.startsWith("Groups:"));
  const ids = idG.trim().split(/\s+/).filter(Boolean);
  if (!line || ids.length === 0) return true;
  const primary = ids[0]!;
  const a = new Set(line.slice("Groups:".length).trim().split(/\s+/).filter((g) => g && g !== primary));
  const b = new Set(ids.filter((g) => g !== primary));
  return a.size === b.size && [...a].every((g) => b.has(g));
}

/**
 * **そのユーザーが Incus のどの区画に繋がるか**。`/1.0` の `environment.project` は、区画を指定しない問い合わせでは incus-user の
 * 制限つきの証明書でも `default` を返す（2026-10-20、banto-ct-test で実測——これを見て誤って断っていた）。代わりに、見える区画の
 * 一覧（`/1.0/projects`。制限つきの証明書には許された区画だけが返る）で決める：自分の区画だけが見えるなら `user-<uid>`、
 * `default` が見えるなら制限の無い口（`default`）、読めなければ空
 */
export async function reachableProject(vm: VmAccess): Promise<string> {
  const r = await vm.run(["incus", "query", "/1.0/projects"]);
  if (r.code !== 0) return "";
  let names: string[];
  try {
    names = (JSON.parse(r.stdout) as unknown[]).filter((x): x is string => typeof x === "string").map((u) => decodeURIComponent(u.split("/").pop() ?? ""));
  } catch {
    return "";
  }
  if (names.includes("default")) return "default";
  return names.length === 1 && names[0] === projectNameOf(vm.uid) ? names[0] : "";
}

/** 向こうの様子を引く（sudo は「通るか」と、ユーザーから見えない置き場を root で見るのにだけ使う。変えない） */
export async function inspectContainersHost(vm: VmAccess): Promise<ContainersHostState> {
  // 同時に張る SSH の接続は5本まで（sshd の MaxStartups の既定 10 から確率で断り始める——ほかの接続と重なっても誤判定しない）
  const [info, groups, groupIds, subuid, subgid] = await Promise.all([
    vm.run(["incus", "query", "/1.0"]),
    vm.run(["id", "-nG"]),
    vm.run(["id", "-G"]),
    vm.run(["cat", "/etc/subuid"]),
    vm.run(["cat", "/etc/subgid"]),
  ]);
  const [sudo, linger, managerPid, dpkg] = await Promise.all([
    vm.run([SUDO, "-n", "true"]),
    vm.run(["test", "-e", `/var/lib/systemd/linger/${vm.user}`]),
    vm.run(["systemctl", "show", "-p", "MainPID", "--value", `user@${vm.uid}.service`]),
    vm.run(["dpkg-query", "-W", "-f=${Version}", "incus"]),
  ]);
  let incus: ContainersHostState["incus"];
  if (info.code === 127) incus = { status: "missing" };
  else if (info.code !== 0) incus = { status: "unreachable", message: info.stderr.trim() || `終了コード ${info.code}` };
  else {
    try {
      const body = JSON.parse(info.stdout) as { environment?: { server_version?: string } };
      incus = { status: "ok", version: body.environment?.server_version ?? "", project: await reachableProject(vm) };
    } catch {
      incus = { status: "unreachable", message: `incus query /1.0 の答えを読めませんでした：${info.stdout.slice(0, 120)}` };
    }
  }
  let projectConfig: Record<string, string> | undefined;
  let pool = false;
  if (incus.status === "ok") {
    const [project, poolAsUser] = await Promise.all([
      vm.run(["incus", "query", `/1.0/projects/${projectNameOf(vm.uid)}`]),
      vm.run(["incus", "query", `/1.0/storage-pools/${BANTO_POOL}`]),
    ]);
    if (project.code === 0) {
      try {
        projectConfig = (JSON.parse(project.stdout) as { config?: Record<string, string> }).config ?? {};
      } catch {
        projectConfig = undefined;
      }
    }
    pool = poolAsUser.code === 0;
  }
  // 区画の外の置き場はユーザーから見えないことがある——root で見る（作り直さないため）
  if (!pool && sudo.code === 0 && incus.status !== "missing") pool = (await sudoRun(vm, ["incus", "storage", "show", BANTO_POOL])).code === 0;
  // ユーザーの systemd が起きたときのグループのまま残っていないか（#363：起こし直すまで新しいグループを持たない）
  let userManagerStale = false;
  const pid = managerPid.stdout.trim();
  if (managerPid.code === 0 && /^[1-9]\d*$/.test(pid) && groupIds.code === 0) {
    const status = await vm.run(["cat", `/proc/${pid}/status`]);
    if (status.code === 0) userManagerStale = !sameGroups(status.stdout, groupIds.stdout);
  }
  const names = groups.stdout.trim().split(/\s+/);
  const installed = dpkg.code === 0 ? dpkg.stdout.trim().replace(/^\d+:/, "") : "";
  // 初期化してあるか（root で読むだけ）。入れた直後は daemon が起きている途中で答えないことがある——起きるまで待ち、待っても
  // 答えなければ「分からない」として初期化しない（初期化済みの daemon に init を打って落ちない。Fable の2回目のレビュー）
  let initialized = true;
  if (installed && sudo.code === 0 && (await sudoRun(vm, ["incus", "admin", "waitready", "--timeout", "120"], 150_000)).code === 0) {
    initialized = (await sudoRun(vm, ["incus", "profile", "device", "get", "default", "root", "pool"])).code === 0;
  }
  return {
    incus,
    inIncusGroup: names.includes("incus"),
    inIncusAdmin: names.includes("incus-admin"),
    userManagerStale,
    ...(installed ? { installedVersion: installed } : {}),
    initialized,
    ...(projectConfig ? { projectConfig } : {}),
    subuid: rootMayMap(subuid.stdout, vm.uid),
    subgid: rootMayMap(subgid.stdout, vm.gid),
    pool,
    sudo: sudo.code === 0,
    linger: linger.code === 0,
  };
}

/** `1000`・`1000-1000,2000` の形の範囲の並びが id を含むか */
export function idRangesInclude(ranges: string | undefined, id: number): boolean {
  return (ranges ?? "").split(",").some((part) => {
    const [a, b] = part.trim().split("-");
    if (!a) return false;
    const lo = Number(a);
    const hi = b === undefined ? lo : Number(b);
    return Number.isInteger(lo) && Number.isInteger(hi) && id >= lo && id <= hi;
  });
}

/** 区画が制限されていないなら、proxy も idmap も区画は断らない */
function restricted(state: ContainersHostState): boolean {
  return state.projectConfig?.["restricted"] === "true";
}

/** Zabbly（Incus の配布元）の鍵の指紋（install.sh の ZABBLY_FPR と同じ。https://github.com/zabbly/incus の README の値） */
export const ZABBLY_FPR = "4EFC590696CB15B87C73A3AD82CC8797C838DCFD";

/** Ubuntu の版 → Zabbly の系統（install.sh の step_check_host と同じ。26.04 の lts-6.0 には resolute が無い） */
export function incusChannelOf(os: VmAccess["os"]): string | undefined {
  if (!os?.apt || os.id !== "ubuntu" || !/^[a-z]+$/.test(os.codename) || !["amd64", "arm64"].includes(os.arch)) return undefined;
  return os.version === "24.04" ? "lts-6.0" : os.version === "26.04" ? "stable" : undefined;
}

/**
 * **Zabbly の鍵を host で取って確かめる**（install.sh の zabbly_key_ok と同じ：公開鍵が1つで、指紋が決めた値）。VM の curl・gpg に
 * 頼らない（Fable のレビュー、2026-10-19）。確かめた中身を VM の `tee` に渡す
 */
export async function fetchVerifiedZabblyKey(): Promise<string> {
  const res = await fetch("https://pkgs.zabbly.com/key.asc", { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Zabbly の鍵を取ってこられませんでした（HTTP ${res.status}）`);
  const key = await res.text();
  const colons = await new Promise<string>((resolve, reject) => {
    const child = execFile("gpg", ["--show-keys", "--with-colons"], { timeout: 30_000 }, (err, stdout) =>
      err ? reject(new Error(`banto の host で gpg を使えませんでした：${err.message}`)) : resolve(stdout),
    );
    child.stdin?.end(key);
  });
  if (!zabblyKeyOk(colons)) {
    throw new Error(`Zabbly の鍵が思っていたものと違います（公開鍵が1つで、指紋が ${ZABBLY_FPR} であること）。すり替えられているおそれがあります`);
  }
  return key;
}

/** `gpg --show-keys --with-colons` の出力が「公開鍵が1つで、指紋が ZABBLY_FPR」か */
export function zabblyKeyOk(colons: string): boolean {
  const lines = colons.split("\n");
  const pubs = lines.filter((l) => l.startsWith("pub:"));
  if (pubs.length !== 1) return false;
  const at = lines.findIndex((l) => l.startsWith("pub:"));
  const fpr = lines.slice(at + 1).find((l) => l.startsWith("fpr:"));
  return fpr?.split(":")[9] === ZABBLY_FPR;
}

/** Incus を Zabbly から入れるコマンド（install.sh の step_incus と同じ道。台本は使わず、項目ごとのコマンドで） */
function incusInstallCommands(vm: VmAccess, channel: string, key: () => Promise<string>): RootCommand[] {
  const os = vm.os!;
  const sources = [
    "Enabled: yes",
    "Types: deb",
    `URIs: https://pkgs.zabbly.com/incus/${channel}`,
    `Suites: ${os.codename}`,
    "Components: main",
    `Architectures: ${os.arch}`,
    "Signed-By: /etc/apt/keyrings/zabbly.asc",
    "",
  ].join("\n");
  return [
    { args: ["install", "-d", "-m", "0755", "/etc/apt/keyrings"] },
    writeRootFile("/etc/apt/keyrings/zabbly.asc", key, `sudo tee /etc/apt/keyrings/zabbly.asc（Zabbly の鍵。banto の host で指紋 ${ZABBLY_FPR} を確かめたもの）`),
    { args: ["chmod", "0644", "/etc/apt/keyrings/zabbly.asc"] },
    writeRootFile(`/etc/apt/sources.list.d/zabbly-incus-${channel}.sources`, async () => sources, `sudo tee /etc/apt/sources.list.d/zabbly-incus-${channel}.sources（Zabbly の ${channel}）`),
    ...aptPrelude(new Map(os.cloudinit ? [["cloudinit", "1"]] : [])),
    aptInstall(["incus", "btrfs-progs"]),
  ];
}

/** 準備の1項目が「今は打てない」とき */
interface Blocked {
  /** 人が直すしかない（断る）。`warn` なら注意にとどめる */
  manual: string;
  fix: string;
  warn?: boolean;
}

/** 前の項目（Incus を入れる）が済めば整える——登録の前の確かめでは注意 */
interface AfterEarlier {
  after: string;
}

type StepCommand = RootCommand;

/** 準備の1項目。`done` で済んでいるか、`commands` で root として打つもの（人に見せる直し方もこれから作る） */
interface PrepareStep {
  id: string;
  label: string;
  done(state: ContainersHostState): boolean;
  /**
   * 済んでいないときに打つもの（sudo の後ろ）。打てないなら理由を返す。`forPerson` なら、Incus がまだ無くても入れたあとに打つ
   * ものを返す（sudo -n が通らない相手に、人が打つコマンドを見せるため）
   */
  commands(state: ContainersHostState, forPerson?: boolean): Promise<StepCommand[] | Blocked | AfterEarlier>;
}

export interface PrepareOptions {
  /** Zabbly の鍵を取って確かめる（試験では差し替える） */
  zabblyKey?: () => Promise<string>;
  /**
   * ユーザーの systemd（user@<uid>）を起こし直してよいか——その実行場所を使う Project が1つも無いとき（登録では常に）だけ。
   * 起こし直すと、そのユーザーの Service・待たない形のコマンドが止まる
   */
  mayRestartUserManager: boolean;
}

const incusFresh = (s: ContainersHostState) =>
  s.incus.status === "ok" ? versionHasNestingFix(s.incus.version) : !!s.installedVersion && versionHasNestingFix(s.installedVersion);

function steps(vm: VmAccess, opts: PrepareOptions): PrepareStep[] {
  const project = projectNameOf(vm.uid);
  const channel = incusChannelOf(vm.os);
  const needsIncus = (s: ContainersHostState, forPerson?: boolean): AfterEarlier | Blocked | undefined => {
    if (forPerson || (s.incus.status !== "missing" && incusFresh(s))) return undefined;
    return channel ? { after: "Incus を入れたあとに整えます。" } : { manual: "Incus が入っていません（上の Incus を入れてから）。", fix: "（上の Incus を入れてから）" };
  };
  return [
    {
      id: "incus",
      label: "Incus 6.0.6 以降",
      done: (s) => s.incus.status !== "missing" && incusFresh(s) && s.initialized,
      commands: async (s) => {
        // 入っていて新しいが、まだ初期化していない（default のプロファイルに root のディスクが無い）
        if (s.incus.status !== "missing" && incusFresh(s)) return [{ args: ["incus", "admin", "init", "--minimal"] }];
        const now = s.incus.status === "ok" ? s.incus.version : s.installedVersion;
        if (!channel) {
          return {
            manual: `${now ? `Incus ${now} は古く、コンテナの中の Docker が AppArmor に止められます。` : "Incus が入っていません。"}` +
              "banto が入れられるのは Ubuntu 24.04・26.04（amd64・arm64）だけです。",
            fix: "Zabbly（https://github.com/zabbly/incus）から Incus 6.0.6 以降を入れてください（sudo apt-get install --no-install-recommends incus）",
          };
        }
        return incusInstallCommands(vm, channel, opts.zabblyKey ?? fetchVerifiedZabblyKey);
      },
    },
    {
      id: "incus-project",
      label: `自分の区画（${project}）でコンテナを作れる`,
      done: (s) => s.incus.status === "ok" && s.incus.project === project,
      commands: async (s, forPerson) => {
        const pending = needsIncus(s, forPerson);
        if (pending) return pending;
        const out: StepCommand[] = [];
        // incus-admin に入っていると、制限の無い管理の口に繋ぐ——外して incus グループだけにする（決定・2026-10-19、案A）
        if (s.inIncusAdmin) out.push({ args: ["gpasswd", "-d", vm.user, "incus-admin"] });
        if (!s.inIncusGroup) out.push({ args: ["usermod", "-aG", "incus", vm.user] });
        if (out.length) return out;
        if (s.incus.status === "ok") {
          return {
            manual: `Incus に区画 ${project} ではなく「${s.incus.project}」で繋がります。banto 専用のユーザーを incus グループだけに入れてください。`,
            fix: `sudo gpasswd -d ${vm.user} incus-admin`,
          };
        }
        // incus グループに入っているのに繋がらない——incus-user の口を起こす（最初に繋いだときに区画を作る）
        return [{ args: ["systemctl", "enable", "--now", "incus-user.socket"] }];
      },
    },
    {
      id: "user-manager",
      label: "ユーザーの systemd が今のグループで動いている",
      done: (s) => !s.userManagerStale,
      commands: async () =>
        opts.mayRestartUserManager
          ? [{ args: ["systemctl", "restart", `user@${vm.uid}.service`] }]
          : {
              manual: "ユーザーの systemd が古いグループのままです（Incus の口に繋げないことがあります）。この実行場所の Project を全部閉じてから、確かめ直してください。",
              fix: `sudo systemctl restart user@${vm.uid}.service`,
              warn: true,
            },
    },
    {
      id: "incus-proxy",
      label: `区画で proxy device を使える（restricted.devices.proxy=allow）`,
      done: (s) => !!s.projectConfig && (!restricted(s) || s.projectConfig["restricted.devices.proxy"] === "allow"),
      commands: async (s, forPerson) => needsIncus(s, forPerson) ?? [{ args: ["incus", "project", "set", project, "restricted.devices.proxy=allow"] }],
    },
    {
      id: "incus-idmap",
      label: `VM の uid/gid（${vm.uid}/${vm.gid}）をコンテナの中と揃えられる（/etc/subuid・/etc/subgid と区画の restricted.idmap）`,
      done: (s) =>
        s.subuid &&
        s.subgid &&
        !!s.projectConfig &&
        (!restricted(s) ||
          (idRangesInclude(s.projectConfig["restricted.idmap.uid"], vm.uid) && idRangesInclude(s.projectConfig["restricted.idmap.gid"], vm.gid))),
      commands: async (s, forPerson) => {
        const pending = needsIncus(s, forPerson);
        if (pending) return pending;
        const out: StepCommand[] = [];
        if (!s.subuid) out.push({ args: ["usermod", "--add-subuids", `${vm.uid}-${vm.uid}`, "root"] });
        if (!s.subgid) out.push({ args: ["usermod", "--add-subgids", `${vm.gid}-${vm.gid}`, "root"] });
        // subuid・subgid は Incus が起きるときに読む（この機械の install.sh と同じ。要るかは まっさらな VM で測る——仕様）
        if (!s.subuid || !s.subgid) {
          out.push({ args: ["systemctl", "restart", "incus.service"] }, { args: ["incus", "admin", "waitready", "--timeout", "120"] });
        }
        const cfg = s.projectConfig ?? {};
        const merged = (key: string, id: number) => {
          const cur = cfg[key];
          return idRangesInclude(cur, id) ? undefined : `${key}=${cur ? `${cur},` : ""}${id}`;
        };
        const sets = [merged("restricted.idmap.uid", vm.uid), merged("restricted.idmap.gid", vm.gid)].filter((x): x is string => !!x);
        if (restricted(s) && sets.length > 0) out.push({ args: ["incus", "project", "set", project, ...sets] });
        return out;
      },
    },
    {
      id: "incus-pool",
      label: `コンテナの置き場（btrfs の ${BANTO_POOL}）`,
      done: (s) => s.pool,
      commands: async (s, forPerson) => {
        const pending = needsIncus(s, forPerson);
        if (pending) return pending;
        // この機械の install.sh と同じ選び方：/var/lib/incus が btrfs ならその中、でなければ大きさを決めたファイル
        const fs = (await vm.run(["findmnt", "-no", "FSTYPE", "--target", "/var/lib/incus"])).stdout.trim();
        if (fs === "btrfs") return [{ args: ["incus", "storage", "create", BANTO_POOL, "btrfs", `source=/var/lib/incus/storage-pools/${BANTO_POOL}`] }];
        const avail = Number((await vm.run(["df", "-BG", "--output=avail", "/var/lib/incus"])).stdout.replace(/[^0-9\n]/g, "").trim().split("\n").pop());
        const size = Math.min(50, Math.floor(avail / 2));
        if (!Number.isFinite(size) || size < 10) {
          return {
            manual: `ディスクの空き（${Number.isFinite(avail) ? `${avail}GiB` : "不明"}）が少なく、置き場を作れません（10GiB 以上要る）。`,
            fix: `sudo incus storage create ${BANTO_POOL} btrfs size=<大きさ>GiB`,
          };
        }
        return [{ args: ["incus", "storage", "create", BANTO_POOL, "btrfs", `size=${size}GiB`] }];
      },
    },
    {
      id: "linger",
      label: "SSH を閉じても動き続ける設定（linger。VM を起こし直したときにコンテナの中の Service と道を戻す）",
      done: (s) => s.linger,
      commands: async () => [{ args: ["loginctl", "enable-linger", vm.user] }],
    },
  ];
}

/**
 * **様子から前提の一覧を作る**。`check`（登録の前）：済んでいないものは sudo が通るなら注意（登録のときに整える）、通らなければ
 * 断る（打つコマンドを添える）。`verify`（整えたあと・繋ぐたび）：済んでいないものは断る
 */
export async function evaluateContainersHost(
  state: ContainersHostState,
  vm: VmAccess,
  mode: "check" | "verify",
  opts: PrepareOptions = { mayRestartUserManager: true },
): Promise<RuntimeCheck[]> {
  const checks: RuntimeCheck[] = [];
  let needsRoot = false;
  for (const step of steps(vm, opts)) {
    const now = state.incus.status === "ok" ? state.incus.version : state.installedVersion;
    const label = step.id === "incus" && now ? `${step.label}（${now}）` : step.label;
    if (step.done(state)) {
      checks.push({ id: step.id, label, status: "ok" });
      continue;
    }
    const plan = await step.commands(state);
    if ("after" in plan) {
      // 前の項目（Incus を入れる）が済めば整える。整えられないなら、Incus を入れたあとに人が打つものを見せる
      needsRoot = true;
      if (mode === "check" && state.sudo) {
        checks.push({ id: step.id, label, status: "warn", detail: plan.after, autoFix: true });
        continue;
      }
      const later = await step.commands(state, true);
      const incusWhy = state.incus.status === "missing" && !state.installedVersion ? "Incus が入っていません。" : "Incus が古いです。";
      checks.push({
        id: step.id,
        label,
        status: "fail",
        detail: `${incusWhy}${mode === "check" ? "sudo -n が通らないので、banto は整えられません。Incus を入れたあとに向こうで打ってください。" : "設定の「実行場所」で「確かめ直す」を押すと、banto が sudo -n で整えます。"}`,
        fix: Array.isArray(later) ? later.map(displayOf).join("\n") : "（上の Incus を入れてから）",
      });
      continue;
    }
    if (!Array.isArray(plan)) {
      checks.push({ id: step.id, label, status: plan.warn ? "warn" : "fail", detail: plan.manual, fix: plan.fix });
      continue;
    }
    needsRoot = true;
    const fix = plan.map(displayOf).join("\n");
    const why =
      step.id === "incus"
        ? state.incus.status === "missing" && !state.installedVersion
          ? "Incus が入っていません。"
          : "Incus が古く、コンテナの中の Docker が AppArmor に止められます。"
        : step.id === "incus-project" && state.inIncusAdmin
          ? `${vm.user} が incus-admin グループに入っていて、制限の無い管理の口に繋がります。incus-admin から外します（このユーザーで Incus を管理しているなら、別のユーザーで登録してください）。`
          : step.id === "user-manager"
            ? "ユーザーの systemd が古いグループのままです。"
            : state.incus.status === "unreachable" && step.id === "incus-project"
              ? `Incus に繋がりません（${state.incus.message}）。`
              : "まだ整っていません。";
    if (mode === "verify") {
      checks.push({
        id: step.id,
        label,
        status: "fail",
        detail: `${why}設定の「実行場所」で「確かめ直す」を押すと、banto が sudo -n で整えます。`,
        fix,
        autoFix: true,
      });
    } else if (state.sudo) {
      checks.push({ id: step.id, label, status: "warn", detail: `${why}${WILL_FIX_ON_REGISTER}`, fix, autoFix: true });
    } else {
      checks.push({ id: step.id, label, status: "fail", detail: `${why}sudo -n が通らないので、banto は整えられません。向こうで打ってください。`, fix });
    }
  }

  checks.push({
    id: "sudo",
    label: "パスワード無しの sudo（sudo -n。root の要る準備を banto が登録のときに済ませる）",
    status: state.sudo ? "ok" : needsRoot ? "fail" : "warn",
    ...(state.sudo
      ? {}
      : {
          detail: needsRoot
            ? `${vm.user} は sudo -n できません。上の準備を banto が済ませられないので、向こうで打つか、sudo を許してください。`
            : `${vm.user} は sudo -n できません。いまは準備が済んでいるので使えますが、崩れたときに banto は直せません。`,
          fix: `echo '${vm.user} ALL=(root) NOPASSWD: ALL' | sudo tee /etc/sudoers.d/banto-${vm.user}  # 準備の台本だけを許す形を勧めます`,
        }),
  });
  return checks;
}

/** 準備が途中で失敗した（打ったコマンドと Incus・sudo の言葉を添える） */
export class ContainersPrepareError extends Error {
  constructor(
    message: string,
    readonly ran: RanCommand[] = [],
  ) {
    super(message);
  }
}

/**
 * **準備を済ませる**（登録のとき・人が「確かめ直す」を押したとき）。済んでいない項目のコマンドを順に `sudo -n` で打ち、
 * 1項目ごとに様子を引き直す（グループに入れたら区画ができる、のように前の項目が次の項目の様子を変える）。同じ項目は、打つものが
 * 変わる間（incus-admin から外したら、次は incus-user の口を起こす、等）3回まで。済んでいる項目には何もしない——何度流しても
 * 同じ。sudo が通らない・人が直すしかない項目に当たったら、そこで止めて返す（呼び手が一覧で断る）
 */
export async function prepareContainersHost(
  vm: VmAccess,
  opts: PrepareOptions = { mayRestartUserManager: true },
): Promise<{ state: ContainersHostState; ran: string[][]; log: RanCommand[] }> {
  let state = await inspectContainersHost(vm);
  const ran: string[][] = [];
  const log: RanCommand[] = [];
  if (!state.sudo) return { state, ran, log };
  for (const step of steps(vm, opts)) {
    let last = "";
    for (let attempt = 0; attempt < 3 && !step.done(state); attempt++) {
      const plan = await step.commands(state);
      if (!Array.isArray(plan)) {
        if ("manual" in plan && plan.warn) break; // 注意にとどめる項目は飛ばして続ける
        return { state, ran, log };
      }
      const key = JSON.stringify(plan.map((c) => c.args));
      if (key === last || plan.length === 0) break;
      last = key;
      for (const c of plan) {
        ran.push(c.args);
        try {
          await runRootCommand(vm.run, c, log, { what: `準備の「${step.label}」で `, ...(vm.log ? { log: vm.log } : {}) });
        } catch (err) {
          if (err instanceof AutoFixError) throw new ContainersPrepareError(err.message, err.ran);
          throw err;
        }
      }
      state = await inspectContainersHost(vm);
    }
  }
  return { state, ran, log };
}

/** 向こうのユーザーとしてコマンドを1つ流す口を、SSH で作る */
export function sshVmRun(t: SshTarget, files: SshFiles, hostKeyType: string): RootRun {
  return sshRun(t, files, hostKeyType);
}

/** `containers` の VM に要る道具（コードを送るのに tar。git・ssh・tmux・Docker はコンテナの中） */
const CONTAINERS_TOOLS = ["tar"] as const;

/**
 * **`containers` の前提を確かめる**（`prepare` なら、足りないものを `sudo -n` で整えてから確かめ直す）。繋げなかったら `checks` は空。
 * 共通の項目（CPU の種類・ログインの静けさ・道具・置き場・sshd の転送）は `machine` と同じ規則で見て、道具・置き場・sshd は
 * `machine` と同じく banto が入れる
 */
export async function probeContainersPrerequisites(
  t: SshTarget,
  files: SshFiles,
  hostKeyType: string,
  dataRoot: string,
  opts: { mode: "check" | "prepare" | "verify"; run?: RootRun; log?: (line: string) => void; base?: typeof probeBase } & Partial<PrepareOptions>,
): Promise<{ checks: RuntimeCheck[]; result: SshResult; ran: string[][] }> {
  const base = opts.base ?? probeBase;
  const run = opts.run ?? sshVmRun(t, files, hostKeyType);
  const prepareOpts: PrepareOptions = {
    mayRestartUserManager: opts.mayRestartUserManager ?? opts.mode !== "verify",
    ...(opts.zabblyKey ? { zabblyKey: opts.zabblyKey } : {}),
  };
  let { probe, forwarding, result } = await base(t, files, hostKeyType, dataRoot, { sudo: opts.mode !== "verify" });
  if (!probe || !forwarding) return { checks: [], result, ran: [] };

  const commonChecks = () => {
    const all = evaluateProbe(probe!, forwarding!, hostPlatform()).filter((c) => ["platform", "silent-login", "data-root", "sshd"].includes(c.id));
    const missingTools = CONTAINERS_TOOLS.filter((tool) => probe!.values.get(`tool.${tool}`) !== "1");
    all.splice(2, 0, {
      id: "tools",
      label: `道具（${CONTAINERS_TOOLS.join("・")}）`,
      status: missingTools.length ? "fail" : "ok",
      ...(missingTools.length ? { detail: `${missingTools.join("・")} がありません。`, fix: `sudo apt install ${missingTools.join(" ")}` } : {}),
    });
    return all;
  };
  const fixesOf = () => commonFixes({ values: probe!.values, forwarding: forwarding!, mode: "containers", requiredTools: CONTAINERS_TOOLS });
  const sudo = probe.values.get("sudo") === "1";
  let fixes = fixesOf();
  const done: RanCommand[] = [];

  const unfixable = (checks: RuntimeCheck[]) => checks.some((c) => (c.id === "platform" || c.id === "silent-login") && c.status === "fail");
  if (opts.mode === "prepare" && sudo && fixes.length > 0 && !unfixable(commonChecks())) {
    const labels = new Map(commonChecks().map((c) => [c.id, c.label]));
    try {
      done.push(...(await runFixes(run, fixes, { labelOf: (id) => labels.get(id) ?? id, log: opts.log })));
    } catch (err) {
      if (err instanceof AutoFixError) throw new ContainersPrepareError(err.message, err.ran);
      throw err;
    }
    ({ probe, forwarding, result } = await base(t, files, hostKeyType, dataRoot, { sudo: true }));
    if (!probe || !forwarding) return { checks: [], result, ran: [] };
    fixes = [];
  }
  const common = markAutoFixes(commonChecks(), fixes, opts.mode, sudo);
  const v = probe.values;
  const vm: VmAccess = {
    user: v.get("user") ?? t.user,
    uid: Number(v.get("uid")),
    gid: Number(v.get("gid")),
    run,
    os: { apt: v.get("apt") === "1", id: v.get("os.id") ?? "", version: v.get("os.version") ?? "", codename: v.get("os.codename") ?? "", arch: v.get("dpkg.arch") ?? "", cloudinit: v.get("cloudinit") === "1" },
    ...(opts.log ? { log: opts.log } : {}),
  };
  // ログインで何か出る相手ではコマンドの答えが崩れる——先にそこを直してもらう。整えても直らなかった共通の項目も同じ
  if (common.some((c) => c.status === "fail")) return { checks: [...common, ...(done.length ? [preparedCheck(done)] : [])], result, ran: [] };
  if (opts.mode === "prepare") {
    const { state, ran, log } = await prepareContainersHost(vm, prepareOpts);
    done.push(...log);
    // 整えたなら、まだ済んでいないものは断る。何も打てなかった（sudo が通らない・人が直すしかない）なら登録の前と同じ言い方で
    const rest = await evaluateContainersHost(state, vm, ran.length > 0 ? "verify" : "check", prepareOpts);
    return { checks: [...common, ...rest, ...(done.length ? [preparedCheck(done)] : [])], result, ran };
  }
  const state = await inspectContainersHost(vm);
  return { checks: [...common, ...(await evaluateContainersHost(state, vm, opts.mode, prepareOpts))], result, ran: [] };
}
