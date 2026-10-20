// **`containers` で仮想化の実験——/dev/kvm と特権**（決定・2026-10-20、ユーザー。`docs/specs/v4-security.md` §1「`containers` で
// 仮想化の実験——/dev/kvm と特権」、Backlog #458）。
//
// 実行場所の「仮想化の実験を許す」（既定オフ）を、人が押したときにだけ変える。オンで core が `sudo -n` で区画に
// `restricted.devices.unix-char=allow` を足し、オフで unset する（incus-user が作った既定と差分が無い形に戻す）。オフにするのは、
// その実行場所の Project が全部（閉じたもの・眠っているものも）仮想化の設定を外してから。
//
// **sudo の形**（同 6.）：項目ごとの固定のコマンドで、`sh -c` の台本は使わない。引数は core が決めた区画の名前（`user-<uid>`）
// と、core が検証した値だけ。人の画面の口（admin の刻印）からだけ呼ぶ——AI の tool は作らない（同 5.）。

import { runRootCommand, AutoFixError, type RanCommand, type RootCommand } from "./host-autoprep.js";
import { allowUnixCharCommand, projectNameOf, unsetUnixCharCommand, UNIX_CHAR_KEY, type VmAccess } from "./containers-host.js";
import { RemoteRuntimeError, runtimeIdOf } from "./remote-runtimes.js";
import type { RemoteRuntime } from "./remote-store.js";

/** サーバの再起動でもモジュールを読み直すファイル（その実行場所の全 Project の名前の和。空なら消す） */
export const MODULES_LOAD_FILE = "/etc/modules-load.d/banto.conf";
/** サーバの hugepages の数を再起動でも戻すファイル（その実行場所の合計。0 なら消す） */
export const HUGEPAGES_SYSCTL_FILE = "/etc/sysctl.d/90-banto-hugepages.conf";

/** Project ごとの仮想化の設定（host 側の Project の設定。Project の根には置かない） */
export interface ProjectVirtualization {
  /** /dev/kvm と /dev/vhost-net を見せる */
  kvm: boolean;
  /** 人が足したカーネルモジュールの名前（`vhost_net` は含めない——/dev/kvm を見せるなら必ず読む） */
  modules: string[];
  /** 2MiB の hugepages の数 */
  hugepages: number;
}

export const NO_VIRTUALIZATION: ProjectVirtualization = { kvm: false, modules: [], hugepages: 0 };

/**
 * Project の設定（host 側の runtime config の Project の層）の鍵。**Project の層だけを読む**——banto 全体の既定から
 * 流れ込ませない（Project ごとに人が選ぶもの）
 */
export const VIRT_KEYS = {
  kvm: "container.kvm",
  /** 空白で区切った名前 */
  modules: "container.kvmModules",
  hugepages: "container.hugepages2M",
} as const;

/** runtime config の Project の層から読む（書くのは値を確かめる人の画面の口だけ） */
export function readProjectVirtualization(layerValue: (key: string) => unknown): ProjectVirtualization {
  const kvm = layerValue(VIRT_KEYS.kvm);
  const modules = layerValue(VIRT_KEYS.modules);
  const hugepages = layerValue(VIRT_KEYS.hugepages);
  return {
    kvm: kvm === true,
    modules: typeof modules === "string" ? modules.split(/\s+/).filter(Boolean) : [],
    hugepages: typeof hugepages === "number" && Number.isInteger(hugepages) && hugepages > 0 ? hugepages : 0,
  };
}

/** 外していない仮想化の設定（人に見せる名前）。空なら何も使っていない */
export function virtualizationInUse(v: ProjectVirtualization): string[] {
  return [...(v.kvm ? ["/dev/kvm を見せる"] : []), ...(v.hugepages > 0 ? [`hugepages ${v.hugepages} 個`] : [])];
}

export interface ContainersVirtualizationDeps {
  /** 実行場所の記録 */
  runtime(name: string): RemoteRuntime | undefined;
  /** 実行場所を押さえて（作成・確かめ直しと同じ鍵で1本ずつ）繋ぎ、VM のユーザーとして流す口を渡す */
  withVm<T>(name: string, fn: (vm: VmAccess) => Promise<T>): Promise<T>;
  /** 実行場所の記録に「許す」を書く */
  recordAllowed(name: string, allowed: boolean): Promise<void>;
  /** その実行場所を使う Project（閉じたもの・眠っているもの・移してくる途中のものも） */
  projectsOn(runtimeId: string): Array<{ id: string; name: string }>;
  /** Project ごとの仮想化の設定（host 側の Project の設定） */
  settingsOf(projectId: string): ProjectVirtualization;
}

/** 人に返す結果（画面に出す注意つき） */
export interface VirtualizationResult {
  warnings: string[];
  /** banto が向こうで sudo -n で打ったもの */
  ran: RanCommand[];
}

export class ContainersVirtualization {
  constructor(private readonly deps: ContainersVirtualizationDeps) {}

  /**
   * **実行場所の「仮想化の実験を許す」を変える**（人が押した）。オン：区画に `restricted.devices.unix-char=allow`。オフ：その実行場所の
   * 全 Project が仮想化の設定を外していなければ名指しして断り、区画の項目を unset し、modules-load と sysctl のファイルを消す
   * （読み込み済みのモジュール・確保済みの hugepages は抜かない——次の再起動で戻らなくなるだけ）
   */
  async setAllowed(runtimeName: string, allowed: boolean): Promise<VirtualizationResult> {
    const r = this.mustContainers(runtimeName);
    if (!allowed) {
      const using = this.deps
        .projectsOn(runtimeIdOf(runtimeName))
        .flatMap((p) => {
          const inUse = virtualizationInUse(this.deps.settingsOf(p.id));
          return inUse.length ? [`「${p.name}」（${inUse.join("・")}）`] : [];
        });
      if (using.length > 0) {
        throw new RemoteRuntimeError(
          409,
          `実行場所「${runtimeName}」の仮想化の実験を止められません——まだ使っている Project があります（閉じたもの・眠っているものも含む）：` +
            `${using.join("、")}。それぞれの設定で外してから止めてください`,
          { code: "virtualization-in-use" },
        );
      }
    }
    const ran: RanCommand[] = [];
    await this.deps.withVm(runtimeName, async (vm) => {
      if (allowed) {
        await root(vm, allowUnixCharCommand(vm.uid), ran, "区画に unix-char の装置を許す");
        return;
      }
      // 足した項目だけを unset する（無いものは触らない——何度流しても同じ）
      const config = await projectConfigOf(vm);
      if (config[UNIX_CHAR_KEY] !== undefined) await root(vm, unsetUnixCharCommand(vm.uid), ran, "区画の unix-char を戻す");
      await root(vm, { args: ["rm", "-f", MODULES_LOAD_FILE, HUGEPAGES_SYSCTL_FILE] }, ran, "再起動で戻す設定を消す");
    });
    if (Boolean(r.virtualization) !== allowed) await this.deps.recordAllowed(runtimeName, allowed);
    return { warnings: [], ran };
  }

  private mustContainers(runtimeName: string): RemoteRuntime {
    const r = this.deps.runtime(runtimeName);
    if (!r) throw new RemoteRuntimeError(404, `実行場所「${runtimeName}」はありません`);
    if (r.mode !== "containers") {
      throw new RemoteRuntimeError(409, `実行場所「${runtimeName}」は Project ごとのコンテナ（containers）ではありません——仮想化の実験は containers だけです`);
    }
    return r;
  }
}

/** 自分の区画の設定（VM のユーザーとして読む） */
async function projectConfigOf(vm: VmAccess): Promise<Record<string, string>> {
  const r = await vm.run(["incus", "query", `/1.0/projects/${projectNameOf(vm.uid)}`]);
  if (r.code !== 0) throw new RemoteRuntimeError(502, `区画 ${projectNameOf(vm.uid)} の設定を読めませんでした：${r.stderr.trim() || `終了コード ${r.code}`}`);
  return (JSON.parse(r.stdout) as { config?: Record<string, string> }).config ?? {};
}

/** sudo -n で1つ打つ（落ちたら、打ったものを添えて断る） */
async function root(vm: VmAccess, c: RootCommand, ran: RanCommand[], what: string): Promise<void> {
  try {
    await runRootCommand(vm.run, c, ran, { what: `仮想化の実験の「${what}」で `, ...(vm.log ? { log: vm.log } : {}) });
  } catch (err) {
    if (err instanceof AutoFixError) throw new RemoteRuntimeError(502, err.message);
    throw err;
  }
}
