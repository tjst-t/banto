/**
 * task-0007: 記憶システム第一層（好み・習慣）の受け入れ検証。ADR-0010 決定10 / D11。
 *
 * テストは MemoryStore **インターフェース**に対して書く（受け入れ条件 a4）。
 * 将来 SQLite 実装を足したときは、下の runMemoryStoreContract() に別のファクトリを
 * 渡すだけで同一のテストが走り、保存形式を変えても振る舞いが変わらないことを示せる。
 *
 * Kobo には接続しない。番頭の記憶は番頭核の中で完結する。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  JsonlMemoryStore,
  type MemoryInput,
  type MemoryQuery,
  type MemoryRecord,
  type MemorySearchQuery,
  type MemoryStore,
} from "@banto/core";

/**
 * MemoryStore の契約テスト。保存形式に依存しない振る舞いだけを検証する。
 *
 * @param name        実装名（テスト表示用）
 * @param createStore 新しい空ストアを返す。同じ引数で呼ぶと同じ保存先を指す
 *                    （プロセス跨ぎの永続性検証に使う）
 */
function runMemoryStoreContract(name: string, createStore: () => MemoryStore): void {
  describe(`[task-0007] MemoryStore contract — ${name}`, () => {
    it("[task-0007/a1] saves a memory and returns it with an id and createdAt", () => {
      const store = createStore();
      const saved = store.save({ kind: "preference", text: "POは統合UIのモックを好む" });

      assert.equal(typeof saved.id, "string");
      assert.ok(saved.id.length > 0);
      assert.equal(saved.kind, "preference");
      assert.equal(saved.text, "POは統合UIのモックを好む");
      assert.ok(!Number.isNaN(Date.parse(saved.createdAt)), "createdAt must be a valid timestamp");
    });

    it("[task-0007/a1] get() returns a saved memory by id, undefined for unknown", () => {
      const store = createStore();
      const saved = store.save({ kind: "habit", text: "テスト結果は自己申告せず直接実行して確認する" });

      assert.deepEqual(store.get(saved.id), saved);
      assert.equal(store.get("no-such-id"), undefined);
    });

    it("[task-0007/a1] list() returns memories in the order they were written", () => {
      const store = createStore();
      store.save({ kind: "preference", text: "1件目" });
      store.save({ kind: "preference", text: "2件目" });
      store.save({ kind: "habit", text: "3件目" });

      assert.deepEqual(store.list().map((r) => r.text), ["1件目", "2件目", "3件目"]);
    });

    it("[task-0007/a1] list() filters by kind", () => {
      const store = createStore();
      store.save({ kind: "preference", text: "好み" });
      store.save({ kind: "habit", text: "習慣" });

      assert.deepEqual(store.list({ kind: "preference" }).map((r) => r.text), ["好み"]);
      assert.deepEqual(store.list({ kind: "habit" }).map((r) => r.text), ["習慣"]);
    });

    it("[task-0007/a1] optional refs round-trip", () => {
      const store = createStore();
      const saved = store.save({ kind: "preference", text: "ADR経由でのみ規則を変える", refs: ["adr-0010"] });

      assert.deepEqual(store.get(saved.id)?.refs, ["adr-0010"]);
    });

    it("[task-0007/a2] memories survive a fresh store instance over the same backing storage", () => {
      const first = createStore();
      first.save({ kind: "preference", text: "セッションを跨いで覚えていてほしい" });

      // 別インスタンス = プロセスを再起動した番頭に相当する
      const second = createStore();
      assert.deepEqual(second.list().map((r) => r.text), ["セッションを跨いで覚えていてほしい"]);
    });

    it("[task-0007/a3] supersede() replaces a memory; only the correction stays active", () => {
      const store = createStore();
      const original = store.save({ kind: "preference", text: "記憶はSQLiteで実装する" });
      const corrected = store.supersede(original.id, {
        kind: "preference",
        text: "記憶は当面JSONLで実装する（Node20のため）",
      });

      assert.equal(corrected.supersedes, original.id);
      assert.deepEqual(
        store.list().map((r) => r.text),
        ["記憶は当面JSONLで実装する（Node20のため）"],
        "superseded memory must drop out of the default view"
      );
    });

    it("[task-0007/a3] superseded memories remain retrievable as history", () => {
      const store = createStore();
      const original = store.save({ kind: "habit", text: "古い習慣" });
      store.supersede(original.id, { kind: "habit", text: "新しい習慣" });

      // 履歴としては残る：idで引けるし、明示すれば一覧にも出る
      assert.equal(store.get(original.id)?.text, "古い習慣");
      assert.deepEqual(
        store.list({ includeSuperseded: true }).map((r) => r.text),
        ["古い習慣", "新しい習慣"]
      );
    });

    it("[task-0007/a3] supersede() on an unknown id throws instead of silently creating (I2)", () => {
      const store = createStore();
      assert.throws(
        () => store.supersede("no-such-id", { kind: "preference", text: "訂正" }),
        /Cannot supersede unknown memory/
      );
      assert.deepEqual(store.list(), [], "nothing should have been written");
    });

    it("[task-0007/a3] a correction can itself be corrected (chained supersede)", () => {
      const store = createStore();
      const v1 = store.save({ kind: "preference", text: "v1" });
      const v2 = store.supersede(v1.id, { kind: "preference", text: "v2" });
      store.supersede(v2.id, { kind: "preference", text: "v3" });

      assert.deepEqual(store.list().map((r) => r.text), ["v3"]);
    });

    it("[task-0007] an empty store lists nothing", () => {
      assert.deepEqual(createStore().list(), []);
    });
  });
}

// ── JSONL 実装をこの契約に通す ───────────────────────────────────────────────

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-memory-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

runMemoryStoreContract("JsonlMemoryStore", () => new JsonlMemoryStore(path.join(dir, "memory.jsonl")));

// ── 契約が保存形式に依存していないことの実証（受け入れ条件 a4）────────────────
//
// 上と同じ契約を、ファイルを一切使わない別実装に対して流す。両方が同じテストを通ることで、
// 契約が JSONL 固有の振る舞いに寄りかかっていないと示せる。将来の SQLite 実装も
// 同じやり方でこの契約に通す（そのとき本番コードの呼び出し側は変更しない）。

/** テスト専用の最小実装。永続化しない以外は JsonlMemoryStore と同じ意味論を持つ。 */
class InMemoryStore implements MemoryStore {
  constructor(private readonly records: MemoryRecord[]) {}

  save(input: MemoryInput): MemoryRecord {
    const record: MemoryRecord = {
      id: `mem-${this.records.length + 1}`,
      kind: input.kind,
      text: input.text,
      createdAt: new Date().toISOString(),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.validFrom ? { validFrom: input.validFrom } : {}),
      ...(input.refs ? { refs: input.refs } : {}),
      ...(input.supersedes ? { supersedes: input.supersedes } : {}),
    };
    this.records.push(record);
    return record;
  }

  get(id: string): MemoryRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  list(query: MemoryQuery = {}): MemoryRecord[] {
    const superseded = new Set(
      this.records.map((r) => r.supersedes).filter((id): id is string => typeof id === "string")
    );
    const forgotten = new Set(
      this.records.map((r) => r.forgets).filter((id): id is string => typeof id === "string")
    );
    return this.records.filter((r) => {
      if (typeof r.forgets === "string") return false;
      if (query.kind && r.kind !== query.kind) return false;
      if (query.origin && (r.origin ?? "explicit") !== query.origin) return false;
      if (!query.includeSuperseded && (superseded.has(r.id) || forgotten.has(r.id))) return false;
      return true;
    });
  }

  supersede(id: string, replacement: Omit<MemoryInput, "supersedes">): MemoryRecord {
    if (!this.get(id)) throw new Error(`Cannot supersede unknown memory "${id}".`);
    return this.save({ ...replacement, supersedes: id });
  }

  forget(id: string, reason?: string): MemoryRecord {
    const target = this.get(id);
    if (!target) throw new Error(`Cannot forget unknown memory "${id}".`);
    const record: MemoryRecord = {
      id: `mem-${this.records.length + 1}`,
      kind: target.kind,
      text: target.text,
      createdAt: new Date().toISOString(),
      forgets: id,
      ...(reason ? { reason } : {}),
    };
    this.records.push(record);
    return record;
  }

  search(query: MemorySearchQuery): MemoryRecord[] {
    const terms = query.text
      .split(/\s+/u)
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0);
    const { text: _text, limit, ...rest } = query;
    const hits = this.list(rest).filter((r) =>
      terms.every((t) => r.text.toLowerCase().includes(t))
    );
    return hits.reverse().slice(0, limit ?? 20);
  }
}

// 配列を beforeEach で作り直すことで「同じ保存先を指す別インスタンス」を再現する
let shared: MemoryRecord[];
beforeEach(() => {
  shared = [];
});
runMemoryStoreContract("InMemoryStore (contract is storage-agnostic)", () => new InMemoryStore(shared));

// ── JSONL 実装に固有の性質（保存形式そのものの検証）─────────────────────────

describe("[task-0007] JsonlMemoryStore — storage-specific behaviour", () => {
  let storageDir: string;

  beforeEach(() => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-memory-jsonl-"));
  });

  afterEach(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it("[task-0007/a3] the file is append-only: superseding never rewrites earlier lines", () => {
    const file = path.join(storageDir, "memory.jsonl");
    const store = new JsonlMemoryStore(file);

    const original = store.save({ kind: "preference", text: "古い" });
    const afterFirstWrite = fs.readFileSync(file, "utf-8");

    store.supersede(original.id, { kind: "preference", text: "新しい" });
    const afterSupersede = fs.readFileSync(file, "utf-8");

    assert.ok(
      afterSupersede.startsWith(afterFirstWrite),
      "existing lines must be preserved verbatim; supersede only appends"
    );
    assert.equal(afterSupersede.trimEnd().split("\n").length, 2);
  });

  it("[task-0007/a3] active/superseded is derived, never persisted (D3)", () => {
    const file = path.join(storageDir, "memory.jsonl");
    const store = new JsonlMemoryStore(file);
    const original = store.save({ kind: "preference", text: "古い" });
    store.supersede(original.id, { kind: "preference", text: "新しい" });

    const raw = fs.readFileSync(file, "utf-8");
    assert.doesNotMatch(raw, /"status"/, "derived status must not be written to disk");
    assert.doesNotMatch(raw, /superseded"\s*:/, "derived flag must not be written to disk");
  });

  it("[task-0007] creates the parent directory if it does not exist", () => {
    const nested = path.join(storageDir, "a", "b", "memory.jsonl");
    const store = new JsonlMemoryStore(nested);
    store.save({ kind: "habit", text: "深い階層でも書ける" });

    assert.ok(fs.existsSync(nested));
  });

  it("[task-0007] a corrupt line raises instead of silently losing memories (I2)", () => {
    const file = path.join(storageDir, "memory.jsonl");
    const store = new JsonlMemoryStore(file);
    store.save({ kind: "preference", text: "正常な記憶" });
    fs.appendFileSync(file, "{ this is not json\n", "utf-8");

    assert.throws(() => store.list(), /Corrupt memory record/);
  });

  it("[task-0007] a well-formed JSON line missing required fields raises (I2)", () => {
    const file = path.join(storageDir, "memory.jsonl");
    const store = new JsonlMemoryStore(file);
    fs.appendFileSync(file, JSON.stringify({ id: "x" }) + "\n", "utf-8");

    assert.throws(() => store.list(), /Invalid memory record/);
  });

  it("[task-0007] blank lines are tolerated", () => {
    const file = path.join(storageDir, "memory.jsonl");
    const store = new JsonlMemoryStore(file);
    store.save({ kind: "preference", text: "記憶" });
    fs.appendFileSync(file, "\n\n", "utf-8");

    assert.deepEqual(store.list().map((r) => r.text), ["記憶"]);
  });
});
