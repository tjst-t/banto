/**
 * studio モジュール（組み込み・ADR-0010 決定25・27）。
 *
 * 番頭自身の中身——**記憶（宣言的記憶）と SKILL（手続き記憶）**——をPOに見せる。
 * 職人ビューアが「いま誰が何をしているか」を見せるのに対して、こちらは
 * 「番頭が何を覚えていて、どう動くつもりか」を見せる。
 *
 * `memory.*` / `skill.*` のドメインは Banto 中核が持つ（決定27a）。このモジュールは
 * それらを**所有しない**——番頭向けの Tool は中核が createBantoHostSession で渡しており、
 * ここが提供するのは GUI と、その GUI がデータを取るための口だけ。所有と閲覧を混ぜないため、
 * 口の名前は `studio.*` にしてある。
 *
 * **読み取り専用。** 記憶の削除は追記で表す設計（task-0023・D3）、SKILL の書き込みは
 * 決定26 の学習層（task-0017）に属する。GUI の都合でその設計を先取りしない。
 *
 * D5: 判断は無い。持っているものをそのまま返すだけ。
 */

import { Type } from "typebox";
import * as fs from "node:fs";
import type { ScopedMemory } from "@banto/core";
import type { BantoModule } from "../module.js";
import type { CanvasViewSpec } from "../canvas.js";
import { defineNamespacedTool, type NamespacedToolDefinition } from "../tool-registry.js";
import type { SkillEntry } from "../module.js";

/** 組み込みモジュールの到達先は Banto ホスト自身。UIは自分のオリジンに解決する。 */
export const STUDIO_BASE_URL = "/api/studio";

const studioViews: CanvasViewSpec[] = [
  {
    kind: "memory.viewer",
    title: "記憶",
    description:
      "番頭が覚えている事実・好み・習慣の一覧。POが「何を覚えている？」と聞いたときや、" +
      "覚え違いを疑ったときに開く。**出所（POが言ったこと／会話から抽出したもの）が見え、" +
      "誤って覚えたものはここで忘れさせられる**（決定28）。訂正済み・忘れた記憶も履歴として辿れる。" +
      "人の記憶とプロジェクトの記憶を切り替えられる（ADR-0003）。",
    parameters: Type.Object({
      kind: Type.Optional(
        Type.String({ description: "fact / preference / habit で絞る（省略時は全部）" })
      ),
      scope: Type.Optional(
        Type.String({ description: "person（人の記憶）/ project（プロジェクトの記憶）" })
      ),
      place: Type.Optional(Type.String({ description: "scope=project のときの場所ID" })),
    }),
    component: "MemoryViewer",
    category: "studio",
    icon: "🧠",
  },
  {
    kind: "skill.viewer",
    title: "SKILL",
    description:
      "番頭が持っている手続き記憶（SKILL）の一覧と中身。どんな手順を知っているか、" +
      "その出所（**番頭が学んだもの**／番頭核／どのモジュール）を見せたいときに開く。" +
      "学習層は同名の既定を上書きする（決定26）ので、ここに出るのが実際に効いている版。**閲覧専用**。",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "最初に開く SKILL 名（省略時は一覧から）" })),
    }),
    component: "SkillViewer",
    category: "studio",
    icon: "📘",
  },
];

export interface StudioModuleOptions {
  /** 二層（ADR-0003）。ビューアは人の記憶とプロジェクトの記憶の両方を見せる。 */
  memory: ScopedMemory;
  /**
   * 解決済みの SKILL（由来つき）。決定26 の3層——**学習層を含めて**解いたもの。
   *
   * **関数で受ける。** 起動時に1回解いた配列を持つと、`skill.learn` で学んだ手順が
   * 再起動まで画面に出ない——番頭は新しい手順で動いているのに PO には古いものが見える、
   * という食い違いになる（決定26 が言う「静かに劣化する」の一種）。
   */
  skills: () => SkillEntry[];
  /**
   * いま登録されている場所（ADR-0003 の第二層を見るのに要る）。
   * 省略すると人の記憶だけを見せる。
   */
  places?: () => Promise<ReadonlyArray<{ id: string; label: string }>>;
}

/**
 * GUI がデータを取る口（決定25）。番頭には渡さない——番頭は中核の
 * `memory.recall` / `skill.read` を直接使うので、同じものを二重に持たせない。
 */
function createStudioDataTools(options: StudioModuleOptions): NamespacedToolDefinition[] {
  const memory = defineNamespacedTool({
    name: "studio.memory",
    label: "Studio: Memory",
    description: "番頭の記憶を一覧で返す（記憶ビューア用のデータ）。",
    parameters: Type.Object({
      kind: Type.Optional(
        Type.Union(
          [Type.Literal("preference"), Type.Literal("habit"), Type.Literal("fact")],
          { description: "種別で絞る（決定31）" }
        )
      ),
      includeSuperseded: Type.Optional(
        Type.Boolean({ description: "訂正済み・忘れた記憶も含める（既定 false）" })
      ),
      scope: Type.Optional(
        Type.Union([Type.Literal("person"), Type.Literal("project")], {
          description: "どの層を見るか（ADR-0003）。既定は person",
        })
      ),
      place: Type.Optional(Type.String({ description: 'scope: "project" のときの幹のID' })),
    }),
    async execute(params) {
      // I2: project なのに幹が無ければ ScopedMemory が例外にする。人の記憶へ落とさない
      const store = options.memory.resolve(params.scope ?? "person", params.place);
      const records = store.list({
        ...(params.kind ? { kind: params.kind } : {}),
        ...(params.includeSuperseded !== undefined
          ? { includeSuperseded: params.includeSuperseded }
          : {}),
      });
      // 履歴を出すときは「訂正された」「忘れた」の別が要る。**画面に導出させない**——
      // 有効かどうかを決めるのは記憶の側で、ビューアが同じ規則をもう一度実装すると割れる（D3/D5）
      const active = new Set(store.list().map((r) => r.id));
      const annotated = records.map((r) => ({ ...r, active: active.has(r.id) }));
      // ADR-0003: どの層を見ているかを画面が読み違えないよう、返す側が名乗る
      const scope = params.scope ?? "person";
      return {
        content: [{ type: "text" as const, text: `${annotated.length} 件` }],
        details: {
          records: annotated,
          scope,
          ...(params.place ? { place: params.place } : {}),
        },
      };
    },
  });

  /**
   * ビューアが層を切り替えるための区画の一覧（ADR-0003）。区画は**幹**。
   *
   * 番頭向けの口と別に持つのは、こちらが**画面のためのデータ**だから
   * （決定25：モジュールは GUI のデータ口を自分で出す）。
   */
  const scopes = defineNamespacedTool({
    name: "studio.memory.scopes",
    label: "Studio: Memory scopes",
    description: "記憶ビューアが切り替えられる層（人／各幹）を返す。",
    parameters: Type.Object({}),
    async execute() {
      const places = options.places ? await options.places() : [];
      return {
        content: [{ type: "text" as const, text: `${places.length + 1} 層` }],
        details: { places: places.map((p) => ({ id: p.id, label: p.label })) },
      };
    },
  });

  /**
   * 記憶を忘れさせる（決定28：抽出した記憶を PO が消せるようにする）。
   *
   * **studio を「閲覧のみ」から一歩出す。** task-0031 は閲覧専用として起票されたが、
   * 決定28 が「自動で有効にする。ただし出所を残し、POが消せるようにする」と定めており、
   * 抽出（task-0022）が動いている以上この面が無いと決定28 の条件を満たさない。
   *
   * 消すのは追記で表される（`MemoryStore.forget`）ので、履歴からは辿れる（D3）。
   */
  const forget = defineNamespacedTool({
    name: "studio.memory.forget",
    label: "Studio: Forget memory",
    description: "記憶を1件忘れさせる（記録は残り、有効な記憶から外れる）。",
    parameters: Type.Object({
      id: Type.String({ description: "忘れる記憶のID" }),
      reason: Type.Optional(Type.String({ description: "理由（任意）" })),
      scope: Type.Optional(
        Type.Union([Type.Literal("person"), Type.Literal("project")], {
          description: "どの層の記憶か（既定 person）",
        })
      ),
      place: Type.Optional(Type.String({ description: 'scope: "project" のときの幹のID' })),
    }),
    async execute(params) {
      const store = options.memory.resolve(params.scope ?? "person", params.place);
      // I2: 知らないIDは MemoryStore が例外にする。黙って成功にしない
      const tombstone = store.forget(params.id, params.reason);
      return {
        content: [{ type: "text" as const, text: `忘れました: ${tombstone.text}` }],
        details: { id: params.id },
      };
    },
  });

  const skills = defineNamespacedTool({
    name: "studio.skills",
    label: "Studio: Skills",
    description: "番頭が持っている SKILL の一覧と中身を返す（SKILLビューア用のデータ）。",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "この SKILL の本文だけを返す" })),
    }),
    async execute(params) {
      const entries = options.skills().map((entry) => {
        const base = {
          name: entry.skill.name,
          description: entry.skill.description,
          /** どの層から来たか（決定26）。番頭核なら core、モジュール名ならそのモジュール */
          origin: entry.origin,
        };
        if (params.name !== undefined && params.name !== entry.skill.name) return base;
        // I2: 読めない SKILL を黙って空にしない。理由を本文として返す
        try {
          return { ...base, body: fs.readFileSync(entry.skill.filePath, "utf-8") };
        } catch (err) {
          return { ...base, error: `読めません: ${String(err)}` };
        }
      });
      return {
        content: [{ type: "text" as const, text: `${entries.length} 件` }],
        details: { skills: entries },
      };
    },
  });

  return [memory, scopes, forget, skills];
}

/**
 * studio モジュールの定義を返す。
 *
 * `tools` は空。番頭に渡す口は中核が持っているので、ここで重ねない（決定27a）。
 */
export function createStudioModule(options: StudioModuleOptions): BantoModule {
  return {
    name: "studio",
    title: "番頭の中身",
    description:
      "番頭が覚えていること（記憶）と、知っている手順（SKILL）を見せる。" +
      "記憶は忘れさせられる（決定28：抽出した記憶を PO が消せるようにする）。",
    endpoint: { baseUrl: STUDIO_BASE_URL },
    tools: [],
    internalTools: createStudioDataTools(options),
    views: studioViews,
    skills: [],
  };
}
