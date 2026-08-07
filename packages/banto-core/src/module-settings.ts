/**
 * モジュールが設定画面に自分の設定を出す契約（決定41・task-0047）。
 *
 * **GUI は渡さない。項目の宣言だけを渡す。** キャンバス（決定12・17）はモジュールが React
 * コンポーネントを持ち込む形だが、設定はそうしない——設定は「名前と型と今の値」でほぼ
 * 尽きており、見た目まで各モジュールが持つと、設定画面の中で書式がばらばらになる。
 * 宣言だけ受け取って**描くのは設定画面**にすれば、モジュールが増えても画面は変わらない。
 *
 * **値の持ち主はモジュール。** 設定画面は読んで表示し、変更を渡すだけ。どこにどう保存するか、
 * 変更をどう効かせるかはモジュールが決める（決定27：Banto をブローカーにしない）。
 * 保存先を持ちたくないモジュールのために、ホストは `SettingsSection` を渡せる。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import { defineNamespacedTool } from "./banto-tool.js";
import type { NamespacedToolDefinition } from "./banto-tool.js";

/** 設定項目の型。増やすときは設定画面の描画も合わせて足す。 */
export type SettingFieldType = "text" | "number" | "boolean" | "select" | "list";

export interface SettingField {
  /** 値の鍵。`read()` / `write()` が受け渡すオブジェクトのキー。 */
  key: string;
  /** 画面に出す名前。 */
  label: string;
  type: SettingFieldType;
  /** 何のための設定かを1〜2文で。**既定値や単位もここに書く**（画面には注記として出る）。 */
  description?: string;
  /** `select` の選択肢。 */
  options?: Array<{ value: string; label: string }>;
  /** `number` の単位表示（`分` / `件` など）。値そのものは変換しない。 */
  unit?: string;
  /** 入力欄に薄く出す例。 */
  placeholder?: string;
  /**
   * 変えても**次の起動まで効かない**項目。画面がその旨を出す。
   *
   * I2: 効いていないのに効いたように見せない——設定したのに動きが変わらない、が
   *     一番分かりにくい。
   */
  restartRequired?: boolean;
  /**
   * 秘密の値。画面で伏せ字にし、`read()` は**中身を返さないこと**
   * （設定済みかどうかだけ分かればよい）。
   */
  secret?: boolean;
}

/** 変更を受けた結果。効いたかどうかを正直に返す。 */
export interface SettingsWriteResult {
  /** その場で効いたか。false なら次の起動から。 */
  applied: boolean;
  /** 画面に出す一言（「次の起動から効きます」など）。 */
  message?: string;
}

/** モジュールが宣言する設定の区画。設定画面のナビ1つ分になる。 */
export interface ModuleSettingsSpec {
  /** ナビに出す名前（例「検証環境」）。 */
  title: string;
  /** 区画の説明。何を決める場所かを1〜2文で。 */
  description?: string;
  fields: SettingField[];
  /**
   * 項目の宣言では表せない区画が、描くコンポーネントの名前を宣言する口
   * （ADR-0011 決定43）。**中核の区画専用**。
   *
   * モジュールには決定41（GUI は渡さない）がそのまま効く——逃げ道を全モジュールに
   * 配ると、決定41 が防ごうとした「設定画面の中で書式がばらばらになる」が起きる。
   * 中核は固定の小さな既知集合（場所／接続と公開／LLM）なので、そこだけに許す。
   *
   * 指定すると `fields` は描かれない。
   */
  view?: string;
  /** いまの値。`secret` の項目は中身を返さない。 */
  read(): Record<string, unknown> | Promise<Record<string, unknown>>;
  /**
   * 変更を受ける。**画面から来た値だけ**が入る（触っていない項目は入らない）。
   *
   * I2: 受け付けられない値は例外にする。黙って丸めると、画面の表示と実際が食い違う。
   */
  write(values: Record<string, unknown>): SettingsWriteResult | Promise<SettingsWriteResult>;
}

/**
 * 保存先を持ちたくないモジュールのための口。ホストが自分の設定ファイルの一区画を貸す。
 *
 * これを使うかは**モジュールの自由**。自前のファイルを持つモジュール（Kobo 等）は
 * `read` / `write` の中で自分の保存先を使えばよい。
 */
export interface SettingsSection {
  read(): Record<string, unknown>;
  write(values: Record<string, unknown>): void;
}

// ── 別プロセスのモジュールの設定（task-0066）────────────────────────────────

/**
 * 設定の区画を Tool 2本として公開する（`<domain>.settings_read` / `<domain>.settings_write`）。
 *
 * **独立サービスとして立つモジュールのための橋**。決定41 で設定は「項目の宣言」だけを渡す
 * 形にしたが、その宣言は同じプロセスに実装がある前提で書かれていた——Worker Pool と
 * Environment Pool を別プロセスへ出すと、宣言（画面に出る項目）は写せても
 * **読み書きが届かない**。値の持ち主はモジュール（決定41）のままにしたいので、
 * 呼び出し規約はモジュール間と同じ Tool にする（決定9・27b：契約体系を2つ持たない）。
 *
 * **番頭には渡さない**（`internalTools` に入れる）。設定を変えるのは PO の画面であって、
 * 番頭が自分で上限を緩められる口ではない（決定63 と同じ考え方）。
 */
export function createSettingsTools(
  domain: string,
  spec: ModuleSettingsSpec
): NamespacedToolDefinition[] {
  const read = defineNamespacedTool({
    name: `${domain}.settings_read` as `${string}.${string}`,
    label: `${spec.title}: 設定を読む`,
    description:
      "このモジュールの設定のいまの値を返す。**設定画面のための口**——番頭には渡らない。",
    parameters: Type.Object({}),
    async execute() {
      const values = await spec.read();
      return { content: [{ type: "text" as const, text: JSON.stringify(values) }], details: { values } };
    },
  });

  const write = defineNamespacedTool({
    name: `${domain}.settings_write` as `${string}.${string}`,
    label: `${spec.title}: 設定を変える`,
    description:
      "このモジュールの設定を変える。**画面から来た項目だけ**を渡すこと（触っていない項目は渡さない）。",
    parameters: Type.Object({
      values: Type.Record(Type.String(), Type.Unknown(), {
        description: "変える項目だけを入れたオブジェクト",
      }),
    }),
    async execute(args) {
      // I2: 受け付けられない値はモジュールが投げる。ここで包み隠さずそのまま外へ出す
      const result = await spec.write((args.values ?? {}) as Record<string, unknown>);
      return {
        content: [{ type: "text" as const, text: result.message ?? "変えました。" }],
        details: result,
      };
    },
  });

  return [read, write] as NamespacedToolDefinition[];
}

/**
 * 設定の保存先をファイル1つで持つ区画（task-0066）。
 *
 * 独立サービスとして立つモジュール用。番頭ホストに同居していたときはホストの設定ファイルの
 * 一区画を借りていた（`settingsSection`）が、別プロセスでは借りる相手がいない——
 * **保存されないと、PO が画面で決めた上限が次の起動で消える**（決定41 の「値の持ち主は
 * モジュール」を、持ち場が変わっても保つ）。
 *
 * D6: node:fs のみ。I2: 壊れたファイルは黙って空にせず、読み手に投げる。
 */
export function createFileSettingsSection(filePath: string): SettingsSection {
  return {
    read(): Record<string, unknown> {
      if (!fs.existsSync(filePath)) return {};
      const raw = fs.readFileSync(filePath, "utf-8").trim();
      if (raw.length === 0) return {};
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch (err) {
        throw new Error(`設定ファイルを読めません（${filePath}）: ${String(err)}`);
      }
    },
    write(values: Record<string, unknown>): void {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(values, null, 2) + "\n", "utf-8");
    },
  };
}
