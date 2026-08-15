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
  describeDetails,
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

/**
 * imp-0035: 器が道具の戻り値を描けない。
 *
 * **道具は1本も変えない**（決定81(a) が書き換えを明文で却下している）ので、直すのは器の側。
 * 下の `details` は実物の道具の戻り値の形（`worker.list` は `pool.find()` を、`env.list` は
 * `{ environments, limits, orphans, artifacts, maintaining }` を、`kobo.list` は
 * `{ tasks, total, truncated }` をそのまま返す）に合わせてある。
 */
const REAL_DETAILS: Record<string, unknown> = {
  "worker.list": {
    workers: [
      {
        taskId: "task-0093",
        projectTag: "banto",
        state: "closed",
        alive: false,
        runtime: "pi",
        pid: 1234,
        sessionId: "s-1",
      },
      {
        taskId: "task-0094",
        projectTag: "banto",
        state: "running",
        alive: true,
        runtime: "pi",
        pid: 1235,
        sessionId: "s-2",
      },
    ],
    total: 2,
    closedTotal: 1,
    limit: 20,
    offset: 0,
  },
  "env.list": {
    environments: [
      {
        envId: "env-31",
        profile: "web",
        state: "live",
        taskId: "task-0093",
        url: "https://x.example",
        ttlDeadline: "2026-08-16",
      },
    ],
    limits: { maxInstancesTotal: 8, maxInstancesPerProfile: 3, defaultRunTimeoutMs: 600000 },
    orphans: [],
    artifacts: { count: 0, bytes: 0 },
    maintaining: true,
  },
  "kobo.list": {
    tasks: [
      { taskId: "task-0093", projectTag: "banto", status: "review-ready", title: "ゲートを直す" },
      { taskId: "task-0094", projectTag: "banto", status: "queued", title: "器を直す" },
    ],
    total: 2,
    truncated: false,
  },
  "git.log": {
    commits: [
      { hash: "b9e6cde", date: "2026-08-15", author: "tjst-t", subject: "docs: 規約を書く" },
      { hash: "fc0da30", date: "2026-08-15", author: "tjst-t", subject: "fix: 固定しない" },
    ],
  },
  "file.grep": {
    pattern: "buildUtsuwa",
    hits: [
      { path: "packages/banto-host/src/canvas-tools.ts", line: 204, text: "const built = buildUtsuwa(" },
      { path: "packages/banto-host/src/index.ts", line: 181, text: "  buildUtsuwa," },
    ],
    truncated: false,
  },
};

describe("[imp-0035] 器が実物の道具の戻り値を描ける", () => {
  it("[imp-0035] 5本の戻り値が list に載り、見出しが「—」にならない", () => {
    for (const [tool, details] of Object.entries(REAL_DETAILS)) {
      const built = buildUtsuwa("list", details, ORIGIN);
      assert.ok(built.ok, `${tool} が list に載らない: ${built.ok ? "" : built.missing}`);
      if (built.utsuwa.kind !== "list") return;
      assert.ok(built.utsuwa.items.length > 0, `${tool} の行が空`);
      for (const item of built.utsuwa.items) {
        assert.notEqual(item.label, "—", `${tool} の見出しが「—」`);
      }
    }
  });

  it("[imp-0035] 5本の戻り値が table に載り、列の名前と行が出る", () => {
    for (const [tool, details] of Object.entries(REAL_DETAILS)) {
      const built = buildUtsuwa("table", details, ORIGIN);
      assert.ok(built.ok, `${tool} が table に載らない: ${built.ok ? "" : built.missing}`);
      if (built.utsuwa.kind !== "table") return;
      assert.ok(built.utsuwa.cols.length > 0, `${tool} の列が空`);
      assert.ok(built.utsuwa.rows.length > 0, `${tool} の行が空`);
      for (const col of built.utsuwa.cols) assert.notEqual(col.label, "—");
      // 先頭の列は**その行を人が識別できる値**（識別子や題）で、空にならない
      for (const row of built.utsuwa.rows) assert.ok(row[0] !== null, `${tool} の1列目が空`);
    }
  });

  it("[imp-0035] path を書いても同じところに着く（配列を直接指す）", () => {
    const details = REAL_DETAILS["worker.list"];
    const auto = buildUtsuwa("list", details, ORIGIN);
    const pointed = buildUtsuwa("list", pickPath(details, "workers"), ORIGIN);
    assert.ok(auto.ok && pointed.ok);
    assert.deepEqual(
      auto.utsuwa.kind === "list" && auto.utsuwa.items,
      pointed.utsuwa.kind === "list" && pointed.utsuwa.items
    );
  });

  it("[imp-0035] 行の配列が一意でないときは黙って選ばず、鍵を名指しして断る", () => {
    const built = buildUtsuwa(
      "list",
      { environments: [{ envId: "env-31" }], orphans: [{ envId: "env-9" }], maintaining: true },
      ORIGIN
    );
    assert.ok(!built.ok, "どちらを出すかは器が決めることではない");
    assert.match(built.missing, /environments/u, "候補を名指しする");
    assert.match(built.missing, /orphans/u);
    assert.match(built.missing, /path/u, "次に何を書けばよいかまで書く");
  });

  it("[imp-0035] 行の配列が無いときは在る鍵を並べて断る", () => {
    const built = buildUtsuwa("list", { total: 3, limit: 20, offset: 0 }, ORIGIN);
    assert.ok(!built.ok);
    assert.match(built.missing, /total/u, "在る鍵を名指しする（番頭が path を書けるように）");
  });

  it("[imp-0035] 行が文字列そのものでも見出しになる", () => {
    const built = buildUtsuwa("list", { items: ["docs/adr", "docs/spec"] }, ORIGIN);
    assert.ok(built.ok);
    assert.deepEqual(
      built.utsuwa.kind === "list" && built.utsuwa.items.map((i) => i.label),
      ["docs/adr", "docs/spec"]
    );
  });
});

describe("[imp-0035] facts は入れ子を黙って捨てない（I1）", () => {
  it("[imp-0035] 中身の入った鍵が落ちるくらいなら描かない", () => {
    // 直す前は `total` / `closedTotal` / `limit` / `offset` だけで「成功」していた——
    // **中身が無いのに成功して見える**のがいちばん質が悪い
    const built = buildUtsuwa("facts", REAL_DETAILS["worker.list"], ORIGIN);
    assert.ok(!built.ok, "workers が消えたまま成功してはいけない");
    assert.match(built.missing, /workers/u, "落ちる鍵を名指しする");
    assert.match(built.missing, /list/u, "どの器なら出せるかまで書く");
    assert.match(built.missing, /path/u);
  });

  it("[imp-0035] 平たい値だけなら今までどおり通る", () => {
    const built = buildUtsuwa("facts", { 置き場: "banto", 公開URL: null }, ORIGIN);
    assert.ok(built.ok);
    assert.deepEqual(built.utsuwa.kind === "facts" && built.utsuwa.facts, [
      ["置き場", "banto"],
      ["公開URL", null],
    ]);
  });

  it("[imp-0035] path で下の階層を指せば描ける（断り文の言うとおりにすると通る）", () => {
    const details = REAL_DETAILS["env.list"];
    const built = buildUtsuwa("facts", pickPath(details, "limits"), ORIGIN);
    assert.ok(built.ok, `断り文の案内どおりにして描けないのは案内が嘘: ${built.ok ? "" : built.missing}`);
  });
});

describe("[imp-0035] 当たらない状態の語で嘘の色が点かない", () => {
  it("[imp-0035] 実データの語は無色で素通しする（勝手に warn へ倒さない）", () => {
    // 器の語彙は5役だけ。誰が写すのかはまだ決まっていないので、ここでは写さない
    const words = ["closed", "running", "idle", "live", "open", "failed", "queued", "review-ready"];
    for (const word of words) {
      const built = buildUtsuwa("list", { items: [{ label: "x", state: word }] }, ORIGIN);
      assert.ok(built.ok);
      assert.equal(
        built.utsuwa.kind === "list" && built.utsuwa.items[0]?.state,
        undefined,
        `"${word}" に色が点いた（当たらない語は無色）`
      );
    }
  });

  it("[imp-0035] 5役の語はそのまま通る", () => {
    for (const word of ["run", "turn", "stop", "warn", "done"]) {
      const built = buildUtsuwa("list", { items: [{ label: "x", state: word }] }, ORIGIN);
      assert.ok(built.ok);
      assert.equal(built.utsuwa.kind === "list" && built.utsuwa.items[0]?.state, word);
    }
  });
});

describe("[imp-0035] 落とした列は書く（table）", () => {
  it("[imp-0035] 列を切ったこと・入れ子を載せていないことを添え書きに出す", () => {
    const built = buildUtsuwa(
      "table",
      { rows: [{ id: "a", one: 1, two: 2, three: 3, four: 4, nest: { x: 1 } }] },
      ORIGIN
    );
    assert.ok(built.ok);
    if (built.utsuwa.kind !== "table") return;
    assert.equal(built.utsuwa.cols.length, 4, "膳に載るのは4列まで");
    assert.match(built.utsuwa.note ?? "", /列は/u, "切ったことを隠さない");
    assert.match(built.utsuwa.note ?? "", /nest/u, "入れ子を載せていないことも書く");
  });

  it("[imp-0035] 番頭の添え書きを消さずに足す", () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ label: `env-${i}` }));
    const built = buildUtsuwa("list", { items, total: 25 }, ORIGIN, { note: "手で選んだ分" });
    assert.ok(built.ok);
    assert.match(built.utsuwa.note ?? "", /手で選んだ分/u);
    assert.match(built.utsuwa.note ?? "", /25 件のうち先頭/u);
  });
});

describe("[imp-0035] 栞が details の鍵名を教える", () => {
  it("[imp-0035] どの鍵があり、どれが行の配列かが読める", () => {
    assert.match(describeDetails(REAL_DETAILS["worker.list"]) ?? "", /workers\[2\]/u);
    assert.match(describeDetails(REAL_DETAILS["worker.list"]) ?? "", /path: "workers"/u);
    // 候補が複数なら「どれか1つを指す」と言う（器は勝手に選ばない）
    const many = describeDetails({ a: [1], b: [2] }) ?? "";
    assert.match(many, /`a`/u);
    assert.match(many, /`b`/u);
  });

  it("[imp-0035] 小さい結果の栞に鍵名が載る（番頭は他に知る手段が無い）", async () => {
    const store = new ArtifactStore(dir);
    const tool = defineNamespacedTool({
      name: "worker.list",
      label: "Worker: List",
      description: "テスト用",
      parameters: Type.Object({}),
      async execute() {
        return {
          content: [{ type: "text" as const, text: "2件" }],
          details: REAL_DETAILS["worker.list"],
        };
      },
    });
    const [wrapped] = withArtifactOffload([tool], store, { moduleOf: () => "worker-pool" });
    const result = await wrapped!.execute({}, { toolCallId: "t1" });
    const text = result.content.map((c) => c.text).join("\n");
    assert.match(text, /観測 a-\d+/u);
    assert.match(text, /workers/u, "鍵名が読める");
    assert.match(text, /path: "workers"/u, "どれが行の配列かまで読める");
  });

  it("[imp-0035] 退避された（大きい）結果の栞にも載る", async () => {
    const store = new ArtifactStore(dir);
    const tool = defineNamespacedTool({
      name: "kobo.list",
      label: "Kobo: List",
      description: "テスト用",
      parameters: Type.Object({}),
      async execute() {
        return {
          content: [{ type: "text" as const, text: "x".repeat(5000) }],
          details: REAL_DETAILS["kobo.list"],
        };
      },
    });
    const [wrapped] = withArtifactOffload([tool], store, { moduleOf: () => "kobo" });
    const result = await wrapped!.execute({}, { toolCallId: "t1" });
    const text = result.content.map((c) => c.text).join("\n");
    assert.match(text, /器に載せるなら/u);
    assert.match(text, /path: "tasks"/u);
  });
});
