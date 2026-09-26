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
  /** 実際に動くモデルの ID（`default` → `claude-opus-5[1m]` のように、別名が指す先） */
  resolvedModel?: string;
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
    ...(m.resolvedModel ? { resolvedModel: m.resolvedModel } : {}),
  }));
}

/** AI 自身に伝える「いま動いているモデル」（決定・2026-09-24、`runner/system-prompt.ts`）。 */
export interface ModelIdentity {
  /** 人の読む名前（`Opus 5 with 1M context` 等） */
  name: string;
  /** 実際のモデル ID（`claude-opus-5[1m]` 等） */
  id: string;
}

/**
 * Thread が選んだモデル（無ければ既定）を、AI に伝える名前と ID にする。
 *
 * **名前は説明文の「·」より前**を使う——CLI の一覧の `displayName` は「Default
 * (recommended)」のように役割の名前で、モデルの名前ではない。説明文は
 * 「Opus 5 with 1M context · Best for …」の形（実測・2026-09-23）。その形でなければ
 * `displayName` を使う。**ID は別名の行き先**（`resolvedModel`）——既定のままの会話でも、
 * 実際に動いているモデルを言える。一覧に無ければ undefined（言わない）。
 */
export function modelIdentityOf(choices: readonly ModelChoice[], model: string | undefined): ModelIdentity | undefined {
  const choice = choices.find((c) => c.value === (model ?? DEFAULT_MODEL_VALUE));
  if (!choice) return undefined;
  const fromDescription = choice.description.split(" · ")[0]?.trim();
  const name = fromDescription && choice.description.includes(" · ") ? fromDescription : choice.displayName;
  return { name, id: choice.resolvedModel ?? choice.value };
}

const TTL_MS = 10 * 60 * 1000;

export class ModelCatalog {
  private cached: { at: number; choices: ModelChoice[] } | undefined;
  private inflight: Promise<ModelChoice[]> | undefined;

  constructor(
    private readonly load: () => Promise<ModelInfo[]>,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * **期限が切れても、前に取ったものがあればすぐ返す**（改訂・2026-09-26、実測）。
   * 取り直しは裏で走らせる（stale-while-revalidate）。以前は期限切れのたびに
   * CLI の起動（約 0.6〜0.8 秒）を待ってから答えていた——**10 分あけて送った最初の
   * ターンは、この分だけ遅れて始まった**（ターンの前に AI に伝えるモデル名を引くため）。
   * 取り直しに失敗したら、手元のものを返し続け、次に聞かれたときにまた取りに行く
   * （失敗は覚えない、は今までどおり）。まだ何も持っていないときだけ待つ。
   */
  async list(): Promise<ModelChoice[]> {
    if (this.cached && this.now() - this.cached.at < TTL_MS) return this.cached.choices;
    if (this.cached) {
      const stale = this.cached.choices;
      this.refresh().catch((err: unknown) => {
        console.warn(
          `[host] モデルの一覧を取り直せませんでした（前の一覧を使い続けます）: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      return stale;
    }
    return this.refresh();
  }

  private refresh(): Promise<ModelChoice[]> {
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
