/**
 * task-0088 a6〜a9: 器（ADR-0017 決定78・81）。
 *
 * 見たいのは3つ：
 * - **番頭は選ぶが、作らない**——語彙は13種で、増やすには ADR が要る
 * - **データを再送させない**——`canvas.show` は器名と退避済み結果への参照だけを取る
 * - **描けなくても会話は止まらない**——出どころと足りないものを添えて会話に出し、
 *   番頭にも同じものが返る（決定81(d)）
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  ArtifactStore,
  Canvas,
  UTSUWA_KINDS,
  SHOWABLE_UTSUWA_KINDS,
  buildUtsuwa,
  createCanvasCatalog,
  createCanvasTools,
  pickPath,
  withArtifactOffload,
  type UtsuwaView,
} from "@banto/host";
import { defineNamespacedTool } from "@banto/core";
import { Type } from "typebox";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-utsuwa-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const catalog = createCanvasCatalog([
  {
    kind: "file.viewer",
    title: "ファイルを読む",
    description: "1つを読む",
    component: "FileViewer",
    parameters: { type: "object", properties: {} },
  },
]);

const ORIGIN = {
  module: "environment-pool",
  tool: "env.list",
  artifact: "a-0001",
  at: "2026-08-09T02:05:00.000Z",
};

/** `canvas.show` を持つ Tool 一式と、会話へ出た器を覗く口。 */
function showTools(): {
  show: ReturnType<typeof createCanvasTools>[number];
  store: ArtifactStore;
  shown: UtsuwaView[];
} {
  const store = new ArtifactStore(dir);
  const shown: UtsuwaView[] = [];
  const tools = createCanvasTools(new Canvas(catalog), catalog, {
    artifacts: store,
    showUtsuwa: (u) => shown.push(u),
  });
  return { show: tools.find((t) => t.name === "canvas.show")!, store, shown };
}

describe("[task-0088/a7] 器は13種（決定78）", () => {
  it("[task-0088/a7] 語彙は13種で打ち止め", () => {
    assert.equal(UTSUWA_KINDS.length, 13, "増やすには ADR を通す（ADR-0017 未決事項）");
    assert.deepEqual(
      [...UTSUWA_KINDS].sort(),
      [
        "choice",
        "diff",
        "doc",
        "facts",
        "image",
        "list",
        "meter",
        "open",
        "quote",
        "spark",
        "stats",
        "table",
        "timeline",
      ]
    );
  });

  it("[task-0088/a7] 判断待ちの器は取次から出る（決定73 の取次を迂回しない）", async () => {
    assert.ok(!SHOWABLE_UTSUWA_KINDS.includes("choice"));
    const { show, shown } = showTools();
    const result = await show.execute({ utsuwa: "choice", artifact: "a-0001" });
    assert.match(result.content.map((c) => c.text).join(""), /描けませんでした/u);
    assert.equal(shown[0]?.kind, "broken");
  });
});

describe("[task-0088/a8] どの器も「いつの」を出し、後から書き換わらない（決定81(c)）", () => {
  it("[task-0088/a8] 全ての器に at と出どころが載る", () => {
    const samples: Array<[string, unknown]> = [
      ["list", { items: [{ label: "env-31", state: "warn", meta: "6日" }] }],
      ["facts", { facts: [["置き場", "banto"], ["公開URL", null]] }],
      ["table", { cols: [{ label: "行", align: "num" }], rows: [[1770]] }],
      ["diff", { path: "a.css", hunks: [{ header: "@@", lines: [["+", "a"]] }] }],
      ["stats", { stats: [{ value: "4", label: "あなたの番", state: "turn" }] }],
      ["meter", { label: "quota", value: 7, max: 10, unit: "台" }],
      ["spark", { label: "落ちる率", points: [37, 12, 0], good: "down" }],
      ["timeline", { events: [{ at: "09:12", label: "職人を立てた", state: "done" }] }],
      ["image", { src: "artifact:shot", alt: "画面の見本" }],
      ["doc", { excerpt: "## 見出し\n本文" }],
      ["quote", { text: "まれに落ちる、で進めない", source: "記憶 · PO の発言" }],
    ];
    for (const [kind, data] of samples) {
      const built = buildUtsuwa(kind, data, ORIGIN);
      assert.ok(built.ok, `${kind} が描けない: ${built.ok ? "" : built.missing}`);
      assert.equal(built.utsuwa.at, ORIGIN.at, `${kind} に「いつの」が無い`);
      assert.deepEqual(built.utsuwa.from, {
        module: ORIGIN.module,
        tool: ORIGIN.tool,
        artifact: ORIGIN.artifact,
      });
    }
    // 面への口だけはデータを要らない（決定78）
    const open = buildUtsuwa("open", undefined, ORIGIN, { view: "file.viewer", label: "読む" });
    assert.ok(open.ok);
    assert.equal(open.utsuwa.at, ORIGIN.at);
  });

  it("[task-0088/a8] モジュールの独自の状態名は通さない（5役だけ・決定78）", () => {
    const built = buildUtsuwa("list", { items: [{ label: "x", state: "provisioning" }] }, ORIGIN);
    assert.ok(built.ok);
    assert.equal(built.utsuwa.kind === "list" && built.utsuwa.items[0]?.state, undefined);
  });

  it("[task-0088/a8] 切ったことは隠さない（I1）", () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ label: `env-${i}` }));
    const built = buildUtsuwa("list", { items, total: 25 }, ORIGIN);
    assert.ok(built.ok);
    if (built.utsuwa.kind !== "list") return;
    assert.equal(built.utsuwa.items.length, 10);
    assert.equal(built.utsuwa.total, 25);
    assert.match(built.utsuwa.note ?? "", /25 件のうち先頭/u);
  });

  it("[task-0088/a8] null は「—」として残し、勝手に埋めない（I1）", () => {
    const built = buildUtsuwa("facts", { facts: [["公開URL", null]] }, ORIGIN);
    assert.ok(built.ok);
    assert.deepEqual(built.utsuwa.kind === "facts" && built.utsuwa.facts, [["公開URL", null]]);
  });
});

describe("[task-0088/a6] canvas.show は器名と退避済み結果への参照を取る（決定81(a)）", () => {
  it("[task-0088/a6] データを再送させず、退避済みの結果から引く", async () => {
    const { show, store, shown } = showTools();
    const ref = store.writeResult({
      tool: "env.list",
      module: "environment-pool",
      text: "3件",
      details: { envs: { items: [{ label: "env-31", state: "warn", meta: "6日" }] } },
      at: "2026-08-09T02:05:00.000Z",
    });

    // 渡すのは「どの観測を・どの器で・どこを」だけ
    const result = await show.execute({
      utsuwa: "list",
      artifact: ref.id,
      path: "envs",
      title: "止まっていない検証環境",
    });

    assert.match(result.content.map((c) => c.text).join(""), /会話に出しました/u);
    const utsuwa = shown[0];
    assert.equal(utsuwa?.kind, "list");
    if (utsuwa?.kind !== "list") return;
    assert.deepEqual(utsuwa.items, [{ label: "env-31", state: "warn", meta: "6日" }]);
    assert.equal(utsuwa.title, "止まっていない検証環境");
    assert.equal(utsuwa.at, "2026-08-09T02:05:00.000Z", "「いつの」は観測を取った時刻");
    assert.deepEqual(utsuwa.from, {
      module: "environment-pool",
      tool: "env.list",
      artifact: ref.id,
    });
  });

  it("[task-0088/a6] 小さいツール結果にも引換番号が付く（再送させないため）", async () => {
    const store = new ArtifactStore(dir);
    const tool = defineNamespacedTool({
      name: "env.list",
      label: "Env: List",
      description: "テスト用",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text" as const, text: "3件" }], details: { total: 3 } };
      },
    });
    const [wrapped] = withArtifactOffload([tool], store, {
      moduleOf: () => "environment-pool",
    });

    const result = await wrapped!.execute({}, { toolCallId: "t1" });
    const text = result.content.map((c) => c.text).join("\n");
    assert.match(text, /3件/u, "本文はそのまま返る");
    const id = /観測 (a-\d+)/u.exec(text)?.[1];
    assert.ok(id, "引換番号が添えられる");
    const record = store.result(id!);
    assert.equal(record.module, "environment-pool");
    assert.deepEqual(record.details, { total: 3 });
  });

  it("[task-0088/a6] 知らない観測を黙って空で描かない（I2）", async () => {
    const { show } = showTools();
    await assert.rejects(
      () => show.execute({ utsuwa: "list", artifact: "a-9999" }),
      /この会話にありません/u
    );
  });

  it("[task-0088/a6] path は素直なドット記法だけ", () => {
    const data = { a: { b: [{ c: 1 }] } };
    assert.deepEqual(pickPath(data, "a.b.0"), { c: 1 });
    assert.equal(pickPath(data, "a.z"), undefined);
    assert.deepEqual(pickPath(data), data);
  });
});

describe("[task-0088/a9] 描けない戻り値は会話に出し、番頭にも返す（決定81(d)）", () => {
  it("[task-0088/a9] モジュール名・Tool名・器名・足りないものが揃う", async () => {
    const { show, store, shown } = showTools();
    const ref = store.writeResult({
      tool: "env.list",
      module: "environment-pool",
      text: "3件",
      // 表で出そうとするが cols が無い
      details: { rows: [["env-31", 6]] },
    });

    const result = await show.execute({ utsuwa: "table", artifact: ref.id });

    const broken = shown[0];
    assert.equal(broken?.kind, "broken");
    if (broken?.kind !== "broken") return;
    assert.equal(broken.from.module, "environment-pool");
    assert.equal(broken.from.tool, "env.list");
    assert.equal(broken.wanted, "table");
    assert.match(broken.missing, /cols/u);
    assert.match(broken.missing, /rows/u, "在るものも書く（直せるのは登録した人）");
    // 素の値は畳んで置く（黙って素の JSON を出さない）
    assert.ok(broken.raw && broken.raw.includes("env-31"));

    // **番頭にも同じものが返る**ので言い直せる。会話は止まらない（失敗にしない）
    const text = result.content.map((c) => c.text).join("");
    assert.match(text, /environment-pool/u);
    assert.match(text, /cols/u);
    assert.match(text, /別の器/u);
  });

  it("[task-0088/a9] 分母の無い割合は出さない（I1）", () => {
    const built = buildUtsuwa("meter", { label: "quota", value: 7 }, ORIGIN);
    assert.ok(!built.ok);
    assert.match(built.missing, /max/u);
  });

  it("[task-0088/a9] 説明の無い画像・出どころの無い引用は出さない（I1）", () => {
    const image = buildUtsuwa("image", { src: "artifact:shot" }, ORIGIN);
    assert.ok(!image.ok);
    assert.match(image.missing, /alt/u);

    const quote = buildUtsuwa("quote", { text: "ひとこと" }, ORIGIN);
    assert.ok(!quote.ok);
    assert.match(quote.missing, /source/u);
  });

  it("[task-0088/a9] 知らない器の名は使える器を添えて返す", () => {
    const built = buildUtsuwa("barchart", {}, ORIGIN);
    assert.ok(!built.ok);
    assert.match(built.missing, /list/u, "使える器を並べる");
  });
});
