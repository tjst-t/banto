/**
 * Banto 中核が設定画面に出す区画（決定41・task-0047）。
 *
 * モジュールと**同じ契約で自分の分も出す**——中核だけ特別扱いにすると、設定画面が
 * 「中核用の描画」と「モジュール用の描画」を2つ持つことになる。
 *
 * ここが持つのは、モジュールに属さないもの：場所・接続・LLM。
 *
 * LLM だけは項目の宣言で表しきれないため、設定画面が専用の面を描く
 * （ADR-0011 決定43。中核の区画にだけ許した例外で、モジュールには決定41 がそのまま効く）。
 * その面が使う `llm.*` は中核の Tool なので、区画は `view` で描き先だけを宣言する。
 */

import { MODEL_TIERS, TIER_LABELS, isLedgerRole, workerRoleOf } from "@banto/core";
import type {
  LlmCatalog,
  ModelLedger,
  ModelTier,
  ModuleSettingsSpec,
  SettingField,
  ModelRoleResolutionSource,
} from "@banto/core";
import type { ChapterModelResolution } from "./chapter-model.js";
import type { PlaceSetting, SettingsStore } from "./settings-store.js";
import type { BindingDecisionEntry } from "./binding-ledger.js";

/** 場所は1行1件のテキストで扱う（`id:/path:glob,glob`）。表形式は画面が育ってから。 */
function placesToLines(places: readonly PlaceSetting[]): string[] {
  return places.map((p) =>
    p.writable && p.writable.length > 0 ? `${p.id}:${p.path}:${p.writable.join(",")}` : `${p.id}:${p.path}`
  );
}

function linesToPlaces(lines: readonly unknown[]): PlaceSetting[] {
  const places: PlaceSetting[] = [];
  for (const raw of lines) {
    const line = String(raw).trim();
    if (line.length === 0) continue;
    const [id, target, writable] = line.split(":");
    // I2: 壊れた行を黙って飛ばさない。場所が1つ消えると番頭が別の場所を触りうる
    if (!id || !target) {
      throw new Error(`場所の指定が不正です: "${line}"（形式は id:/path または id:/path:glob,glob）`);
    }
    places.push({
      id: id.trim(),
      path: target.trim(),
      ...(writable
        ? { writable: writable.split(",").map((w) => w.trim()).filter((w) => w.length > 0) }
        : {}),
    });
  }
  return places;
}

/** 束縛を画面の値（`backend|provider|model`）へ。 */
function refValue(ref?: { backend?: string; provider: string; model: string }): string {
  return ref ? `${ref.backend ?? "pi"}|${ref.provider}|${ref.model}` : "";
}

/** 束縛の文字列（`backend|provider|model`）を人が読む形（`backend › provider › model`）へ。 */
function toDisplayModel(value: string): string {
  return value ? value.replace(/\|/g, " › ") : "";
}

/**
 * 統合表の選択肢（`backend|provider|model`）を、モジュールの保存形式へ変換する
 * （2026-08-19 提案）。Kobo の `selectableModelNames`（worker.models）は `provider/model`
 * で照合する——pi の値は backend を落とし、Claude Code は別名（`opus` 等）だけ残す。
 */
function toModuleValue(value: string): string {
  const [backend, provider, model] = value.split("|");
  if (backend === "claude-agent-sdk") return model ?? "";
  return provider && model ? `${provider}/${model}` : "";
}

/** 統合表の行の並びグループ（並び順: 番頭 → 職人 → 工場）。 */
export type RoleTableGroup = "steward" | "worker" | "module";

/** 統合表の1行（専用 view `ModelRolesView` が描く形）。 */
export interface RoleTableRow {
  key: string;
  group: RoleTableGroup;
  label: string;
  tierDependent: boolean;
  /** モデル指定（保存形式。空＝継承＝上位に従う）。 */
  value: string;
  /** 割り当てモデル（解決後の表示）。 */
  effective: string;
  /** 出所・継承の注記。 */
  note: string;
  /** モデル指定の選択肢（先頭は「継承」）。 */
  options: Array<{ value: string; label: string }>;
  /**
   * 思考レベル（2026-08-19 提案）。空＝サービス既定に従う（継承）。指定あり＝上書き。
   * 選択肢は `thinkingOptions`。pi のレベル（off/low/…/max）と Claude の config
   * （disabled/adaptive）を共通の値で扱う。
   */
  thinking: string;
  /** 思考レベルの選択肢（先頭は「継承：サービス既定」）。 */
  thinkingOptions: Array<{ value: string; label: string }>;
}

/** 思考レベルの選択肢（統合表・チャット共通）。値はバックエンド側で解釈・変換する。 */
export const THINKING_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "継承（サービス既定に従う）" },
  { value: "off", label: "off" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
  { value: "max", label: "max" },
  { value: "disabled", label: "disabled（Claude）" },
  { value: "adaptive", label: "adaptive（Claude）" },
];

/** 思考レベルを人が読む形（空＝継承）。 */
export function thinkingLabel(value: string): string {
  if (value === "") return "（継承：サービス既定）";
  return THINKING_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

/**
 * **いまの値が一覧に無ければ足す**（I2：画面と実態を食い違わせない）。
 *
 * 供給に聞いた一覧は「いま選べるもの」で、**いま効いているもの**とは限らない
 * ——黙って先頭の項目が選ばれているように見せると、開いただけで別のモデルに見える。
 */
function withCurrentValue(
  options: Array<{ value: string; label: string }>,
  current: string
): Array<{ value: string; label: string }> {
  if (current === "" || options.some((o) => o.value === current)) return options;
  return [{ value: current, label: `${toDisplayModel(current)}（いまの値）` }, ...options];
}

export interface CoreSettingsOptions {
  /**
   * **番頭が使うモデルの選択肢**（PO裁定 2026-08-13）。
   * 会話の画面と同じ「バックエンド → プロバイダ → モデル」を、`backend|provider|model`
   * の値で返す。**選択肢を2箇所で組まない**（D3）ので、bin.ts が1つの元から作る。
   */
  harnessChoices?: () => Array<{ value: string; label: string }>;
  /** 場所が変わったときに呼ぶ（その場で効かせるため）。 */
  onPlacesChanged?: () => void;
  /**
   * **いま効いている場所**を返す（設定と起動時指定のどちらが勝つか、既定の場所があるか、
   * を解いた後のもの）。画面はこれをそのまま映す。
   *
   * これが無いと、起動時の指定（`BANTO_PLACES`）で動いているとき画面が空に見えたり、
   * 既定の書斎が出ないまま効いていたりする（I2：画面と実態を食い違わせない）。
   * **判断をここで再現しない**——両側に置くと、片方を直したときもう片方が古いまま残る。
   */
  effectivePlaces?: () => PlaceSetting[];
  /** LLM の区画を出すためのカタログ。渡さなければ区画ごと出ない。 */
  llmCatalog?: LlmCatalog;
  /**
   * 役の台帳（ModelLedger）。思考レベルの保存に使う（`updateRole`）。
   * 番頭ホストが書き手として持つ。
   */
  modelLedger?: ModelLedger;
  /** 職人の既定 tier が変わったときに Worker Pool へ伝える口。 */
  onWorkerTierChanged?: (tier: ModelTier) => void;
  /**
   * **職人に選べるモデル**（ADR-0021 決定102）。番頭と同じ3段だが、**層が違うので別に聞く**
   * ——番頭の pi ハーネスと職人の pi ドライバは別物で、片方だけ使える構成がありうる（決定100）。
   */
  workerChoices?: () => Array<{ value: string; label: string }>;
  /** いま効いている職人の既定等級（画面に映す）。 */
  workerDefaultTier?: () => string;
  /**
   * **章の要約に実際に使われているモデル**（task-0151・a3）。保存した指定と、
   * 環境変数・既定への落ちを解いた後のもの。画面はこれをそのまま映す
   * ——「保存した値」と「実際に効いているもの」が食い違いうる（BANTO_CHAPTER_MODEL が
   * 優先するため）ので、判断をここで再現せず呼び手からもらう。
   */
  effectiveChapterModel?: () => ChapterModelResolution;
  /**
   * 「役割とモデル」統合表に参加するモジュールの役（`modelRoles` 宣言）の供給元
   * （2026-08-19 提案 `model-roles-module-offer`・ADR-0021 の続き）。
   *
   * 各モジュールの `settings` 契約（`read()` / `write()`）をそのまま使い、核は表の組み立てに
   * 集約するだけ（D3：保存しない・実効は導出）。宣言の無いモジュールは統合表に出ない。
   * 保存は各モジュールが自分で持つ（依存の逆転を避ける・決定99a）。
   */
  modelRoleSources?: () => Array<{
    /** モジュール名（例 "kobo"）。role の id 空間を分けるための接頭辞に使う。 */
    origin: string;
    /** 表示名（例 "工場"）。 */
    originTitle: string;
    spec: ModuleSettingsSpec;
  }>;
  /**
   * モデル束縛の変更を記録する口（決定 ledger・2026-08-19 提案）。監査・履歴のため。
   * 無ければ記録しない（テスト等）。
   */
  onModelBindingChanged?: (entry: BindingDecisionEntry) => void;
}

/**
 * @param store 設定の保存先
 */
export function createCoreSettingsSections(
  store: SettingsStore,
  options: CoreSettingsOptions = {}
): Array<{ id: string; spec: ModuleSettingsSpec }> {
  return [
    {
      id: "places",
      spec: {
        title: "場所と書き込み許可",
        description:
          "番頭が作業できる場所と、書き込みを許す範囲。既定はどの場所も読み取り専用で、" +
          "ここで許した範囲だけ書ける（決定38）。ghq / gwq が見つけるリポジトリは自動で" +
          "読み取り専用の場所になるので、場所の一覧に書くのは「明示的に足したい場所」だけ。",
        // 決定75: 場所と、そこで書ける範囲は**同じ1つの設定**。項目の宣言だけでは
        // 「保留中の要求を許す」「全場所共通で許す」が表せないので、専用の面を宣言する
        // （決定43 の枠。中核の区画にだけ許した例外）
        view: "PlaceSettings",
        fields: [
          {
            key: "places",
            label: "場所の一覧",
            type: "list",
            placeholder: "banto:/home/ubuntu/ghq/github.com/tjst-t/banto:docs/**,work/**",
            description:
              "1件1行。`id:/絶対パス` で読み取り専用、`id:/絶対パス:glob,glob` で" +
              "その範囲だけ書き込み可。`.git/` と Banto のデータ置き場はどう書いても書けない。" +
              "まだ保存していないときは**起動時の指定（BANTO_PLACES）がそのまま出る**ので、" +
              "保存するとその内容が設定として残る。" +
              "`desk`（成果物の置き場所）は**既定で必ずある**——行を書き換えれば場所も" +
              "書き込み範囲も変えられ、消しても既定（`~/banto-desk`）に戻る",
          },
        ],
        read: () => {
          // **いま効いている場所をそのまま出す**（画面と実態を食い違わせない）。
          // 「設定と起動時指定のどちらが効くか」「既定の場所があるか」の判断は呼び手が
          // 持っている——ここで再現すると、片方を直したときにもう片方が古いまま残る
          const effective = options.effectivePlaces?.() ?? store.all().places ?? [];
          return { places: placesToLines(effective) };
        },
        write: (values) => {
          const lines = Array.isArray(values["places"]) ? values["places"] : [];
          store.update("places", linesToPlaces(lines));
          options.onPlacesChanged?.();
          // 場所は毎回帳簿に聞き直す（D3）ので、その場で効く
          return { applied: true, message: "場所を変えました（すぐ効きます）。" };
        },
      },
    },
    {
      id: "network",
      spec: {
        title: "接続と公開",
        description:
          "**Banto は認証を持たない**（決定40）。外に出すなら前段（Caddy 等）で守ること。" +
          "既定では localhost だけを待ち受けるので、前段を素通りされることはない。",
        fields: [
          {
            key: "port",
            label: "待ち受けるポート",
            type: "number",
            placeholder: "4100",
            description: "既定 4100。WebUI（開発サーバ）もここへ中継するので、変えたら両方を直す",
            restartRequired: true,
          },
          {
            key: "bind",
            label: "待ち受けるアドレス",
            type: "text",
            placeholder: "127.0.0.1",
            description:
              "既定は 127.0.0.1（localhost のみ）。広げると、前段で守られていない経路から" +
              "記憶・書き込み・検証環境の credentials 経路に直接届く",
            restartRequired: true,
          },
          {
            key: "publicUrl",
            label: "外から見えるURL",
            type: "text",
            placeholder: "https://banto.example.com",
            description: "検証環境を外から見せるときのリンクの土台。省略すると相対パスになる",
            restartRequired: true,
          },
          {
            key: "caddyAdmin",
            label: "Caddy の admin API",
            type: "text",
            placeholder: "http://localhost:2019",
            description:
              "設定すると検証環境をサブドメインで公開する（決定39c）。" +
              "**下の土台ドメインと対で設定する**——片方だけだと起動時に止まる",
            restartRequired: true,
          },
          {
            key: "envDomain",
            label: "検証環境の土台ドメイン",
            type: "text",
            placeholder: "env.example.com",
            description: "`*.この名前` の DNS と証明書が用意されている前提",
            restartRequired: true,
          },
        ],
        read: () => ({ ...(store.all().network ?? {}) }),
        write: (values) => {
          const current = store.all().network ?? {};
          const port = values["port"];
          // I2: ポートでない値を黙って既定に落とさない（起動して初めて分かるのを避ける）
          if (port !== undefined && port !== null && port !== "") {
            const parsed = Number(port);
            if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
              throw new Error(`ポートは1〜65535の整数で指定してください（受け取った値: ${String(port)}）`);
            }
          }
          const next = { ...current, ...values } as NonNullable<
            ReturnType<SettingsStore["all"]>["network"]
          >;
          // I2: 片方だけの設定を保存させない。起動して初めて止まるより、ここで断る
          if ((next.caddyAdmin && !next.envDomain) || (!next.caddyAdmin && next.envDomain)) {
            throw new Error("Caddy の admin API と土台ドメインは対で設定してください。");
          }
          store.update("network", next);
          return { applied: false, message: "保存しました。**次の起動から効きます**" };
        },
      },
    },
    {
      id: "roles",
      spec: {
        title: "役割とモデル",
        description:
          "誰が何のモデルを使うかを1枚の表で見える化します。いま効いているものと、その出所" +
          "（等級既定／工場などモジュールの上書き）を併記します。編集はこの表で行えます。" +
          "**優先順位：①上書き（名指し） ②等級既定 ③バックエンド既定**。" +
          "モデルそのものの登録（プロバイダ・鍵・取り込み）は「使えるモデル」の面で行います。",
        // 項目の羅列では表せない（行＝役割・欄＝既定/上書き/実効）ため、専用 view で描く（決定43）
        view: "ModelRolesView",
        fields: [],
        read: async () => {
          const roles = options.llmCatalog?.roles() ?? {};
          const asValue = (r?: { backend?: string; provider: string; model: string }): string =>
            r ? `${r.backend ?? "pi"}|${r.provider}|${r.model}` : "";

          // 選択肢。value は各役の保存形式、label は統一表示（backend › provider › model）
          const workerChoices = options.workerChoices?.() ?? []; // value: backend|provider|model
          const workerOptions = workerChoices.map((c) => ({
            value: c.value,
            label: toDisplayModel(c.value),
          }));
          // 工場（モジュール）は保存形式が違う（provider/model か Claude 別名）。label は統一
          const moduleOptions = workerChoices.map((c) => ({
            value: toModuleValue(c.value),
            label: toDisplayModel(c.value),
          }));
          const harnessChoices = options.harnessChoices?.() ?? [];
          const harnessOptions = harnessChoices.map((c) => ({
            value: c.value,
            label: toDisplayModel(c.value),
          }));

          const rows: Array<RoleTableRow> = [];

          // ── 番頭 ──
          const steward = asValue(roles.steward);
          rows.push({
            key: "steward",
            group: "steward",
            label: "番頭",
            tierDependent: false,
            value: steward,
            effective: toDisplayModel(steward) || "（未指定）",
            note: steward ? "指定" : "未指定",
            options: [{ value: "", label: "（継承：未指定なら既定に従う）" }, ...harnessOptions],
            thinking: (roles.steward as { thinking?: string } | undefined)?.thinking ?? "",
            thinkingOptions: THINKING_OPTIONS,
          });

          // 章の要約（本編とは別呼び出し）
          const chapter = String(store.all().chapterModel ?? "");
          rows.push({
            key: "chapterModel",
            group: "steward",
            label: "章の要約",
            tierDependent: false,
            value: chapter,
            effective: toDisplayModel(chapter) || "（継承：既定 claude-agent-sdk/haiku）",
            note: chapter ? "指定" : "既定に従う",
            options: [{ value: "", label: "（継承：既定に従う）" }, ...harnessOptions],
            thinking: "",
            thinkingOptions: THINKING_OPTIONS,
          });

          // ── 職人 ──
          const defaultTier = options.workerDefaultTier?.() ?? "";
          rows.push({
            key: "defaultTier",
            group: "worker",
            label: "職人の既定の等級",
            tierDependent: false,
            value: defaultTier,
            effective: defaultTier ? TIER_LABELS[defaultTier as ModelTier] : "（指定なし）",
            note: defaultTier ? "等級既定の既定" : "指定なし",
            options: [
              { value: "", label: "（継承：指定なし）" },
              ...MODEL_TIERS.map((t) => ({ value: t, label: TIER_LABELS[t] })),
            ],
            thinking: "",
            thinkingOptions: THINKING_OPTIONS,
          });
          for (const tier of MODEL_TIERS) {
            const binding = asValue(roles[workerRoleOf(tier)]);
            rows.push({
              key: `worker.${tier}`,
              group: "worker",
              label: `職人（${TIER_LABELS[tier]}）`,
              tierDependent: false,
              value: binding,
              effective: toDisplayModel(binding) || "（継承：バックエンド既定に従う）",
              note: binding ? "等級既定" : "継承",
              options: [{ value: "", label: "（継承：バックエンド既定に従う）" }, ...workerOptions],
              thinking:
                (roles[workerRoleOf(tier)] as { thinking?: string } | undefined)?.thinking ?? "",
              thinkingOptions: THINKING_OPTIONS,
            });
          }

          // ── 工場（モジュールの役：Kobo の executor / rework / audit 等）──
          for (const source of options.modelRoleSources?.() ?? []) {
            let values: Record<string, unknown> = {};
            try {
              values = await source.spec.read();
            } catch {
              // 読めないモジュールは飛ばすが黙らない（I2：値の捏造はしない）
            }
            for (const role of source.spec.modelRoles ?? []) {
              const binding = String(values[role.key] ?? "");
              rows.push({
                key: `${source.origin}:${role.id}`,
                group: "module",
                label: `${source.originTitle}・${role.label}`,
                tierDependent: role.tierDependent === true,
                value: binding,
                effective: toDisplayModel(binding) || "（継承：等級既定に従う）",
                note: binding ? "上書き" : "継承",
                options: [{ value: "", label: "（継承：等級既定に従う）" }, ...moduleOptions],
                thinking: String(values[`${role.id}Thinking`] ?? ""),
                thinkingOptions: THINKING_OPTIONS,
              });
            }
          }

          // 並び順: 番頭 → 職人 → 工場（グループ内は宣言順を保つ安定ソート）
          const order: Record<RoleTableGroup, number> = { steward: 0, worker: 1, module: 2 };
          rows.sort((a, b) => order[a.group] - order[b.group]);

          // 現在値が選択肢に無いときも選ばれているように見せる（I2）
          for (const row of rows) {
            row.options = withCurrentValue(row.options, row.value);
          }

          return {
            _rolesTable: rows,
            steward: asValue(roles.steward),
            defaultTier: options.workerDefaultTier?.() ?? "",
            ...Object.fromEntries(
              MODEL_TIERS.map((t) => [`worker.${t}`, asValue(roles[workerRoleOf(t)])])
            ),
          };
        },
        write: async (values) => {
          const applied: string[] = [];
          for (const [key, raw] of Object.entries(values)) {
            // 思考レベル（`.thinking` で終わるキー）。モデル指定とセットで、各束縛へ保存する
            if (key.endsWith(".thinking")) {
              const baseKey = key.slice(0, -".thinking".length);
              const thinking = String(raw ?? "");
              const sep = baseKey.split(":");
              const source =
                sep.length === 2 && options.modelRoleSources
                  ? options.modelRoleSources().find((s) => s.origin === sep[0])
                  : undefined;
              const role = source?.spec.modelRoles?.find((r) => r.id === sep[1]);
              if (source && role) {
                // モジュール役（例 kobo:executor.thinking → kobo の write へ）
                await source.spec.write({ [`${role.id}Thinking`]: thinking });
                applied.push(
                  `${source.originTitle}・${role.label} の思考 → ${thinkingLabel(thinking)}`
                );
                options.onModelBindingChanged?.({
                  at: new Date().toISOString(),
                  role: role.id,
                  origin: source.origin,
                  model: "",
                  thinking,
                });
                continue;
              }
              const roleName = baseKey;
              if (options.modelLedger && (roleName === "steward" || isLedgerRole(roleName))) {
                // 核役（steward / worker.<tier>）
                options.modelLedger.updateRole(roleName as never, { thinking });
                applied.push(`${roleName} の思考 → ${thinkingLabel(thinking)}`);
                options.onModelBindingChanged?.({
                  at: new Date().toISOString(),
                  role: roleName,
                  origin: "core",
                  model: "",
                  thinking,
                });
                continue;
              }
            }
            // モジュール役（origin:role.id）。それぞれのモジュールの settings.write へ委譲（決定27）
            const sep = key.split(":");
            if (sep.length === 2 && options.modelRoleSources) {
              const source = options.modelRoleSources().find((s) => s.origin === sep[0]);
              const role = source?.spec.modelRoles?.find((r) => r.id === sep[1]);
              if (source && role) {
                await source.spec.write({ [role.key]: String(raw ?? "") });
                applied.push(
                  `${source.originTitle}・${role.label} → ${String(raw ?? "") || "割り当てなし"}`
                );
                options.onModelBindingChanged?.({
                  at: new Date().toISOString(),
                  role: role.id,
                  origin: source.origin,
                  model: String(raw ?? ""),
                });
                continue;
              }
            }
            if (key === "defaultTier") {
              const tier = String(raw ?? "");
              if (tier && !MODEL_TIERS.includes(tier as ModelTier)) {
                throw new Error(`知らない等級です: ${tier}`);
              }
              if (tier) {
                options.onWorkerTierChanged?.(tier as ModelTier);
                applied.push(`既定の等級を ${TIER_LABELS[tier as ModelTier]} に`);
              }
              continue;
            }
            if (key === "chapterModel") {
              const text = String(raw ?? "");
              store.update("chapterModel", text.length > 0 ? text : undefined);
              applied.push(`章の要約 → ${text || "既定に従う"}`);
              continue;
            }
            const role = key === "steward" ? "steward" : key;
            const text = String(raw ?? "");
            if (text === "") {
              options.llmCatalog?.clearRole(role as never);
              applied.push(`${role} の割り当てを外しました`);
              options.onModelBindingChanged?.({
                at: new Date().toISOString(),
                role,
                origin: "core",
                model: "",
              });
              continue;
            }
            const [backend, provider, model] = text.split("|");
            // I2: 壊れた値を黙って既定に落とさない
            if (!backend || !provider || !model) {
              throw new Error(`モデルの指定が不正です: ${text}`);
            }
            options.llmCatalog?.setRole(role as never, provider, model, backend);
            applied.push(`${role} → ${backend}/${provider}/${model}`);
            options.onModelBindingChanged?.({
              at: new Date().toISOString(),
              role,
              origin: "core",
              model: `${backend}|${provider}|${model}`,
            });
          }
          return {
            applied: true,
            message:
              `${applied.join("、")}。\n\n` +
              "**優先順位：①上書き（名指し） ②等級既定 ③バックエンド既定**\n" +
              "番頭は新しい会話から、職人は次の委譲から効きます。",
          };
        },
      } as ModuleSettingsSpec,
    },
    // ADR-0011 決定42・43: LLM は中核。項目では表しきれないので専用の面を宣言する
    ...(options.llmCatalog
      ? [
          {
            id: "llm",
            spec: {
              title: "使えるモデル（pi の供給）",
              description:
                "ここは pi バックエンドの供給の面です——プロバイダの登録・鍵・取り込み・" +
                "文脈長・等級と、この店で使う気があるか（採用）まで。" +
                "誰がどれを使うかは「役ごとのモデル」で決めます" +
                "（Claude Code のモデルも含めてバックエンドを跨いで1枚）。" +
                "会話ごとの切り替えは会話の画面から。",
              // 項目の宣言では表せないため、描き先だけを宣言する（決定43）
              view: "LlmRegistryViewer",
              fields: [],
              read: () => ({}),
              write: () => ({ applied: true }),
            } as ModuleSettingsSpec,
          },
        ]
      : []),
  ];
}
