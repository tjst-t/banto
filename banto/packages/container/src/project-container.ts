// Project ごとのコンテナを作り・起こし・止め・消す（決定・2026-09-25、`docs/specs/v4-security.md` §1、
// `docs/tasks.json` container-lifecycle）。形は PoC 09（`poc/09-project-container/README.md`）で確かめたもの：
//
// - **Project の根を同じ絶対パスでマウント**（Shell と FileSystem が同じ場所を同じ名前で指す）
// - **ファイルの持ち主を揃える**：中の uid ＝ホストの uid（`raw.idmap`）。中の root はホストでは一般ユーザー
// - banto の Module のコードは**読み取り専用**でマウント。node はホストの実行ファイルを中に置く
//   （権限を絞った区画はホームの外をマウントできないので、`/usr/local/bin/node` はマウントできない）
// - **入れ子（中で Docker）は要る Project だけ**——許したコンテナだけ `/proc`・`/sys` の保護が外れる
// - **止めるのを待ちすぎない**：上限を過ぎたら強制停止する
//
// **Incus を呼ぶときは必ず時間の上限を付ける**。`incus init` が返らなかったことがあった（原因は標準入力——
// `incus.ts`）。上限を過ぎたら黙って再試行せず、失敗として返す（規則2・6）。

import { networkInterfaces } from "node:os";
import type { RunIncus } from "./incus.js";
import { BANTO_POOL } from "./prereqs.js";

export interface ProjectContainerSpec {
  /**
   * コンテナの名前の元（Project の id。banto 全体用のコンテナは `instanceContainerId(owner)`）。
   * 名前は `containerNameFor(id)`
   */
  projectId: string;
  /**
   * Project の根（realpath 済み）。中にも同じパスで見せる。**banto 全体用のコンテナには無い**
   * （外から足した banto 全体の Module を入れる。見せるのは Module の置き場だけ）
   */
  root?: string;
  /** banto のコードの置き場（モノレポの根）。中にも同じパスで、読み取り専用 */
  bantoDir: string;
  /** 中に置く node の実行ファイル（ホストのもの） */
  nodePath: string;
  /** 中の node の版（`process.version`）。違えば置き直す */
  nodeVersion: string;
  /** 中で Docker を使うか（`security.nesting`） */
  nesting: boolean;
  /** 例：`images:ubuntu/24.04` */
  image: string;
  /**
   * どの banto のコンテナか（banto のデータの置き場）。札（`user.banto.owner`）として付け、片づけで引く——
   * E2E や検証用の banto（別の置き場）が作ったものと、人の banto のものを混ぜない
   */
  owner: string;
  /**
   * ホストの uid/gid——中の同じ番号に対応させる。**gid はユーザーの登録情報（`os.userInfo().gid`）から取る**：
   * `sg incus` で起こしたプロセスは主グループが incus に変わり、`process.getgid()` はそれを返す（踏んだ）
   */
  uid: number;
  gid: number;
}

export interface ContainerTimeouts {
  /** 1回の操作（作る・設定する・起こす） */
  operationMs: number;
  /** 穏やかに止めるのを待つ上限。過ぎたら強制停止 */
  stopSec: number;
  /** 起こしてから中でコマンドが通るまで待つ上限 */
  readyMs: number;
}

export const DEFAULT_TIMEOUTS: ContainerTimeouts = { operationMs: 120_000, stopSec: 20, readyMs: 30_000 };

/** node が中で置かれる場所 */
export const CONTAINER_NODE_PATH = "/usr/local/bin/node";

/** Incus の名前の決まり（英数字とハイフン、先頭は英字、63文字まで）に合わせる */
export function containerNameFor(projectId: string): string {
  const safe = projectId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const name = `banto-${safe}`.slice(0, 63).replace(/-+$/, "");
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`Project の id からコンテナの名前を作れません：${projectId}`);
  return name;
}

/**
 * **banto 全体用のコンテナ**の id（決定・2026-09-25、`docs/specs/v4-security.md` §1）。外から足した banto 全体の
 * Module をここで動かす——banto 本体で動くのは banto 自身のコードだけ。どの banto のものか（データの置き場）で
 * 分ける：E2E や検証用の banto が、人の banto のコンテナを使わない
 */
export function instanceContainerId(owner: string): string {
  let h = 0;
  for (const ch of owner) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
  return `instance-${h.toString(16).padStart(8, "0")}`;
}

interface DiskRequest {
  device: string;
  source: string;
  readonly: boolean;
  resolve(): void;
  reject(err: unknown): void;
}

/** 中の同じ番号に対応させる（uid と gid が同じなら `both` の1行） */
export function idmapFor(uid: number, gid: number): string {
  return uid === gid ? `both ${uid} ${uid}` : `uid ${uid} ${uid}\ngid ${gid} ${gid}`;
}

interface InstanceState {
  status: string;
  config: Record<string, string>;
  devices: Record<string, Record<string, string>>;
  /** 土台（profile）から来たものも含めた装置。どのネットワークに繋がっているかはこちらにしか無い */
  expandedDevices: Record<string, Record<string, string>>;
}

type Device = Record<string, string>;

/** ホストのネットワークインターフェースの IPv4（名前 → アドレス）。試験では差し替える */
export type HostInterfaces = () => Record<string, string[]>;
const hostIPv4Interfaces: HostInterfaces = () =>
  Object.fromEntries(
    Object.entries(networkInterfaces()).map(([name, addrs]) => [
      name,
      (addrs ?? []).filter((a) => a.family === "IPv4" && !a.internal).map((a) => a.address),
    ]),
  );

/**
 * **コンテナに確かに届かない**（無い・この banto のものでない・動いていない・アドレスがまだ無い。追加・2026-09-28）。
 * `containerAddress` はこれと、それ以外の失敗（Incus が答えない・時間切れ＝**分からない**）を分けて投げる
 * ——公開の実装は、前者なら中継をやめ、後者なら今の道に触らない（一時の失敗で全部の公開を 503 にしない）
 */
export class ContainerAddressUnavailable extends Error {}

export class ProjectContainers {
  constructor(
    private readonly run: RunIncus,
    private readonly timeouts: ContainerTimeouts = DEFAULT_TIMEOUTS,
    private readonly interfaces: HostInterfaces = hostIPv4Interfaces,
  ) {}

  private async incus(args: string[], what: string, timeoutMs = this.timeouts.operationMs): Promise<string> {
    const r = await this.run(args, { timeoutMs });
    if (r.code !== 0) {
      const detail = r.stderr.trim() || `終了コード ${r.code}`;
      throw new Error(`${what}に失敗しました：${detail}`);
    }
    return r.stdout;
  }

  private project: string | undefined;
  /**
   * コンテナごとに、設定の書き換えを1本ずつ通す。Incus は同じコンテナへの同時の書き換えを
   * `ETag doesn't match` で断る——Project の Module は並んで起きるので、それぞれが自分の置き場を
   * 足そうとして当たった（E2E で踏んだ・2026-09-25）
   */
  private readonly queues = new Map<string, Promise<unknown>>();
  private serialize<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(name) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.queues.set(name, next.then(() => undefined, () => undefined));
    return next;
  }

  /**
   * いまの区画（権限を絞った使い方では `user-<uid>`）。ほかのコマンドは CLI が自動で付けるが、
   * `incus query` は付けない（`default` を見に行って「権限が無い」と断られる——実測）
   */
  private async currentProject(): Promise<string> {
    if (this.project === undefined) this.project = (await this.incus(["project", "get-current"], "いまの区画を引くの")).trim();
    return this.project;
  }

  /** 無ければ undefined（「無い」と「読めない」を混ぜない） */
  async state(name: string): Promise<InstanceState | undefined> {
    const project = encodeURIComponent(await this.currentProject());
    const r = await this.run(["query", `/1.0/instances/${name}?project=${project}`], { timeoutMs: this.timeouts.operationMs });
    if (r.code !== 0) {
      if (/not found/i.test(r.stderr)) return undefined;
      throw new Error(`コンテナ ${name} の状態を読めませんでした：${r.stderr.trim() || `終了コード ${r.code}`}`);
    }
    const j = JSON.parse(r.stdout) as {
      status: string;
      config: Record<string, string>;
      devices: Record<string, Device>;
      expanded_devices?: Record<string, Device>;
    };
    return { status: j.status, config: j.config ?? {}, devices: j.devices ?? {}, expandedDevices: j.expanded_devices ?? {} };
  }

  /**
   * **装置をまとめて1回で足す**（追加・2026-09-26、実測）。`incus config device add` は1回に1つで、
   * 1回 60〜75 ms。新しい Project では Module の置き場まで含めて5〜8回が直列に並んでいた。
   * REST の PATCH は装置の表を**差分として混ぜる**（既にあるものは残る——実測）ので、1回（約 85 ms）で済む
   */
  private async addDevices(name: string, devices: Record<string, Device>, what: string): Promise<void> {
    if (Object.keys(devices).length === 0) return;
    const project = encodeURIComponent(await this.currentProject());
    await this.incus(
      ["query", "-X", "PATCH", `/1.0/instances/${name}?project=${project}`, "--data", JSON.stringify({ devices })],
      what,
    );
  }

  /**
   * 無ければ作り、設定を宣言に合わせ、起こして中でコマンドが通るまで待つ。**道具を入れた状態は残す**
   * （作り直さない）。返すのはコンテナの名前
   */
  async ensure(spec: ProjectContainerSpec): Promise<{ name: string; created: boolean }> {
    const name = containerNameFor(spec.projectId);
    return this.serialize(name, () => this.ensureNow(name, spec));
  }

  private async ensureNow(name: string, spec: ProjectContainerSpec): Promise<{ name: string; created: boolean }> {
    let st = await this.state(name);
    const created = st === undefined;
    if (!st) {
      await this.incus(
        [
          "init", spec.image, name, "--storage", BANTO_POOL,
          "-c", `raw.idmap=${idmapFor(spec.uid, spec.gid)}`,
          "-c", `security.nesting=${spec.nesting}`,
          "-c", `user.banto.project=${spec.projectId}`,
          "-c", `user.banto.owner=${spec.owner}`,
        ],
        `コンテナ ${name} を作るの`,
      );
      st = await this.state(name);
      if (!st) throw new Error(`コンテナ ${name} を作ったはずが見つかりません`);
    }

    // 宣言に合わせる（コードの置き場・根が変わった・入れ子の要否が変わった）
    let needsRestart = false;
    // **banto のコードの置き場も付け直す**（改訂・2026-09-26）。以前は作るときに1回付けるだけで、置き場を移すと
    // （作業ツリーを変えた等）中の Module が古いパスを探して起きられなかった。作るときもここを通る（付ける所は1つ）
    const toAdd: Record<string, Device> = {};
    const code = st.devices["banto"];
    if (!code || code["source"] !== spec.bantoDir || code["path"] !== spec.bantoDir || code["readonly"] !== "true") {
      if (code) await this.incus(["config", "device", "remove", name, "banto"], "古い banto のコードの置き場を外すの");
      toAdd["banto"] = { type: "disk", source: spec.bantoDir, path: spec.bantoDir, readonly: "true" };
    }
    const project = st.devices["project"];
    if (spec.root && (!project || project["source"] !== spec.root || project["path"] !== spec.root)) {
      if (project) await this.incus(["config", "device", "remove", name, "project"], "古い Project の根を外すの");
      toAdd["project"] = { type: "disk", source: spec.root, path: spec.root };
    }
    await this.addDevices(name, toAdd, "banto のコードと Project の根をマウントするの");
    if ((st.config["security.nesting"] ?? "false") !== String(spec.nesting)) {
      await this.incus(["config", "set", name, `security.nesting=${spec.nesting}`], "入れ子の設定を変えるの");
      // AppArmor のプロファイルは起動のときに作られる——動いているなら起こし直さないと効かない
      needsRestart = st.status === "Running";
    }

    if (needsRestart) await this.stop(name);
    if (needsRestart || st.status !== "Running") await this.incus(["start", name], `コンテナ ${name} を起こすの`);
    await this.waitReady(name);
    await this.ensureNode(name, spec);
    return { name, created };
  }

  /** 中でコマンドが通るまで待つ（起こした直後は init がまだ立ち上がっていない） */
  private async waitReady(name: string): Promise<void> {
    const deadline = Date.now() + this.timeouts.readyMs;
    let last = "";
    while (Date.now() < deadline) {
      const r = await this.run(["exec", name, "--", "true"], { timeoutMs: 10_000 });
      if (r.code === 0) return;
      last = r.stderr.trim();
      await new Promise((res) => setTimeout(res, 300));
    }
    throw new Error(`コンテナ ${name} が ${this.timeouts.readyMs / 1000} 秒で使えるようになりませんでした：${last}`);
  }

  /** 中の node をホストと同じ版にする（版が違えば置き直す） */
  private async ensureNode(name: string, spec: ProjectContainerSpec): Promise<void> {
    const r = await this.run(["exec", name, "--", CONTAINER_NODE_PATH, "--version"], { timeoutMs: 10_000 });
    if (r.code === 0 && r.stdout.trim() === spec.nodeVersion) return;
    await this.incus(["file", "push", spec.nodePath, `${name}${CONTAINER_NODE_PATH}`, "--mode", "0755"], "node を中に置くの");
  }

  /**
   * ホストのフォルダを中の同じパスに見せる（Module の置き場など）。既にあれば何もしない。
   *
   * **同時に来た分はまとめて1回で足す**（改訂・2026-09-26、実測）。Project の Module は並んで起き、
   * それぞれが自分の置き場を頼むので、以前は「読む＋足す」（約 0.1 秒）が Module の数だけ直列に並んでいた。
   * 書き換えを1本ずつ通す決まり（`serialize`）の順番待ちのあいだに来た頼みを束ね、読む1回・足す1回で済ませる
   */
  async ensureDisk(name: string, device: string, source: string, opts: { readonly?: boolean } = {}): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let batch = this.pendingDisks.get(name);
      if (!batch) {
        const fresh: DiskRequest[] = [];
        batch = fresh;
        this.pendingDisks.set(name, fresh);
        void this.serialize(name, async () => {
          // 始まったら束を閉じる——ここから先に来た頼みは次の束になる
          if (this.pendingDisks.get(name) === fresh) this.pendingDisks.delete(name);
          await this.applyDisks(name, fresh);
        });
      }
      batch.push({ device, source, readonly: Boolean(opts.readonly), resolve, reject });
    });
  }

  private readonly pendingDisks = new Map<string, DiskRequest[]>();

  private async applyDisks(name: string, batch: DiskRequest[]): Promise<void> {
    let st: InstanceState | undefined;
    try {
      st = await this.state(name);
      if (!st) throw new Error(`コンテナ ${name} がありません`);
    } catch (err) {
      for (const r of batch) r.reject(err);
      return;
    }
    const toAdd: Record<string, Device> = {};
    const adding: DiskRequest[] = [];
    for (const r of batch) {
      const cur = st.devices[r.device];
      const ro = String(r.readonly);
      if (cur && cur["source"] === r.source && cur["path"] === r.source && (cur["readonly"] ?? "false") === ro) {
        r.resolve();
        continue;
      }
      try {
        if (cur && !(r.device in toAdd)) await this.incus(["config", "device", "remove", name, r.device], `${r.device} を外すの`);
      } catch (err) {
        r.reject(err);
        continue;
      }
      toAdd[r.device] = { type: "disk", source: r.source, path: r.source, ...(r.readonly ? { readonly: "true" } : {}) };
      adding.push(r);
    }
    if (adding.length === 0) return;
    try {
      await this.addDevices(name, toAdd, `${adding.map((r) => r.source).join("・")} をマウントするの`);
      for (const r of adding) r.resolve();
    } catch (err) {
      if (adding.length === 1) {
        adding[0]!.reject(err);
        return;
      }
      // **束ごと断られたら、1つずつ足し直して悪い1つだけを落とす**——PATCH は全部か無しかなので、
      // 1つの誤りで同じ束の別の Module まで起きられなくなる（束ねる前は1つずつ失敗していた）
      for (const r of adding) {
        try {
          await this.addDevices(name, { [r.device]: toAdd[r.device]! }, `${r.source} をマウントするの`);
          r.resolve();
        } catch (one) {
          r.reject(one);
        }
      }
    }
  }

  /**
   * 中から host に届くアドレス（中の既定の経路の行き先＝ブリッジの host 側）。host の中継はここで待ち受けている。
   *
   * **ブリッジはホスト自身のインターフェース**なので、まずホストの側で読む（改訂・2026-09-26、実測）。
   * 以前は中の経路が引けるまで待っていて、起こした直後は DHCP が済むまで**約 0.4 秒**待たされていた
   * ——新しい Project を開くたびに、その分だけ Module が起きるのが遅れた。同じ値を DHCP を待たずに
   * 得られる。ホストに同じ名前のインターフェースが無い形（ブリッジでないネットワーク等）だけ、中の経路を待つ
   */
  async hostAddress(name: string): Promise<string> {
    const st = await this.state(name);
    const nic = Object.values(st?.expandedDevices ?? {}).find((d) => d["type"] === "nic" && d["network"]);
    const bridge = nic ? this.interfaces()[nic["network"]!] : undefined;
    if (bridge && bridge.length > 0) return bridge[0]!;
    return this.hostAddressFromRoute(name);
  }

  /** 中の既定の経路から読む。**起こした直後は経路がまだ無い**（DHCP が済んでいない——E2E で踏んだ）ので、できるまで待つ（上限つき） */
  private async hostAddressFromRoute(name: string): Promise<string> {
    const deadline = Date.now() + this.timeouts.readyMs;
    let out = "";
    while (Date.now() < deadline) {
      out = await this.incus(["exec", name, "--", "ip", "-4", "route", "show", "default"], "中から host への経路を読むの", 10_000);
      const m = /\bvia\s+(\d+\.\d+\.\d+\.\d+)/.exec(out);
      if (m) return m[1]!;
      await new Promise((res) => setTimeout(res, 300));
    }
    throw new Error(`コンテナ ${name} から host への経路が ${this.timeouts.readyMs / 1000} 秒でできませんでした：${out.trim() || "（既定の経路が無い）"}`);
  }

  /**
   * **host からコンテナに届くアドレス**（ブリッジ上の IPv4。追加・2026-09-27、`docs/specs/v4-modules.md` §4.3 Publish）。
   * DHCP で配られるので変わりうる——**覚えずに毎回読む**（規則3）。
   *
   * 読むのは装置の表の NIC（ネットワークに繋がっているもの）の、中でのインターフェースの名前の global な IPv4 だけ。
   * **推測しない**：その banto のものでない・動いていない・まだアドレスが無い、はそれぞれ理由つきで断る（規則2）
   */
  async containerAddress(name: string, owner: string): Promise<string> {
    const st = await this.state(name);
    if (!st) throw new ContainerAddressUnavailable(`コンテナ ${name} がありません（その Project の Module がまだ一度も起きていない）`);
    if (st.config["user.banto.owner"] !== owner) throw new ContainerAddressUnavailable(`コンテナ ${name} はこの banto のものではありません`);
    if (st.status !== "Running") throw new ContainerAddressUnavailable(`コンテナ ${name} は動いていません（${st.status}）`);
    const nic = Object.entries(st.expandedDevices).find(([, d]) => d["type"] === "nic" && d["network"]);
    if (!nic) throw new ContainerAddressUnavailable(`コンテナ ${name} にネットワークの NIC がありません`);
    // 装置の `name` が中でのインターフェース名。無ければ装置の名前と同じ（Incus の既定）
    const ifname = nic[1]["name"] ?? nic[0];
    const project = encodeURIComponent(await this.currentProject());
    const out = await this.incus(["query", `/1.0/instances/${name}/state?project=${project}`], `コンテナ ${name} のアドレスを読むの`);
    const j = JSON.parse(out) as {
      network?: Record<string, { addresses?: { family?: string; address?: string; scope?: string }[] }> | null;
    };
    const v4 = (j.network?.[ifname]?.addresses ?? []).find((a) => a.family === "inet" && a.scope === "global" && a.address);
    // 動いているがアドレスがまだ無い——前のアドレスは別のコンテナに配られうるので、確かに「届かない」側に数える
    if (!v4) throw new ContainerAddressUnavailable(`コンテナ ${name} の ${ifname} に IPv4 のアドレスがまだありません（DHCP が済んでいない）`);
    return v4.address!;
  }

  /** banto が作ったコンテナと、その札（どの banto のものか）。札の無いもの（人が作ったもの）は入れない */
  async listBanto(): Promise<{ name: string; owner: string }[]> {
    const project = encodeURIComponent(await this.currentProject());
    const r = await this.run(["query", `/1.0/instances?recursion=1&project=${project}`], { timeoutMs: this.timeouts.operationMs });
    if (r.code !== 0) throw new Error(`コンテナの一覧を読めませんでした：${r.stderr.trim() || `終了コード ${r.code}`}`);
    const all = JSON.parse(r.stdout) as { name: string; config?: Record<string, string> }[];
    return all.flatMap((i) => {
      const owner = i.config?.["user.banto.owner"];
      return owner ? [{ name: i.name, owner }] : [];
    });
  }

  /** その banto（`owner`）が作ったコンテナの名前 */
  async listOwned(owner: string): Promise<string[]> {
    return (await this.listBanto()).filter((c) => c.owner === owner).map((c) => c.name);
  }

  /** 穏やかに止め、上限を過ぎたら強制停止する。無い・止まっているなら何もしない */
  async stop(name: string): Promise<void> {
    const st = await this.state(name);
    if (!st || st.status !== "Running") return;
    const r = await this.run(["stop", name, "--timeout", String(this.timeouts.stopSec)], { timeoutMs: (this.timeouts.stopSec + 30) * 1000 });
    if (r.code === 0) return;
    await this.incus(["stop", name, "--force"], `コンテナ ${name} を強制停止するの`);
  }

  /** 消す（中に入れた道具も消える）。無ければ何もしない */
  async remove(name: string): Promise<void> {
    if (!(await this.state(name))) return;
    await this.incus(["delete", name, "--force"], `コンテナ ${name} を消すの`);
  }
}

/**
 * 中でプロセスを起こす `incus exec` の引数（MCP の標準入出力の口にそのまま渡す）。
 * **env は `--env` で渡す**——`incus exec` はホストの環境を引き継がない。値は host の `incus` の argv に載る
 * （ホストの `ps` から、ホストの同じユーザーには見える）が、コンテナの中からは見えない。
 *
 * **作業ディレクトリは `--cwd` に頼らない**：`incus exec --cwd` は、ユーザーを切り替える**前に中の root で**移り、
 * 入れなければ**黙って `/` で動かす**（実測・2026-09-25——ホストのグループが中に対応していないフォルダに、中の
 * root は入れない）。ユーザーを切り替えたあとに自分で `cd` し、入れなければ 126 で止まる（規則2）
 */
export function execInContainer(
  name: string,
  opts: { cwd: string; env: Record<string, string>; uid: number; gid: number },
  command: string,
  args: string[],
): { command: string; args: string[] } {
  const env = Object.entries(opts.env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
  return {
    command: "incus",
    args: [
      "exec", name, "--user", String(opts.uid), "--group", String(opts.gid), ...env, "--",
      "/bin/sh", "-c", 'cd -- "$1" || exit 126; shift; exec "$@"', "banto-cd", opts.cwd, command, ...args,
    ],
  };
}
