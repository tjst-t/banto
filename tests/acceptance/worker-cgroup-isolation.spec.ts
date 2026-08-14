/**
 * inc-0066 第2段: **職人1本ごとの cgroup 隔離**。
 *
 * 2026-08-14、職人1本（`claude` CLI）が 10.72 GiB まで膨らみ、15GiB・swap 無しの VM が
 * kernel の OOM で応答不能になった。第1段（unit への `MemoryMax=9G`）は「機械ごと落ちる」を
 * 「工房の袋の中で落ちる」に変えたが、犯人は分からず健全な職人も巻き添えになる。
 *
 * ## なぜ偽の cgroupfs を作るのか（この試験の要）
 *
 * 本物の cgroup を書き換える試験は打てない——**稼働中の工房と職人に直接効く**。かといって
 * 「cgroup がある環境でだけ試験する」にすると、CI・コンテナ・開発機のどれでも一度も走らず、
 * **いちばん壊れやすい順序が未検証のまま本番へ出る**。だからカーネルの規則（内部ノードに
 * プロセスを置けない＝`EBUSY`）を実装した偽の木を用意し、順序そのものを試験する。
 *
 * 偽物が本物の規則を持っていることは、最初の describe で**その規則自体を検査**して担保する
 * ——偽物が甘ければ、その下の試験は何も証明しないため。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
  DriverEvent,
  DriverEventHandler,
  RuntimeDriver,
  SessionHandle,
  SpawnOptions,
} from "@banto/core";
import {
  WorkerCgroups,
  WorkerPool,
  createWorkerTools,
  parseByteSize,
  formatBytes,
  DEFAULT_WORKER_MEMORY_MAX,
  type CgroupFs,
} from "@banto/worker-pool";

/** `worker.list` が番頭へ返す文面（隔離の見え方はここでしか確かめられない）。 */
async function listText(pool: WorkerPool): Promise<string> {
  const list = createWorkerTools(pool).find((t) => t.name === "worker.list")!;
  const out = await list.execute({} as never);
  return out.content
    .map((c) => (c.type === "text" ? (c as { type: "text"; text: string }).text : ""))
    .join("\n");
}

// ── カーネルの規則を持った偽の cgroupfs ──────────────────────────────────────

interface FakeNode {
  /** 自分の中で使えるコントローラ（親が `subtree_control` で配ったもの）。 */
  controllers: Set<string>;
  /** 子へ配っているコントローラ。 */
  subtree: Set<string>;
  procs: number[];
  values: Map<string, string>;
}

function fail(code: string, message: string): never {
  const err = new Error(`${code}: ${message}`) as NodeJS.ErrnoException;
  err.code = code;
  throw err;
}

const CORE_FILES = ["cgroup.procs", "cgroup.controllers", "cgroup.subtree_control"];

/**
 * cgroup v2 の**規則を実装した**偽の木。
 *
 * 実装している規則:
 * 1. 内部プロセス禁止——自分にプロセスを抱えたまま `subtree_control` は書けない（EBUSY）
 * 2. 逆向きも同じ——`subtree_control` を配っている cgroup にプロセスは入れられない（EBUSY）
 * 3. `subtree_control` に配ったものが、子の `cgroup.controllers` に現れる
 * 4. `memory.*` は memory コントローラが自分の中で使えるときだけ在る（無ければ ENOENT）
 * 5. `rmdir` はプロセスも子も無いときだけ通る（EBUSY）
 */
class FakeCgroupFs implements CgroupFs {
  readonly nodes = new Map<string, FakeNode>();
  /** 書き込みを拒む場所（委譲されていない＝root 所有の再現）。 */
  readonly denied = new Set<string>();
  /** 何をどの順で書いたか（順序の検査用）。 */
  readonly writes: string[] = [];
  /** `cgroup.kill` を持つか（カーネル 5.14 未満の再現）。 */
  hasCgroupKill = true;

  node(dir: string, init: { controllers?: string[]; procs?: number[] } = {}): FakeNode {
    const node: FakeNode = {
      controllers: new Set(init.controllers ?? []),
      subtree: new Set(),
      procs: [...(init.procs ?? [])],
      values: new Map(),
    };
    this.nodes.set(dir, node);
    return node;
  }

  private require(dir: string): FakeNode {
    const node = this.nodes.get(dir);
    if (!node) fail("ENOENT", `そんな cgroup はありません: ${dir}`);
    return node;
  }

  read(file: string): string {
    const dir = path.dirname(file);
    const name = path.basename(file);
    const node = this.require(dir);
    if (name === "cgroup.controllers") return [...node.controllers].join(" ") + "\n";
    if (name === "cgroup.subtree_control") return [...node.subtree].join(" ") + "\n";
    if (name === "cgroup.procs") return node.procs.join("\n") + (node.procs.length ? "\n" : "");
    if (name.startsWith("memory.") && !node.controllers.has("memory")) {
      fail("ENOENT", `memory コントローラが有効ではありません: ${file}`);
    }
    const stored = node.values.get(name);
    if (stored !== undefined) return stored;
    if (name === "memory.peak") return "0\n";
    if (name === "memory.events") {
      return "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\noom_group_kill 0\n";
    }
    if (name === "memory.max") return "max\n";
    fail("ENOENT", `そんなファイルはありません: ${file}`);
  }

  write(file: string, data: string): void {
    this.writes.push(`${file}=${data}`);
    if (this.denied.has(file)) fail("EACCES", `書き込みを拒みました: ${file}`);
    const dir = path.dirname(file);
    const name = path.basename(file);
    const node = this.require(dir);

    if (name === "cgroup.subtree_control") {
      // 規則1: 自分にプロセスが居るあいだは配れない
      if (node.procs.length > 0) fail("EBUSY", `${dir} にプロセスが居ます`);
      for (const token of data.trim().split(/\s+/)) {
        const ctrl = token.slice(1);
        if (token.startsWith("+")) {
          if (!node.controllers.has(ctrl)) fail("ENOENT", `${ctrl} は ${dir} で使えません`);
          node.subtree.add(ctrl);
        } else if (token.startsWith("-")) {
          node.subtree.delete(ctrl);
        }
      }
      // 規則3: 配ったものが子に現れる
      for (const [childDir, child] of this.nodes) {
        if (path.dirname(childDir) === dir) child.controllers = new Set(node.subtree);
      }
      return;
    }

    if (name === "cgroup.procs") {
      // 規則2: 子へ配っている cgroup にプロセスは入れられない
      if (node.subtree.size > 0) fail("EBUSY", `${dir} は子にコントローラを配っています`);
      const pid = Number.parseInt(data.trim(), 10);
      if (!Number.isInteger(pid)) fail("EINVAL", `pid ではありません: ${data}`);
      for (const other of this.nodes.values()) {
        const at = other.procs.indexOf(pid);
        if (at >= 0) other.procs.splice(at, 1);
      }
      node.procs.push(pid);
      return;
    }

    if (name === "cgroup.kill") {
      if (!this.hasCgroupKill) fail("ENOENT", `cgroup.kill がありません: ${file}`);
      if (data.trim() !== "1") return;
      for (const [otherDir, other] of this.nodes) {
        if (otherDir === dir || otherDir.startsWith(dir + path.sep)) other.procs = [];
      }
      return;
    }

    if (name.startsWith("memory.") && !node.controllers.has("memory")) {
      fail("ENOENT", `memory コントローラが有効ではありません: ${file}`);
    }
    node.values.set(name, data);
  }

  mkdir(dir: string): void {
    if (this.nodes.has(dir)) fail("EEXIST", `既にあります: ${dir}`);
    const parent = this.require(path.dirname(dir));
    this.node(dir, { controllers: [...parent.subtree] });
  }

  rmdir(dir: string): void {
    const node = this.require(dir);
    if (node.procs.length > 0) fail("EBUSY", `${dir} にプロセスが居ます`);
    for (const other of this.nodes.keys()) {
      if (other !== dir && other.startsWith(dir + path.sep)) fail("EBUSY", `${dir} に子が居ます`);
    }
    this.nodes.delete(dir);
  }

  readdir(dir: string): string[] {
    this.require(dir);
    return [...this.nodes.keys()]
      .filter((other) => path.dirname(other) === dir)
      .map((other) => path.basename(other));
  }

  exists(target: string): boolean {
    if (this.nodes.has(target)) return true;
    const node = this.nodes.get(path.dirname(target));
    if (!node) return false;
    const name = path.basename(target);
    if (CORE_FILES.includes(name)) return true;
    if (name === "cgroup.kill") return this.hasCgroupKill;
    if (name.startsWith("memory.")) return node.controllers.has("memory");
    return node.values.has(name);
  }
}

const UNIT = "/sys/fs/cgroup/system.slice/banto-worker-pool.service";
const SUPERVISOR = `${UNIT}/supervisor`;
/** 工房本体の pid（実測では `bin.ts serve` の1本）。 */
const SHOP_PID = 725;

/**
 * 2026-08-14 に実測した本番の姿を作る。
 *
 * - unit は委譲済み（`Delegate=yes`）で `cgroup.controllers` に memory が在る
 * - しかし `cgroup.subtree_control` は空——systemd は配らない
 * - `DelegateSubgroup=supervisor` により工房本体は `supervisor/` に**直接**ぶら下がる
 */
function productionShapedTree(): FakeCgroupFs {
  const fsx = new FakeCgroupFs();
  fsx.node("/sys/fs/cgroup", { controllers: ["cpu", "memory", "pids"] });
  fsx.node("/sys/fs/cgroup/system.slice", { controllers: ["cpu", "memory", "pids"] });
  fsx.node(UNIT, { controllers: ["cpuset", "cpu", "io", "memory", "hugetlb", "pids"] });
  fsx.node(SUPERVISOR, { controllers: [] });
  fsx.nodes.get(SUPERVISOR)!.procs.push(SHOP_PID);
  return fsx;
}

function prepared(fsx: FakeCgroupFs, memoryMax = DEFAULT_WORKER_MEMORY_MAX): WorkerCgroups {
  return WorkerCgroups.prepare({ selfDir: SUPERVISOR, fs: fsx, memoryMax });
}

// ── 偽物が本物の規則を持っていることの確認 ───────────────────────────────────

describe("[inc-0066] 偽の cgroupfs がカーネルの規則を守る（この下の試験の土台）", () => {
  it("プロセスを抱えたまま subtree_control を書くと EBUSY（順序を間違えた実装が通らない）", () => {
    const fsx = productionShapedTree();
    assert.throws(
      () => fsx.write(`${SUPERVISOR}/cgroup.subtree_control`, "+memory"),
      /EBUSY/,
      "工房本体を退かす前に +memory が通ってしまうなら、この試験は何も証明しない"
    );
  });

  it("memory を配っていない cgroup に memory.max は無い", () => {
    const fsx = productionShapedTree();
    fsx.mkdir(`${SUPERVISOR}/w-x`);
    assert.throws(() => fsx.write(`${SUPERVISOR}/w-x/memory.max`, "1"), /ENOENT/);
  });

  it("子にコントローラを配っている cgroup にはプロセスを入れられない", () => {
    const fsx = productionShapedTree();
    fsx.write(`${UNIT}/cgroup.subtree_control`, "+memory");
    assert.throws(() => fsx.write(`${UNIT}/cgroup.procs`, "999"), /EBUSY/);
  });
});

// ── 起動時の能力判定 ─────────────────────────────────────────────────────────

describe("[inc-0066] 起動時の能力判定は宣言的で、失敗しても工房は立つ", () => {
  it("本番と同じ形の木で isolation=cgroup になり、工房本体は葉へ退く", () => {
    const fsx = productionShapedTree();
    const cg = prepared(fsx);

    assert.equal(cg.status.mode, "cgroup");
    assert.equal(cg.status.parentDir, SUPERVISOR);
    assert.equal(cg.status.reason, undefined);

    // 規則1を満たすために、supervisor 直下は空でなければならない
    assert.deepEqual(fsx.nodes.get(SUPERVISOR)!.procs, [], "supervisor 直下にプロセスが残っている");
    assert.deepEqual(
      fsx.nodes.get(`${SUPERVISOR}/main`)!.procs,
      [SHOP_PID],
      "工房本体が葉へ移っていない"
    );
    // 職人の袋に memory.max を持たせるには、unit と supervisor の両方で配る必要がある
    assert.ok(fsx.nodes.get(UNIT)!.subtree.has("memory"));
    assert.ok(fsx.nodes.get(SUPERVISOR)!.subtree.has("memory"));
  });

  it("順序を守っている：unit へ配る → 本体を退かす → supervisor へ配る", () => {
    const fsx = productionShapedTree();
    prepared(fsx);
    const order = fsx.writes.map((w) => w.split("=")[0]!);
    const unitAt = order.indexOf(`${UNIT}/cgroup.subtree_control`);
    const moveAt = order.indexOf(`${SUPERVISOR}/main/cgroup.procs`);
    const supAt = order.indexOf(`${SUPERVISOR}/cgroup.subtree_control`);
    assert.ok(unitAt >= 0 && moveAt >= 0 && supAt >= 0, `書き込みが足りない: ${order.join(" / ")}`);
    assert.ok(moveAt < supAt, "本体を退かす前に supervisor へ配ると EBUSY になる");
  });

  it("何度立ち上げ直しても同じ結果になる（冪等）", () => {
    const fsx = productionShapedTree();
    assert.equal(prepared(fsx).status.mode, "cgroup");
    const again = prepared(fsx);
    assert.equal(again.status.mode, "cgroup");
    assert.deepEqual(fsx.nodes.get(`${SUPERVISOR}/main`)!.procs, [SHOP_PID]);
  });

  it("委譲されていない（親へ書けない）と isolation=none。理由が必ず入る", () => {
    const fsx = productionShapedTree();
    fsx.denied.add(`${UNIT}/cgroup.subtree_control`);
    const cg = prepared(fsx);
    assert.equal(cg.status.mode, "none");
    assert.match(String(cg.status.reason), /EACCES|配れません/);
    assert.match(cg.describe(), /隔離していません/);
  });

  it("cgroup v2 の統一階層でなければ isolation=none（コンテナ・古い機械）", () => {
    const fsx = new FakeCgroupFs();
    fsx.node("/proc");
    fsx.nodes.get("/proc")!.values.set("self-cgroup", "3:memory:/docker/abc\n2:cpu:/docker/abc\n");
    const cg = WorkerCgroups.prepare({
      fs: fsx,
      procSelfCgroup: "/proc/self-cgroup",
      mountPoint: "/sys/fs/cgroup",
    });
    assert.equal(cg.status.mode, "none");
    assert.match(String(cg.status.reason), /cgroup v2/);
  });

  it("/proc/self/cgroup が読めなくても投げずに none（工房は立つ）", () => {
    const cg = WorkerCgroups.prepare({
      fs: new FakeCgroupFs(),
      procSelfCgroup: "/proc/self/cgroup",
    });
    assert.equal(cg.status.mode, "none");
    assert.ok(String(cg.status.reason).length > 0);
  });

  it("設定で切ってあるときも、理由つきの none として宣言される", () => {
    const cg = WorkerCgroups.disabled("BANTO_WORKER_CGROUP が off（既定）");
    assert.equal(cg.status.mode, "none");
    assert.match(String(cg.status.reason), /off/);
    assert.equal(cg.createBag("p", "t"), undefined, "隔離しない運転では袋を作らない");
  });
});

// ── 袋の作成・上限・後始末 ───────────────────────────────────────────────────

describe("[inc-0066] 職人1本ごとの袋", () => {
  it("既定の上限は 2GiB（PO 裁定。実測 600MB の職人に対して約3.4倍）", () => {
    const fsx = productionShapedTree();
    const bag = prepared(fsx).createBag("banto", "task-0149")!;
    assert.equal(fsx.nodes.get(bag.dir)!.values.get("memory.max"), String(2 * 1024 ** 3));
    assert.equal(DEFAULT_WORKER_MEMORY_MAX, 2 * 1024 ** 3);
  });

  it("上限に当たったら袋ごと死ぬ（半分死んだ職人を残さない）", () => {
    const fsx = productionShapedTree();
    const bag = prepared(fsx).createBag("banto", "task-0149")!;
    assert.equal(fsx.nodes.get(bag.dir)!.values.get("memory.oom.group"), "1");
  });

  it("袋ごと殺された（oom_group_kill）ことも「上限で死んだ」と読む", () => {
    const fsx = productionShapedTree();
    const cg = prepared(fsx);
    const bag = cg.createBag("banto", "task-0149")!;
    fsx.nodes
      .get(bag.dir)!
      .values.set("memory.events", "low 0\nhigh 0\nmax 5\noom 1\noom_kill 0\noom_group_kill 1\n");
    assert.equal(cg.usage(bag).oomKilled, true);
  });

  it("上限は設定で変えられる", () => {
    const fsx = productionShapedTree();
    const bag = prepared(fsx, 3 * 1024 ** 3).createBag("banto", "task-0149")!;
    assert.equal(fsx.nodes.get(bag.dir)!.values.get("memory.max"), String(3 * 1024 ** 3));
  });

  it("同じ職人を起こし直しても、前の袋が残っていれば別の袋になる", () => {
    const fsx = productionShapedTree();
    const cg = prepared(fsx);
    const first = cg.createBag("banto", "task-0149")!;
    const second = cg.createBag("banto", "task-0149")!;
    assert.notEqual(first.dir, second.dir);
  });

  it("上限を書けなければ投げ、作りかけの袋を残さない（fail closed の土台）", () => {
    const fsx = productionShapedTree();
    const cg = prepared(fsx);
    const before = fsx.readdir(SUPERVISOR).length;
    fsx.denied.add(`${SUPERVISOR}/w-banto-task-0149/memory.max`);
    assert.throws(() => cg.createBag("banto", "task-0149"), /memory.max/);
    assert.equal(fsx.readdir(SUPERVISOR).length, before, "作りかけの袋が残っている");
  });

  it("袋へ入れたことを読み返して確かめる（書いたつもりで素通りさせない）", () => {
    const fsx = productionShapedTree();
    const cg = prepared(fsx);
    const bag = cg.createBag("banto", "task-0149")!;
    cg.join(bag, 4242);
    assert.ok(cg.contains(bag, 4242));
  });

  it("cgroup.kill で袋の中の子孫まで全部殺す（協力に依存しない）", () => {
    const fsx = productionShapedTree();
    const cg = prepared(fsx);
    const bag = cg.createBag("banto", "task-0149")!;
    cg.join(bag, 100); // node ホスト
    // ホストが起こした claude CLI と、その下の bash（cgroup v2 では自動的に同じ袋）
    fsx.nodes.get(bag.dir)!.procs.push(200, 300);
    cg.killAll(bag);
    assert.deepEqual(fsx.nodes.get(bag.dir)!.procs, [], "袋の中に生き残りが居る");
  });

  it("cgroup.kill が無いカーネルでも名簿の pid へ直接撃つ（黙って諦めない）", () => {
    const fsx = productionShapedTree();
    fsx.hasCgroupKill = false;
    const cg = prepared(fsx);
    const bag = cg.createBag("banto", "task-0149")!;
    cg.join(bag, 999999); // 存在しない pid。撃てないことは数に出る
    const result = cg.killAll(bag);
    assert.match(String(result.error), /cgroup.kill/);
  });

  it("使い終わった袋は消える（空ディレクトリを溜めない）", async () => {
    const fsx = productionShapedTree();
    const cg = prepared(fsx);
    const bag = cg.createBag("banto", "task-0149")!;
    assert.ok(fsx.nodes.has(bag.dir));
    const removed = await cg.remove(bag, 2, 1);
    assert.equal(removed.ok, true);
    assert.equal(fsx.nodes.has(bag.dir), false);
  });

  it("起動時、前回の袋のうち空のものだけ片付け、生きているものは晒す", () => {
    const fsx = productionShapedTree();
    const cg = prepared(fsx);
    const stale = cg.createBag("banto", "task-old")!;
    const orphan = cg.createBag("banto", "task-orphan")!;
    fsx.nodes.get(orphan.dir)!.procs.push(31337);
    const mine = cg.createBag("banto", "task-mine")!;

    const swept = cg.sweep([mine.dir]);
    assert.deepEqual(swept.removed, [path.basename(stale.dir)]);
    assert.deepEqual(swept.alive, [{ name: path.basename(orphan.dir), pids: [31337] }]);
    assert.ok(fsx.nodes.has(mine.dir), "台帳に載っている職人の袋を消してはいけない");
  });
});

// ── 使い切りの記録（犯人の同定） ─────────────────────────────────────────────

describe("[inc-0066] 袋が消える前に memory.peak と memory.events を読む", () => {
  it("上限に当たって殺されたことが分かる", () => {
    const fsx = productionShapedTree();
    const cg = prepared(fsx);
    const bag = cg.createBag("banto", "task-0149")!;
    const node = fsx.nodes.get(bag.dir)!;
    node.values.set("memory.peak", `${2 * 1024 ** 3}\n`);
    node.values.set("memory.events", "low 0\nhigh 0\nmax 12\noom 3\noom_kill 1\noom_group_kill 0\n");

    const usage = cg.usage(bag);
    assert.equal(usage.peakBytes, 2 * 1024 ** 3);
    assert.equal(usage.hitLimit, true);
    assert.equal(usage.oomKilled, true);
    assert.equal(usage.events?.["oom_kill"], 1);
  });

  it("健全に終わった職人は上限に当たっていない", () => {
    const fsx = productionShapedTree();
    const cg = prepared(fsx);
    const bag = cg.createBag("banto", "task-0149")!;
    fsx.nodes.get(bag.dir)!.values.set("memory.peak", `${600 * 1024 ** 2}\n`);
    const usage = cg.usage(bag);
    assert.equal(usage.hitLimit, false);
    assert.equal(usage.oomKilled, false);
  });

  it("読めなくても投げず、読めなかったことを理由つきで残す（I2）", () => {
    const fsx = productionShapedTree();
    const cg = prepared(fsx);
    const bag = cg.createBag("banto", "task-0149")!;
    fsx.nodes.delete(bag.dir);
    const usage = cg.usage(bag);
    assert.ok(usage.error, "読めなかったことが黙って消えている");
    assert.equal(usage.oomKilled, false);
  });
});

// ── 上限の指定 ───────────────────────────────────────────────────────────────

describe("[inc-0066] 上限の指定を人が書ける形で受ける", () => {
  it("2G / 1536M / 素のバイト数を読む", () => {
    assert.equal(parseByteSize("2G"), 2 * 1024 ** 3);
    assert.equal(parseByteSize("2GiB"), 2 * 1024 ** 3);
    assert.equal(parseByteSize("1536M"), 1536 * 1024 ** 2);
    assert.equal(parseByteSize("2147483648"), 2147483648);
  });

  it("読み取れない指定は undefined（呼び出し側が投げる。黙って既定に落とさない）", () => {
    assert.equal(parseByteSize("たくさん"), undefined);
    assert.equal(parseByteSize("2 gigs"), undefined);
    assert.equal(parseByteSize(undefined), undefined);
  });

  it("人が読める形に直せる", () => {
    assert.equal(formatBytes(2 * 1024 ** 3), "2.0GiB");
    assert.equal(formatBytes(512), "512B");
  });
});

// ── 工房と噛み合っているか ───────────────────────────────────────────────────

/** 偽ドライバ。無害な `sleep` を起こす（生存確認と停止が本物の pid に効くのを見たいため）。 */
class FakeDriver implements RuntimeDriver {
  failNext = false;
  private counter = 0;
  private children: childProcess.ChildProcess[] = [];
  private handlers = new Set<DriverEventHandler>();
  lastSpawn: SpawnOptions | undefined;

  async spawn(opts: SpawnOptions): Promise<SessionHandle> {
    if (this.failNext) throw new Error("boom");
    this.lastSpawn = opts;
    this.counter += 1;
    fs.mkdirSync(path.dirname(opts.sessionPath), { recursive: true });
    fs.writeFileSync(opts.sessionPath, "");
    const child = childProcess.spawn("sleep", ["30"], { stdio: "ignore" });
    this.children.push(child);
    return { pid: child.pid!, sessionId: `fake-${this.counter}`, sessionPath: opts.sessionPath };
  }
  async inject(): Promise<void> {}
  async kill(): Promise<void> {}
  subscribe(handler: DriverEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  emit(event: DriverEvent): void {
    for (const handler of this.handlers) handler(event);
  }
  cleanup(): void {
    for (const child of this.children) {
      if (child.pid !== undefined) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* 既に終わっている */
        }
      }
    }
    this.children = [];
  }
}

describe("[inc-0066] 工房が職人を袋に入れて起こす", () => {
  let dir: string;
  let driver: FakeDriver;
  let pool: WorkerPool | undefined;

  const delegateInput = {
    taskId: "task-0149",
    worktreePath: "/tmp",
    instruction: "調べてくれ",
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-cg-"));
    driver = new FakeDriver();
  });

  afterEach(() => {
    pool?.dispose();
    pool = undefined;
    driver.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makePool(cgroups: WorkerCgroups): WorkerPool {
    pool = new WorkerPool({
      driver,
      dataDir: dir,
      defaultProjectTag: "banto",
      // 子プロセスの走査（inc-0066 第1段）は本題ではないので切る
      childPidProbe: false,
      cgroups,
    });
    return pool;
  }

  it("起こした職人は袋の中に居て、上限が張ってある", async () => {
    const fsx = productionShapedTree();
    const p = makePool(prepared(fsx));
    const worker = await p.delegate(delegateInput);

    const bagDir = `${SUPERVISOR}/w-banto-task-0149`;
    assert.ok(fsx.nodes.has(bagDir), `袋が無い: ${fsx.readdir(SUPERVISOR).join(",")}`);
    assert.equal(fsx.nodes.get(bagDir)!.values.get("memory.max"), String(2 * 1024 ** 3));
    assert.ok(fsx.nodes.get(bagDir)!.procs.includes(worker.pid), "職人が袋に入っていない");
  });

  it("子が自分で袋へ入れるよう、名簿の在り処をドライバへ渡す（孫を取りこぼさないため）", async () => {
    const fsx = productionShapedTree();
    const p = makePool(prepared(fsx));
    await p.delegate(delegateInput);
    assert.equal(
      driver.lastSpawn?.driverOptions?.["cgroupProcs"],
      `${SUPERVISOR}/w-banto-task-0149/cgroup.procs`
    );
  });

  it("袋を作れなければ職人を起こさない（fail closed）", async () => {
    const fsx = productionShapedTree();
    const p = makePool(prepared(fsx));
    fsx.denied.add(`${SUPERVISOR}/w-banto-task-0149/memory.max`);

    await assert.rejects(
      () => p.delegate(delegateInput),
      /隔離.*作れなかった|機械全体を巻き込みます/,
      "隔離できないのに職人が起きてしまった"
    );
    assert.equal(driver.lastSpawn, undefined, "ドライバまで進んではいけない");
    assert.deepEqual(p.list(), [], "台帳に半端な職人が残っている");
  });

  it("隔離しない運転でも職人は起きる。ただし台帳と一覧に「隔離なし」が出る", async () => {
    const p = makePool(WorkerCgroups.disabled("この機械には委譲された cgroup がありません"));
    const worker = await p.delegate(delegateInput);
    assert.equal(worker.pid > 0, true);

    const listed = p.get(worker.sessionId);
    assert.equal(listed?.isolation, "none");

    const text = await listText(p);
    assert.match(text, /隔離なし/);
    assert.match(text, /委譲された cgroup がありません/, "なぜ隔離できていないかが番頭に届かない");
  });

  it("上限に当たって殺された職人は、そうと分かる形で終わる", async () => {
    const fsx = productionShapedTree();
    const p = makePool(prepared(fsx));
    const worker = await p.delegate(delegateInput);

    // カーネルが袋の中で OOM killer を走らせた状態にする
    const node = fsx.nodes.get(`${SUPERVISOR}/w-banto-task-0149`)!;
    node.values.set("memory.peak", `${2 * 1024 ** 3}\n`);
    node.values.set("memory.events", "low 0\nhigh 0\nmax 40\noom 2\noom_kill 1\noom_group_kill 0\n");

    driver.emit({
      type: "process_exited",
      pid: worker.pid,
      sessionId: worker.sessionId,
      exitCode: null,
      signal: "SIGKILL",
    });

    const exited = p.events().find((e) => e.type === "worker_exited");
    assert.ok(exited, "worker_exited が積まれていない");
    const memory = exited.data["memory"] as Record<string, unknown>;
    assert.equal(memory["oomKilled"], true);
    assert.equal(memory["peakBytes"], 2 * 1024 ** 3);

    const info = p.get(worker.sessionId);
    assert.equal(info?.memory?.oomKilled, true);

    const text = await listText(p);
    assert.match(text, /上限で kill された/, "番頭には「なぜか落ちた」としか見えない");
  });

  it("畳むと、記録を読んでから袋ごと殺し、袋を消す（順序が逆だと記録が取れない）", async () => {
    const fsx = productionShapedTree();
    const p = makePool(prepared(fsx));
    const worker = await p.delegate(delegateInput);
    const bagDir = `${SUPERVISOR}/w-banto-task-0149`;
    fsx.nodes.get(bagDir)!.values.set("memory.peak", `${700 * 1024 ** 2}\n`);
    // ホストが取り残した claude CLI（協力しないプロセス）が居ることにする
    fsx.nodes.get(bagDir)!.procs.push(20001);

    await p.close(worker.sessionId, "done");

    assert.equal(fsx.nodes.has(bagDir), false, "袋が残っている");
    const closed = p.events().find((e) => e.type === "worker_closed");
    const memory = closed!.data["memory"] as Record<string, unknown>;
    assert.equal(memory["peakBytes"], 700 * 1024 ** 2, "消す前に読めていない");
  });

  it("落ちる前に生きていた職人の袋は、起き直しても掃除で消さない（決定44）", async () => {
    const fsx = productionShapedTree();
    const first = makePool(prepared(fsx));
    const worker = await first.delegate(delegateInput);
    const bagDir = `${SUPERVISOR}/w-banto-task-0149`;
    fsx.nodes.get(bagDir)!.procs.push(20002); // まだ働いている
    first.dispose();

    // 工房だけ立て直す（台帳は同じ置き場から読み直される）
    pool = new WorkerPool({
      driver,
      dataDir: dir,
      defaultProjectTag: "banto",
      childPidProbe: false,
      cgroups: prepared(fsx),
    });
    assert.ok(fsx.nodes.has(bagDir), "生きている職人の袋を掃除で消してしまった");
    assert.ok(pool.get(worker.sessionId), "台帳から職人が消えた");
  });
});
