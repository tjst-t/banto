// **選べるモデルの一覧**（決定・2026-09-23、ユーザー要望「入力欄の下でモデルも選べるように」）。
//
// **一覧を自分で持たない**（規則3）——どのモデルが使えるか、どの effort の段があるかは
// アカウントと CLI の版で変わる。SDK の `supportedModels()` がそれを答える（実測・
// 2026-09-23：CLI を起動するだけで API は呼ばず、約0.8秒で返る）。
//
// 毎回 CLI を起動するのは重いので、少しのあいだ覚えておく。**失敗は覚えない**
// ——覚えると、直ったあとも「取れない」と言い続ける。

import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { THREAD_EFFORTS, type ThreadEffort } from "../project-thread/types.js";

/** 画面に出す1件。 */
export interface ModelChoice {
  /** SDK に渡す値（`sonnet`・`opus[1m]` 等）。`default` は「選んでいない」と同じ */
  value: string;
  displayName: string;
  description: string;
  /** このモデルで選べる effort の段（空なら effort を選べない） */
  efforts: ThreadEffort[];
}

/** 「選んでいない」＝ CLI の既定。SDK の一覧にもこの値で載っている。 */
export const DEFAULT_MODEL_VALUE = "default";

export function toChoices(infos: readonly ModelInfo[]): ModelChoice[] {
  return infos.map((m) => ({
    value: m.value,
    displayName: m.displayName,
    description: m.description,
    efforts: m.supportsEffort
      ? (m.supportedEffortLevels ?? []).filter((e): e is ThreadEffort => (THREAD_EFFORTS as readonly string[]).includes(e))
      : [],
  }));
}

const TTL_MS = 10 * 60 * 1000;

export class ModelCatalog {
  private cached: { at: number; choices: ModelChoice[] } | undefined;
  private inflight: Promise<ModelChoice[]> | undefined;

  constructor(
    private readonly load: () => Promise<ModelInfo[]>,
    private readonly now: () => number = Date.now,
  ) {}

  async list(): Promise<ModelChoice[]> {
    if (this.cached && this.now() - this.cached.at < TTL_MS) return this.cached.choices;
    // 同時に何本来ても、CLI は1本しか起こさない
    this.inflight ??= this.load()
      .then((infos) => {
        const choices = toChoices(infos);
        if (choices.length === 0) throw new Error("使えるモデルが1つも返ってきませんでした");
        this.cached = { at: this.now(), choices };
        return choices;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }
}
