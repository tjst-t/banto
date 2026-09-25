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

import type { RunIncus } from "./incus.js";

export interface ProjectContainerSpec {
  projectId: string;
  /** Project の根（realpath 済み）。中にも同じパスで見せる */
  root: string;
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

/** 中の同じ番号に対応させる（uid と gid が同じなら `both` の1行） */
export function idmapFor(uid: number, gid: number): string {
  return uid === gid ? `both ${uid} ${uid}` : `uid ${uid} ${uid}\ngid ${gid} ${gid}`;
}

interface InstanceState {
  status: string;
  config: Record<string, string>;
  devices: Record<string, Record<string, string>>;
}

export class ProjectContainers {
  constructor(
    private readonly run: RunIncus,
    private readonly timeouts: ContainerTimeouts = DEFAULT_TIMEOUTS,
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
    const j = JSON.parse(r.stdout) as { status: string; config: Record<string, string>; devices: Record<string, Record<string, string>> };
    return { status: j.status, config: j.config ?? {}, devices: j.devices ?? {} };
  }

  /**
   * 無ければ作り、設定を宣言に合わせ、起こして中でコマンドが通るまで待つ。**道具を入れた状態は残す**
   * （作り直さない）。返すのはコンテナの名前
   */
  async ensure(spec: ProjectContainerSpec): Promise<{ name: string; created: boolean }> {
    const name = containerNameFor(spec.projectId);
    let st = await this.state(name);
    const created = st === undefined;
    if (!st) {
      await this.incus(
        [
          "init", spec.image, name,
          "-c", `raw.idmap=${idmapFor(spec.uid, spec.gid)}`,
          "-c", `security.nesting=${spec.nesting}`,
          "-c", `user.banto.project=${spec.projectId}`,
        ],
        `コンテナ ${name} を作るの`,
      );
      await this.incus(["config", "device", "add", name, "project", "disk", `source=${spec.root}`, `path=${spec.root}`], "Project の根をマウントするの");
      await this.incus(["config", "device", "add", name, "banto", "disk", `source=${spec.bantoDir}`, `path=${spec.bantoDir}`, "readonly=true"], "banto のコードをマウントするの");
      st = await this.state(name);
      if (!st) throw new Error(`コンテナ ${name} を作ったはずが見つかりません`);
    }

    // 宣言に合わせる（根が変わった・入れ子の要否が変わった）
    let needsRestart = false;
    const project = st.devices["project"];
    if (!project || project["source"] !== spec.root || project["path"] !== spec.root) {
      if (project) await this.incus(["config", "device", "remove", name, "project"], "古い Project の根を外すの");
      await this.incus(["config", "device", "add", name, "project", "disk", `source=${spec.root}`, `path=${spec.root}`], "Project の根をマウントするの");
    }
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

  /** ホストのフォルダを中の同じパスに見せる（Module の置き場など）。既にあれば何もしない */
  async ensureDisk(name: string, device: string, source: string, opts: { readonly?: boolean } = {}): Promise<void> {
    const st = await this.state(name);
    if (!st) throw new Error(`コンテナ ${name} がありません`);
    const cur = st.devices[device];
    const ro = String(Boolean(opts.readonly));
    if (cur && cur["source"] === source && cur["path"] === source && (cur["readonly"] ?? "false") === ro) return;
    if (cur) await this.incus(["config", "device", "remove", name, device], `${device} を外すの`);
    await this.incus(["config", "device", "add", name, device, "disk", `source=${source}`, `path=${source}`, ...(opts.readonly ? ["readonly=true"] : [])], `${source} をマウントするの`);
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
