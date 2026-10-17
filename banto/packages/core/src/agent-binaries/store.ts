// **エージェントの本体を取ってきて、host の置き場に置く**（決定・2026-10-17、アーキ仕様 §4.1「エージェントの本体を取ってくる」）。
//
// 置き場は `<データ置き場>/agent-binaries/<agent>-<版>-<CPU の種類>-<integrity の頭12>/`（中に実行ファイル1本、0755、版のフォルダは
// 0555）。**全 Project で共有**。使い捨ての作業フォルダ（親の下の `.incoming-*`——rename が同じ device の中で済む）へ落とし、
// **tarball の sha512 を目録の integrity と比べてから**、Node で tar を読んで目録のパスと一致する通常のファイル1件だけを取り出し
// （`tar-extract.ts`）、rename で置く。合わなければ置かずに消して断る（何も残さず、次に使うときにまた試す）。
// 同時に頼まれたら（エージェント・版・CPU の種類）ごとに1本だけ取り、ほかは待たせる

import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { mkdtemp, open } from "node:fs/promises";
import { join } from "node:path";
import {
  agentBinaryDirName,
  agentBinaryFileName,
  integrityOf,
  selectAgentBinary,
  type AgentBinary,
} from "./agent-binaries.js";
import { DEFAULT_PROGRESS_TIMING, SharedProgressTasks, mb, watchProgress, type ProgressListener, type ProgressTiming } from "./progress.js";
import { TarballRefused, extractSingleFile } from "./tar-extract.js";

/** 取れなかった・確かめが合わなかった・目録に無い——理由はそのまま呼び元（AI）に返す */
export class AgentBinaryError extends Error {}

export interface AgentBinaryStoreOptions {
  dataDir: string;
  catalog: readonly AgentBinary[];
  /** この機械（host）の CPU が AVX2 を持つか——この機械のコンテナで使うものはこれで選ぶ */
  hostAvx2: boolean;
  /** 試験だけが差し替える */
  fetch?: typeof fetch;
  timing?: Partial<ProgressTiming>;
  log?: (line: string) => void;
}

/** 置いてある本体1本（host の側のパス） */
export interface PlacedAgentBinary {
  entry: AgentBinary;
  /** 版のフォルダ */
  dir: string;
  /** 実行ファイル */
  file: string;
  sizeBytes: number;
}

/** 設定画面に出す、この機械の様子 */
export interface AgentBinaryStatus {
  agent: string;
  title: string;
  version: string;
  cpu: string;
  present: boolean;
  /** 置いてあるときの大きさ */
  sizeBytes?: number;
  /** まだ無いとき、取ってくるおおよその大きさ */
  approxBytes: number;
}

export class AgentBinaryStore {
  /** 親の `agent-binaries/`（この機械のコンテナには、これを1つの device で同じパスに読み取り専用で見せる） */
  readonly root: string;
  private readonly timing: ProgressTiming;
  private readonly fetching = new SharedProgressTasks<PlacedAgentBinary>();
  private readonly log: (line: string) => void;

  constructor(private readonly opts: AgentBinaryStoreOptions) {
    this.root = join(opts.dataDir, "agent-binaries");
    this.timing = { ...DEFAULT_PROGRESS_TIMING, ...opts.timing };
    this.log = opts.log ?? ((line) => console.log(line));
  }

  get catalog(): readonly AgentBinary[] {
    return this.opts.catalog;
  }

  /** いまの目録にある版のフォルダの名前（ほかは片づける） */
  catalogDirNames(): Set<string> {
    return new Set(this.opts.catalog.map(agentBinaryDirName));
  }

  /**
   * **起きたときに1回**：親を 0755 で作り（core が rename で中に置く。中からは読み取り専用のマウントで書けない）、
   * いまの目録に無い版のフォルダと、前の走行が残した作業フォルダを消す。走っているプロセスは消しても影響を受けない
   */
  init(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o755 });
    chmodSync(this.root, 0o755);
    const keep = this.catalogDirNames();
    for (const name of readdirSync(this.root)) {
      if (keep.has(name)) continue;
      removeTree(join(this.root, name));
      if (!name.startsWith(".incoming-")) this.log(`[host] エージェントの本体の、いまの目録に無い版を消しました（${name}）`);
    }
  }

  /** 目録から、その機械の CPU に合うものを選ぶ。目録に無いエージェントは断る */
  entryFor(agent: string, avx2: boolean): AgentBinary {
    const entry = selectAgentBinary(this.opts.catalog, agent, avx2);
    if (!entry) {
      const known = [...new Set(this.opts.catalog.map((e) => e.agent))];
      throw new AgentBinaryError(`エージェント "${agent}" の本体は目録にありません（目録にあるもの：${known.join(", ") || "なし"}）`);
    }
    return entry;
  }

  /** この機械の CPU 向けのものが置いてあるか（取ってこない） */
  status(agent: string): AgentBinaryStatus {
    const entry = this.entryFor(agent, this.opts.hostAvx2);
    const placed = this.placed(entry);
    return {
      agent,
      title: entry.title,
      version: entry.version,
      cpu: entry.cpu,
      present: placed !== undefined,
      ...(placed ? { sizeBytes: placed.sizeBytes } : {}),
      approxBytes: entry.approxBytes,
    };
  }

  /** 置いてあればそれを、無ければ取ってきて置く。`avx2` は動かす機械の CPU（既定はこの機械） */
  ensure(agent: string, opts: { avx2?: boolean; onProgress?: ProgressListener } = {}): Promise<PlacedAgentBinary> {
    const entry = this.entryFor(agent, opts.avx2 ?? this.opts.hostAvx2);
    const placed = this.placed(entry);
    if (placed) return Promise.resolve(placed);
    return this.fetching.run(agentBinaryDirName(entry), (emit) => this.fetchAndPlace(entry, emit), opts.onProgress);
  }

  private placed(entry: AgentBinary): PlacedAgentBinary | undefined {
    const dir = join(this.root, agentBinaryDirName(entry));
    const file = join(dir, agentBinaryFileName(entry));
    try {
      const st = lstatSync(file);
      if (!st.isFile()) return undefined;
      return { entry, dir, file, sizeBytes: st.size };
    } catch {
      return undefined;
    }
  }

  private async fetchAndPlace(entry: AgentBinary, emit: ProgressListener): Promise<PlacedAgentBinary> {
    const name = agentBinaryDirName(entry);
    mkdirSync(this.root, { recursive: true, mode: 0o755 });
    const work = await mkdtemp(join(this.root, ".incoming-"));
    const started = performance.now();
    try {
      const tgz = join(work, "package.tgz");
      const tarballBytes = await this.download(entry, tgz, emit);
      emit(`${entry.title} の本体を確かめて取り出しています`);
      const staged = join(work, name);
      mkdirSync(staged, { mode: 0o755 });
      const file = join(staged, agentBinaryFileName(entry));
      let size: number;
      try {
        size = await extractSingleFile(tgz, entry.path, file, entry.maxBytes);
      } catch (err) {
        if (err instanceof TarballRefused) throw new AgentBinaryError(`${entry.title} の本体の tarball を開けませんでした：${err.message}`);
        throw err;
      }
      chmodSync(file, 0o755);
      const dest = join(this.root, name);
      try {
        renameSync(staged, dest);
        // 版のフォルダは置いてから 0555 にする（書けないフォルダは親を跨いで rename できない——`..` を書き換えるため）
        chmodSync(dest, 0o555);
      } catch (err) {
        // 別の banto の走行が先に置いていた（同じ中身——名前に integrity が入っている）
        if (!existsSync(dest)) throw err;
      }
      this.log(
        `[host] ${entry.title} の本体を取ってきました（版 ${entry.version}・${entry.cpu}・tarball ${mb(tarballBytes)}MB・実行ファイル ${mb(size)}MB・` +
          `${Math.round(performance.now() - started)}ms）`,
      );
      return this.placed(entry) ?? fail(`${entry.title} の本体を置いたはずの ${dest} にありません`);
    } finally {
      removeTree(work);
    }
  }

  /** tarball を落とし、sha512 を目録と比べる。返すのは tarball の大きさ */
  private async download(entry: AgentBinary, dest: string, emit: ProgressListener): Promise<number> {
    const controller = new AbortController();
    let received = 0;
    let total: number | undefined;
    const watcher = watchProgress({
      timing: this.timing,
      bytes: () => received,
      describe: (b) => `${entry.title} を取ってきています（${mb(b)} / ${total !== undefined ? mb(total) : `約${mb(entry.approxBytes)}`}MB）`,
      report: emit,
      giveUp: (seconds) =>
        controller.abort(new AgentBinaryError(`${entry.title} の本体を取ってこられませんでした——${seconds}秒のあいだ1バイトも進みませんでした`)),
    });
    const hash = createHash("sha512");
    const out = await open(dest, "wx", 0o600);
    try {
      const res = await (this.opts.fetch ?? fetch)(entry.url, { signal: controller.signal }).catch((err: unknown) => {
        throw stalledOr(controller, err, `${entry.title} の本体を取ってこられませんでした（${entry.url}）`);
      });
      if (!res.ok || !res.body) throw new AgentBinaryError(`${entry.title} の本体を取ってこられませんでした（${entry.url} が ${res.status} を返しました）`);
      const length = Number(res.headers.get("content-length"));
      if (Number.isFinite(length) && length > 0) total = length;
      if (total !== undefined && total > entry.maxBytes) {
        throw new AgentBinaryError(`${entry.title} の本体の tarball が上限（${mb(entry.maxBytes)}MB）より大きい（${mb(total)}MB）`);
      }
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          received += chunk.length;
          if (received > entry.maxBytes) {
            throw new AgentBinaryError(`${entry.title} の本体の tarball が上限（${mb(entry.maxBytes)}MB）を越えました`);
          }
          hash.update(chunk);
          await out.write(chunk);
        }
      } catch (err) {
        throw err instanceof AgentBinaryError ? err : stalledOr(controller, err, `${entry.title} の本体を取ってくる途中で切れました`);
      }
    } finally {
      watcher.stop();
      await out.close();
    }
    const got = integrityOf(hash);
    if (got !== entry.integrity) {
      throw new AgentBinaryError(
        `${entry.title} の本体の確かめが合いませんでした（目録の integrity ${entry.integrity.slice(0, 20)}…・取ってきたもの ${got.slice(0, 20)}…）。置かずに消しました`,
      );
    }
    return received;
  }
}

/** 進まずにやめたならその理由、ほかは元の理由を添える */
function stalledOr(controller: AbortController, err: unknown, what: string): Error {
  if (controller.signal.aborted && controller.signal.reason instanceof AgentBinaryError) return controller.signal.reason;
  const cause = err instanceof Error ? ((err.cause as Error | undefined)?.message ?? err.message) : String(err);
  return new AgentBinaryError(`${what}：${cause}`);
}

function fail(message: string): never {
  throw new AgentBinaryError(message);
}

/** 版のフォルダは 0555 なので、書けるようにしてから消す */
function removeTree(path: string): void {
  try {
    const st = statSync(path);
    if (st.isDirectory()) {
      chmodSync(path, 0o755);
      for (const child of readdirSync(path)) {
        const p = join(path, child);
        if (lstatSync(p).isDirectory()) chmodSync(p, 0o755);
      }
    }
  } catch {
    // 無い
  }
  rmSync(path, { recursive: true, force: true });
}
