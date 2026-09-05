// docs/specs/v4-architecture.md §2.6「層2：runtime config」の実装。
// 別の設定ストアを作らず、Event Store自体のイベント型として載せる（規則3）。
// 既定で全項目がProject単位に上書き可能——上書きさせたくない項目だけ
// ブラックリストで塞ぐ（既定は開いている）。

import type { StoredEvent } from "../event-store/log.js";
import type { Fold } from "../event-store/snapshot.js";
import type { EventLog } from "../event-store/log.js";
import { SnapshotProjection } from "../event-store/snapshot.js";

export type RuntimeConfigValue = string | number | boolean;

export interface RuntimeConfigState {
  instance: Map<string, RuntimeConfigValue>;
  projectOverrides: Map<string, Map<string, RuntimeConfigValue>>;
}

export type RuntimeConfigEvent =
  | { type: "config.instance_set"; payload: { key: string; value: RuntimeConfigValue } }
  | {
      type: "config.project_set";
      payload: { projectId: string; key: string; value: RuntimeConfigValue };
    }
  | { type: "config.project_unset"; payload: { projectId: string; key: string } };

export const runtimeConfigFold: Fold<RuntimeConfigState> = {
  initial: () => ({ instance: new Map(), projectOverrides: new Map() }),
  apply(state, raw: StoredEvent): RuntimeConfigState {
    const event = raw as unknown as RuntimeConfigEvent;
    const instance = new Map(state.instance);
    const projectOverrides = new Map(
      Array.from(state.projectOverrides, ([k, v]) => [k, new Map(v)] as const),
    );

    switch (event.type) {
      case "config.instance_set":
        instance.set(event.payload.key, event.payload.value);
        break;
      case "config.project_set": {
        const m = projectOverrides.get(event.payload.projectId) ?? new Map();
        m.set(event.payload.key, event.payload.value);
        projectOverrides.set(event.payload.projectId, m);
        break;
      }
      case "config.project_unset": {
        const m = projectOverrides.get(event.payload.projectId);
        m?.delete(event.payload.key);
        break;
      }
    }
    return { instance, projectOverrides };
  },
};

/** Project単位で上書きさせない項目。既定は開いている——ここに書いたものだけ塞ぐ。 */
export const NON_OVERRIDABLE_KEYS = new Set<string>([
  // 例: "instanceId" のような、Project単位で意味を持たない項目をここに足す
]);

export class ConfigNotOverridableError extends Error {}

export class RuntimeConfigStore {
  private readonly projection: SnapshotProjection<RuntimeConfigState>;

  constructor(dataDir: string, private readonly log: EventLog) {
    this.projection = new SnapshotProjection(dataDir, "runtime-config", log, runtimeConfigFold);
  }

  async load(): Promise<void> {
    await this.projection.load();
  }
  async save(): Promise<void> {
    await this.projection.save();
  }

  /** カスケード解決：Project上書き → instance既定。 */
  resolve(key: string, projectId?: string): RuntimeConfigValue | undefined {
    if (projectId) {
      const override = this.projection.current.projectOverrides.get(projectId)?.get(key);
      if (override !== undefined) return override;
    }
    return this.projection.current.instance.get(key);
  }

  async setInstanceDefault(key: string, value: RuntimeConfigValue): Promise<void> {
    const event = await this.log.append("config.instance_set", { key, value });
    this.projection.applyOne(event);
  }

  async setProjectOverride(projectId: string, key: string, value: RuntimeConfigValue): Promise<void> {
    if (NON_OVERRIDABLE_KEYS.has(key)) {
      throw new ConfigNotOverridableError(`${key} はProject単位で上書きできません`);
    }
    const event = await this.log.append("config.project_set", { projectId, key, value });
    this.projection.applyOne(event);
  }

  async unsetProjectOverride(projectId: string, key: string): Promise<void> {
    const event = await this.log.append("config.project_unset", { projectId, key });
    this.projection.applyOne(event);
  }
}
