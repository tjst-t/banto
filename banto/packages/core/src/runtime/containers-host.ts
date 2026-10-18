// **実行場所「別のサーバ」の動かし方 `containers` の前提の確かめと、core が `sudo -n` で行う準備**（決定・2026-10-17、
// `docs/specs/v4-security.md` §1「別のサーバの中のコンテナ——1台に Project を複数置く」、Backlog #367）。
//
// `containers` では Project ごとに Incus のコンテナを立てる（SSH ユーザーの制限された区画 `user-<uid>` で）。そのための root の
// 要る準備——区画の `restricted.devices.proxy=allow`・VM の uid/gid を区画とコンテナで揃える許可（`/etc/subuid`・`/etc/subgid`
// と区画の `restricted.idmap.uid/gid`）・置き場（pool）`banto`・linger——は、**core が登録のときだけ `sudo -n` で済ませる**。
// どれも「入っていれば何もしない」形（何度流しても同じ）。`sudo -n` が通らなければ、足りないものと打つコマンドを名指しして断る。
// 繋ぐたびには、何もしないこと（準備が崩れていないこと）を確かめるだけで、sudo はしない。
//
// 向こうでのコマンドは1つずつ `VmAccess.run` で流す（試験では偽の Incus・偽の sudo に差し替える）。Docker・tmux は VM には
// 要らない（コンテナの中の話）。

import { BANTO_POOL, rootMayMap, versionHasNestingFix, type IncusResult, type RunIncus } from "@banto/container";
import { evaluateProbe, hostPlatform, probeBase, runRemoteScript, shq, type RuntimeCheck, type SshFiles, type SshResult, type SshTarget } from "./ssh.js";

/** 向こうの SSH ユーザーと、そのユーザーとしてコマンドを1つ流す口 */
export interface VmAccess {
  user: string;
  uid: number;
  gid: number;
  /** そのユーザーとしてコマンドを流す（`["incus", …]`・`["sudo", "-n", …]`・`["cat", …]` など）。見つからなければ 127 */
  run: RunIncus;
}

/** 向こうの、準備に関わる様子 */
export interface ContainersHostState {
  incus:
    | { status: "missing" }
    | { status: "unreachable"; message: string }
    | { status: "ok"; version: string; project: string };
  /** `incus` グループに入っている（incus-user の口に繋げる） */
  inIncusGroup: boolean;
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

const sudoRun = (vm: VmAccess, args: string[]) => vm.run(["sudo", "-n", ...args], { timeoutMs: 180_000 });

/** 向こうの様子を引く（sudo は「通るか」と、ユーザーから見えない置き場を root で見るのにだけ使う。変えない） */
export async function inspectContainersHost(vm: VmAccess): Promise<ContainersHostState> {
  const [info, groups, subuid, subgid, sudo, linger] = await Promise.all([
    vm.run(["incus", "query", "/1.0"]),
    vm.run(["id", "-nG"]),
    vm.run(["cat", "/etc/subuid"]),
    vm.run(["cat", "/etc/subgid"]),
    vm.run(["sudo", "-n", "true"]),
    vm.run(["test", "-e", `/var/lib/systemd/linger/${vm.user}`]),
  ]);
  let incus: ContainersHostState["incus"];
  if (info.code === 127) incus = { status: "missing" };
  else if (info.code !== 0) incus = { status: "unreachable", message: info.stderr.trim() || `終了コード ${info.code}` };
  else {
    try {
      const body = JSON.parse(info.stdout) as { environment?: { server_version?: string; project?: string } };
      incus = { status: "ok", version: body.environment?.server_version ?? "", project: body.environment?.project ?? "" };
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
  return {
    incus,
    inIncusGroup: groups.stdout.trim().split(/\s+/).includes("incus"),
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

/** 準備の1項目。`done` で済んでいるか、`commands` で root として打つもの（人に見せる直し方もこれから作る） */
interface PrepareStep {
  id: string;
  label: string;
  done(state: ContainersHostState): boolean;
  /** 済んでいないときに打つもの（sudo の後ろ）。打てない（人が直すしかない）なら理由を返す */
  commands(state: ContainersHostState, vm: VmAccess): Promise<string[][] | { manual: string; fix: string }>;
}

function steps(vm: VmAccess): PrepareStep[] {
  const project = projectNameOf(vm.uid);
  return [
    {
      id: "incus-project",
      label: `自分の区画（${project}）でコンテナを作れる`,
      done: (s) => s.incus.status === "ok" && s.incus.project === project,
      commands: async (s) => {
        if (s.incus.status === "missing") return { manual: "Incus が入っていません。", fix: "（上の Incus を入れてから）" };
        if (s.incus.status === "ok") {
          return {
            manual: `Incus に区画 ${project} ではなく「${s.incus.project}」で繋がります（incus-admin グループに入っていると、制限の無い管理の口に繋ぎます）。banto 専用のユーザーを incus グループだけに入れてください。`,
            fix: `sudo gpasswd -d ${vm.user} incus-admin`,
          };
        }
        // incus グループに入れば、incus-user が最初に繋いだときに区画を作る。入っているのに繋がらないなら口を起こす
        return s.inIncusGroup ? [["systemctl", "enable", "--now", "incus-user.socket"]] : [["usermod", "-aG", "incus", vm.user]];
      },
    },
    {
      id: "incus-proxy",
      label: `区画で proxy device を使える（restricted.devices.proxy=allow）`,
      done: (s) => !!s.projectConfig && (!restricted(s) || s.projectConfig["restricted.devices.proxy"] === "allow"),
      commands: async () => [["incus", "project", "set", project, "restricted.devices.proxy=allow"]],
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
      commands: async (s) => {
        const out: string[][] = [];
        if (!s.subuid) out.push(["usermod", "--add-subuids", `${vm.uid}-${vm.uid}`, "root"]);
        if (!s.subgid) out.push(["usermod", "--add-subgids", `${vm.gid}-${vm.gid}`, "root"]);
        // subuid・subgid は Incus が起きるときに読む（この機械の install.sh と同じ。要るかは まっさらな VM で測る——仕様）
        if (!s.subuid || !s.subgid) out.push(["systemctl", "restart", "incus.service"], ["incus", "admin", "waitready", "--timeout", "120"]);
        const cfg = s.projectConfig ?? {};
        const merged = (key: string, id: number) => {
          const cur = cfg[key];
          return idRangesInclude(cur, id) ? undefined : `${key}=${cur ? `${cur},` : ""}${id}`;
        };
        const sets = [merged("restricted.idmap.uid", vm.uid), merged("restricted.idmap.gid", vm.gid)].filter((x): x is string => !!x);
        if (restricted(s) && sets.length > 0) out.push(["incus", "project", "set", project, ...sets]);
        return out;
      },
    },
    {
      id: "incus-pool",
      label: `コンテナの置き場（btrfs の ${BANTO_POOL}）`,
      done: (s) => s.pool,
      commands: async (s) => {
        if (s.incus.status === "missing") return { manual: "Incus が入っていません。", fix: "（上の Incus を入れてから）" };
        // この機械の install.sh と同じ選び方：/var/lib/incus が btrfs ならその中、でなければ大きさを決めたファイル
        const fs = (await vm.run(["findmnt", "-no", "FSTYPE", "--target", "/var/lib/incus"])).stdout.trim();
        if (fs === "btrfs") return [["incus", "storage", "create", BANTO_POOL, "btrfs", `source=/var/lib/incus/storage-pools/${BANTO_POOL}`]];
        const avail = Number((await vm.run(["df", "-BG", "--output=avail", "/var/lib/incus"])).stdout.replace(/[^0-9\n]/g, "").trim().split("\n").pop());
        const size = Math.min(50, Math.floor(avail / 2));
        if (!Number.isFinite(size) || size < 10) {
          return {
            manual: `ディスクの空き（${Number.isFinite(avail) ? `${avail}GiB` : "不明"}）が少なく、置き場を作れません（10GiB 以上要る）。`,
            fix: `sudo incus storage create ${BANTO_POOL} btrfs size=<大きさ>GiB`,
          };
        }
        return [["incus", "storage", "create", BANTO_POOL, "btrfs", `size=${size}GiB`]];
      },
    },
    {
      id: "linger",
      label: "SSH を閉じても動き続ける設定（linger。VM を起こし直したときにコンテナの中の Service と道を戻す）",
      done: (s) => s.linger,
      commands: async () => [["loginctl", "enable-linger", vm.user]],
    },
  ];
}

/** sudo の後ろの引数を、人が打つ1行にする */
function sudoLine(args: string[]): string {
  return `sudo ${args.map((a) => (/^[A-Za-z0-9@%+=:,./_-]+$/.test(a) ? a : shq(a))).join(" ")}`;
}

/**
 * **様子から前提の一覧を作る**。`check`（登録の前）：済んでいないものは sudo が通るなら注意（登録のときに整える）、通らなければ
 * 断る（打つコマンドを添える）。`verify`（整えたあと・繋ぐたび）：済んでいないものは断る
 */
export async function evaluateContainersHost(
  state: ContainersHostState,
  vm: VmAccess,
  mode: "check" | "verify",
): Promise<RuntimeCheck[]> {
  const checks: RuntimeCheck[] = [];
  if (state.incus.status === "missing") {
    checks.push({
      id: "incus",
      label: "Incus 6.0.6 以降",
      status: "fail",
      detail: "Incus が入っていません。",
      fix: "Zabbly の lts-6.0 から Incus を入れてください（sudo apt-get install --no-install-recommends incus）",
    });
  } else if (state.incus.status === "ok") {
    const fresh = versionHasNestingFix(state.incus.version);
    checks.push({
      id: "incus",
      label: `Incus 6.0.6 以降（${state.incus.version || "版が分からない"}）`,
      status: fresh ? "ok" : "fail",
      ...(fresh
        ? {}
        : {
            detail: "Incus が古く、コンテナの中の Docker が AppArmor に止められます。",
            fix: "sudo apt-get install --no-install-recommends incus  # Zabbly の lts-6.0 から上げる",
          }),
    });
  }
  // 繋がらない（グループに入っていない等）ときは版が分からない——区画の項目で名指しする

  let needsRoot = false;
  for (const step of steps(vm)) {
    if (step.done(state)) {
      checks.push({ id: step.id, label: step.label, status: "ok" });
      continue;
    }
    const plan = await step.commands(state, vm);
    if (!Array.isArray(plan)) {
      checks.push({ id: step.id, label: step.label, status: "fail", detail: plan.manual, fix: plan.fix });
      continue;
    }
    needsRoot = true;
    const fix = plan.map(sudoLine).join("\n");
    const why =
      state.incus.status === "unreachable" && step.id === "incus-project" ? `Incus に繋がりません（${state.incus.message}）。` : "まだ整っていません。";
    if (mode === "verify") {
      checks.push({
        id: step.id,
        label: step.label,
        status: "fail",
        detail: `${why}設定の「実行場所」で「確かめ直す」を押すと、banto が sudo -n で整えます。`,
        fix,
      });
    } else if (state.sudo) {
      checks.push({ id: step.id, label: step.label, status: "warn", detail: `${why}登録するときに banto が sudo -n で整えます。`, fix });
    } else {
      checks.push({ id: step.id, label: step.label, status: "fail", detail: `${why}sudo -n が通らないので、banto は整えられません。向こうで打ってください。`, fix });
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
export class ContainersPrepareError extends Error {}

/**
 * **準備を済ませる**（登録のとき・人が「確かめ直す」を押したとき）。済んでいない項目のコマンドを順に `sudo -n` で打ち、
 * 1項目ごとに様子を引き直す（グループに入れたら区画ができる、のように前の項目が次の項目の様子を変える）。済んでいる項目には
 * 何もしない——何度流しても同じ。sudo が通らない・人が直すしかない項目があれば、何もしないで返す（呼び手が一覧で断る）
 */
export async function prepareContainersHost(vm: VmAccess): Promise<{ state: ContainersHostState; ran: string[][] }> {
  let state = await inspectContainersHost(vm);
  const ran: string[][] = [];
  if (!state.sudo || state.incus.status === "missing") return { state, ran };
  if (state.incus.status === "ok" && !versionHasNestingFix(state.incus.version)) return { state, ran };
  for (const step of steps(vm)) {
    if (step.done(state)) continue;
    const plan = await step.commands(state, vm);
    if (!Array.isArray(plan)) return { state, ran };
    for (const args of plan) {
      const r: IncusResult = await sudoRun(vm, args);
      ran.push(args);
      if (r.code !== 0) {
        throw new ContainersPrepareError(
          `準備の「${step.label}」で ${sudoLine(args)} が失敗しました（終了コード ${r.code}）：${(r.stderr || r.stdout).trim().slice(0, 400)}`,
        );
      }
    }
    state = await inspectContainersHost(vm);
  }
  return { state, ran };
}

/** 向こうのユーザーとしてコマンドを1つ流す口を、SSH で作る */
export function sshVmRun(t: SshTarget, files: SshFiles, hostKeyType: string): RunIncus {
  return async (args, opts) => {
    const r: SshResult = await runRemoteScript(t, files, hostKeyType, `exec ${args.map(shq).join(" ")}\n`, {
      timeoutMs: opts?.timeoutMs ?? 30_000,
    });
    return r;
  };
}

/** `containers` の VM に要る道具（コードを送るのに tar。git・ssh・tmux・Docker はコンテナの中） */
const CONTAINERS_TOOLS = ["tar"] as const;

/**
 * **`containers` の前提を確かめる**（`prepare` なら、足りないものを `sudo -n` で整えてから確かめ直す）。繋げなかったら `checks` は空。
 * 共通の項目（CPU の種類・ログインの静けさ・置き場・sshd の転送）は `machine` と同じ規則で見る
 */
export async function probeContainersPrerequisites(
  t: SshTarget,
  files: SshFiles,
  hostKeyType: string,
  dataRoot: string,
  opts: { mode: "check" | "prepare" | "verify"; run?: RunIncus },
): Promise<{ checks: RuntimeCheck[]; result: SshResult; ran: string[][] }> {
  const { probe, forwarding, result } = await probeBase(t, files, hostKeyType, dataRoot);
  if (!probe || !forwarding) return { checks: [], result, ran: [] };
  const common = evaluateProbe(probe, forwarding, hostPlatform()).filter((c) => ["platform", "silent-login", "data-root", "sshd"].includes(c.id));
  const missingTools = CONTAINERS_TOOLS.filter((tool) => probe.values.get(`tool.${tool}`) !== "1");
  common.splice(2, 0, {
    id: "tools",
    label: `道具（${CONTAINERS_TOOLS.join("・")}）`,
    status: missingTools.length ? "fail" : "ok",
    ...(missingTools.length ? { detail: `${missingTools.join("・")} がありません。`, fix: `sudo apt install ${missingTools.join(" ")}` } : {}),
  });
  const vm: VmAccess = {
    user: probe.values.get("user") ?? t.user,
    uid: Number(probe.values.get("uid")),
    gid: Number(probe.values.get("gid")),
    run: opts.run ?? sshVmRun(t, files, hostKeyType),
  };
  // ログインで何か出る相手では、コマンドの答えが崩れる——先にそこを直してもらう
  if (common.some((c) => c.status === "fail")) return { checks: common, result, ran: [] };
  if (opts.mode === "prepare") {
    const { state, ran } = await prepareContainersHost(vm);
    // 整えたなら、まだ済んでいないものは断る。何も打てなかった（sudo が通らない・人が直すしかない）なら登録の前と同じ言い方で
    return { checks: [...common, ...(await evaluateContainersHost(state, vm, ran.length > 0 ? "verify" : "check"))], result, ran };
  }
  const state = await inspectContainersHost(vm);
  return { checks: [...common, ...(await evaluateContainersHost(state, vm, opts.mode))], result, ran: [] };
}
