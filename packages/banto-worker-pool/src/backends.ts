/**
 * 職人のバックエンド（ランタイム）と、等級ごとのモデルの割り当て（PO要望 2026-08-10）。
 *
 * ## なぜここに置くか
 *
 * 職人が何で動くか（pi / Claude Code / 将来の Codex）と、どの等級にどのモデルを当てるかは
 * **職人の設定**である。LLM Registry（「LLM・モデル」の区画）が持つのは*素材と採用*
 * ——どのプロバイダに鍵があり、どのモデルを職人に使ってよいか——までで、
 * 「職人の既定」をあちらに置くと、pi のモデルだけが特別扱いになる（Claude Code の
 * モデルは登録に載らないので並べられない）。
 *
 * ここに一本化すると、**どのバックエンドのモデルも同じ1つの割り当て表**に並ぶ:
 *
 *     reasoning → opus（Claude Code）
 *     standard  → opencode-go/deepseek-v4-flash（pi）
 *     fast      → （指定なし＝ランタイムの既定解決に任せる）
 *
 * D3: 割り当ての真実はここ1つ。ドライバは渡されたモデルで起こすだけ。
 * D5: 判断は無い。どれを当てるかは PO が決める。
 */

import type { RuntimeDriver, SettingsSection } from "@banto/core";

/** 等級（`@banto/core` の ModelTier と同じ並び）。 */
export type WorkerTier = "reasoning" | "standard" | "fast";

export const WORKER_TIERS: readonly WorkerTier[] = ["reasoning", "standard", "fast"];

/** 使えるかどうかの見立て。**分からないなら分からないと言う**（I1）。 */
export interface BackendAvailability {
  ok: boolean;
  /** 画面に出す一言（「認証あり」「claude が見つかりません」など）。 */
  detail: string;
}

/** ランタイムを1つ登録する形。ドライバだけ渡す旧い形も受ける。 */
export interface RuntimeRegistration {
  driver: RuntimeDriver;
  /** 画面に出す名前（「Claude Code」）。省略時は識別子。 */
  title?: string;
  description?: string;
  /** 使える状態かを確かめる（鍵・バイナリの有無）。省略すると「確かめていない」。 */
  probe?: () => BackendAvailability;
  /** このバックエンドが自前で持っているモデルの名前（Claude Code の別名など）。 */
  models?: () => Array<{ name: string; label: string }>;
  /**
   * 割り当てが無い等級を渡されたら、このバックエンドは何を使うか。
   *
   * **画面に「指定なしのときはこれになります」を出すために要る。** 解決の仕方は
   * バックエンドごとに違う（pi は LLM Registry の第一候補、Claude Code は等級の別名）ので、
   * 工房が代表して答えると**既定を切り替えたときに嘘になる**——実機でそれを出していた。
   */
  resolveTier?: (tier: WorkerTier) => string | undefined;
}

/** 画面に出す1つ分。 */
export interface BackendView {
  id: string;
  title: string;
  description?: string;
  /** 使える状態か（確かめられないときは undefined）。 */
  available?: boolean;
  detail?: string;
  enabled: boolean;
  isDefault: boolean;
  /** このバックエンドから選べるモデルの数。 */
  modelCount: number;
}

/** 保存する形（worker-pool の settings.json に載る）。 */
export interface BackendState {
  /** 既定のバックエンド（`runtime` を指定されなかったときに使う）。 */
  defaultBackend?: string;
  /** 切ってあるバックエンド（**既定は全部入り**——載っている＝使えるつもりで登録している）。 */
  disabled?: string[];
  /** 職人の既定の等級（タスクにも番頭にも指定が無いとき）。 */
  defaultTier?: WorkerTier;
  /** 等級ごとのモデルの名指し。空＝ランタイムの既定解決に任せる。 */
  tierAssignments?: Partial<Record<WorkerTier, string>>;
}

/**
 * バックエンドと割り当ての帳簿。
 *
 * 保存先は借り物（`SettingsSection`）。持っていなければメモリだけで動く——
 * 試験や、まだ設定を持たない立ち上げのため。
 */
export class BackendRegistry {
  private state: BackendState;

  constructor(
    private readonly runtimes: Map<string, RuntimeRegistration>,
    private readonly fallbackDefault: string,
    private readonly section?: SettingsSection
  ) {
    const saved = section?.read()["backends"];
    this.state = saved && typeof saved === "object" ? { ...(saved as BackendState) } : {};
  }

  /** 既定のバックエンド。切られていたら、生きている中の先頭へ落とす（I2 の例外）。 */
  defaultBackend(): string {
    const wanted = this.state.defaultBackend ?? this.fallbackDefault;
    if (this.isEnabled(wanted) && this.runtimes.has(wanted)) return wanted;
    const alive = [...this.runtimes.keys()].find((id) => this.isEnabled(id));
    return alive ?? this.fallbackDefault;
  }

  isEnabled(id: string): boolean {
    return !(this.state.disabled ?? []).includes(id);
  }

  defaultTier(): WorkerTier | undefined {
    return this.state.defaultTier;
  }

  /** 等級に当てられたモデル（無ければ undefined＝ランタイムの既定解決に任せる）。 */
  assignedModel(tier: WorkerTier | undefined): string | undefined {
    const key = tier ?? this.state.defaultTier;
    if (!key) return undefined;
    const assigned = this.state.tierAssignments?.[key];
    return assigned && assigned.trim().length > 0 ? assigned : undefined;
  }

  assignments(): Partial<Record<WorkerTier, string>> {
    return { ...(this.state.tierAssignments ?? {}) };
  }

  /** 画面に出す一覧。 */
  list(modelCountOf: (id: string) => number): BackendView[] {
    const def = this.defaultBackend();
    return [...this.runtimes.entries()].map(([id, reg]) => {
      const probed = reg.probe?.();
      return {
        id,
        title: reg.title ?? id,
        ...(reg.description ? { description: reg.description } : {}),
        ...(probed ? { available: probed.ok, detail: probed.detail } : {}),
        enabled: this.isEnabled(id),
        isDefault: id === def,
        modelCount: modelCountOf(id),
      };
    });
  }

  /**
   * バックエンドを切り替える。
   *
   * I2: 知らないバックエンド・最後の1つを切る操作は断る——全部切ると職人を1人も
   *     起こせなくなり、それが分かるのは次に仕事を頼んだときになる。
   */
  setBackend(id: string, next: { enabled?: boolean; makeDefault?: boolean }): void {
    if (!this.runtimes.has(id)) {
      throw new Error(`知らないバックエンドです: ${id}（あるのは ${[...this.runtimes.keys()].join(", ")}）`);
    }
    if (next.enabled === false) {
      const others = [...this.runtimes.keys()].filter((other) => other !== id && this.isEnabled(other));
      if (others.length === 0) {
        throw new Error("最後のバックエンドは切れません（職人を起こせなくなります）。");
      }
      this.state.disabled = [...new Set([...(this.state.disabled ?? []), id])];
      // 切ったものが既定だったなら、既定も動かす（切ったのに既定のまま、を残さない）
      if (this.state.defaultBackend === id || this.defaultBackend() === id) {
        this.state.defaultBackend = others[0]!;
      }
    }
    if (next.enabled === true) {
      this.state.disabled = (this.state.disabled ?? []).filter((other) => other !== id);
    }
    if (next.makeDefault) {
      if (!this.isEnabled(id)) {
        throw new Error(`${id} は切ってあります。既定にするなら先に入れてください。`);
      }
      this.state.defaultBackend = id;
    }
    this.save();
  }

  /** 等級にモデルを当てる（空文字で解除）。 */
  setAssignment(tier: WorkerTier, model: string | undefined): void {
    const next = { ...(this.state.tierAssignments ?? {}) };
    if (!model || model.trim().length === 0) delete next[tier];
    else next[tier] = model.trim();
    this.state.tierAssignments = next;
    this.save();
  }

  /** 職人の既定の等級。 */
  setDefaultTier(tier: WorkerTier): void {
    this.state.defaultTier = tier;
    this.save();
  }

  private save(): void {
    this.section?.write({ ...(this.section.read() ?? {}), backends: this.state });
  }
}
