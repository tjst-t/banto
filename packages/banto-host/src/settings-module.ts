/**
 * 設定画面（決定41・task-0047）。
 *
 * **画面はここ1つで、区画は集めてくる。** Banto 中核の区画（LLM・場所・接続）に加えて、
 * 登録されているモジュールが宣言した区画（`BantoModule.settings`）を並べる。モジュールが
 * 増えても画面のコードは変わらない——**描くのは宣言からで、GUI は受け取らない**。
 *
 * **設定の口は `internalTools`**（決定29e と同じ枠）。番頭には渡さない——設定を番頭が
 * 書き換えられると、場所の許可も上限も自分で広げられる（決定38b の自己昇格）。
 * 書き込み許可のパネル（task-0042）と同じ形で、機構として分けてある。
 */

import { Type } from "typebox";
import { resolveSettingsFields } from "@banto/core";
import type { ModuleSettingsSpec, SettingField, SettingsSection } from "@banto/core";
import { defineNamespacedTool, type NamespacedToolDefinition } from "./tool-registry.js";
import type { BantoModule, ModuleRegistry } from "./module.js";
import type { SettingsStore } from "./settings-store.js";

export const SETTINGS_BASE_URL = "/api/settings";

/** 区画1つ分（画面へ渡す形）。`fields` は宣言、`values` はいまの値。 */
interface SettingsSectionView {
  id: string;
  title: string;
  description?: string;
  /** どこから来た区画か。`core` は Banto 自身、それ以外はモジュール名。 */
  origin: string;
  /** 由来の表示名（モジュールの `title`）。画面が「どこが公開しているか」を出すため。 */
  originTitle: string;
  fields: SettingField[];
  /** 項目で表せない中核の区画が指定する描き先（ADR-0011 決定43）。 */
  view?: string;
  values: Record<string, unknown>;
}

export interface SettingsModuleOptions {
  /** Banto 中核の区画（LLM・場所・接続）。 */
  core: Array<{ id: string; spec: ModuleSettingsSpec }>;
  /** モジュールの帳簿。宣言している区画を集める。 */
  modules: ModuleRegistry;
  /** 設定の保存先。画面に「どこに保存しているか」を出すため。 */
  store: SettingsStore;
  /**
   * **選べるバックエンドと、その下のモデル**（PO裁定 2026-08-13）。
   *
   * 会話の途中で切り替える画面が使う。**番頭には渡さない**（`internalTools`）
   * ——モデルの選び直しは人の操作で、番頭の道具ではない。
   */
  harnessOptions?: () => Promise<HarnessBackendOption[]> | HarnessBackendOption[];
}

/** バックエンド → プロバイダ → モデル の3段（`opus` は pi 経由でも SDK 経由でも選べる）。 */
export interface HarnessBackendOption {
  id: string;
  label: string;
  /** 使えない理由（認証が無い等）。あるときは画面で選ばせない。 */
  unavailable?: string;
  providers: Array<{
    id: string;
    label?: string;
    models: Array<{ id: string; name?: string; vision?: boolean; contextWindow?: number }>;
  }>;
}

/**
 * ホストの設定ファイルの一区画を、モジュールへ貸す（`SettingsSection`）。
 *
 * 自前の保存先を持ちたくないモジュールのため。使うかはモジュールの自由。
 */
export function settingsSection(store: SettingsStore, name: string): SettingsSection {
  return {
    read: () => (store.all().modules?.[name] ?? {}) as Record<string, unknown>,
    write: (values) => {
      const current = store.all().modules ?? {};
      store.update("modules", { ...current, [name]: values });
    },
  };
}

export function createSettingsModule(options: SettingsModuleOptions): BantoModule {
  const sections = (): Array<{
    id: string;
    origin: string;
    originTitle: string;
    spec: ModuleSettingsSpec;
  }> => [
    ...options.core.map((c) => ({
      id: c.id,
      origin: "core",
      originTitle: "Banto 本体",
      spec: c.spec,
    })),
    // モジュールが宣言した区画。宣言していないモジュールは出ない
    ...options.modules
      .list()
      .filter((m) => m.settings)
      .map((m) => ({ id: m.name, origin: m.name, originTitle: m.title, spec: m.settings! })),
  ];

  /**
   * 画面が「バックエンド → プロバイダ → モデル」を出すための一覧。
   *
   * **バックエンドは provider の上位の階層**——同じ `opus` が pi（opencode zen）経由でも
   * Claude Code 経由でも選べるので、モデル名からは決まらない（PO裁定 2026-08-13）。
   */
  const harnessModels = defineNamespacedTool({
    name: "settings.harness_models",
    label: "Settings: Harness models",
    description: "選べるバックエンドと、その下のプロバイダ・モデルを返す（画面用）。",
    parameters: Type.Object({}),
    async execute() {
      const backends = (await options.harnessOptions?.()) ?? [];
      return {
        content: [{ type: "text" as const, text: `${backends.length} 個のバックエンド` }],
        details: { backends },
      };
    },
  });

  const describe = defineNamespacedTool({
    name: "settings.describe",
    label: "Settings: Describe",
    description: "設定画面が描くための、区画の宣言と現在の値（GUI用）。",
    parameters: Type.Object({}),
    async execute() {
      const views: SettingsSectionView[] = [];
      for (const { id, origin, originTitle, spec } of sections()) {
        let values: Record<string, unknown> = {};
        // 宣言は**開くたびに解決する**（選択肢が動く区画があるため。PO要望 2026-08-10）
        let fields: SettingField[] = [];
        try {
          values = await spec.read();
        } catch (err) {
          // I2: 1区画が読めなくても他は出す。ただし黙らせない
          console.error(`[banto] 設定「${spec.title}」を読めませんでした: ${String(err)}`);
        }
        try {
          fields = await resolveSettingsFields(spec);
        } catch (err) {
          // I2: 選択肢を数え上げられなかったことを「項目なし」に見せない
          console.error(`[banto] 設定「${spec.title}」の項目を組み立てられませんでした: ${String(err)}`);
        }
        views.push({
          id,
          title: spec.title,
          ...(spec.description ? { description: spec.description } : {}),
          origin,
          originTitle,
          fields,
          ...(spec.view ? { view: spec.view } : {}),
          values,
        });
      }
      return {
        content: [{ type: "text" as const, text: `${views.length} 区画` }],
        details: { sections: views, storedAt: options.store.location() },
      };
    },
  });

  const update = defineNamespacedTool({
    name: "settings.update",
    label: "Settings: Update",
    description: "設定を変える（GUI用）。触った項目だけを送る。",
    parameters: Type.Object({
      section: Type.String({ description: "区画の id" }),
      values: Type.Object({}, { additionalProperties: true, description: "変えた項目だけ" }),
    }),
    async execute(params) {
      const target = sections().find((s) => s.id === params.section);
      // I2: 知らない区画を黙って捨てない（設定したつもりで効いていない、が起きる）
      if (!target) {
        throw new Error(
          `設定の区画「${params.section}」はありません。ある区画: ${sections()
            .map((s) => s.id)
            .join(", ")}`
        );
      }
      const result = await target.spec.write(params.values as Record<string, unknown>);
      return {
        content: [
          {
            type: "text" as const,
            text:
              result.message ??
              (result.applied ? "設定を変えました。" : "設定を保存しました（次の起動から効きます）。"),
          },
        ],
        details: { section: params.section, ...result },
      };
    },
  });

  return {
    name: "settings",
    title: "設定",
    description:
      "Banto とモジュールの設定。番頭には渡さない口で、POが画面から変える" +
      "（設定を番頭が書き換えられると、場所の許可も上限も自分で広げられる）。",
    endpoint: { baseUrl: SETTINGS_BASE_URL },
    // 番頭には1本も渡さない（決定38b の自己昇格を機構で塞ぐ）
    tools: [],
    internalTools: [
      describe,
      update,
      ...(options.harnessOptions ? [harnessModels] : []),
    ] as NamespacedToolDefinition[],
    // **キャンバスの面にはしない**（PO要望 2026-08-01）。設定は Banto の一級の機能で、
    // 会話と同じヘッダーの右端から開く独立した面（prototype の3面構成：
    // セッション面／履歴面／設定面）。番頭が canvas.open で出すものでもない
    views: [],
    skills: [],
  };
}
