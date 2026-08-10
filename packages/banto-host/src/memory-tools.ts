/**
 * 記憶を番頭に公開する Tool（ADR-0010 決定9・決定10・決定28、ADR-0003、D11）。
 *
 * 決定9の境界線に従い、記憶の読み書きは「単発の照会・単発のアクション」なので Tool とする
 * （複数Tool呼び出しにまたがる手順知識は SKILL 側）。
 *
 * ## ここが持っている3つの性質
 *
 * 1. **二層**（ADR-0003）：人の記憶は横断、プロジェクトの記憶は閉じる。層の分離は
 *    `ScopedMemory` がストアごと分けて担保しており、ここは `scope` を渡すだけ
 * 2. **注入の予算**（提案3.3）：`renderMemoryForPrompt` は際限なく載せない。溢れた分は
 *    件数だけ知らせ、`memory.search` で引かせる
 * 3. **削除は追記**（決定28）：`memory.forget` は消さずに「忘れた」ことを足す
 *
 * D5: 判断ロジックを持たない。保存・取り出しは MemoryStore に委ね、選抜の規則は
 *     banto-core の `selectMemoriesForBudget` にある。ここは受け渡しと組み立てのみ。
 * D6: 依存は banto-core の記憶と typebox のみ。ファイル操作はここで一切しない。
 */

import {
  selectMemoriesForBudget,
  type MemoryKind,
  type MemoryRecord,
  type MemoryScope,
  type MemoryStore,
  type ScopedMemory,
} from "@banto/core";
import { Type } from "typebox";
import { defineNamespacedTool, type NamespacedToolDefinition } from "./tool-registry.js";

const MemoryKindSchema = Type.Union(
  [Type.Literal("preference"), Type.Literal("habit"), Type.Literal("fact")],
  {
    description:
      "preference（好み。文体や見せ方など、そうしてほしいこと。変わってよい）、" +
      "habit（習慣。手順やチェックのルーティン。変わってよい）、" +
      "fact（事実。名前・役割・許諾範囲など、導出できず変わらないことが期待される属性）。" +
      "**事実を好みに入れない**——名前を好みとして覚えると「変えてよいもの」として扱ってしまう",
  }
);

const MemoryScopeSchema = Type.Union([Type.Literal("person"), Type.Literal("project")], {
  description:
    "person（人の記憶。POの好み・習慣・事実。**幹をまたいで共有される**）、" +
    "project（**この幹の記憶**。その仕事の決定・規約・ドメイン。**他の幹へは載らない**）。" +
    "**迷ったら person ではなく project**——ある仕事に固有の話が人の記憶に入ると、" +
    "無関係な仕事の判断まで歪める。幹をまたいで効く一般解になったときだけ person にする",
});

/** 記憶を1件、プロンプト用の1行にする。 */
function renderLine(record: MemoryRecord): string {
  // 抽出したものは印を付ける。PO が言ったことと、番頭が会話から拾ったことは重みが違う（決定28）
  const mark = (record.origin ?? "explicit") === "extracted" ? " [抽出]" : "";
  const since = record.validFrom ? `（${record.validFrom} から）` : "";
  return `- ${record.text}${since}${mark} (id: ${record.id})`;
}

/** `createMemoryTools` の指定。記憶の区画は**幹**（PO裁定 2026-08-10）。 */
export interface MemoryToolsOptions {
  /**
   * いま在る幹のID。渡すと `scope: "project"` の宛先を検算する。
   * 省略すると検算しない（テスト・幹を持たない構成向け）。
   */
  knownTrunkIds?: () => readonly string[];
  /**
   * **いまの会話の幹**（PO裁定 2026-08-10）。記憶が分かれる単位は幹になった。
   *
   * 渡すと `scope: "project"` で `trunk` を省いたときの既定になる——番頭は常に
   * ちょうど1つの幹に居るので、毎回どの幹かを書かせる意味がない。
   */
  defaultTrunkId?: () => string | undefined;
  /** 幹の一覧（横断して探すときに開く区画）。id と、人に見える名前。 */
  knownTrunkList?: () => readonly { id: string; label?: string }[];
}

/**
 * `memory.save` / `memory.recall` / `memory.search` / `memory.forget` を生成する。
 *
 * どれも渡された `ScopedMemory` だけを触るため、保存形式（JSONL・将来の別実装）が
 * 変わっても Tool 側は変更しない。
 */
export function createMemoryTools(
  memory: ScopedMemory,
  options: MemoryToolsOptions = {}
): NamespacedToolDefinition[] {
  /**
   * `scope` と `trunk` からストアを解決する。
   *
   * I2: `project` なのに幹が決まらない／知らない幹を指しているときは、人の記憶へ
   *     黙って落とさずエラーにする——それが ADR-0003 の禁じた「横断」そのもの。
   */
  const resolve = (scope: MemoryScope | undefined, trunk: string | undefined): MemoryStore => {
    const wanted = scope ?? "person";
    if (wanted === "person") return memory.forPerson();
    // **既定はいまの会話の幹**（PO裁定 2026-08-10）。番頭は常に1つの幹に居る
    const id = trunk && trunk.trim() !== "" ? trunk : options.defaultTrunkId?.();
    if (!id) {
      throw new Error(
        'scope: "project" には幹が要ります（記憶が分かれる単位は幹・ADR-0003 の第二層）'
      );
    }
    const known = options.knownTrunkIds?.();
    if (known && !known.includes(id)) {
      throw new Error(
        `知らない幹です: ${id}（開いている幹: ${known.join(", ") || "なし"}）`
      );
    }
    return memory.forProject(id);
  };

  const scopeParams = {
    scope: Type.Optional(MemoryScopeSchema),
    trunk: Type.Optional(
      Type.String({
        description:
          'scope: "project" のときの幹のID。**省略するとこの会話の幹**——' +
          "他の幹を指すときだけ書く（thread.list で確かめる）",
      })
    ),
  };

  const saveTool = defineNamespacedTool({
    name: "memory.save",
    label: "Memory: Save",
    description:
      "長期に覚えておくべきことを1件保存する。" +
      "セッションを跨いで参照されるため、その場限りの作業メモではなく、次回以降も効く事実だけを書く。" +
      "既存の記憶を訂正する場合は supersedes に古い記憶のIDを渡す。" +
      "**進行中の作業の経緯はここに入れない**——それは会話の引き継ぎ（章）が持つ。\n" +
      "**記憶が分かれる単位は幹**：`scope: \"project\"` はこの会話の幹に入り、他の幹の" +
      "会話には載らない。幹をまたいで効くものだけ `scope: \"person\"` にする。",
    parameters: Type.Object({
      kind: MemoryKindSchema,
      text: Type.String({ description: "記憶の内容。1件1事実で簡潔に書く。" }),
      ...scopeParams,
      validFrom: Type.Optional(
        Type.String({
          description:
            "この事実が世界で真になった時刻（ISO-8601、任意）。" +
            "「2026-08から〜」のように、いつから真かが意味を持つときだけ渡す。記録した時刻とは別軸",
        })
      ),
      refs: Type.Optional(
        Type.Array(Type.String(), { description: "関連するタスク・ADR等のID（任意）" })
      ),
      supersedes: Type.Optional(
        Type.String({ description: "訂正する場合、置き換える古い記憶のID" })
      ),
    }),
    async execute(params) {
      const store = resolve(params.scope, params.trunk);
      // I2: 存在しないIDの訂正は MemoryStore が例外にする。ここで握りつぶさない。
      const input = {
        kind: params.kind,
        text: params.text,
        // Tool 経由の保存は常に番頭の意思。抽出（決定28）は Tool を通らず直に保存する
        origin: "explicit" as const,
        ...(params.validFrom ? { validFrom: params.validFrom } : {}),
        ...(params.refs ? { refs: params.refs } : {}),
      };
      const saved = params.supersedes
        ? store.supersede(params.supersedes, input)
        : store.save(input);

      const where =
        params.scope === "project"
          ? `幹「${params.trunk ?? options.defaultTrunkId?.() ?? "?"}」の記憶`
          : "人の記憶（幹をまたぐ）";
      return {
        content: [
          { type: "text" as const, text: `saved memory ${saved.id} to ${where}: ${saved.text}` },
        ],
        details: {},
      };
    },
  });

  const recallTool = defineNamespacedTool({
    name: "memory.recall",
    label: "Memory: Recall",
    description:
      "保存済みの記憶を取り出す。訂正済み・忘れた記憶は既定で除外される。" +
      "セッション開始時の記憶は既にシステムプロンプトへ注入されているため、" +
      "種別で絞りたいときや、注入後に保存した記憶を読み直したいときに使う。" +
      "**注入は予算で打ち切られる**ので、「他にN件」と出ていたらここか memory.search で引く。",
    parameters: Type.Object({
      kind: Type.Optional(MemoryKindSchema),
      ...scopeParams,
    }),
    async execute(params) {
      const store = resolve(params.scope, params.trunk);
      const records = store.list(params.kind ? { kind: params.kind } : {});
      const text =
        records.length === 0
          ? "記憶なし"
          : records.map((r) => `- [${r.kind}] ${r.text} (id: ${r.id})`).join("\n");
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });

  const searchTool = defineNamespacedTool({
    name: "memory.search",
    label: "Memory: Search",
    description:
      "記憶を本文の部分一致で探す。空白区切りの語をすべて含むものが返る（大小文字は無視）。" +
      "注入の予算から溢れた記憶を引くときに使う。\n" +
      "**注入は幹ごとだが、探すのは幹をまたげる**（`acrossTrunks: true`）——" +
      "「前に別の仕事で似た話をした」を思い出せないと、幹を分けた代償が大きすぎる。",
    parameters: Type.Object({
      text: Type.String({ description: "探す語。空白区切りで複数指定するとAND検索になる" }),
      kind: Type.Optional(MemoryKindSchema),
      ...scopeParams,
      acrossTrunks: Type.Optional(
        Type.Boolean({
          description:
            "**他の幹の記憶も探す**（人の記憶も含む）。どの幹の記憶かは結果に出る。" +
            "見つけたものを持ってくるなら、いまの幹へ改めて memory.save すること",
        })
      ),
      limit: Type.Optional(Type.Number({ description: "返す最大件数（既定20）" })),
    }),
    async execute(params) {
      const query = {
        text: params.text,
        ...(params.kind ? { kind: params.kind } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      };
      /**
       * **幹をまたいで探す**（PO裁定 2026-08-10）。注入は幹ごとに絞るが、探すのは
       * 絞らない——予算が要るのは注入だけで、探すのは番頭が要ると判断したときだけ走る。
       */
      if (params.acrossTrunks === true) {
        const here = options.defaultTrunkId?.();
        const lines: string[] = [];
        for (const r of memory.forPerson().search(query)) {
          lines.push(`- [人の記憶] ${r.text} (id: ${r.id})`);
        }
        for (const project of options.knownTrunkList?.() ?? []) {
          for (const r of memory.forProject(project.id).search(query)) {
            const mark = project.id === here ? "この幹" : (project.label ?? project.id);
            lines.push(`- [${mark}] ${r.text} (id: ${r.id})`);
          }
        }
        return {
          content: [
            {
              type: "text" as const,
              text:
                lines.length === 0
                  ? `「${params.text}」に当たる記憶は、どの幹にもありません`
                  : lines.join("\n"),
            },
          ],
          details: {},
        };
      }
      const store = resolve(params.scope, params.trunk);
      const records = store.search(query);
      const text =
        records.length === 0
          ? `「${params.text}」に当たる記憶はありません`
          : records.map((r) => `- [${r.kind}] ${r.text} (id: ${r.id})`).join("\n");
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });

  const forgetTool = defineNamespacedTool({
    name: "memory.forget",
    label: "Memory: Forget",
    description:
      "記憶を1件忘れる。誤って覚えたことや、もう当てはまらなくなったことに使う。" +
      "**訂正したいだけなら memory.save の supersedes を使う**——忘れると中身が残らない。" +
      "記録は消えず「忘れた」ことが追記される（後から何を忘れたか辿れる）。",
    parameters: Type.Object({
      id: Type.String({ description: "忘れる記憶のID" }),
      reason: Type.Optional(Type.String({ description: "忘れる理由（任意）" })),
      ...scopeParams,
    }),
    async execute(params) {
      const store = resolve(params.scope, params.trunk);
      // I2: 知らないIDは MemoryStore が例外にする。黙って成功にしない
      const tombstone = store.forget(params.id, params.reason);
      return {
        content: [
          { type: "text" as const, text: `forgot memory ${params.id}: ${tombstone.text}` },
        ],
        details: {},
      };
    },
  });

  return [saveTool, recallTool, searchTool, forgetTool];
}

/** `renderMemoryForPrompt` の指定。 */
export interface RenderMemoryOptions {
  /**
   * この会話で効く幹（ADR-0003 の第二層）。渡した幹の記憶だけが載る。
   * 空・省略なら人の記憶だけ。**普通はちょうど1本**（いまの会話の幹）。
   */
  trunks?: readonly { id: string; label?: string }[];
  /**
   * 層ごとのトークン予算。人の記憶にこの値、幹の記憶は全体でこの値を
   * 幹の数で割って配る。省略すると `DEFAULT_MEMORY_TOKEN_BUDGET`。
   */
  tokenBudget?: number;
}

/**
 * セッション開始時にシステムプロンプトへ差し込む記憶のセクションを組み立てる。
 * 記憶が無ければ空文字（プロンプトに空セクションを足さない）。
 *
 * 注入するのは active な記憶のみ——訂正済み・忘れた記憶を混ぜると、番頭が古い前提で判断する。
 *
 * **予算で打ち切る（提案3.3）。** 溢れた分は件数だけ書く——黙って落とすと、番頭は
 * 「無い」と「載らなかった」を区別できない（I2）。
 */
export function renderMemoryForPrompt(
  memory: ScopedMemory,
  options: RenderMemoryOptions = {}
): string {
  const sections: string[] = [];
  let omittedTotal = 0;

  const renderStore = (store: MemoryStore, tokenBudget: number | undefined): string[] => {
    const byKind = (kind: MemoryKind): MemoryRecord[] => store.list({ kind });
    const all = [...byKind("fact"), ...byKind("preference"), ...byKind("habit")];
    if (all.length === 0) return [];
    const { selected, omitted } = selectMemoriesForBudget(
      all,
      tokenBudget === undefined ? {} : { tokenBudget }
    );
    omittedTotal += omitted.length;
    const out: string[] = [];
    // 決定31d: 事実が最も安定しているので先に読ませる（事実 → 好み → 習慣）
    for (const [kind, heading] of [
      ["fact", "事実"],
      ["preference", "好み"],
      ["habit", "習慣"],
    ] as const) {
      const lines = selected.filter((r) => r.kind === kind).map(renderLine);
      if (lines.length > 0) out.push(`### ${heading}\n${lines.join("\n")}`);
    }
    return out;
  };

  const personBody = renderStore(memory.forPerson(), options.tokenBudget);
  if (personBody.length > 0) {
    sections.push(`## あなた（人）について\n\n${personBody.join("\n\n")}`);
  }

  const trunks = options.trunks ?? [];
  if (trunks.length > 0) {
    // 幹の記憶は全体で1層ぶんの予算を、幹の数で割って配る。
    // 幹が増えるほど1件ずつは載らなくなるが、人の記憶を押し出すよりはよい
    const perTrunk =
      options.tokenBudget === undefined
        ? undefined
        : Math.max(1, Math.floor(options.tokenBudget / trunks.length));
    for (const trunk of trunks) {
      const body = renderStore(memory.forProject(trunk.id), perTrunk);
      if (body.length === 0) continue;
      sections.push(`## ${trunk.label ?? trunk.id} について\n\n${body.join("\n\n")}`);
    }
  }

  if (sections.length === 0) return "";

  const head = "# 記憶（前回までに覚えたこと）";
  const foot = [
    "これらは過去のセッションで保存された。矛盾する指示を受けたら、" +
      "古い記憶を memory.save の supersedes で訂正する。",
    "**幹の記憶は、その見出しの幹の中でだけ効く**（他の幹へ持ち出さない）。" +
      "他の幹で覚えたことを探すなら `memory.search({ acrossTrunks: true })`。",
  ];
  if (omittedTotal > 0) {
    foot.push(
      `**ここに載っていない記憶が他に ${omittedTotal} 件ある**（予算のため省いた）。` +
        "関係しそうなら memory.search で引くこと。"
    );
  }
  return [head, ...sections, foot.join("\n")].join("\n\n");
}
