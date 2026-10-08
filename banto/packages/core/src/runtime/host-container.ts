// **実行場所の1つ目——この host のコンテナ**（決定・2026-09-25、`docs/specs/v4-security.md` §1）。
//
// Project ごとに1台、外から足した banto 全体の Module 用に1台。Project の根・banto のコード（読み取り専用）・
// Module の置き場・取ってきた配布物（読み取り専用）を **host と同じパスで**マウントするので、host の側のパスと
// 実行場所の側のパスは同じ。Incus を呼ぶのはこのファイル（と `@banto/container`）だけ

import { existsSync, mkdirSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  CONTAINER_NODE_PATH,
  ContainerAddressUnavailable,
  ProjectContainers,
  checkContainerPrereqs,
  containerNameFor,
  ensureBaseImage,
  execInContainer,
  hostPrereqDeps,
  instanceContainerId,
  runIncus,
  type ContainerLimits,
  type PrereqResult,
} from "@banto/container";
import { syncShellHome } from "../modules/shell-home.js";
import { SingleFlight } from "../modules/single-flight.js";
import {
  RuntimeStopError,
  type PlaceAddress,
  type PreparedPlace,
  type Runtime,
  type RuntimePlace,
  type RuntimeProcess,
} from "./runtime.js";

export interface HostContainerRuntimeOptions {
  /** banto のデータの置き場。コンテナの札（`user.banto.owner`）にもなる */
  dataDir: string;
  /** host が待ち受けているポート（中からはブリッジの host 側のアドレスで届く） */
  port: number;
  /** banto のコードの置き場（モノレポの根）。中にも同じパスで、読み取り専用 */
  bantoDir: string;
  /** その箱の資源の上限（この host の資源と、banto 全体・Project ごとの設定から計算したもの） */
  limitsFor(placeId: string): ContainerLimits;
  /** Shell のホームへ写す元（既定は人のホーム。E2E だけが差し替える） */
  shellHomeSource?: string;
}

interface ReadyContainer {
  name: string;
  /** 中から host に届くアドレス（ブリッジの host 側）。host は 0.0.0.0 で待ち受けている */
  hostAddress: string;
  root?: string;
  nesting: boolean;
}

/** Module の置き場の中の、鍵の窓口用のフォルダ（0700）。Unix ソケットのパスは短くないと作れないので名前は短く */
function ensureSocketDir(moduleDataDir: string): string {
  const dir = join(moduleDataDir, "s");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** ホストのフォルダを中に見せる口の名前（Incus の装置名。パスから決まる） */
const diskDeviceName = (dir: string) => `m-${createHash("sha256").update(dir).digest("hex").slice(0, 16)}`;

export class HostContainerRuntime implements Runtime {
  readonly instancePlaceId: string;
  private readonly ready = new Map<string, ReadyContainer>();
  private readonly spawns = new SingleFlight<ReadyContainer>();

  /** `create` を使う。直接は試験だけ（Incus を偽物にする） */
  constructor(
    private readonly opts: HostContainerRuntimeOptions,
    /** **閉じ込めはコンテナ**。前提が欠けていれば、コンテナで起こす Module は起こさずに断る（黙って閉じ込め無しで起こさない、規則2） */
    private readonly prereqs: PrereqResult,
    private readonly containers: ProjectContainers = new ProjectContainers(runIncus),
    /** banto の機能が頼る道具（git・ssh・curl・node）を入れた土台——無ければ一度だけ作る */
    private readonly baseImage: () => Promise<string> = () => ensureBaseImage(runIncus),
  ) {
    this.instancePlaceId = instanceContainerId(opts.dataDir);
  }

  static async create(opts: HostContainerRuntimeOptions): Promise<HostContainerRuntime> {
    return new HostContainerRuntime(opts, await checkContainerPrereqs(hostPrereqDeps()));
  }

  describePrerequisites(): string {
    return `コンテナの前提: ${
      this.prereqs.ok
        ? `そろっている（Incus ${this.prereqs.serverVersion}）`
        : this.prereqs.problems.map((p) => `${p.message} 直し方：${p.fix}`).join(" / ")
    }`;
  }

  async prepare(place: RuntimePlace): Promise<PreparedPlace> {
    return this.preparedFrom(await this.ensureContainer(place));
  }

  private async ensureContainer(place: RuntimePlace): Promise<ReadyContainer> {
    const ready = this.ready.get(place.id);
    if (ready && ready.root === place.root && ready.nesting === place.nesting) return ready;
    return this.spawns.run(place.id, async () => {
      if (!this.prereqs.ok) {
        throw new Error(
          "コンテナを用意できません——前提が欠けています：" +
            this.prereqs.problems.map((p) => `${p.message}（直し方：${p.fix}）`).join(" ") +
            " 直したら banto を起動し直してください",
        );
      }
      // gid はユーザーの登録情報から——起動のしかたで主グループが変わっていても、中の同じ番号に揃える
      const { uid, gid } = userInfo();
      const { name } = await this.containers.ensure({
        projectId: place.id,
        ...(place.root ? { root: place.root } : {}),
        bantoDir: this.opts.bantoDir,
        nodePath: process.execPath,
        nodeVersion: process.version,
        nesting: place.nesting,
        image: await this.baseImage(),
        uid,
        gid,
        owner: this.opts.dataDir,
        // 資源の上限（決定・2026-10-02）
        limits: this.opts.limitsFor(place.id),
      });
      const r: ReadyContainer = {
        name,
        hostAddress: await this.containers.hostAddress(name),
        ...(place.root ? { root: place.root } : {}),
        nesting: place.nesting,
      };
      this.ready.set(place.id, r);
      return r;
    });
  }

  private preparedFrom(c: ReadyContainer): PreparedPlace {
    const containers = this.containers;
    const shellHomeSource = this.opts.shellHomeSource;
    return {
      name: c.name,
      // node は中の決まった場所に置いてある（ホストと同じ版）
      nodePath: CONTAINER_NODE_PATH,
      bantoOrigin: `http://${c.hostAddress}:${this.opts.port}`,
      // host と同じパスでマウントしている
      pathInside: (hostPath) => hostPath,
      async prepareModuleDirs({ dataDir, packageDir }) {
        mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        await Promise.all([
          containers.ensureDisk(c.name, diskDeviceName(dataDir), dataDir),
          ...(existsSync(packageDir)
            ? [containers.ensureDisk(c.name, diskDeviceName(packageDir), packageDir, { readonly: true })]
            : []),
        ]);
      },
      // Module の置き場はコンテナに同じパスで見せているので、その中なら host の Vault が立てた ssh-agent に
      // 中から届く（host の /tmp は中から見えない）
      socketDirFor: (moduleDataDir) => ensureSocketDir(moduleDataDir),
      async prepareShellHome(moduleDataDir, files) {
        const home = join(moduleDataDir, "home");
        const resync = (f: readonly string[]) => syncShellHome(home, f, { sourceHome: shellHomeSource });
        return { home, sync: await resync(files), resync };
      },
      processCommand(p: RuntimeProcess) {
        const { uid, gid } = userInfo();
        // 宣言が host の node を名指ししていても、中の決まった場所のものを使う
        const command = p.command === process.execPath ? CONTAINER_NODE_PATH : p.command;
        return execInContainer(c.name, { cwd: p.cwd, uid, gid, env: p.env }, command, p.args);
      },
    };
  }

  forget(placeId: string): void {
    this.ready.delete(placeId);
  }

  async release(placeId: string, opts: { stop: boolean }): Promise<void> {
    const ready = this.ready.get(placeId);
    this.ready.delete(placeId);
    if (!opts.stop || !ready) return;
    await this.containers.stop(ready.name).catch((err: unknown) => {
      throw new RuntimeStopError(ready.name, err instanceof Error ? err.message : String(err));
    });
  }

  // **この banto が作ったものだけ**。確かに届かない（止まっている・無い・他人のもの）は値で返し、
  // 分からない（Incus が答えない）は投げる
  async address(projectId: string): Promise<PlaceAddress> {
    try {
      return { address: await this.containers.containerAddress(containerNameFor(projectId), this.opts.dataDir) };
    } catch (err) {
      if (err instanceof ContainerAddressUnavailable) return { unavailable: err.message };
      throw err;
    }
  }

  // 覚えずに毎回 Incus に聞く——止まっている・無いコンテナは「違う」
  async sourceMatches(projectId: string, remote: string): Promise<boolean> {
    const a = await this.address(projectId);
    return "address" in a && a.address === remote;
  }

  async status(projectId: string): Promise<{ name: string; status: string } | undefined> {
    const name = containerNameFor(projectId);
    const st = await this.containers.state(name);
    return st ? { name, status: st.status } : undefined;
  }

  async applyLimits(placeId: string): Promise<void> {
    // 動いている箱の中の仕事の組の天井も合わせる（uid はその持ち主）
    await this.containers.applyLimits(containerNameFor(placeId), this.opts.limitsFor(placeId), userInfo().uid);
  }

  resourceTargets(): { containerName: string; projectId?: string }[] {
    return [...this.ready].map(([id, r]) => ({
      containerName: r.name,
      ...(id === this.instancePlaceId ? {} : { projectId: id }),
    }));
  }

  placeName(placeId: string): string {
    return containerNameFor(placeId);
  }

  resourceScope(): Promise<string> {
    return this.containers.incusProjectName();
  }
}
