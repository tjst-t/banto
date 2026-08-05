/**
 * 提案「コンパクションをやめ、退避と章立てで文脈を管理する」§3.1 の受け入れ検証。
 *
 * 確かめるのは「**要約せず、参照に置き換える**」という性質そのもの:
 *
 * - 大きなツール結果は文脈に載らない（栞になる）
 * - しかし**情報は失われない**——`artifact.read` で全文が戻る
 * - 小さい結果はそのまま通る（退避が邪魔をしない）
 * - 退避は会話ごとに閉じている（別の会話の観測を引けない）
 *
 * LLM には繋がない。退避はホスト側の機構で、モデルの振る舞いに依らない。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";

import {
  ArtifactStore,
  createArtifactTools,
  renderArtifactIndex,
  defineNamespacedTool,
  outlineOf,
  withArtifactOffload,
  type NamespacedToolDefinition,
} from "@banto/host";

let dir: string;
let store: ArtifactStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-artifacts-"));
  store = new ArtifactStore(path.join(dir, "thread-1"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 指定した本文を返すだけの Tool。 */
function fakeTool(name: `${string}.${string}`, text: string): NamespacedToolDefinition {
  return defineNamespacedTool({
    name,
    label: name,
    description: "test",
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    async execute() {
      return { content: [{ type: "text" as const, text }], details: { size: text.length } };
    },
  }) as NamespacedToolDefinition;
}

const BIG = "# 見出しA\n" + "あ".repeat(3000) + "\n## 見出しB\n" + "い".repeat(3000);

// ── 退避そのもの ────────────────────────────────────────────────────────────

describe("[提案§3.1] 大きなツール出力は栞に置き換わる", () => {
  it("閾値を超えた結果は文脈に載らない", async () => {
    const [tool] = withArtifactOffload([fakeTool("file.read", BIG)], store);
    const result = await tool!.execute({ path: "docs/big.md" });
    const text = result.content.map((c) => c.text).join("");

    assert.doesNotMatch(text, /あああああ/, "本文が文脈に残ってはいけない");
    assert.match(text, /artifact a-0001/, "栞に artifact のIDが要る");
    assert.ok(text.length < 1000, `栞が大きすぎる（${text.length}字）`);
  });

  it("栞には元の大きさと、読み戻す手立てが書いてある", async () => {
    const [tool] = withArtifactOffload([fakeTool("file.read", BIG)], store);
    const text = (await tool!.execute({ path: "docs/big.md" })).content[0]!.text;

    assert.match(text, /file\.read/, "どの Tool の出力か");
    assert.match(text, /6,0\d\d字/, "元の大きさ");
    assert.match(text, /artifact\.read/, "読み戻す手立て");
  });

  it("栞には見出しが載る（中身の当たりが付く）", async () => {
    const [tool] = withArtifactOffload([fakeTool("file.read", BIG)], store);
    const text = (await tool!.execute({ path: "docs/big.md" })).content[0]!.text;

    assert.match(text, /# 見出しA/);
    assert.match(text, /## 見出しB/);
  });

  it("小さい結果はそのまま通る（退避が邪魔をしない）", async () => {
    const [tool] = withArtifactOffload([fakeTool("git.status", "clean")], store);
    const text = (await tool!.execute({})).content[0]!.text;

    assert.equal(text, "clean");
  });

  it("details（GUI 向け）は退避しても通る——画面の情報は減らさない", async () => {
    const [tool] = withArtifactOffload([fakeTool("file.read", BIG)], store);
    const result = await tool!.execute({ path: "docs/big.md" });

    assert.deepEqual(result.details, { size: BIG.length });
  });

  it("Tool の名前・説明・パラメータは変わらない（番頭から見た契約はそのまま）", () => {
    const original = fakeTool("file.read", BIG);
    const [wrapped] = withArtifactOffload([original], store);

    assert.equal(wrapped!.name, original.name);
    assert.equal(wrapped!.description, original.description);
    assert.deepEqual(wrapped!.parameters, original.parameters);
  });
});

// ── 情報を失わないこと（要約との違い）────────────────────────────────────────

describe("[提案§3.1] 退避は可逆——情報を失わない", () => {
  it("退避した全文がそのままファイルに残る", async () => {
    const [tool] = withArtifactOffload([fakeTool("file.read", BIG)], store);
    await tool!.execute({ path: "docs/big.md" });

    const saved = fs.readFileSync(path.join(dir, "thread-1", "a-0001.md"), "utf-8");
    assert.equal(saved, BIG, "1文字も変えずに残っていること");
  });

  it("artifact.read で本文が読み戻せる", async () => {
    const [tool] = withArtifactOffload([fakeTool("file.read", "行1\n行2\n行3")], store, {
      thresholdChars: 1,
    });
    await tool!.execute({});

    const [read] = createArtifactTools(store);
    const out = (await read!.execute({ id: "a-0001" })).content[0]!.text;
    assert.match(out, /行1\n行2\n行3/);
  });

  it("artifact.read は行の範囲で読める", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `行${i + 1}`).join("\n");
    store.write(lines);

    const [read] = createArtifactTools(store);
    const out = (await read!.execute({ id: "a-0001", offset: 10, limit: 3 })).content[0]!.text;

    assert.match(out, /行10\n行11\n行12/);
    assert.doesNotMatch(out, /行13/);
    assert.match(out, /全 100 行/);
  });

  it("artifact.read は語で絞れる（行番号つき）", async () => {
    store.write("あたり\nはずれ\nあたり2");

    const [read] = createArtifactTools(store);
    const out = (await read!.execute({ id: "a-0001", grep: "あたり" })).content[0]!.text;

    assert.match(out, /1: あたり/);
    assert.match(out, /3: あたり2/);
    assert.doesNotMatch(out, /はずれ/);
  });

  it("読み戻しにも上限がある（全部を一度に戻せない）", async () => {
    store.write("あ".repeat(50_000));

    const [read] = createArtifactTools(store);
    const out = (await read!.execute({ id: "a-0001" })).content[0]!.text;

    assert.ok(out.length < 10_000, `一度に戻しすぎ（${out.length}字）`);
    assert.match(out, /以降は省略/);
  });
});

// ── 砦 ──────────────────────────────────────────────────────────────────────

describe("[提案§3.1] 退避先は会話ごとに閉じている", () => {
  it("別の会話の artifact は引けない", () => {
    const other = new ArtifactStore(path.join(dir, "thread-2"));
    other.write("別の会話の観測");

    // thread-1 のストアからは見えない
    assert.throws(() => store.read("a-0001"), /この会話にありません/);
  });

  it("無いIDは黙って空を返さずエラーにする（I2）", () => {
    assert.throws(() => store.read("a-9999"), /この会話にありません/);
  });

  it("パスを含むIDは弾く（../ で外へ出させない）", () => {
    assert.throws(() => store.read("../../etc/passwd"), /artifact のIDは/);
    assert.throws(() => store.read("a-1/../../x"), /artifact のIDは/);
  });

  it("番号は既存のファイルから導く（再起動しても上書きしない・D3）", () => {
    store.write("1件目");
    // 別インスタンス = ホストを再起動した状態
    const reopened = new ArtifactStore(path.join(dir, "thread-1"));
    const second = reopened.write("2件目");

    assert.equal(second.id, "a-0002");
    assert.equal(fs.readFileSync(path.join(dir, "thread-1", "a-0001.md"), "utf-8"), "1件目");
  });
});

// ── 退避しないもの ──────────────────────────────────────────────────────────

describe("[提案§3.1] 退避しない Tool", () => {
  it("artifact.read 自身は退避しない（読んだ先がまた栞になったら読めない）", async () => {
    const tools = withArtifactOffload(createArtifactTools(store), store, { thresholdChars: 1 });
    store.write("読みたい本文");

    const out = (await tools[0]!.execute({ id: "a-0001" })).content[0]!.text;
    assert.match(out, /読みたい本文/);
  });

  it("memory.* は退避しない（予算で既に絞ってある）", async () => {
    const [tool] = withArtifactOffload([fakeTool("memory.recall", BIG)], store);
    const text = (await tool!.execute({})).content[0]!.text;
    assert.equal(text, BIG);
  });

  it("skill.* は退避しない（段階的開示が1段増えるだけ）", async () => {
    const [tool] = withArtifactOffload([fakeTool("skill.read", BIG)], store);
    const text = (await tool!.execute({})).content[0]!.text;
    assert.equal(text, BIG);
  });
});

// ── 栞の組み立て ────────────────────────────────────────────────────────────

describe("[提案§3.1] 栞は要約しない（機械的に抜けるものだけ）", () => {
  it("Markdown の見出しがあれば見出しを使う", () => {
    assert.equal(outlineOf("# A\n本文\n## B\n本文"), "# A\n## B");
  });

  it("見出しが無ければ先頭の数行を使う", () => {
    assert.equal(outlineOf("一行目\n二行目\n三行目\n四行目"), "一行目\n二行目\n三行目");
  });

  it("見出しが多すぎるときは打ち切る", () => {
    const many = Array.from({ length: 30 }, (_, i) => `# 見出し${i}`).join("\n");
    assert.equal(outlineOf(many).split("\n").length, 12);
  });
});

// ── 一覧と、章を畳んだあとの手がかり（PO指摘 2026-08-05）────────────────────

describe("[提案§3.1] 退避したものを数え上げられる", () => {
  it("ArtifactStore.list が ID・大きさ・見出しを返す", () => {
    store.write("# 見出しA\n本文");
    store.write("# 見出しB\n本文");

    const items = store.list();
    assert.deepEqual(items.map((a) => a.id), ["a-0001", "a-0002"]);
    assert.match(items[0]!.outline, /# 見出しA/);
    assert.ok(items[0]!.chars > 0);
  });

  it("退避が無ければ空", () => {
    assert.deepEqual(store.list(), []);
  });

  it("**見出しを取るのに全文は読まない**（大きいものを一覧するたびに読み直さない）", () => {
    // 4KB を超える位置にある見出しは拾われない＝先頭だけ読んでいる証拠
    store.write(`# 先頭の見出し\n${"あ".repeat(20000)}\n# ずっと後ろの見出し`);
    const outline = store.list()[0]!.outline;

    assert.match(outline, /# 先頭の見出し/);
    assert.doesNotMatch(outline, /ずっと後ろの見出し/);
  });

  it("artifact.list Tool が一覧を返す", async () => {
    store.write("# ADR-0010\n本文");
    const [, list] = createArtifactTools(store);

    const out = (await list!.execute({})).content[0]!.text;
    assert.match(out, /a-0001/);
    assert.match(out, /ADR-0010/);
  });

  it("artifact.list は退避が無いときそう言う（エラーにしない）", async () => {
    const [, list] = createArtifactTools(store);
    assert.match((await list!.execute({})).content[0]!.text, /退避された観測はありません/);
  });
});

describe("[提案§3.1] 引き継ぎ資料に載せる索引", () => {
  it("ID・大きさ・見出しが並び、読み方が書いてある", () => {
    store.write("# ADR-0010\n本文");
    store.write("# 職人の報告\n本文");

    const index = renderArtifactIndex(store.list());
    assert.match(index, /## この章で退避した観測/);
    assert.match(index, /`a-0001`/);
    assert.match(index, /ADR-0010/);
    assert.match(index, /`a-0002`/);
    assert.match(index, /artifact\.read/);
  });

  it("退避が無ければ空文字（資料に空の節を足さない）", () => {
    assert.equal(renderArtifactIndex([]), "");
  });
});
