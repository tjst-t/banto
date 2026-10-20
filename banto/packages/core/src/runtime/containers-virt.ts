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
import { containerNameFor, DEFAULT_TIMEOUTS, effectiveInsideIds, defaultContainerLimits, ProjectContainers, type ContainerVirtualization } from "@banto/container";
import { LEGACY_INSIDE_IDS } from "./remote-containers.js";
import { remoteNameOf, RemoteRuntimeError, runtimeIdOf } from "./remote-runtimes.js";
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

/** runtime config の Project の層に書く（既定の値は書かずに外す） */
export async function writeProjectVirtualization(
  config: {
    setProjectOverride(projectId: string, key: string, value: string | number | boolean): Promise<void>;
    unsetProjectOverride(projectId: string, key: string): Promise<void>;
  },
  projectId: string,
  v: ProjectVirtualization,
): Promise<void> {
  const put = (key: string, value: string | number | boolean | undefined) =>
    value === undefined ? config.unsetProjectOverride(projectId, key) : config.setProjectOverride(projectId, key, value);
  await put(VIRT_KEYS.kvm, v.kvm ? true : undefined);
  await put(VIRT_KEYS.modules, v.modules.length ? v.modules.join(" ") : undefined);
  await put(VIRT_KEYS.hugepages, v.hugepages > 0 ? v.hugepages : undefined);
}

/** /dev/kvm を見せるなら必ず読むモジュール（`/dev/vhost-net` を見せる前にサーバに無ければならない。測った4つの 1.） */
export const ALWAYS_MODULES = ["vhost_net"] as const;
/** サーバのブリッジ全部の通り方を変えるので、足すときに注意を出すモジュール */
const BRIDGE_NETFILTER = "br_netfilter";

/**
 * **人が足したモジュールの名前を確かめて揃える**（`[a-z0-9_-]+`、`-` は `_` と同じ扱いで `_` に揃える。重ねない。`vhost_net` は
 * 必ず読むので除く）。形が違えば断る——sudo の引数になる
 */
export function parseModuleNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new RemoteRuntimeError(400, "modules はモジュールの名前の配列で渡してください");
  const out: string[] = [];
  for (const x of raw) {
    if (typeof x !== "string" || !/^[a-z0-9_-]{1,64}$/.test(x)) {
      throw new RemoteRuntimeError(400, `モジュールの名前は英小文字・数字・_・- で 64 字までにしてください：${JSON.stringify(x).slice(0, 80)}`);
    }
    const name = x.replace(/-/g, "_");
    if (!(ALWAYS_MODULES as readonly string[]).includes(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * **`/etc/modules-load.d/banto.conf` の中身**：その実行場所の Project のうち /dev/kvm を見せるものの名前の和（閉じたものも）。
 * 見せる Project が無ければ undefined（ファイルを消す）
 */
export function modulesLoadContent(settings: ProjectVirtualization[]): string | undefined {
  const names = new Set<string>();
  for (const v of settings) if (v.kvm) for (const m of [...ALWAYS_MODULES, ...v.modules]) names.add(m);
  if (names.size === 0) return undefined;
  return [
    "# banto が書く（仮想化の実験。この実行場所の Project が /dev/kvm を見せるときに読むモジュール）。手で変えても次に書き直す",
    ...[...names].sort(),
    "",
  ].join("\n");
}

/** 2MiB の hugepages の1つ */
export const HUGEPAGE_BYTES = 2 * 1024 ** 2;
/** 1つの Project の hugepages の数の上限（壊れた値を弾くだけ。本当の上限はサーバのメモリの半分） */
const MAX_HUGEPAGES = 1 << 20;

/** Project の設定 → コンテナに付けるもの */
function specOf(v: ProjectVirtualization): ContainerVirtualization {
  return { kvm: v.kvm, hugepagesBytes: v.hugepages * HUGEPAGE_BYTES };
}

/** `/proc/meminfo` から、メモリの全体・hugepages の確保した数・既定の大きさ */
export function parseMeminfo(text: string): { totalKiB: number; hugepagesTotal: number; hugepageKiB: number } | undefined {
  const field = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(text)?.[1]);
  const v = { totalKiB: field("MemTotal"), hugepagesTotal: field("HugePages_Total"), hugepageKiB: field("Hugepagesize") };
  return Object.values(v).every((x) => Number.isFinite(x)) ? v : undefined;
}

async function readMeminfo(vm: VmAccess): Promise<NonNullable<ReturnType<typeof parseMeminfo>>> {
  const r = await vm.run(["cat", "/proc/meminfo"]);
  const m = r.code === 0 ? parseMeminfo(r.stdout) : undefined;
  if (!m) throw new RemoteRuntimeError(502, `サーバのメモリ（/proc/meminfo）を読めませんでした：${r.stderr.trim() || `終了コード ${r.code}`}`);
  return m;
}

/**
 * **そのコンテナが使っている hugepages（バイト）**：中の cgroup の `hugetlb.2MB.current`（cgroup 名前空間でコンテナの枠が根に
 * 見える）。無い・動いていなければ 0。動いているのに読めなければ断る（使っていないと決めつけない——規則2）
 */
async function hugepagesInUse(incus: ProjectContainers, vm: VmAccess, container: string): Promise<number> {
  if ((await incus.state(container))?.status !== "Running") return 0;
  const r = await vm.run(["incus", "exec", container, "--", "cat", "/sys/fs/cgroup/hugetlb.2MB.current"]);
  const n = Number(r.stdout.trim());
  if (r.code !== 0 || !/^\d+$/.test(r.stdout.trim())) {
    throw new RemoteRuntimeError(502, `コンテナが hugepages を使っているか読めませんでした：${r.stderr.trim() || r.stdout.trim() || `終了コード ${r.code}`}`);
  }
  return n;
}

/** VM のユーザーとして Incus を呼ぶ（仮想化の実験の装置を付け外す） */
function containersOver(vm: VmAccess): ProjectContainers {
  return new ProjectContainers((args, opts) => vm.run(["incus", ...args], opts), DEFAULT_TIMEOUTS);
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
  /** Project の設定に書く（人が押して、向こうを整えたあと） */
  saveSettings(projectId: string, v: ProjectVirtualization): Promise<void>;
  /** Project（無ければ undefined）。`runtime` は Project の記録の実行場所の印 */
  project(projectId: string): { id: string; name: string; runtime?: string } | undefined;
  /** その Project の「中で Docker を使う」（`container.nesting`）。変えない——画面が聞くのに返すだけ */
  nestingOf(projectId: string): boolean;
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
      const incus = containersOver(vm);
      const containers = this.deps.projectsOn(runtimeIdOf(runtimeName)).map((p) => containerNameFor(p.id));
      if (allowed) {
        await root(vm, allowUnixCharCommand(vm.uid), ran, "区画に unix-char の装置を許す");
        // 許した実行場所の全コンテナに hugepages の上限 0 を書く（付けないと制限が無い。まだ無いコンテナは作るときに書く）
        for (const name of containers) await incus.applyVirtualization(name, { kvm: false, hugepagesBytes: 0 });
        return;
      }
      // hugepages の上限を外す（どの Project も 0 に戻してある）
      for (const name of containers) await incus.applyVirtualization(name, null);
      // 足した項目だけを unset する（無いものは触らない——何度流しても同じ）
      const config = await projectConfigOf(vm);
      if (config[UNIX_CHAR_KEY] !== undefined) await root(vm, unsetUnixCharCommand(vm.uid), ran, "区画の unix-char を戻す");
      await root(vm, { args: ["rm", "-f", MODULES_LOAD_FILE, HUGEPAGES_SYSCTL_FILE] }, ran, "再起動で戻す設定を消す");
    });
    if (Boolean(r.virtualization) !== allowed) await this.deps.recordAllowed(runtimeName, allowed);
    return { warnings: [], ran };
  }

  /**
   * **Project の「/dev/kvm を見せる」を変える**（人が押した。v4-security.md §1「`containers` で仮想化の実験」の 2.）。オン：
   * `sudo -n modprobe vhost_net` と人が足したモジュールを読み、`/etc/modules-load.d/banto.conf` をその実行場所の全 Project（閉じた
   * ものも）の名前の和で書き直し（`tee` に標準入力、空なら消す）、コンテナに /dev/kvm と /dev/vhost-net を足す（動いていても
   * 起こし直さない）。オフ：装置を外してから書き直す（読み込んだモジュールは抜かない——ほかの Project が使っているかもしれない）。
   * 「中で Docker を使う」は変えない（返すだけ——画面が一緒に入れるか聞く）。識別子は Project id だけを使う
   */
  async setKvm(projectId: string, input: { enabled: boolean; modules?: unknown }): Promise<VirtualizationResult & { kvm: boolean; modules: string[]; nesting: boolean }> {
    const { runtimeName } = this.mustAllowedProject(projectId);
    const cur = this.deps.settingsOf(projectId);
    const modules = input.modules === undefined ? cur.modules : parseModuleNames(input.modules);
    const next: ProjectVirtualization = { ...cur, kvm: input.enabled, modules };
    const warnings: string[] = [];
    if (next.kvm && modules.includes(BRIDGE_NETFILTER)) {
      warnings.push(
        `${BRIDGE_NETFILTER} はサーバのブリッジ全部の通り方を変えます（ブリッジを通るものが iptables・nftables を通るようになる）。` +
          "同じサーバのほかの Project と、サーバそのもののネットワークにも効きます。外しても読み込んだままです",
      );
    }
    const container = containerNameFor(projectId);
    const ran: RanCommand[] = [];
    await this.deps.withVm(runtimeName, async (vm) => {
      const incus = containersOver(vm);
      if (next.kvm) {
        // 先に vhost_net を読む——/dev/vhost-net がサーバに無いと装置を足せない
        for (const m of [...ALWAYS_MODULES, ...modules]) await root(vm, { args: ["modprobe", m] }, ran, `モジュール ${m} を読む`);
      } else {
        await incus.applyVirtualization(container, specOf(next));
      }
      await this.rewriteModulesLoad(vm, runtimeName, projectId, next, ran);
      await this.deps.saveSettings(projectId, next);
      if (next.kvm) await incus.applyVirtualization(container, specOf(next));
    });
    return { warnings, ran, kvm: next.kvm, modules, nesting: this.deps.nestingOf(projectId) };
  }

  /** その Project のコンテナに付ける設定（実行場所が許していなければ null——付いていれば外す） */
  containerSpecOf(runtimeName: string, projectId: string): ContainerVirtualization | null {
    if (!this.deps.runtime(runtimeName)?.virtualization) return null;
    return specOf(this.deps.settingsOf(projectId));
  }

  /**
   * **その実行場所で確保した hugepages の合計（バイト）**。hugepages はメモリの cgroup に数えないので、コンテナのメモリの上限の
   * 計算からこれを引く（v4-security.md §1「`containers` で仮想化の実験」の 2. の運用）。許していなければ 0
   */
  hugepagesReservedBytes(runtimeName: string): number {
    if (!this.deps.runtime(runtimeName)?.virtualization) return 0;
    return this.hugepagesTotal(runtimeName) * HUGEPAGE_BYTES;
  }

  /**
   * **Project の hugepages の数を変える**（人が押した。2MiB の数）。その実行場所の合計を求め、サーバのメモリの半分を越えるなら断る。
   * 減らすとき、その Project が使っている（コンテナの hugetlb の使用中がある）なら「止めてから」と断る。通れば
   * `sudo -n sysctl -w vm.nr_hugepages=<合計>` と `/etc/sysctl.d/90-banto-hugepages.conf` を合計で書き直し（tee。0 なら消す）、
   * 確保できた数を読んで足りなければ言い、コンテナの `limits.hugepages.2MB` を N×2MiB にする。合計が変わったら、同じ実行場所の
   * 動いているコンテナのメモリの上限を、合計を引いて引き直す。hugetlbfs のマウントは作らない（memfd で使う）
   */
  async setHugepages(projectId: string, count: unknown): Promise<VirtualizationResult & { hugepages: number; total: number; allocated: number }> {
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > MAX_HUGEPAGES) {
      throw new RemoteRuntimeError(400, `hugepages の数は 0 から ${MAX_HUGEPAGES} までの整数で渡してください`);
    }
    const { runtimeName } = this.mustAllowedProject(projectId);
    const cur = this.deps.settingsOf(projectId);
    const next: ProjectVirtualization = { ...cur, hugepages: count };
    const before = this.hugepagesTotal(runtimeName);
    const total = before - cur.hugepages + count;
    const container = containerNameFor(projectId);
    const ran: RanCommand[] = [];
    const warnings: string[] = [];
    let allocated = 0;
    await this.deps.withVm(runtimeName, async (vm) => {
      const incus = containersOver(vm);
      const mem = await readMeminfo(vm);
      if (mem.hugepageKiB !== HUGEPAGE_BYTES / 1024) {
        throw new RemoteRuntimeError(409, `サーバの既定の hugepages の大きさが 2MiB ではありません（${mem.hugepageKiB} kB）。vm.nr_hugepages では 2MiB の数を決められません`);
      }
      if (total * HUGEPAGE_BYTES > (mem.totalKiB * 1024) / 2) {
        throw new RemoteRuntimeError(
          409,
          `hugepages の合計（${total} 個＝${(total * 2) / 1024} GiB。この実行場所の全 Project の和）がサーバのメモリ（${Math.floor(mem.totalKiB / 1024 ** 2)} GiB）の半分を越えます`,
          { code: "hugepages-too-many" },
        );
      }
      if (count < cur.hugepages) {
        const inUse = await hugepagesInUse(incus, vm, container);
        if (inUse > 0) {
          throw new RemoteRuntimeError(
            409,
            `この Project のコンテナは hugepages を使っています（${Math.ceil(inUse / HUGEPAGE_BYTES)} 個）。使っているもの（qemu 等）を止めてから減らしてください`,
            { code: "hugepages-in-use" },
          );
        }
        // 先に上限を下げる（その間にコンテナが新しく取らない）
        await incus.applyVirtualization(container, specOf(next));
      }
      await root(vm, { args: ["sysctl", "-w", `vm.nr_hugepages=${total}`] }, ran, "サーバの hugepages を合計に揃える");
      if (total > 0) {
        const content = `# banto が書く（仮想化の実験。この実行場所の Project の hugepages の合計）。手で変えても次に書き直す\nvm.nr_hugepages = ${total}\n`;
        await root(vm, { args: ["tee", HUGEPAGES_SYSCTL_FILE], input: async () => content, display: `sudo tee ${HUGEPAGES_SYSCTL_FILE}（vm.nr_hugepages = ${total}）` }, ran, "再起動でも hugepages を戻す");
      } else {
        await root(vm, { args: ["rm", "-f", HUGEPAGES_SYSCTL_FILE] }, ran, "再起動で hugepages を戻す設定を消す");
      }
      allocated = (await readMeminfo(vm)).hugepagesTotal;
      if (allocated < total) {
        warnings.push(
          `hugepages は ${total} 個頼みましたが、確保できたのは ${allocated} 個です（サーバのメモリが断片化していると揃わないことがあります）。` +
            "hugepages が足りないので、使うものが起きられないことがあります",
        );
      }
      await this.deps.saveSettings(projectId, next);
      if (count >= cur.hugepages) await incus.applyVirtualization(container, specOf(next));
      if (total !== before) await this.reapplyMemoryLimits(vm, incus, runtimeName, mem.totalKiB * 1024 - total * HUGEPAGE_BYTES);
    });
    return { warnings, ran, hugepages: count, total, allocated };
  }

  /** その実行場所の全 Project（閉じたものも）の hugepages の和（数） */
  private hugepagesTotal(runtimeName: string): number {
    return this.deps.projectsOn(runtimeIdOf(runtimeName)).reduce((sum, p) => sum + this.deps.settingsOf(p.id).hugepages, 0);
  }

  /** 同じ実行場所の動いているコンテナのメモリの上限を、hugepages の合計を引いたメモリで引き直す（sudo は要らない） */
  private async reapplyMemoryLimits(vm: VmAccess, incus: ProjectContainers, runtimeName: string, memoryBytes: number): Promise<void> {
    const nproc = await vm.run(["nproc"]);
    const cpus = Number(nproc.stdout.trim());
    if (nproc.code !== 0 || !Number.isFinite(cpus) || cpus <= 0) throw new RemoteRuntimeError(502, `VM の CPU の数を読めませんでした：${nproc.stderr.trim() || nproc.stdout.trim()}`);
    const limits = defaultContainerLimits({ cpus, memoryBytes });
    for (const p of this.deps.projectsOn(runtimeIdOf(runtimeName))) {
      const name = containerNameFor(p.id);
      const st = await incus.state(name);
      // 仕事の組の天井は中のユーザーの systemd に置く——中の番号はコンテナごと（まだ付け替えていなければ前の番号）
      const ids = { uid: vm.uid, gid: vm.gid, inside: { uid: vm.uid, gid: vm.gid }, legacyInside: LEGACY_INSIDE_IDS };
      if (st?.status === "Running") await incus.applyLimits(name, limits, effectiveInsideIds(st.config, ids).uid);
    }
  }

  /** 画面に出す様子（その Project で使えるか・今の設定） */
  describe(projectId: string): ProjectVirtualization & { available: boolean; reason?: string } {
    const settings = this.deps.settingsOf(projectId);
    try {
      this.mustAllowedProject(projectId);
      return { ...settings, available: true };
    } catch (err) {
      return { ...settings, available: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /** modules-load.d のファイルを、その実行場所の全 Project（閉じたものも）の名前の和で書き直す。空なら消す */
  private async rewriteModulesLoad(vm: VmAccess, runtimeName: string, projectId: string, next: ProjectVirtualization, ran: RanCommand[]): Promise<void> {
    const all = this.deps.projectsOn(runtimeIdOf(runtimeName)).filter((p) => p.id !== projectId).map((p) => this.deps.settingsOf(p.id));
    const content = modulesLoadContent([...all, next]);
    if (content === undefined) await root(vm, { args: ["rm", "-f", MODULES_LOAD_FILE] }, ran, "再起動で読むモジュールの一覧を消す");
    else await root(vm, { args: ["tee", MODULES_LOAD_FILE], input: async () => content, display: `sudo tee ${MODULES_LOAD_FILE}（${content.split("\n").filter((l) => l && !l.startsWith("#")).join("・")}）` }, ran, "再起動で読むモジュールの一覧を書く");
  }

  /** 仮想化の実験を許した `containers` の実行場所の Project か（でなければ断る） */
  private mustAllowedProject(projectId: string): { runtimeName: string } {
    const project = this.deps.project(projectId);
    if (!project) throw new RemoteRuntimeError(404, "Project がありません");
    const runtimeName = remoteNameOf(project.runtime);
    const r = runtimeName ? this.deps.runtime(runtimeName) : undefined;
    if (!runtimeName || !r || r.mode !== "containers") {
      throw new RemoteRuntimeError(409, "仮想化の実験は、別のサーバの Project ごとのコンテナ（containers）の Project だけです");
    }
    if (!r.virtualization) {
      throw new RemoteRuntimeError(409, `実行場所「${runtimeName}」は仮想化の実験を許していません——先に実行場所の設定で許してください`, {
        code: "virtualization-not-allowed",
      });
    }
    return { runtimeName };
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
