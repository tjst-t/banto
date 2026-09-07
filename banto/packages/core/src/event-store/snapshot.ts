// 「畳んだ状態を安く得る」ための増分適用＋スナップショット（アーキ仕様§2.1）。
// 各read model（Project/Thread・Configuration・Inbox等）がこれを1つずつ持つ——
// EventLog自体はスナップショットの概念を知らない（関心の分離）。

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EventLog, StoredEvent } from "./log.js";

export interface Fold<S> {
  initial(): S;
  apply(state: S, event: StoredEvent): S;
}

// JSON は Map/Set を表現できない——素の JSON.stringify(state) だと
// Map が {} になり、読み戻すと壊れる（実測で発見）。read model の状態は
// Map を多用するので、汎用の replacer/reviver でここだけ吸収する。
const MAP_TAG = "__banto_map__";

function snapshotReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) {
    return { [MAP_TAG]: true, entries: Array.from(value.entries()) };
  }
  return value;
}

function snapshotReviver(_key: string, value: unknown): unknown {
  if (typeof value === "object" && value !== null && (value as Record<string, unknown>)[MAP_TAG]) {
    return new Map((value as { entries: [unknown, unknown][] }).entries);
  }
  return value;
}

interface SnapshotFile<S> {
  seq: number;
  state: S;
}

/**
 * fold関数と EventLog から、常に最新の状態を安く得られるようにする。
 * 起動時：スナップショットを読み、それ以降のイベントだけ追いかける。
 * 定期的に（呼び出し側が判断したタイミングで）スナップショットを書き出す。
 */
export class SnapshotProjection<S> {
  private state: S;
  private seq = 0;
  private readonly snapshotPath: string;

  /**
   * `version` は **read model の形**の版（イベントの版ではない）。
   * スナップショットは Event Store から導出した写しにすぎないので、形を変えたら
   * **古い写しは読まずに捨て、ログから作り直す**のが正しい（規則3）。版を上げると
   * ファイル名が変わり、古いファイルは読まれない——**version を上げ忘れると、
   * 古い形のオブジェクトが新しいコードに流れ込む**（2026-09-05、Memory を
   * Project 持ちに変えたときに踏みかけた）。
   */
  constructor(
    private readonly dataDir: string,
    private readonly name: string,
    private readonly log: EventLog,
    private readonly fold: Fold<S>,
    version = 1,
  ) {
    const suffix = version === 1 ? "" : `.v${version}`;
    this.snapshotPath = join(dataDir, `${name}${suffix}.snapshot.json`);
    this.state = fold.initial();
  }

  /** スナップショットを読み、ログの続きを fold して最新化する。 */
  async load(): Promise<void> {
    if (existsSync(this.snapshotPath)) {
      const raw = await readFile(this.snapshotPath, "utf8");
      const snap = JSON.parse(raw, snapshotReviver) as SnapshotFile<S>;
      this.state = snap.state;
      this.seq = snap.seq;
    }
    for await (const event of this.log.readFrom(this.seq)) {
      this.state = this.fold.apply(this.state, event);
      this.seq = event.seq;
    }
  }

  /** 新規イベントを1件だけ取り込む（appendの直後に呼ぶ想定）。 */
  applyOne(event: StoredEvent): void {
    if (event.seq <= this.seq) return;
    this.state = this.fold.apply(this.state, event);
    this.seq = event.seq;
  }

  get current(): S {
    return this.state;
  }

  get appliedSeq(): number {
    return this.seq;
  }

  /** アトミックに書き出す（tmpファイル→rename、途中状態を見せない）。 */
  async save(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const tmpPath = `${this.snapshotPath}.tmp`;
    const snap: SnapshotFile<S> = { seq: this.seq, state: this.state };
    await writeFile(tmpPath, JSON.stringify(snap, snapshotReplacer), "utf8");
    await rename(tmpPath, this.snapshotPath);
  }
}
