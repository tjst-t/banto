/**
 * task-0038: 場所（Place）の契約と砦の一般化。ADR-0010 決定36・38。
 *
 * 番頭は複数リポジトリを相手にする（決定36）。判定基準を「1つの固定ルート」から
 * 「**登録された場所のいずれかの中**」へ広げつつ、既存の性質（シンボリックリンクで
 * 外に出られない）を落とさないことを見る。
 *
 * 書き込みは既定で不可（決定38a）。`.git/` はどんな設定でも書けない（決定38d：
 * ここを書けると git コマンド無しで履歴を変えられ、決定37 の抜け道になる）。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  DESK_PLACE_ID,
  PlaceRegistry,
  assertWritable,
  broadlyWritable,
  createFileTools,
  createStaticPlaceProvider,
  defaultDeskPlace,
  ensureDeskDir,
  withDefaultDesk,
  guardPathArg,
  placeScopedTools,
  resolveInPlace,
  type NamespacedToolDefinition,
} from "@banto/host";
import { defineNamespacedTool } from "@banto/core";
import { Type } from "typebox";
import type { Place, PlaceProvider } from "@banto/core";

let dir: string;
let repoA: string;
let repoB: string;
let outside: string;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-places-"));
  repoA = path.join(dir, "repo-a");
  repoB = path.join(dir, "repo-b");
  outside = path.join(dir, "outside");
  for (const d of [repoA, repoB, outside]) fs.mkdirSync(path.join(d, "docs"), { recursive: true });
  fs.mkdirSync(path.join(repoA, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repoA, "docs", "a.md"), "a");
});

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const placeA = (writable?: string[]): Place => ({
  id: "repo-a",
  label: "Repo A",
  path: repoA,
  ...(writable ? { writable } : {}),
});

describe("[task-0038] 場所の帳簿", () => {
  it("[task-0038] 複数の提供元を束ね、毎回聞き直す（台帳を持たない・D3）", async () => {
    let calls = 0;
    const dynamic: PlaceProvider = {
      name: "dynamic",
      list: async () => {
        calls++;
        return [{ id: "repo-b", label: "Repo B", path: repoB }];
      },
    };
    const registry = new PlaceRegistry([
      createStaticPlaceProvider([{ id: "repo-a", path: repoA }]),
      dynamic,
    ]);

    assert.deepEqual((await registry.list()).map((p) => p.id), ["repo-a", "repo-b"]);
    await registry.list();
    assert.equal(calls, 2, "呼ぶたびに導出する（キャッシュしない）");
  });

  it("[task-0038] 提供元が落ちても他は返す（ghq 未導入でも静的な場所で動く）", async () => {
    const broken: PlaceProvider = {
      name: "broken",
      list: async () => {
        throw new Error("ghq not found");
      },
    };
    const registry = new PlaceRegistry([broken, createStaticPlaceProvider([{ id: "repo-a", path: repoA }])]);
    assert.deepEqual((await registry.list()).map((p) => p.id), ["repo-a"]);
  });

  it("[task-0038] 先に登録された提供元が勝つ（設定が自動発見より優先）", async () => {
    const discovered: PlaceProvider = {
      name: "discovered",
      list: async () => [{ id: "repo-a", label: "自動発見", path: repoB }],
    };
    const registry = new PlaceRegistry([
      createStaticPlaceProvider([{ id: "repo-a", label: "設定", path: repoA }]),
      discovered,
    ]);
    const places = await registry.list();
    assert.equal(places.length, 1);
    assert.equal(places[0]!.label, "設定");
  });

  it("[task-0038] 未登録の場所は黙って既定へ落とさずエラー（I2）", async () => {
    const registry = new PlaceRegistry([createStaticPlaceProvider([{ id: "repo-a", path: repoA }])]);
    await assert.rejects(() => registry.require("repo-x"), /Unknown place/);
  });

  /**
   * 重い導出（`gwq list` は 400ms 超）を持つ提供元は、少し古い写しを返してよい。
   * そのぶん**「見つからない」ときは取り直させてから断る**——さもないと、たった今
   * 作ったワークツリーが「そんな場所は無い」と言われる。
   */
  it("[task-0038] 写しを返す提供元でも、知らない場所は取り直してから断る", async () => {
    let visible = [{ id: "repo-a", label: "Repo A", path: repoA }];
    let stale = [...visible];
    let refreshed = 0;
    const cached: PlaceProvider = {
      name: "cached",
      // 写しを返す（取り直すまで中身が変わらない）
      list: async () => [...stale],
      refresh: () => {
        refreshed++;
        stale = [...visible];
      },
    };
    const registry = new PlaceRegistry([cached]);
    assert.deepEqual((await registry.list()).map((p) => p.id), ["repo-a"]);

    // 写しの外で場所が増えた（別の経路でワークツリーが作られた、等）
    visible = [...visible, { id: "repo-b", label: "Repo B", path: repoB }];

    const found = await registry.require("repo-b");
    assert.equal(found.path, repoB, "取り直して見つけること");
    assert.equal(refreshed, 1, "見つからなかったときだけ取り直すこと");

    // 見つかるものは取り直さない（普段の呼び出しで遅くならない）
    await registry.require("repo-a");
    assert.equal(refreshed, 1, "見つかる場所では取り直さないこと");

    // 砦（決定36g）も同じ：写しの古さで「場所の外」と誤判定しない
    const inside = await registry.placeContaining(path.join(repoB, "docs"));
    assert.equal(inside?.id, "repo-b");
  });

  it("[task-0038] 取り直しても無いものは、これまでどおり断る（I2）", async () => {
    const cached: PlaceProvider = {
      name: "cached",
      list: async () => [{ id: "repo-a", label: "Repo A", path: repoA }],
      refresh: () => {},
    };
    const registry = new PlaceRegistry([cached]);
    await assert.rejects(() => registry.require("repo-x"), /Unknown place/);
  });

  it("[task-0038] 複数あるのに省略されたら決めない（聞き返させる・I2）", async () => {
    const one = new PlaceRegistry([createStaticPlaceProvider([{ id: "repo-a", path: repoA }])]);
    assert.equal((await one.resolve()).id, "repo-a", "1つしか無ければそれ");

    const two = new PlaceRegistry([
      createStaticPlaceProvider([
        { id: "repo-a", path: repoA },
        { id: "repo-b", path: repoB },
      ]),
    ]);
    await assert.rejects(() => two.resolve(), /Specify one/);
  });
});

describe("[task-0038] 砦：登録された場所の中だけ（決定36g）", () => {
  it("[task-0038] 場所の中は通り、外は弾く", () => {
    const place = placeA();
    assert.equal(resolveInPlace(place, "docs/a.md"), path.join(fs.realpathSync(repoA), "docs/a.md"));
    assert.throws(() => resolveInPlace(place, "../repo-b/docs"), /outside the place/);
    assert.throws(() => resolveInPlace(place, "/etc/passwd"), /outside the place/);
  });

  it("[task-0038] シンボリックリンクで外へ出られない（既存の性質を落とさない）", () => {
    const link = path.join(repoA, "escape");
    if (!fs.existsSync(link)) fs.symlinkSync(repoB, link);
    assert.throws(() => resolveInPlace(placeA(), "escape/docs"), /outside the place/);
  });

  it("[task-0038] 存在しないパスも判定できる（これから作るファイル）", () => {
    const place = placeA();
    assert.doesNotThrow(() => resolveInPlace(place, "docs/not-yet.md"));
    assert.throws(() => resolveInPlace(place, "../nope/not-yet.md"), /outside the place/);
  });

  it("[task-0038] 副作用の宛先が、どの場所にも属さないなら弾く（worker.delegate の穴）", async () => {
    const registry = new PlaceRegistry([
      createStaticPlaceProvider([{ id: "repo-a", path: repoA }]),
    ]);
    // 登録された場所の中なら通る
    const inside = await registry.requireInsideSomePlace(path.join(repoA, "docs"), "worktree");
    assert.equal(inside.id, "repo-a");
    // 外は弾く——ここが塞がっていないと、番頭が任意のディレクトリを職人に書き換えさせられる
    await assert.rejects(
      () => registry.requireInsideSomePlace(outside, "worktree"),
      /outside every registered place/
    );
  });
});

describe("[task-0038/決定38] 書き込みは許した範囲だけ", () => {
  it("[決定38a] 既定は読み取り専用", () => {
    assert.throws(() => assertWritable(placeA(), "docs/a.md"), /読み取り専用/);
  });

  it("[決定38a] 許した範囲だけ書ける", () => {
    const place = placeA(["docs/**", "work/**"]);
    assert.doesNotThrow(() => assertWritable(place, "docs/a.md"));
    assert.doesNotThrow(() => assertWritable(place, "docs/deep/nested/b.md"));
    assert.doesNotThrow(() => assertWritable(place, "work/tasks/task-1.md"));
    assert.throws(() => assertWritable(place, "src/index.ts"), /範囲の外/);
    assert.throws(() => assertWritable(place, "README.md"), /範囲の外/);
  });

  it("[決定38a] `docs/**` は docs 自身にも当たる", () => {
    assert.doesNotThrow(() => assertWritable(placeA(["docs/**"]), "docs"));
  });

  it("[決定38a] `*` は1階層だけ（深い場所には当たらない）", () => {
    const place = placeA(["docs/*"]);
    assert.doesNotThrow(() => assertWritable(place, "docs/a.md"));
    assert.throws(() => assertWritable(place, "docs/deep/b.md"), /範囲の外/);
  });

  it("[決定38d] .git/ はどんな設定でも書けない（決定37 の抜け道を塞ぐ）", () => {
    // ** を許しても通さない。ここを書けると git コマンド無しで履歴を書き換えられる
    const place = placeA(["**"]);
    assert.throws(() => assertWritable(place, ".git/config"), /書き込み禁止/);
    assert.throws(() => assertWritable(place, ".git/refs/heads/main"), /書き込み禁止/);
    // ホスト自身のデータ置き場も同様（許可の宣言を書き換えられると自己昇格する）
    assert.throws(() => assertWritable(place, ".banto/memory.jsonl"), /書き込み禁止/);
    // それ以外は ** で通る
    assert.doesNotThrow(() => assertWritable(place, "src/index.ts"));
  });

  it("[決定38] 書き込みでも場所の外は弾く（砦は共通）", () => {
    assert.throws(() => assertWritable(placeA(["**"]), "../repo-b/x.md"), /outside the place/);
  });

  it("[決定38e] 広すぎる範囲を持つ場所が分かる（起動時の警告に使う）", () => {
    const places = [placeA(["docs/**"]), { id: "wide", label: "wide", path: repoB, writable: ["**"] }];
    assert.deepEqual(broadlyWritable(places).map((p) => p.id), ["wide"]);
  });
});

describe("[task-0038] 既存の Tool を場所に対応させる（本体は無変更）", () => {
  it("[task-0038] file.list が place で場所を選べる", async () => {
    const registry = new PlaceRegistry([
      createStaticPlaceProvider([
        { id: "repo-a", path: repoA },
        { id: "repo-b", path: repoB },
      ]),
    ]);
    const tools = placeScopedTools(registry, createFileTools);
    const list = tools.find((t) => t.name === "file.list")!;

    const a = await list.execute({ place: "repo-a", path: "docs" });
    assert.match(a.content.map((c) => c.text).join(""), /a\.md/);
    // どの場所の結果かが必ず添う（決定36d）
    assert.deepEqual((a.details as { place?: unknown }).place, { id: "repo-a", label: "repo-a" });

    const b = await list.execute({ place: "repo-b", path: "docs" });
    assert.doesNotMatch(b.content.map((c) => c.text).join(""), /a\.md/, "別の場所の中身は出ない");
  });

  it("[task-0038] 場所が複数あるのに省略したら聞き返される（I2）", async () => {
    const registry = new PlaceRegistry([
      createStaticPlaceProvider([
        { id: "repo-a", path: repoA },
        { id: "repo-b", path: repoB },
      ]),
    ]);
    const list = placeScopedTools(registry, createFileTools).find((t) => t.name === "file.list")!;
    await assert.rejects(() => list.execute({ path: "docs" }), /Specify one/);
  });

  it("[task-0038] 場所が1つなら省略できる（従来どおり動く）", async () => {
    const registry = new PlaceRegistry([createStaticPlaceProvider([{ id: "repo-a", path: repoA }])]);
    const list = placeScopedTools(registry, createFileTools).find((t) => t.name === "file.list")!;
    const out = await list.execute({ path: "docs" });
    assert.match(out.content.map((c) => c.text).join(""), /a\.md/);
  });

  it("[task-0038] place がパラメータスキーマに載る（番頭とGUIが選べる）", () => {
    const registry = new PlaceRegistry([createStaticPlaceProvider([{ id: "repo-a", path: repoA }])]);
    const list = placeScopedTools(registry, createFileTools).find((t) => t.name === "file.list")!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 実行時は素の JSON Schema (I4)
    const params = list.parameters as any;
    assert.ok("place" in params.properties, "place が無いと場所を選べない");
    assert.ok("path" in params.properties, "元のパラメータが失われていない");
  });
});

describe("[task-0038/決定36g] worker.delegate の穴を塞ぐ", () => {
  /** 呼ばれたかどうかだけ見る偽の Tool。 */
  function fakeDelegate(calls: string[]): NamespacedToolDefinition {
    return defineNamespacedTool({
      name: "worker.delegate",
      label: "Worker: Delegate",
      description: "偽",
      parameters: Type.Object({ worktreePath: Type.String() }),
      async execute(args) {
        calls.push(args.worktreePath);
        return { content: [{ type: "text" as const, text: "ok" }] };
      },
    });
  }

  it("[決定36g] 登録された場所の中なら通る", async () => {
    const registry = new PlaceRegistry([createStaticPlaceProvider([{ id: "repo-a", path: repoA }])]);
    const calls: string[] = [];
    const guarded = guardPathArg(fakeDelegate(calls), registry, "worktreePath");

    await guarded.execute({ worktreePath: path.join(repoA, "docs") });
    assert.equal(calls.length, 1);
  });

  it("[決定36g] 場所の外は弾く（番頭が任意のディレクトリを職人に書き換えさせられない）", async () => {
    const registry = new PlaceRegistry([createStaticPlaceProvider([{ id: "repo-a", path: repoA }])]);
    const calls: string[] = [];
    const guarded = guardPathArg(fakeDelegate(calls), registry, "worktreePath");

    await assert.rejects(
      () => guarded.execute({ worktreePath: outside }),
      /outside every registered place/
    );
    assert.deepEqual(calls, [], "弾いたのに職人を起こしていない");
  });

  it("[決定36g] 塞ぐ前は素通りだったことを確かめる（回帰の基準）", async () => {
    // ガードを外した状態＝これまでの挙動。外を指しても職人が起きてしまう
    const calls: string[] = [];
    await fakeDelegate(calls).execute({ worktreePath: outside });
    assert.deepEqual(calls, [outside], "無検査なら通ってしまう（これが塞いだ穴）");
  });
});

describe("[決定36g] 場所の指定が欠けていても弾く", () => {
  it("**省略は素通りにしない**（番頭の cwd で職人が動くのを防ぐ）", async () => {
    const places = new PlaceRegistry([
      createStaticPlaceProvider([{ id: "a", path: repoA }]),
    ]);
    let ran = false;
    const tool = defineNamespacedTool({
      name: "worker.delegate",
      label: "delegate",
      description: "職人を起こす",
      parameters: Type.Object({ worktreePath: Type.String() }),
      async execute() {
        ran = true;
        return { content: [{ type: "text" as const, text: "ok" }], details: {} };
      },
    });
    const guarded = guardPathArg(tool as NamespacedToolDefinition, places, "worktreePath");

    await assert.rejects(() => guarded.execute({}), /worktreePath/);
    await assert.rejects(() => guarded.execute({ worktreePath: "" }), /worktreePath/);
    assert.equal(ran, false, "実行させないこと");

    // 登録された場所なら通る
    await guarded.execute({ worktreePath: repoA });
    assert.equal(ran, true);
  });
});

/**
 * 成果物置き場（書斎）の既定（PO裁定 2026-08-05）。
 *
 * **id が必ずあること**が値打ち。番頭の SKILL は配布物に入るので、実体のパスを書くと
 * 人やデプロイ先が変わるたびに書き換えが要る——SKILL は `desk` だけを指す。
 */
describe("[desk] 成果物置き場の既定", () => {
  it("[desk] 設定に無ければ既定の書斎が足される", () => {
    const result = withDefaultDesk([{ id: "workspace", path: "/tmp/ws" }]);
    const desk = result.find((c) => c.id === DESK_PLACE_ID);
    assert.ok(desk, "desk が足されること");
    assert.equal(desk!.path, path.join(os.homedir(), "banto-desk"));
  });

  it("[desk] 既定は読み取り専用（決定38a：場所があることと書けることは別）", async () => {
    assert.equal(defaultDeskPlace().writable, undefined);
    const [desk] = await createStaticPlaceProvider([defaultDeskPlace()]).list();
    assert.equal(desk?.writable, undefined, "既定で書ける場所を作らない");
  });

  it("[desk] 同じ id が設定にあれば上書きが勝つ（パスも書き込み範囲も）", () => {
    const configured = { id: DESK_PLACE_ID, path: "/tmp/my-desk", writable: ["reports/**"] };
    const result = withDefaultDesk([configured]);
    assert.equal(result.filter((c) => c.id === DESK_PLACE_ID).length, 1, "二重にしない");
    assert.deepEqual(result.find((c) => c.id === DESK_PLACE_ID), configured);
  });

  it("[desk] 実体が無ければ作る。あるときは触らず undefined を返す", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "banto-desk-"));
    const target = path.join(base, "nested", "desk");
    const configs = [{ id: DESK_PLACE_ID, path: target }];

    assert.equal(ensureDeskDir(configs), path.resolve(target), "作ったパスを返す");
    assert.ok(fs.statSync(target).isDirectory());
    assert.equal(ensureDeskDir(configs), undefined, "既にあれば黙って何もしない");

    fs.rmSync(base, { recursive: true, force: true });
  });

  it("[desk] 書斎が無い設定なら何も作らない", () => {
    assert.equal(ensureDeskDir([{ id: "workspace", path: "/tmp/ws" }]), undefined);
  });
});

/**
 * inc-0054: 断るときは「直し方」まで書く。
 *
 * **読んでも直せないエラーは、繰り返しを生む。** 実測（thread-72・2026-08-11）で、
 * 番頭が `file.write` を place 指定なしで7回連続で呼んで空回りし、最後は打ち切られた。
 * 返っていたのは「Multiple places are registered (banto, desk, ...)」——事実は正しいが、
 * **どの引数に何を入れれば通るのかが書かれていない**ので、同じ呼び出しを繰り返した。
 *
 * ここで見るのは「引数名が書かれているか」「候補が名指しされているか」の2点。
 * 文言そのものではなく、**直せる形になっているか**を固定する。
 */
describe("[inc-0054] 断るときは直し方まで書く", () => {
  const twoPlaces = () =>
    new PlaceRegistry([
      createStaticPlaceProvider([
        { id: "repo-a", path: repoA },
        { id: "repo-b", path: repoB },
      ]),
    ]);

  it("[inc-0054] 場所が複数で省略されたら、引数名と候補と例を出す", async () => {
    const err = await twoPlaces()
      .resolve()
      .then(() => undefined, (e: unknown) => e as Error);
    assert.ok(err, "複数あるのに省略したら通らない（I2）");
    assert.match(err.message, /Multiple places are registered/, "既存の頭は残す");
    assert.match(err.message, /"place"/, "**どの引数か**を名指しする");
    assert.match(err.message, /repo-a/, "候補を挙げる");
    assert.match(err.message, /例: place: "repo-a"/, "そのまま書き写せる例を出す");
  });

  it("[inc-0054] 知らない場所を指されたら、渡せる id を名指しする", async () => {
    const err = await twoPlaces()
      .require("repo-x")
      .then(() => undefined, (e: unknown) => e as Error);
    assert.ok(err);
    assert.match(err.message, /Unknown place "repo-x"/);
    assert.match(err.message, /"place"/, "引数名を出す");
    assert.match(err.message, /repo-a/, "渡せる id を挙げる");
  });

  it("[inc-0054] 場所の外を指されたら、その場所の根を出す（パスと場所のどちらが違うか分かる）", () => {
    let err: Error | undefined;
    try {
      resolveInPlace({ id: "repo-a", label: "A", path: repoA }, "../outside/x.md");
    } catch (e) {
      err = e as Error;
    }
    assert.ok(err, "場所の外は弾く（砦）");
    assert.match(err.message, /outside the place "repo-a"/, "既存の頭は残す");
    assert.match(err.message, new RegExp(repoA.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")), "根を出す");
    assert.match(err.message, /place/, "場所を変える道も示す");
  });

  it("[inc-0054] file.* が失敗したら、どの場所を見た結果かを添える", async () => {
    const tools = placeScopedTools(twoPlaces(), (root) => createFileTools(root));
    const read = tools.find((t) => t.name === "file.read");
    assert.ok(read, "file.read がある");

    const err = await read
      .execute({ path: "docs/nope.md", place: "repo-b" }, {} as never)
      .then(() => undefined, (e: unknown) => e as Error);
    assert.ok(err, "無いファイルは黙って空を返さない（I2）");
    assert.match(err.message, /repo-b/, "**どの場所を見たか**を書く（これが無いと場所を変えずに繰り返す）");
    assert.match(err.message, new RegExp(repoB.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")), "根も書く");
  });
});
