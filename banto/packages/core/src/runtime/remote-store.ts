// **登録した別のサーバの一覧**（決定・2026-10-08、`docs/specs/v4-security.md` §1「登録と選び方」）。
//
// 別の設定ストアを作らず、Event Store のイベント型として載せる（`config/runtime.ts` と同じ。規則3）。
// 1件は名前（＝id。Project の記録の `remote:<名前>`）・SSH の宛先・鍵（Vault の ssh-identity の alias だけ。値は持たない）・
// 向こうの置き場の根・**人が確かめて覚えた host 鍵**。覚えた鍵と違う鍵が返ってきたら、それも記録する（繋がない理由を画面に
// 出し続けるため。人が「覚え直す」を押すまで消えない）。前提の確かめの最後の結果も持つ（一覧に出す）。

import type { EventLog, StoredEvent } from "../event-store/log.js";
import type { Fold } from "../event-store/snapshot.js";
import { SnapshotProjection } from "../event-store/snapshot.js";
import type { HostKey, RuntimeCheck } from "./ssh.js";

/** この機械のコンテナ（既定）。Project の記録に `runtime` が無いものもこれ */
export const HOST_CONTAINER_RUNTIME = "host-container";
/** Project の記録の、別のサーバの印の前置き */
export const REMOTE_RUNTIME_PREFIX = "remote:";

/**
 * 別のサーバの動かし方（決定・2026-10-17、v4-security.md §1「別のサーバの中のコンテナ」）：`machine` は向こうのユーザーで直に
 * 動かし、サーバ丸ごとが1つの Project の箱。`containers` は Project ごとに Incus のコンテナを立てる（1台に Project を複数）。
 * 登録のときに決め、あとから変えない。前の記録（動かし方が無い）は `machine`
 */
export type RemoteRuntimeMode = "machine" | "containers";

/** 既定の向こうの置き場の根 */
export const DEFAULT_REMOTE_DATA_ROOT = "~/.local/share/banto-remote";

export interface RemoteRuntimeInput {
  /** 名前（一覧と選ぶ画面に出す。id も兼ねる——あとから変えない） */
  name: string;
  host: string;
  user: string;
  port: number;
  /** Vault の ssh-identity の alias */
  identity: string;
  /** 向こうの置き場の根 */
  dataRoot: string;
  /** 動かし方 */
  mode: RemoteRuntimeMode;
}

export interface RemoteRuntime extends RemoteRuntimeInput {
  /** 人が確かめて覚えた host 鍵 */
  hostKey: HostKey & { confirmedAt: string };
  /** 覚えた鍵と違う鍵が返ってきた（繋がない）。人が覚え直すまで残す */
  hostKeyMismatch?: HostKey & { seenAt: string };
  /** 最後に確かめた前提 */
  checks: RuntimeCheck[];
  checkedAt: string;
  registeredAt: string;
}

export interface RemoteRuntimeState {
  runtimes: Map<string, RemoteRuntime>;
}

export type RemoteRuntimeEvent =
  // 動かし方を持つ前の記録には `mode` が無い
  | { type: "runtime.remote_registered"; payload: { runtime: Omit<RemoteRuntimeInput, "mode"> & { mode?: RemoteRuntimeMode }; hostKey: HostKey; checks: RuntimeCheck[] } }
  | { type: "runtime.remote_checked"; payload: { name: string; checks: RuntimeCheck[] } }
  | { type: "runtime.remote_host_key_mismatch"; payload: { name: string; hostKey: HostKey } }
  | { type: "runtime.remote_host_key_accepted"; payload: { name: string; hostKey: HostKey } }
  | { type: "runtime.remote_removed"; payload: { name: string } };

export const remoteRuntimeFold: Fold<RemoteRuntimeState> = {
  initial: () => ({ runtimes: new Map() }),
  apply(state, raw: StoredEvent): RemoteRuntimeState {
    const event = raw as unknown as RemoteRuntimeEvent;
    if (!event.type.startsWith("runtime.remote_")) return state;
    const runtimes = new Map(state.runtimes);
    switch (event.type) {
      case "runtime.remote_registered": {
        const { runtime, hostKey, checks } = event.payload;
        runtimes.set(runtime.name, {
          ...runtime,
          mode: runtime.mode ?? "machine",
          hostKey: { ...hostKey, confirmedAt: raw.ts },
          checks,
          checkedAt: raw.ts,
          registeredAt: raw.ts,
        });
        break;
      }
      case "runtime.remote_checked": {
        const r = runtimes.get(event.payload.name);
        if (r) runtimes.set(r.name, { ...r, checks: event.payload.checks, checkedAt: raw.ts });
        break;
      }
      case "runtime.remote_host_key_mismatch": {
        const r = runtimes.get(event.payload.name);
        if (r) runtimes.set(r.name, { ...r, hostKeyMismatch: { ...event.payload.hostKey, seenAt: raw.ts } });
        break;
      }
      case "runtime.remote_host_key_accepted": {
        const r = runtimes.get(event.payload.name);
        if (r) {
          const { hostKeyMismatch: _dropped, ...rest } = r;
          runtimes.set(r.name, { ...rest, hostKey: { ...event.payload.hostKey, confirmedAt: raw.ts } });
        }
        break;
      }
      case "runtime.remote_removed":
        runtimes.delete(event.payload.name);
        break;
    }
    return { runtimes };
  },
};

export class RemoteRuntimeStore {
  private readonly projection: SnapshotProjection<RemoteRuntimeState>;

  constructor(dataDir: string, private readonly log: EventLog) {
    this.projection = new SnapshotProjection(dataDir, "remote-runtimes", log, remoteRuntimeFold);
  }

  async load(): Promise<void> {
    await this.projection.load();
  }
  async save(): Promise<void> {
    await this.projection.save();
  }

  list(): RemoteRuntime[] {
    return [...this.projection.current.runtimes.values()].sort((a, b) => a.registeredAt.localeCompare(b.registeredAt));
  }

  get(name: string): RemoteRuntime | undefined {
    return this.projection.current.runtimes.get(name);
  }

  async register(runtime: RemoteRuntimeInput, hostKey: HostKey, checks: RuntimeCheck[]): Promise<RemoteRuntime> {
    await this.append({ type: "runtime.remote_registered", payload: { runtime, hostKey, checks } });
    return this.get(runtime.name)!;
  }

  async recordChecks(name: string, checks: RuntimeCheck[]): Promise<void> {
    await this.append({ type: "runtime.remote_checked", payload: { name, checks } });
  }

  async recordMismatch(name: string, hostKey: HostKey): Promise<void> {
    await this.append({ type: "runtime.remote_host_key_mismatch", payload: { name, hostKey } });
  }

  async acceptHostKey(name: string, hostKey: HostKey): Promise<void> {
    await this.append({ type: "runtime.remote_host_key_accepted", payload: { name, hostKey } });
  }

  async remove(name: string): Promise<void> {
    await this.append({ type: "runtime.remote_removed", payload: { name } });
  }

  private async append(event: RemoteRuntimeEvent): Promise<void> {
    const stored = await this.log.append(event.type, event.payload);
    this.projection.applyOne(stored);
  }
}
