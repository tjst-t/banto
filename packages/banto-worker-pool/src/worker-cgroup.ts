/**
 * 職人1本ごとの **cgroup 隔離**（inc-0066 第2段）。
 *
 * 2026-08-14、職人の1本（`claude` CLI）が 10.72 GiB まで膨らみ、15GiB・swap 無しの VM が
 * kernel の OOM で応答不能になった。第1段（unit への `MemoryMax=9G` ＋ `OOMPolicy=continue`）
 * は「機械ごと落ちる」を「工房の袋の中で落ちる」に変えたが、**どの職人が犯人かは分からず、
 * 健全な職人も巻き添えになる**。第2段はここ——職人1本ずつを別の袋に入れ、
 *
 * - 上限（`memory.max`）を1本ごとに張る（既定 2GiB。実測で健全な1本は約 600MB）
 * - 畳むときは `cgroup.kill` で**協力に依存せず**袋ごと殺す（孫の bash / grep まで届く）
 * - 畳む前に `memory.peak` と `memory.events` を読み、**誰がどれだけ抱えていたか**を残す
 *
 * ## なぜ「書くだけ」で済むのか（D6：依存を増やさない）
 *
 * cgroup v2 の操作は疑似ファイルの読み書きだけで足りる。`systemd-run` も D-Bus も要らない。
 * 触るのは node 標準の `fs` のみ。
 *
 * ## 押さえている cgroup v2 の規則（これを外すと EBUSY で落ちる）
 *
 * 1. **内部ノードにプロセスを置けない**：自分にプロセスを抱えたまま
 *    `cgroup.subtree_control` にコントローラを配ることはできない。
 *    だから工房本体を葉（`main/`）へ先に退かす。
 * 2. **`cgroup.controllers` は「自分の中で使えるもの」**、`cgroup.subtree_control` は
 *    「子に配るもの」。職人の袋に `memory.max` を持たせるには、**親でも祖父でも**
 *    `+memory` を配っておく必要がある。
 * 3. **制限は階層的**：子に緩い値を書いても親（unit の 9GiB）は超えられない。第1段は無傷。
 *
 * ## 隔離できないときは黙って素通りさせない
 *
 * 開発機・コンテナ・CI には委譲された cgroup が無い。そこでも職人は起こせる必要があるが、
 * **「知らないうちに隔離なしで回っていた」を作らない**のが条件（PO 裁定）。
 * `IsolationStatus.mode` が `none` のときは理由が必ず入り、工房はそれを
 * 起動ログ・台帳・番頭から見える一覧の3箇所に出す。
 *
 * I2: 失敗は握りつぶさない。個別の袋を作れなかったときは**その職人を起こさない**
 *     （fail closed）——隔離なしで起こすと1本の暴走が機械全体を巻き込む。
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** 職人1本あたりの上限の既定（PO 裁定 2026-08-14）。実測 600MB の約3.4倍。 */
export const DEFAULT_WORKER_MEMORY_MAX = 2 * 1024 * 1024 * 1024;

/** 職人の袋のディレクトリ名の接頭辞。掃除（`sweep`）はこれで見分ける。 */
const BAG_PREFIX = "w-";

/** 工房本体を退かす葉の名前。ここに退かさないと `+memory` を配れない（規則1）。 */
const DEFAULT_LEAF_NAME = "main";

// ── ファイルを触る口 ─────────────────────────────────────────────────────────

/**
 * cgroup の疑似ファイルを触る口。
 *
 * **なぜ間に一枚挟むか。** 本物の cgroup を書き換える試験は打てない（稼働中の工房と
 * 職人に直接効く）。かといって「cgroup が無い環境では試験しない」にすると、
 * **一番壊れやすい順序（規則1）が一度も試されない**まま本番へ出ることになる。
 * 偽の木にカーネルの規則を実装して、順序そのものを試験できるようにするための seam。
 */
export interface CgroupFs {
  /** 疑似ファイルを読む。無ければ投げる。 */
  read(file: string): string;
  /** 疑似ファイルへ書く（cgroupfs では「書き込み＝命令」なので追記も切り詰めも同じ）。 */
  write(file: string, data: string): void;
  mkdir(dir: string): void;
  rmdir(dir: string): void;
  readdir(dir: string): string[];
  exists(target: string): boolean;
}

/** 本物の cgroupfs。node 標準の `fs` をそのまま使う。 */
export const nodeCgroupFs: CgroupFs = {
  read: (file) => fs.readFileSync(file, "utf-8"),
  write: (file, data) => fs.writeFileSync(file, data),
  mkdir: (dir) => fs.mkdirSync(dir),
  rmdir: (dir) => fs.rmdirSync(dir),
  readdir: (dir) => fs.readdirSync(dir),
  exists: (target) => fs.existsSync(target),
};

// ── 外へ出す形 ───────────────────────────────────────────────────────────────

/** 隔離が効いているか。`none` は「隔離せずに動いている」という宣言。 */
export type IsolationMode = "cgroup" | "none";

/** 工房の運転モード。起動時に1回決めて、以後変えない（宣言的）。 */
export interface IsolationStatus {
  mode: IsolationMode;
  /**
   * `none` の理由。**`none` のときは必ず入る。**
   * 「なぜ隔離できていないのか」が分からないまま回るのを禁じるため（PO 裁定）。
   */
  reason?: string;
  /** 職人の袋を作る親ディレクトリ（`cgroup` のときだけ）。 */
  parentDir?: string;
  /** 職人1本あたりの `memory.max`（バイト）。 */
  memoryMax: number;
}

/**
 * ランタイム別の想定消費ピーク（MiB）。
 *
 * タスクA〜E で仮置きした値。task-0263 はこれを `memory.peak` の実測と突き合わせて
 * **可視化**するところまで——自動更新（想定値を実測で上書きする）は PO 判断を伴うので
 * このタスクでは行わない。実測/想定 の比を出すための参照値としてだけ使う。
 */
export const ASSUMED_PEAK_MIB: Readonly<Record<string, number>> = {
  /** pi 経路（既定ランタイム）。タスクA〜E の仮置き。 */
  "pi-rpc": 300,
  /** Claude Agent SDK 経路。タスクA〜E の仮置き。 */
  "claude-agent-sdk": 1200,
};

/** 職人1本の袋。 */
export interface WorkerBag {
  /** 袋のディレクトリ（絶対パス）。 */
  dir: string;
  /** 自分の pid を書き込む先。職人の子はここへ**自分で**書いてから働き始める。 */
  procsFile: string;
}

/**
 * 袋が消える前に読み取った使い切りの記録（inc-0066 の「犯人が分からなかった」への答え）。
 *
 * **`rmdir` の前に読む。** 消すと二度と読めない。
 */
export interface CgroupUsage {
  /** `memory.peak`：この袋が抱えた最大値（バイト）。 */
  peakBytes?: number;
  /** `memory.events` の生の数え上げ（`low` / `high` / `max` / `oom` / `oom_kill` …）。 */
  events?: Record<string, number>;
  /** 上限に張り付いた（`max` が1以上）。殺されてはいないが、明らかに異常。 */
  hitLimit: boolean;
  /** **袋の中で OOM killer に殺された**（`oom_kill` が1以上）。「なぜか落ちた」で終わらせない。 */
  oomKilled: boolean;
  /** 読めなかった理由。I2：黙って空を返さない。 */
  error?: string;
}

/**
 * 袋の中を殺した結果。
 *
 * `cgroup.kill` はカーネルが袋の中の全部へ SIGKILL を配るので、**何本だったかは分からない**
 * ——分からないものを数として出さない（I1）。名簿を1本ずつ撃った場合だけ本数が入る。
 */
export interface KillResult {
  method: "cgroup.kill" | "signal";
  /** `signal` のときだけ。撃てた本数。 */
  killed?: number;
  /** `cgroup.kill` を使えなかった理由（使えたときは無い）。 */
  error?: string;
}

/** `prepare` に渡す指定。 */
export interface PrepareOptions {
  /**
   * 委譲された自分の cgroup ディレクトリ（絶対パス）。
   * 省くと `/proc/self/cgroup` と `mountPoint` から解く。
   */
  selfDir?: string;
  /** cgroup v2 のマウント位置。既定 `/sys/fs/cgroup`。 */
  mountPoint?: string;
  /** 自分の cgroup を書いてあるファイル。既定 `/proc/self/cgroup`。 */
  procSelfCgroup?: string;
  /** 職人1本あたりの上限（バイト）。既定 `DEFAULT_WORKER_MEMORY_MAX`。 */
  memoryMax?: number;
  /** 工房本体を退かす葉の名前。既定 `main`。 */
  leafName?: string;
  /** 差し替え可能なファイル操作（試験が偽の木を差し込む）。 */
  fs?: CgroupFs;
}

// ── 値の読み書き ─────────────────────────────────────────────────────────────

/**
 * `2G` / `512M` / バイト数の文字列を解く。分からなければ undefined。
 *
 * 設定で上限を変えられるようにするため（既定は 2GiB）。人が `2G` と書けないと、
 * 桁を1つ間違えた値が黙って入る。
 */
export function parseByteSize(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]i?b?)?\s*$/i.exec(raw);
  if (!m) return undefined;
  const value = Number.parseFloat(m[1]!);
  if (!Number.isFinite(value)) return undefined;
  const unit = (m[2] ?? "").toLowerCase();
  const scale = unit.startsWith("k")
    ? 1024
    : unit.startsWith("m")
      ? 1024 ** 2
      : unit.startsWith("g")
        ? 1024 ** 3
        : unit.startsWith("t")
          ? 1024 ** 4
          : 1;
  return Math.floor(value * scale);
}

/** 人が読む形（報告とログに出す）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return String(bytes);
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? v : v.toFixed(1)}${units[i]}`;
}

/** ディレクトリ名に使える形へ落とす（`/` や空白を持ち込ませない）。 */
function slug(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 64) : "unnamed";
}

/** `cgroup.controllers` / `cgroup.subtree_control` を語の配列で読む。 */
function readWords(fsx: CgroupFs, file: string): string[] {
  return fsx
    .read(file)
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/** `cgroup.procs` を pid の配列で読む。 */
function readPids(fsx: CgroupFs, file: string): number[] {
  return fsx
    .read(file)
    .split("\n")
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/**
 * `/proc/self/cgroup` から自分の cgroup ディレクトリを解く。
 *
 * cgroup v2（統一階層）の行は `0::/system.slice/....` の形ひとつだけ。
 * v1 の行（`N:controller:/...`）しか無ければ v2 ではない＝隔離は使えない。
 */
export function resolveSelfCgroupDir(
  fsx: CgroupFs,
  procSelfCgroup: string,
  mountPoint: string
): { dir: string } | { error: string } {
  let raw: string;
  try {
    raw = fsx.read(procSelfCgroup);
  } catch (err) {
    return { error: `${procSelfCgroup} を読めません: ${String(err)}` };
  }
  const line = raw.split("\n").find((l) => l.startsWith("0::"));
  if (!line) {
    return { error: `cgroup v2（統一階層）ではありません: ${procSelfCgroup} に 0:: の行がない` };
  }
  const rel = line.slice("0::".length).trim();
  if (!rel.startsWith("/")) return { error: `自分の cgroup の位置を読み取れません: "${line}"` };
  return { dir: path.join(mountPoint, rel) };
}

// ── 本体 ─────────────────────────────────────────────────────────────────────

/**
 * 職人の袋を作り・殺し・片付ける係。
 *
 * **状態は「運転モード」1つだけ**（D3）。袋そのものは cgroupfs の中に在るのが真実で、
 * ここは覚え直さない。工房が畳んだ袋を台帳へ書くのは、再起動後に引き継ぐため。
 */
export class WorkerCgroups {
  private constructor(
    private readonly st: IsolationStatus,
    private readonly fsx: CgroupFs
  ) {}

  /** 隔離しないことが決まっているとき（設定で切ってある・この機械では使えない）。 */
  static disabled(reason: string, memoryMax = DEFAULT_WORKER_MEMORY_MAX): WorkerCgroups {
    return new WorkerCgroups({ mode: "none", reason, memoryMax }, nodeCgroupFs);
  }

  /**
   * 起動時に1回だけ走る**能力判定**。ここで運転モードを確定させる。
   *
   * 順序が命（cgroup v2 の規則1）。逆にすると `EBUSY` で落ちる:
   *
   * 1. 親（unit）の `cgroup.subtree_control` に `+memory`
   *    ——unit 直下にプロセスは0本なので通る
   * 2. `<自分>/main/` を作り、**自分の直下のプロセスを全部**そこへ移す
   * 3. `<自分>/cgroup.subtree_control` に `+memory`
   *    ——2 を先にやっていないとここで `EBUSY`
   *
   * どこかで転んだら**投げずに** `mode: none` を理由つきで返す。開発機・コンテナでも
   * 工房は立つ必要がある——ただし黙らせない。
   */
  static prepare(options: PrepareOptions = {}): WorkerCgroups {
    const fsx = options.fs ?? nodeCgroupFs;
    const memoryMax = options.memoryMax ?? DEFAULT_WORKER_MEMORY_MAX;
    const mountPoint = options.mountPoint ?? "/sys/fs/cgroup";
    const leafName = options.leafName ?? DEFAULT_LEAF_NAME;
    const none = (reason: string): WorkerCgroups =>
      new WorkerCgroups({ mode: "none", reason, memoryMax }, fsx);

    let selfDir = options.selfDir;
    if (selfDir === undefined) {
      const resolved = resolveSelfCgroupDir(
        fsx,
        options.procSelfCgroup ?? "/proc/self/cgroup",
        mountPoint
      );
      if ("error" in resolved) return none(resolved.error);
      selfDir = resolved.dir;
    }
    if (!fsx.exists(selfDir)) {
      return none(`委譲された cgroup が見当たりません: ${selfDir}`);
    }

    // 1) 自分の中で memory コントローラが使えるようにする。使えないなら親から配ってもらう
    //    ——親が root 所有（＝委譲されていない）ならここで EACCES になり、degraded へ落ちる
    try {
      if (!readWords(fsx, path.join(selfDir, "cgroup.controllers")).includes("memory")) {
        const parent = path.dirname(selfDir);
        fsx.write(path.join(parent, "cgroup.subtree_control"), "+memory");
        if (!readWords(fsx, path.join(selfDir, "cgroup.controllers")).includes("memory")) {
          return none(
            `memory コントローラを ${selfDir} で使えるようにできませんでした` +
              `（${parent}/cgroup.subtree_control に +memory を書いたが反映されない）`
          );
        }
      }
    } catch (err) {
      return none(`memory コントローラを配れません（${selfDir} の親へ書けない）: ${String(err)}`);
    }

    // 2) 自分の直下に居るプロセス（工房本体）を葉へ退かす。規則1：内部ノードにプロセスを置けない
    const leafDir = path.join(selfDir, leafName);
    try {
      if (!fsx.exists(leafDir)) fsx.mkdir(leafDir);
      const moved = moveAllProcs(fsx, selfDir, leafDir);
      if ("error" in moved) return none(moved.error);
    } catch (err) {
      return none(`工房本体を ${leafDir} へ退かせませんでした: ${String(err)}`);
    }

    // 3) 子（職人の袋）に memory を配る。2 のあとでなければ EBUSY
    try {
      const subtree = path.join(selfDir, "cgroup.subtree_control");
      if (!readWords(fsx, subtree).includes("memory")) {
        fsx.write(subtree, "+memory");
        if (!readWords(fsx, subtree).includes("memory")) {
          return none(`${subtree} に +memory を書いたが反映されませんでした`);
        }
      }
    } catch (err) {
      return none(`職人の袋に memory コントローラを配れません: ${String(err)}`);
    }

    return new WorkerCgroups({ mode: "cgroup", parentDir: selfDir, memoryMax }, fsx);
  }

  get status(): IsolationStatus {
    return this.st;
  }

  get enabled(): boolean {
    return this.st.mode === "cgroup";
  }

  /** 番頭・ログに出す1行。`none` のときは理由まで出す（黙らせない）。 */
  describe(): string {
    return this.st.mode === "cgroup"
      ? `職人ごとに cgroup で隔離します（上限 ${formatBytes(this.st.memoryMax)} / 場所 ${this.st.parentDir}）`
      : `⚠ 職人を隔離していません（cgroup 不可: ${this.st.reason ?? "理由不明"}）。` +
          `1本の暴走が機械全体を巻き込みます`;
  }

  /**
   * 職人1本の袋を作る。隔離していないときは `undefined`（＝作らないのが正しい）。
   *
   * **失敗は投げる。** 呼び出し側はそれを職人の起動失敗として番頭へ返す（fail closed）。
   * 「作れなかったので隔離なしで起こしました」は、いちばんやってはいけない振る舞い。
   */
  createBag(projectTag: string, taskId: string): WorkerBag | undefined {
    if (this.st.mode !== "cgroup" || this.st.parentDir === undefined) return undefined;
    const base = `${BAG_PREFIX}${slug(projectTag)}-${slug(taskId)}`;
    // 同じ職人を起こし直したとき、前の袋が残っていても衝突させない
    let dir = path.join(this.st.parentDir, base);
    for (let n = 2; this.fsx.exists(dir) && n < 100; n += 1) {
      dir = path.join(this.st.parentDir, `${base}-${n}`);
    }
    this.fsx.mkdir(dir);
    try {
      this.fsx.write(path.join(dir, "memory.max"), String(this.st.memoryMax));
    } catch (err) {
      // 作りかけを残さない。次の職人が同じ名前で拾ってしまう
      try {
        this.fsx.rmdir(dir);
      } catch {
        /* 消せなくても、投げる理由は上書きしない */
      }
      throw new Error(`${dir}/memory.max に上限を書けませんでした: ${String(err)}`);
    }
    /**
     * **上限に当たったら袋ごと死ぬ**（`memory.oom.group`）。
     *
     * 既定（0）だと、カーネルは袋の中で「いちばん大きいもの」だけを殺す。すると
     * `claude` CLI だけが消えて node ホストが半端に生き残る（あるいはその逆）といった、
     * **半分死んだ職人**が残りうる。1本まるごと死ねば、工房から見えるのは
     * `process_exited` 1件——いまのコードが既に知っている形に落ちる。
     *
     * 書けなくても職人は起こす。上限（`memory.max`）は既に張れており、
     * ここは死に方を揃えるだけの refinement だから（カーネル 4.19 以降）。
     */
    try {
      this.fsx.write(path.join(dir, "memory.oom.group"), "1");
    } catch (err) {
      console.error(`[worker-pool] ${dir}/memory.oom.group を書けませんでした（続行）: ${String(err)}`);
    }
    return { dir, procsFile: path.join(dir, "cgroup.procs") };
  }

  /**
   * 袋へプロセスを入れ、**入ったことを読み返して確かめる**。
   *
   * 確かめるのは、子が自分で入る形（`BANTO_WORKER_CGROUP_PROCS`）が主で、これは
   * 取りこぼしの押さえだから——「書いたつもり」で素通りさせると隔離が無いのと同じになる。
   * 既に入っている pid をもう一度書いても no-op なので、二重に呼んで構わない。
   */
  join(bag: WorkerBag, pid: number): void {
    this.fsx.write(bag.procsFile, String(pid));
    if (!readPids(this.fsx, bag.procsFile).includes(pid)) {
      throw new Error(`pid ${pid} を ${bag.dir} へ入れられませんでした（書いたが名簿に居ない）`);
    }
  }

  /** その pid が袋の中に居るか。生死は見ない（死んでいれば居ないのが正しい）。 */
  contains(bag: WorkerBag, pid: number): boolean {
    try {
      return readPids(this.fsx, bag.procsFile).includes(pid);
    } catch {
      return false;
    }
  }

  /**
   * 袋が消える前に使い切りの記録を読む（inc-0066）。**`remove` より先に呼ぶこと。**
   *
   * 投げない。ここで転んで職人を畳めなくなるのは本末転倒——読めなかった理由は
   * `error` に載せて、その事実ごと記録に残す（I2）。
   */
  usage(bag: WorkerBag): CgroupUsage {
    let peakBytes: number | undefined;
    let events: Record<string, number> | undefined;
    const problems: string[] = [];

    try {
      const peak = Number.parseInt(this.fsx.read(path.join(bag.dir, "memory.peak")).trim(), 10);
      if (Number.isFinite(peak)) peakBytes = peak;
    } catch (err) {
      problems.push(`memory.peak: ${String(err)}`);
    }
    try {
      events = {};
      for (const line of this.fsx.read(path.join(bag.dir, "memory.events")).split("\n")) {
        const [key, value] = line.trim().split(/\s+/);
        if (key === undefined || value === undefined) continue;
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n)) events[key] = n;
      }
    } catch (err) {
      events = undefined;
      problems.push(`memory.events: ${String(err)}`);
    }

    return {
      ...(peakBytes !== undefined ? { peakBytes } : {}),
      ...(events ? { events } : {}),
      hitLimit: (events?.["max"] ?? 0) > 0,
      // `memory.oom.group=1` を張っているので、袋ごと殺された分（oom_group_kill）も同じ意味
      oomKilled: (events?.["oom_kill"] ?? 0) > 0 || (events?.["oom_group_kill"] ?? 0) > 0,
      ...(problems.length > 0 ? { error: problems.join(" / ") } : {}),
    };
  }

  /**
   * 袋の中の全部を確実に殺す。
   *
   * これが第2段の要のひとつ。いまの畳み方は「標準入力に `abort` を書く」＝**相手の協力**に
   * 依存していて、暴走している相手には効かない（inc-0066 の理由2）。`cgroup.kill` は
   * カーネルが袋の中の全部に SIGKILL を配るので、`claude` CLI も その下の bash も残らない。
   *
   * `cgroup.kill` はカーネル 5.14 以降。無ければ名簿の pid へ直接 SIGKILL を撃つ。
   */
  killAll(bag: WorkerBag): KillResult {
    const killFile = path.join(bag.dir, "cgroup.kill");
    try {
      if (this.fsx.exists(killFile)) {
        this.fsx.write(killFile, "1");
        // 何本殺したかはカーネルしか知らない。数を偽らない
        return { method: "cgroup.kill" };
      }
    } catch (err) {
      // 落ちても下の直接撃ちへ進む。ここで諦めると孤児が残る
      return this.killByPid(bag, `cgroup.kill に書けませんでした: ${String(err)}`);
    }
    return this.killByPid(bag, "cgroup.kill がありません（カーネル 5.14 未満）");
  }

  private killByPid(bag: WorkerBag, why: string): KillResult {
    let killed = 0;
    try {
      for (const pid of readPids(this.fsx, bag.procsFile)) {
        try {
          process.kill(pid, "SIGKILL");
          killed += 1;
        } catch {
          // 既に死んでいる pid は数えない
        }
      }
    } catch (err) {
      return { method: "signal", killed, error: `${why} / 名簿も読めません: ${String(err)}` };
    }
    return { method: "signal", killed, error: why };
  }

  /**
   * 空になった袋を片付ける。残すと空ディレクトリが溜まる。
   *
   * `cgroup.kill` で殺した直後はまだ名簿が空になっていない（死ぬのは非同期）ので、
   * `EBUSY` を数回だけ待って引き取る。粘りすぎない——残っても次の起動の `sweep` が拾う。
   */
  async remove(bag: WorkerBag, attempts = 20, waitMs = 50): Promise<{ ok: boolean; error?: string }> {
    let last = "";
    for (let i = 0; i < attempts; i += 1) {
      if (!this.fsx.exists(bag.dir)) return { ok: true };
      try {
        this.fsx.rmdir(bag.dir);
        return { ok: true };
      } catch (err) {
        last = String(err);
        /**
         * **この待ちの timer を `unref` してはいけない。** 実機で踏んだ:
         * 他に予定が無いプロセスだと、unref した timer では node が先に抜けてしまい、
         * 待ちが解けないまま袋が残る。片付けは最後までやり切る側に倒す。
         */
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
    return { ok: false, error: last };
  }

  /**
   * 起動時、前回の工房が残していった袋を片付ける（決定44 の復帰と対になる掃除）。
   *
   * **中身が生きている袋は消さない。** 名前を返すので、呼び出し側が帳簿に載せる
   * ——台帳から漏れた孤児を突き止める材料になる（inc-0066 の (d)）。
   *
   * @param keep 台帳から引き継いだ、いまも自分のものである袋のディレクトリ名
   */
  sweep(keep: readonly string[] = []): { removed: string[]; alive: { name: string; pids: number[] }[] } {
    const removed: string[] = [];
    const alive: { name: string; pids: number[] }[] = [];
    if (this.st.mode !== "cgroup" || this.st.parentDir === undefined) return { removed, alive };
    const parentDir = this.st.parentDir;
    const keepSet = new Set(keep.map((k) => path.basename(k)));

    let names: string[];
    try {
      names = this.fsx.readdir(parentDir);
    } catch {
      return { removed, alive };
    }

    for (const name of names) {
      if (!name.startsWith(BAG_PREFIX) || keepSet.has(name)) continue;
      const dir = path.join(parentDir, name);
      let pids: number[] = [];
      try {
        pids = readPids(this.fsx, path.join(dir, "cgroup.procs"));
      } catch {
        continue; // ディレクトリでない・既に消えた
      }
      if (pids.length > 0) {
        alive.push({ name, pids });
        continue;
      }
      try {
        this.fsx.rmdir(dir);
        removed.push(name);
      } catch {
        // 消せなければ次の起動で拾う
      }
    }
    return { removed, alive };
  }
}

/**
 * `from` の直下に居るプロセスを全部 `to` へ移す。
 *
 * `cgroup.procs` は**1回の書き込みに pid 1つ**。移している最中に増えることもあるので
 * 数回だけ繰り返す。増え続けるなら諦めて理由を返す——ここで無限に粘ると工房が起動しない。
 */
function moveAllProcs(fsx: CgroupFs, from: string, to: string): Record<string, never> | { error: string } {
  const fromProcs = path.join(from, "cgroup.procs");
  const toProcs = path.join(to, "cgroup.procs");
  for (let round = 0; round < 5; round += 1) {
    const pids = readPids(fsx, fromProcs);
    if (pids.length === 0) return {};
    for (const pid of pids) {
      try {
        fsx.write(toProcs, String(pid));
      } catch (err) {
        // 移す前に死んだ pid は放っておく。それ以外は次の周回で拾い直す
        if (!isGoneError(err)) {
          return { error: `pid ${pid} を ${to} へ移せませんでした: ${String(err)}` };
        }
      }
    }
  }
  const left = readPids(fsx, fromProcs);
  return left.length === 0
    ? {}
    : { error: `${from} の直下にプロセスが残っています（${left.join(",")}）` };
}

/** 「もう居ない」を表すエラーか（移す前に死んだプロセス）。 */
function isGoneError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ESRCH" || code === "ENOENT";
}
