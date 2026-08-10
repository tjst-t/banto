/**
 * 提案「コンパクションをやめ、退避と章立てで文脈を管理する」§3.3 / §3.4 / §3.5 の受け入れ検証。
 *
 * ここで確かめるのは3つ:
 *
 * 1. **注入の予算**（§3.3）——記憶は際限なくプロンプトへ載らない。溢れたら件数を知らせる
 * 2. **忘れる・探す**（§3.4）——削除は追記で表し、溢れた記憶は検索で引ける
 * 3. **二層**（§3.5 / ADR-0003）——人の記憶は横断、プロジェクトの記憶は横断しない
 *
 * Kobo にも LLM にも繋がない。記憶は番頭核の中で完結する。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  JsonlMemoryStore,
  ScopedMemory,
  estimateMemoryTokens,
  projectIdOf,
  projectScopesOf,
  resolveProjects,
  selectMemoriesForBudget,
  type MemoryRecord,
} from "@banto/core";
import { PlaceRegistry, createMemoryTools, renderMemoryForPrompt } from "@banto/host";

let dir: string;
let person: JsonlMemoryStore;
let memory: ScopedMemory;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-memory-layers-"));
  person = new JsonlMemoryStore(path.join(dir, "memory.jsonl"));
  memory = new ScopedMemory(
    person,
    (placeId) => new JsonlMemoryStore(path.join(dir, "projects", encodeURIComponent(placeId), "memory.jsonl"))
  );
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const tool = (name: string) => {
  const found = createMemoryTools(memory).find((t) => t.name === name);
  assert.ok(found, `${name} が登録されていない`);
  return found;
};

// ── §3.3 注入の予算 ─────────────────────────────────────────────────────────

describe("[提案§3.3] 記憶の注入は予算で打ち切られる", () => {
  it("予算に収まる記憶だけがプロンプトに載る", () => {
    // 1件 200 文字 ≒ 100 トークンの見積り。予算 250 なら 2件までしか入らない
    for (let i = 0; i < 5; i++) {
      person.save({ kind: "preference", text: `好み${i}` + "あ".repeat(199) });
    }
    const prompt = renderMemoryForPrompt(memory, { tokenBudget: 250 });

    const loaded = [0, 1, 2, 3, 4].filter((i) => prompt.includes(`好み${i}`));
    assert.equal(loaded.length, 2, `予算 250 なら2件のはず（実際: ${loaded.length}件）`);
  });

  it("溢れた件数をプロンプトに明示する（黙って落とさない・I2）", () => {
    for (let i = 0; i < 5; i++) {
      person.save({ kind: "preference", text: `好み${i}` + "あ".repeat(199) });
    }
    const prompt = renderMemoryForPrompt(memory, { tokenBudget: 250 });

    assert.match(prompt, /他に 3 件ある/, "溢れた件数が書かれていない");
    assert.match(prompt, /memory\.search/, "引く手段が案内されていない");
  });

  it("予算に収まるときは「他に」の断りを出さない", () => {
    person.save({ kind: "fact", text: "POの名前は「たくみ」である" });
    const prompt = renderMemoryForPrompt(memory, { tokenBudget: 1500 });

    assert.doesNotMatch(prompt, /他に \d+ 件/);
  });

  it("事実 → 好み → 習慣 の順で予算を使う（決定31d：事実が最も安定している）", () => {
    // 予算が1件分しか無いとき、残るのは事実でなければならない
    person.save({ kind: "habit", text: "習慣" + "あ".repeat(199) });
    person.save({ kind: "preference", text: "好み" + "あ".repeat(199) });
    person.save({ kind: "fact", text: "事実" + "あ".repeat(199) });

    const prompt = renderMemoryForPrompt(memory, { tokenBudget: 120 });
    assert.match(prompt, /事実/);
    assert.doesNotMatch(prompt, /### 好み/);
    assert.doesNotMatch(prompt, /### 習慣/);
  });

  it("同じ種別なら、PO が言ったこと（explicit）が抽出（extracted）より先に載る（決定28）", () => {
    person.save({ kind: "preference", text: "抽出された好み" + "あ".repeat(199), origin: "extracted" });
    person.save({ kind: "preference", text: "POが言った好み" + "あ".repeat(199), origin: "explicit" });

    const prompt = renderMemoryForPrompt(memory, { tokenBudget: 120 });
    assert.match(prompt, /POが言った好み/);
    assert.doesNotMatch(prompt, /抽出された好み/);
  });

  it("抽出された記憶には印が付く（出所が読める・決定28）", () => {
    person.save({ kind: "fact", text: "抽出した事実", origin: "extracted" });
    assert.match(renderMemoryForPrompt(memory), /抽出した事実.*\[抽出\]/);
  });

  it("長い1件が、後ろの短い記憶を巻き添えにしない", () => {
    person.save({ kind: "preference", text: "長い好み" + "あ".repeat(999) });
    person.save({ kind: "preference", text: "短い好み" });

    const prompt = renderMemoryForPrompt(memory, { tokenBudget: 100 });
    assert.match(prompt, /短い好み/, "予算を割った1件で以降を全部落としてはいけない");
  });

  it("selectMemoriesForBudget は選抜と溢れを分けて返す（純関数）", () => {
    const records: MemoryRecord[] = [
      { id: "a", kind: "fact", text: "あ".repeat(100), createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "b", kind: "fact", text: "い".repeat(100), createdAt: "2026-01-02T00:00:00.000Z" },
    ];
    // 100文字 = 50トークンの見積り。予算 60 なら1件だけ
    const { selected, omitted } = selectMemoriesForBudget(records, { tokenBudget: 60 });
    assert.equal(selected.length, 1);
    assert.equal(omitted.length, 1);
    assert.equal(estimateMemoryTokens("あ".repeat(100)), 50);
  });
});

// ── §3.4 忘れる・探す ───────────────────────────────────────────────────────

describe("[提案§3.4] 忘れることと探すこと", () => {
  it("forget は消さずに追記で表す（D3：有効な記憶は読み出しで導く）", () => {
    const saved = person.save({ kind: "preference", text: "もう当てはまらない好み" });
    person.forget(saved.id, "PO が方針を変えた");

    assert.deepEqual(person.list(), [], "忘れた記憶は既定の一覧から外れる");
    const raw = fs.readFileSync(path.join(dir, "memory.jsonl"), "utf-8");
    assert.match(raw, /もう当てはまらない好み/, "ファイルからは消えない（履歴として残る）");
    assert.match(raw, /PO が方針を変えた/, "忘れた理由が残る");
  });

  it("忘れた記憶はプロンプトに注入されない", () => {
    const saved = person.save({ kind: "fact", text: "誤って覚えた事実" });
    person.forget(saved.id);
    assert.equal(renderMemoryForPrompt(memory), "");
  });

  it("忘れた記憶も履歴としては引ける", () => {
    const saved = person.save({ kind: "fact", text: "誤って覚えた事実" });
    person.forget(saved.id);

    const history = person.list({ includeSuperseded: true });
    assert.ok(history.some((r) => r.id === saved.id), "履歴には残る");
  });

  it("知らないIDを忘れようとしたらエラーにする（I2）", () => {
    assert.throws(() => person.forget("no-such-id"), /Cannot forget unknown memory/);
  });

  it("search は本文の部分一致で引く。空白区切りは AND", () => {
    person.save({ kind: "habit", text: "リリース前に CHANGELOG を更新する" });
    person.save({ kind: "habit", text: "毎朝アテンションキューを確認する" });

    assert.equal(person.search({ text: "CHANGELOG" }).length, 1);
    assert.equal(person.search({ text: "リリース CHANGELOG" }).length, 1, "AND で当たる");
    assert.equal(person.search({ text: "リリース 存在しない語" }).length, 0, "AND なので落ちる");
  });

  it("search は忘れた記憶・訂正済みの記憶を返さない", () => {
    const stale = person.save({ kind: "preference", text: "古い前提" });
    person.supersede(stale.id, { kind: "preference", text: "新しい前提" });
    const gone = person.save({ kind: "preference", text: "忘れる前提" });
    person.forget(gone.id);

    const hits = person.search({ text: "前提" }).map((r) => r.text);
    assert.deepEqual(hits, ["新しい前提"]);
  });

  it("memory.search Tool が予算から溢れた記憶を引ける", async () => {
    for (let i = 0; i < 5; i++) {
      person.save({ kind: "preference", text: `好み${i}` + "あ".repeat(199) });
    }
    const prompt = renderMemoryForPrompt(memory, { tokenBudget: 250 });
    const missing = [0, 1, 2, 3, 4].filter((i) => !prompt.includes(`好み${i}`));
    assert.ok(missing.length > 0);

    const result = await tool("memory.search").execute({ text: `好み${missing[0]}` } as never);
    assert.match(JSON.stringify(result.content), new RegExp(`好み${missing[0]}`));
  });

  it("memory.forget Tool は理由つきで忘れられる", async () => {
    const saved = person.save({ kind: "fact", text: "誤った事実" });
    await tool("memory.forget").execute({ id: saved.id, reason: "誤りだった" } as never);
    assert.deepEqual(person.list(), []);
  });
});

// ── §3.5 二層（ADR-0003）────────────────────────────────────────────────────

describe("[提案§3.5 / ADR-0003] 記憶の二層", () => {
  it("プロジェクトの記憶は人の記憶に混ざらない", () => {
    person.save({ kind: "fact", text: "POの名前は「たくみ」である" });
    memory.forProject("github.com/tjst-t/banto").save({ kind: "fact", text: "banto のテストは env -u が要る" });

    assert.deepEqual(
      person.list().map((r) => r.text),
      ["POの名前は「たくみ」である"],
      "人の記憶にプロジェクトの記憶が入ってはいけない"
    );
  });

  it("あるプロジェクトの記憶は、別のプロジェクトへ横断しない（ADR-0003 の眼目）", () => {
    memory.forProject("proj-a").save({ kind: "fact", text: "A のデプロイは staging 経由" });
    memory.forProject("proj-b").save({ kind: "fact", text: "B のデプロイは直接" });

    assert.deepEqual(
      memory.forProject("proj-a").list().map((r) => r.text),
      ["A のデプロイは staging 経由"]
    );
    assert.deepEqual(
      memory.forProject("proj-b").list().map((r) => r.text),
      ["B のデプロイは直接"]
    );
  });

  it("同じ場所を2度開いても同じストアになる（追記の並びがずれない）", () => {
    const first = memory.forProject("proj-a");
    first.save({ kind: "fact", text: "1件目" });
    const second = memory.forProject("proj-a");
    second.save({ kind: "fact", text: "2件目" });

    assert.equal(first.list().length, 2);
    assert.equal(second.list().length, 2);
  });

  it("プロンプトには、いま効く場所の記憶だけが見出しつきで載る", () => {
    person.save({ kind: "fact", text: "POの名前は「たくみ」である" });
    memory.forProject("proj-a").save({ kind: "fact", text: "A の決定" });
    memory.forProject("proj-b").save({ kind: "fact", text: "B の決定" });

    const prompt = renderMemoryForPrompt(memory, { trunks: [{ id: "proj-a", label: "プロジェクトA" }] });

    assert.match(prompt, /## あなた（人）について/);
    assert.match(prompt, /## プロジェクトA について/);
    assert.match(prompt, /A の決定/);
    assert.doesNotMatch(prompt, /B の決定/, "渡していない場所の記憶が載ってはいけない");
  });

  it("場所を渡さなければ人の記憶だけが載る", () => {
    person.save({ kind: "fact", text: "人の事実" });
    memory.forProject("proj-a").save({ kind: "fact", text: "A の決定" });

    const prompt = renderMemoryForPrompt(memory);
    assert.match(prompt, /人の事実/);
    assert.doesNotMatch(prompt, /A の決定/);
  });

  it("幹の記憶は「その幹の中でだけ効く」とプロンプトに書く", () => {
    memory.forProject("proj-a").save({ kind: "fact", text: "A の決定" });
    const prompt = renderMemoryForPrompt(memory, { trunks: [{ id: "proj-a" }] });
    assert.match(prompt, /他の幹へ持ち出さない/);
    // 幹をまたぐ引き方があることも書く（分けた代償を番頭が回収できるように）
    assert.match(prompt, /acrossTrunks/);
  });

  it("場所を持たない構成でプロジェクトの記憶を引こうとしたらエラー（I2：人の記憶へ落とさない）", () => {
    const personOnly = new ScopedMemory(person);
    assert.throws(() => personOnly.forProject("proj-a"), /project memory is not configured/);
  });

  it("place を空にしたままプロジェクトの記憶を引こうとしたらエラー", () => {
    assert.throws(() => memory.forProject("  "), /requires a place id/);
  });

  it('memory.save Tool は scope: "project" に幹を要求する（既定が無いとき）', async () => {
    await assert.rejects(
      () => tool("memory.save").execute({ kind: "fact", text: "X", scope: "project" } as never),
      /幹が要ります/
    );
  });

  it("memory.save Tool は知らない幹への保存を断る（I2）", async () => {
    const tools = createMemoryTools(memory, { knownTrunkIds: () => ["proj-a"] });
    const save = tools.find((t) => t.name === "memory.save")!;
    await assert.rejects(
      () => save.execute({ kind: "fact", text: "X", scope: "project", trunk: "proj-z" } as never),
      /知らない幹です/
    );
  });

  it("memory.save Tool でプロジェクトの記憶を保存できる", async () => {
    await tool("memory.save").execute({
      kind: "fact",
      text: "A の決定",
      scope: "project",
      trunk: "proj-a",
    } as never);

    assert.deepEqual(memory.forProject("proj-a").list().map((r) => r.text), ["A の決定"]);
    assert.deepEqual(person.list(), [], "人の記憶には入らない");
  });
});

// ── 記憶の区画は幹（PO裁定 2026-08-10）──────────────────────────────────────

/**
 * 記憶が分かれる単位を**場所（リポジトリ）から幹へ**移した。
 *
 * 場所に結びつけていると、複数のリポジトリにまたがる仕事も、まだリポジトリの無い
 * 相談も記憶を持てない。幹＝プロジェクトの単位なので、区画もそこに合わせる。
 *
 * 見たいのは3つ: **省略でいまの幹に入る**・**幹をまたいで注入されない**・
 * **探すときだけは幹をまたげる**（分けた代償を番頭が回収できる）。
 */
describe("[ADR-0003 / PO裁定 2026-08-10] 記憶の区画は幹", () => {
  /** thread-51 の会話に居る番頭が持つ Tool 一式。 */
  const toolsHere = (trunkId: string) =>
    createMemoryTools(memory, {
      defaultTrunkId: () => trunkId,
      knownTrunkIds: () => ["thread-51", "thread-52"],
      knownTrunkList: () => [
        { id: "thread-51", label: "banto 開発" },
        { id: "thread-52", label: "ひらがな学習アプリ" },
      ],
    });
  const here = (trunkId: string, name: string) => {
    const found = toolsHere(trunkId).find((t) => t.name === name);
    assert.ok(found, `${name} が登録されていない`);
    return found;
  };

  it("幹を書かずに保存すると、いまの会話の幹に入る", async () => {
    await here("thread-51", "memory.save").execute({
      kind: "fact",
      text: "デプロイは systemd 再起動で足りる",
      scope: "project",
    } as never);

    assert.deepEqual(
      memory.forProject("thread-51").list().map((r) => r.text),
      ["デプロイは systemd 再起動で足りる"]
    );
    assert.deepEqual(memory.forProject("thread-52").list(), [], "他の幹には入らない");
    assert.deepEqual(person.list(), [], "人の記憶にも入らない");
  });

  it("枝は親の幹と同じ区画（枝で調べたことが仕事に溜まる）", async () => {
    // 枝の会話でも defaultTrunkId は親の幹（ThreadIdentity.trunkId がそう解決する）
    await here("thread-51", "memory.save").execute({
      kind: "fact",
      text: "間欠的に落ちるのは fixture の後片付け漏れ",
      scope: "project",
    } as never);

    assert.equal(memory.forProject("thread-51").list().length, 1);
  });

  it("別の幹の記憶はプロンプトに載らない", () => {
    memory.forProject("thread-51").save({ kind: "fact", text: "banto の決定" });
    memory.forProject("thread-52").save({ kind: "fact", text: "ひらがなアプリの決定" });

    const prompt = renderMemoryForPrompt(memory, {
      trunks: [{ id: "thread-51", label: "banto 開発" }],
    });
    assert.match(prompt, /## banto 開発 について/);
    assert.match(prompt, /banto の決定/);
    assert.doesNotMatch(prompt, /ひらがなアプリの決定/, "幹を分けた意味が消える");
  });

  it("acrossTrunks なら幹をまたいで探せる（どの幹のものかも出る）", async () => {
    memory.forProject("thread-51").save({ kind: "fact", text: "incus で隔離して動かす" });
    memory.forProject("thread-52").save({ kind: "fact", text: "incus は使わない" });
    person.save({ kind: "habit", text: "incus のログは journalctl で見る" });

    const result = await here("thread-51", "memory.search").execute({
      text: "incus",
      acrossTrunks: true,
    } as never);
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");

    assert.match(text, /\[人の記憶\].*journalctl/);
    assert.match(text, /\[この幹\].*incus で隔離/);
    assert.match(text, /\[ひらがな学習アプリ\].*incus は使わない/);
  });

  it("acrossTrunks を付けなければ、いまの幹の中だけを探す", async () => {
    memory.forProject("thread-51").save({ kind: "fact", text: "incus で隔離して動かす" });
    memory.forProject("thread-52").save({ kind: "fact", text: "incus は使わない" });

    const result = await here("thread-51", "memory.search").execute({
      text: "incus",
      scope: "project",
    } as never);
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");

    assert.match(text, /incus で隔離/);
    assert.doesNotMatch(text, /incus は使わない/);
  });

  it("知らない幹を名指ししたら断る（I2：黙って新しい区画を作らない）", async () => {
    await assert.rejects(
      () =>
        here("thread-51", "memory.save").execute({
          kind: "fact",
          text: "X",
          scope: "project",
          trunk: "thread-99",
        } as never),
      /知らない幹です/
    );
  });
});

// ── validFrom（Zep の valid time / ingestion time）────────────────────────────

describe("[提案§3.4] validFrom は記録した時刻とは別軸", () => {
  it("保存して読み戻せる", () => {
    const saved = person.save({
      kind: "fact",
      text: "番頭ホストは Node 22 前提",
      validFrom: "2026-08-01",
    });
    assert.equal(person.get(saved.id)?.validFrom, "2026-08-01");
    assert.notEqual(saved.createdAt, "2026-08-01", "記録した時刻とは別の値");
  });

  it("プロンプトに「いつから」が出る", () => {
    person.save({ kind: "fact", text: "Node 22 前提", validFrom: "2026-08-01" });
    assert.match(renderMemoryForPrompt(memory), /Node 22 前提（2026-08-01 から）/);
  });
});

// ── 場所の親子関係（PO裁定 2026-08-05）──────────────────────────────────────

describe("[ADR-0003 / 決定36c] ワークツリーは親リポジトリの記憶を共有する", () => {
  const repo = { id: "github.com/tjst-t/banto", label: "tjst-t/banto", path: "/r" };
  const wt = {
    id: "github.com/tjst-t/banto/feat-x",
    label: "tjst-t/banto/feat-x（ワークツリー: feat/x）",
    path: "/w",
    parent: "github.com/tjst-t/banto",
  };

  it("projectIdOf は親があれば親を返す", () => {
    assert.equal(projectIdOf(wt), "github.com/tjst-t/banto");
    assert.equal(projectIdOf(repo), "github.com/tjst-t/banto");
  });

  it("親を持たない場所は自分自身がプロジェクト", () => {
    assert.equal(projectIdOf({ id: "workspace" }), "workspace");
  });

  it("projectScopesOf はワークツリーを親に畳む（チップが増えない）", () => {
    const other = { id: "github.com/a/b", label: "a/b", path: "/o" };
    const wt2 = { ...wt, id: "github.com/tjst-t/banto/feat-y", label: "feat-y" };

    assert.deepEqual(projectScopesOf([repo, wt, wt2, other]), [
      { id: "github.com/tjst-t/banto", label: "tjst-t/banto" },
      { id: "github.com/a/b", label: "a/b" },
    ]);
  });

  it("親が一覧に無いときの名前はIDから作る（子のブランチ名を流用しない）", () => {
    // 子の label をそのまま使うと「…（ワークツリー: feat/x）」と出て、
    // そのブランチだけの記憶であるかのように読める。実際は親リポジトリ全体の記憶
    assert.deepEqual(projectScopesOf([wt]), [
      { id: "github.com/tjst-t/banto", label: "tjst-t/banto" },
    ]);
  });

  it("ワークツリーで覚えたことが、親リポジトリでも見える", () => {
    // ホストは place → プロジェクトID に畳んでからストアを開く
    const scoped = new ScopedMemory(
      person,
      (placeId) =>
        new JsonlMemoryStore(
          path.join(dir, "projects", encodeURIComponent(placeId), "memory.jsonl")
        )
    );
    scoped.forProject(projectIdOf(wt)).save({ kind: "fact", text: "ワークツリーで覚えた" });

    assert.deepEqual(
      scoped.forProject(projectIdOf(repo)).list().map((r) => r.text),
      ["ワークツリーで覚えた"],
      "ブランチを切り替えただけで記憶が見えなくなってはいけない"
    );
  });

  it("別リポジトリへは横断しない（畳んでも ADR-0003 は保たれる）", () => {
    const scoped = new ScopedMemory(
      person,
      (placeId) =>
        new JsonlMemoryStore(
          path.join(dir, "projects", encodeURIComponent(placeId), "memory.jsonl")
        )
    );
    scoped.forProject(projectIdOf(wt)).save({ kind: "fact", text: "banto の決定" });

    assert.deepEqual(scoped.forProject("github.com/a/b").list(), []);
  });
});

// ── 同じ場所を指す別名（PO裁定 2026-08-05）────────────────────────────────────

describe("[ADR-0003] 同じ場所を指す別名は1つのプロジェクトに畳む", () => {
  // `BANTO_PLACES` の静的な場所と、repo-manager が出す同じリポジトリ
  const staticPlace = { id: "banto", label: "banto", path: "/repo", writable: ["docs/**"] };
  const discovered = { id: "github.com/tjst-t/banto", label: "tjst-t/banto", path: "/repo" };
  const other = { id: "github.com/a/b", label: "a/b", path: "/other" };

  it("パスが同じなら1つに畳まれる", () => {
    const { scopes } = resolveProjects([staticPlace, discovered, other]);
    assert.deepEqual(scopes.map((s) => s.id), ["banto", "github.com/a/b"]);
  });

  it("どちらの名前で保存しても同じプロジェクトになる", () => {
    const { idByPlace } = resolveProjects([staticPlace, discovered]);
    assert.equal(idByPlace.get("banto"), idByPlace.get("github.com/tjst-t/banto"));
  });

  it("代表は辞書順で最小（並び順や登録の仕方で入れ替わらない）", () => {
    const forward = resolveProjects([staticPlace, discovered]).idByPlace.get("banto");
    const reverse = resolveProjects([discovered, staticPlace]).idByPlace.get("banto");
    assert.equal(forward, "banto");
    assert.equal(reverse, "banto", "登録順で代表が変わると、過去の記憶が取り残される");
  });

  it("畳んだ別名を報告する（別名側に記憶が残っていないか確かめられる）", () => {
    const { aliases } = resolveProjects([staticPlace, discovered]);
    assert.deepEqual(aliases.get("banto"), ["github.com/tjst-t/banto"]);
  });

  it("パスが違えば畳まない（別プロジェクトのまま）", () => {
    const { scopes, aliases } = resolveProjects([staticPlace, other]);
    assert.equal(scopes.length, 2);
    assert.equal(aliases.size, 0);
  });

  it("ワークツリー（親子）と別名（同パス）が同時に効く", () => {
    const wt = {
      id: "github.com/tjst-t/banto/feat-x",
      label: "feat-x",
      path: "/wt",
      parent: "github.com/tjst-t/banto",
    };
    const { idByPlace, scopes } = resolveProjects([staticPlace, discovered, wt]);

    // ワークツリー → 親リポジトリ → 別名で畳まれて `banto`
    assert.equal(idByPlace.get("github.com/tjst-t/banto/feat-x"), "banto");
    assert.deepEqual(scopes.map((s) => s.id), ["banto"]);
  });

  it("親が一覧に無いワークツリーは畳めない（推測でパスを決めない）", () => {
    const wt = { id: "x/y/feat", label: "feat", path: "/wt", parent: "x/y" };
    const { idByPlace } = resolveProjects([wt]);
    assert.equal(idByPlace.get("x/y/feat"), "x/y", "宣言された親までは効く");
  });

  it("同一性の判定は呼び出し側が決められる（リンク解決など）", () => {
    const linked = { id: "z-link", label: "link", path: "/link-to-repo" };
    const { scopes } = resolveProjects([staticPlace, linked], (p) =>
      p.path === "/link-to-repo" ? "/repo" : p.path
    );
    assert.deepEqual(scopes.map((s) => s.id), ["banto"]);
  });
});

// ── 落とされた親の付け替え（PlaceRegistry）────────────────────────────────────

describe("[ADR-0003] 同じ場所が先勝ちで落とされたとき、親の指し先を付け替える", () => {
  /** 与えた場所をそのまま返す提供元。 */
  const provider = (name: string, places: Array<Record<string, unknown>>) => ({
    name,
    list: async () => places as never,
  });

  it("落とされた親を指すワークツリーが、残った側の id を指すようになる", async () => {
    // 設定の静的な場所（先勝ち）と、repo-manager の同じリポジトリ＋そのワークツリー
    const registry = new PlaceRegistry([
      provider("static", [{ id: "banto", label: "banto", path: dir }]),
      provider("repo-manager", [
        { id: "github.com/tjst-t/banto", label: "tjst-t/banto", path: dir },
        {
          id: "github.com/tjst-t/banto/feat-x",
          label: "feat-x",
          path: path.join(dir, "wt"),
          parent: "github.com/tjst-t/banto",
        },
      ]),
    ]);

    const places = await registry.list();
    // 同じディレクトリは先勝ちで1つに（既存の振る舞い）
    assert.deepEqual(places.map((p) => p.id), ["banto", "github.com/tjst-t/banto/feat-x"]);
    // 親は落とされた id ではなく、残った側を指す
    assert.equal(places[1]!.parent, "banto");
  });

  it("付け替えの結果、記憶のプロジェクトが1つに畳まれる", async () => {
    const registry = new PlaceRegistry([
      provider("static", [{ id: "banto", label: "banto", path: dir }]),
      provider("repo-manager", [
        { id: "github.com/tjst-t/banto", label: "tjst-t/banto", path: dir },
        {
          id: "github.com/tjst-t/banto/feat-x",
          label: "feat-x",
          path: path.join(dir, "wt"),
          parent: "github.com/tjst-t/banto",
        },
      ]),
    ]);

    const { scopes } = resolveProjects(await registry.list());
    assert.deepEqual(scopes.map((s) => s.id), ["banto"], "同じリポジトリが2つに分かれてはいけない");
  });

  it("親が落とされていなければ何も変えない", async () => {
    const registry = new PlaceRegistry([
      provider("repo-manager", [
        { id: "github.com/a/b", label: "a/b", path: dir },
        { id: "github.com/a/b/feat", label: "feat", path: path.join(dir, "wt"), parent: "github.com/a/b" },
      ]),
    ]);

    const places = await registry.list();
    assert.equal(places[1]!.parent, "github.com/a/b");
  });
});
