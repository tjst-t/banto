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
  PlaceRegistry,
  assertWritable,
  broadlyWritable,
  createStaticPlaceProvider,
  resolveInPlace,
} from "@banto/host";
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
