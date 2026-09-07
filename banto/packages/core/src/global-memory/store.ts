// docs/specs/v4-architecture.md §2.2「Global Memory」（決定・2026-09-05）。
// banto 全体で覚えておくこと——人の名前・呼ばれ方・Project に紐づかない好み。
//
// **Project Memory と同じ規律をそのまま使う**（新しい機構を作らない）：
// 追記のみ・訂正は無効化イベント・上限を超えたら追記を拒否（G5）。
// 走行中の Thread には効かせない（Thread 作成時に確定、§2.3）——増えた分は
// Project Memory と同じくターンに添えて届ける。
//
// **Phase 0 では人が書くだけ。** AI から書く経路（tool）は開けない——
// 「人の名前」を勝手に書き換える経路を、観測の仕組みが揃う前に作らない。

import type { EventLog, StoredEvent } from "../event-store/log.js";
import type { Fold } from "../event-store/snapshot.js";
import { SnapshotProjection } from "../event-store/snapshot.js";
import { MEMORY_ENTRY_MAX_CHARS, MemoryLimitExceededError } from "../project-thread/store.js";
import type { MemoryEntry } from "../project-thread/types.js";

interface GlobalMemoryReadModel {
  entries: MemoryEntry[];
}

type GlobalMemoryEvent =
  | { type: "global_memory.appended"; payload: { text: string } }
  | { type: "global_memory.invalidated"; payload: { targetSeq: number } };

export const globalMemoryFold: Fold<GlobalMemoryReadModel> = {
  initial: () => ({ entries: [] }),

  apply(state, raw: StoredEvent): GlobalMemoryReadModel {
    const event = raw as unknown as GlobalMemoryEvent;
    switch (event.type) {
      case "global_memory.appended":
        return { entries: [...state.entries, { seq: raw.seq, text: event.payload.text }] };
      case "global_memory.invalidated":
        return {
          entries: state.entries.map((m) =>
            m.seq === event.payload.targetSeq && m.invalidatedAtSeq === undefined
              ? { ...m, invalidatedAtSeq: raw.seq }
              : m,
          ),
        };
      default:
        return state;
    }
  },
};

export class GlobalMemoryStore {
  private readonly projection: SnapshotProjection<GlobalMemoryReadModel>;

  constructor(dataDir: string, private readonly log: EventLog) {
    this.projection = new SnapshotProjection(dataDir, "global-memory", log, globalMemoryFold);
  }

  async load(): Promise<void> {
    await this.projection.load();
  }

  async save(): Promise<void> {
    await this.projection.save();
  }

  list(): MemoryEntry[] {
    return this.projection.current.entries;
  }

  async append(text: string): Promise<void> {
    if (text.length > MEMORY_ENTRY_MAX_CHARS) {
      throw new MemoryLimitExceededError(
        `Global Memory entry exceeds ${MEMORY_ENTRY_MAX_CHARS} chars (${text.length})`,
      );
    }
    const event = await this.log.append("global_memory.appended", { text });
    this.projection.applyOne(event);
  }

  async invalidate(targetSeq: number): Promise<void> {
    const event = await this.log.append("global_memory.invalidated", { targetSeq });
    this.projection.applyOne(event);
  }
}
