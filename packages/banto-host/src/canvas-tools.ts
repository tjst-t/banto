/**
 * キャンバス操作Tool（ADR-0010 決定9・決定13）。
 *
 * 決定5 §1・§5 の制約に従い、**表示状態の変更に閉じる**——ここで中身のデータは取らない。
 * 何を表示するかのデータ取得は別ドメインのTool（`file.*` / `git.*` / Kobo Extension Pack）が担う。
 *
 * 決定13：番頭は「いまキャンバスに何が開いているか」を自分で照会できる必要がある
 * （`canvas.query_state`）。POの発言が「この画面」等を指すと判断したときに参照する。
 *
 * D5: 判断は持たない。Canvas に言われた通り操作を伝えるだけ。
 * I2: 未知の kind・タブIDは Canvas が例外にする。ここで握りつぶさない。
 */

import { Type } from "typebox";
import type { Canvas, CanvasCatalog } from "./canvas.js";
import type { ArtifactStore } from "./artifacts.js";
import type { UtsuwaView } from "./protocol.js";
import { buildUtsuwa, pickPath, SHOWABLE_UTSUWA_KINDS } from "./canvas-utsuwa.js";
import { defineNamespacedTool, type NamespacedToolDefinition } from "./tool-registry.js";

/** `canvas.show`（器を出す口）を生やすのに要るもの。 */
export interface CanvasToolsOptions {
  /**
   * 退避済みのツール結果（決定47(a) の `artifacts/`）。
   *
   * **渡さないと `canvas.show` は生えない**——データを再送させない（決定81(a)）ための
   * 引き出しなので、無いなら器そのものが成り立たない。
   */
  artifacts?: ArtifactStore;
  /**
   * 器を会話へ積む。**器は凍る**（決定81(c)）ので、積んだ後は書き換えない。
   * 渡さないと `canvas.show` は生えない（出す先が無い）。
   */
  showUtsuwa?(utsuwa: UtsuwaView): void;
}

/** `canvas.*` を生成する。 */
export function createCanvasTools(
  canvas: Canvas,
  catalog: CanvasCatalog,
  options: CanvasToolsOptions = {}
): NamespacedToolDefinition[] {
  const listCatalog = defineNamespacedTool({
    name: "canvas.list_catalog",
    label: "Canvas: List Catalog",
    description:
      "キャンバスに開けるGUIの一覧（kind・説明・必要なパラメータ）を返す。" +
      "何を見せられるか分からないときに、開く前に確認する。",
    parameters: Type.Object({}),
    async execute() {
      const specs = catalog.list();
      const text =
        specs.length === 0
          ? "開けるGUIなし"
          : specs
              .map((s) => `- ${s.kind}: ${s.title} — ${s.description}`)
              .join("\n");
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });

  const open = defineNamespacedTool({
    name: "canvas.open",
    label: "Canvas: Open",
    description:
      "キャンバスにGUIをタブとして開き、アクティブにする。POに何かを見せたいときに使う。" +
      "開けるkindは canvas.list_catalog で確認できる。表示を変えるだけで、データの取得はしない。" +
      "既定では同じ種別のタブを使い回す（例：ファイルを次々に開いてもタブは増えない）。" +
      "POが「別のタブで」「並べて見たい」と言ったときだけ newTab: true を渡す。",
    parameters: Type.Object({
      kind: Type.String({ description: "開くGUIの種別（例: demo.hello）" }),
      params: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "そのGUIに渡すパラメータ。必要な形は canvas.list_catalog を参照",
        })
      ),
      title: Type.Optional(Type.String({ description: "タブに表示する名前（省略時はカタログの既定）" })),
      newTab: Type.Optional(
        Type.Boolean({
          description:
            "既存のタブを使い回さず新しいタブで開く。POが明示的に別タブ・並べて見たいと言ったときだけ true",
        })
      ),
    }),
    async execute(params) {
      // I2: 未知の kind は Canvas が利用可能な一覧付きで例外にする（決定20）
      const tab = canvas.open(
        params.kind,
        (params.params as Record<string, unknown> | undefined) ?? {},
        params.title,
        { ...(params.newTab === true ? { newTab: true } : {}) }
      );
      const how = tab.rev === 0 ? "opened" : "reused tab for";
      return {
        content: [
          { type: "text" as const, text: `${how} ${tab.kind} as "${tab.title}" (tabId: ${tab.id})` },
        ],
        details: { tabId: tab.id, kind: tab.kind, title: tab.title, rev: tab.rev },
      };
    },
  });

  const close = defineNamespacedTool({
    name: "canvas.close",
    label: "Canvas: Close",
    description: "キャンバスのタブを閉じる。tabId は canvas.query_state で確認できる。",
    parameters: Type.Object({
      tabId: Type.String({ description: "閉じるタブのID" }),
    }),
    async execute(params) {
      canvas.close(params.tabId);
      return { content: [{ type: "text" as const, text: `closed ${params.tabId}` }], details: {} };
    },
  });

  const switchTool = defineNamespacedTool({
    name: "canvas.switch",
    label: "Canvas: Switch",
    description: "キャンバスで表示するタブを切り替える。",
    parameters: Type.Object({
      tabId: Type.String({ description: "表示に切り替えるタブのID" }),
    }),
    async execute(params) {
      canvas.switchTo(params.tabId);
      return { content: [{ type: "text" as const, text: `switched to ${params.tabId}` }], details: {} };
    },
  });

  const queryState = defineNamespacedTool({
    name: "canvas.query_state",
    label: "Canvas: Query State",
    description:
      "いまキャンバスに何が開いているか（タブ一覧と、どれが表示中か）を返す。" +
      "POの発言が「この画面」「これ」などキャンバスの現在の表示を指していると判断したら、まずこれを見る。",
    parameters: Type.Object({}),
    async execute() {
      const { tabs, activeTabId } = canvas.snapshot();
      const text =
        tabs.length === 0
          ? "キャンバスには何も開かれていない"
          : tabs
              .map((t) => `${t.id === activeTabId ? "▶" : " "} ${t.title} [${t.kind}] (tabId: ${t.id})`)
              .join("\n");
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });

  /**
   * 器を1つ会話へ出す（ADR-0017 決定78・81）。
   *
   * **番頭は選ぶが、作らない。** 器は中核が持つ有限の語彙で、ここで渡すのは
   * 「どのツール結果を・どの器で・どこを」だけ——**データは再送させない**（決定81(a)）。
   * 実体はホストが退避済みの結果から引く。
   *
   * **膳＝器1つ**（決定81(b)）。並べたいときは続けて呼ぶ。入れ子は許さない。
   * **器は凍る**（決定81(c)）ので、出したものは後から書き換わらない。
   *
   * I2: 描けなかったら黙って落とさず、**会話にも番頭にも同じもの**を返す（決定81(d)）
   *     ——出どころと足りないものまで書く。会話は止めない（言い直せるので回復可能）。
   */
  const show = defineNamespacedTool({
    name: "canvas.show",
    label: "Canvas: Show",
    description:
      "**Tool の戻り値を器に載せて会話に出す**。番頭が選ぶのは「どの観測を・どの器で・どこを」" +
      "だけで、データは書き直さない（退避済みの結果からホストが引く）。\n" +
      `使える器：${SHOWABLE_UTSUWA_KINDS.join(" / ")}。` +
      "1回に1つ（並べたいときは続けて呼ぶ）。判断を求めるものは器ではなく取次（inbox.post）へ。\n" +
      "**見比べる作業は面（canvas.open）、判断に要る事実は器**。10行を超える一覧・全部の差分・" +
      "触れる環境は器に載せず `open` の器で面への口を出す。",
    parameters: Type.Object({
      utsuwa: Type.String({
        description: `どの器で描くか（${SHOWABLE_UTSUWA_KINDS.join(" / ")}）`,
      }),
      artifact: Type.Optional(
        Type.String({
          description:
            "載せる観測のID（`a-0007`）。ツール結果の末尾に出ている。" +
            "`open` の器のときだけ省ける（面への口はデータを要らない）",
        })
      ),
      path: Type.Optional(
        Type.String({
          description:
            "観測の中のどこを載せるか（`envs.items` のようなドット記法）。省略すると全体",
        })
      ),
      title: Type.Optional(Type.String({ description: "器の見出し" })),
      meta: Type.Optional(Type.String({ description: "見出しの脇の小さい字（件数・大きさ）" })),
      note: Type.Optional(
        Type.String({ description: "下に添える1行。抜粋であること・切ったことを書く" })
      ),
      view: Type.Optional(
        Type.String({ description: "`open` の器で開く面の kind（`file.viewer` など）" })
      ),
      label: Type.Optional(Type.String({ description: "`open` の器の押せる文言" })),
      args: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), { description: "`open` の器が面へ渡す引数" })
      ),
    }),
    async execute(params) {
      const store = options.artifacts;
      const emit = options.showUtsuwa;
      // I2: 配線されていないことを「出したつもり」にしない
      if (!store || !emit) {
        throw new Error("この会話では器を出せません（退避先か会話への口が配線されていません）");
      }

      const artifactId = params.artifact;
      // **器の名を先に見る。** 使えない器で観測を引きに行くと、器の間違いが
      // 「観測が無い」に化けて、番頭が直しどころを見失う（I2）
      const record =
        artifactId === undefined || !SHOWABLE_UTSUWA_KINDS.includes(params.utsuwa as never)
          ? undefined
          : store.result(artifactId);
      const origin = record
        ? { module: record.module, tool: record.tool, artifact: record.id, at: record.at }
        : // `open` の器と、描けない器はデータを要らない。出どころは番頭自身
          {
            module: "core",
            tool: "canvas.show",
            artifact: artifactId ?? "-",
            at: new Date().toISOString(),
          };

      const data = record ? pickPath(record.details, params.path) : undefined;

      const built = buildUtsuwa(params.utsuwa, data, origin, {
        ...(params.title ? { title: params.title } : {}),
        ...(params.meta ? { meta: params.meta } : {}),
        ...(params.note ? { note: params.note } : {}),
        ...(params.view ? { view: params.view } : {}),
        ...(params.label ? { label: params.label } : {}),
        ...(params.args ? { args: params.args as Record<string, unknown> } : {}),
      });

      // **描けなくても会話は止めない**（決定81(d)）。同じものが会話にも番頭にも出る
      emit(built.utsuwa);
      if (!built.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `器「${params.utsuwa}」では描けませんでした（会話にもそう出しています）。` +
                `出どころ：${origin.module} / ${origin.tool}。足りないもの：${built.missing}。` +
                "別の器にするか、面（canvas.open）へ送ってください",
            },
          ],
          details: { ok: false, utsuwa: built.utsuwa },
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `器「${params.utsuwa}」で会話に出しました（${origin.at} 時点の記録として凍ります）`,
          },
        ],
        details: { ok: true, utsuwa: built.utsuwa },
      };
    },
  });

  // 器を出す先が無ければ `canvas.show` は生やさない（描けない口を並べない）
  const base = [listCatalog, open, close, switchTool, queryState];
  return options.artifacts && options.showUtsuwa ? [...base, show] : base;
}
