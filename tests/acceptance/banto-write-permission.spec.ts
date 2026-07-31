/**
 * task-0042: 書き込み許可の要求と承認。ADR-0010 決定38(c)(e)。
 *
 * 番頭は範囲の拡大を**頼めるだけ**で、決めるのは PO、書くのはホスト。
 *
 * ここで一番見たいのは a2——**番頭が自分で承認できないこと**。約束ではなく機構で
 * 分かれていること（承認の口が番頭の Tool 一覧に出ないこと）を確かめる。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  PlaceGrantStore,
  PlaceRegistry,
  createPlaceGrantAdminTools,
  createPlaceRequestTools,
  createStaticPlaceProvider,
  createWorkspaceModule,
  createFileWriteTools,
  PLACE_PERMISSIONS_VIEW_KIND,
  type NamespacedToolDefinition,
} from "@banto/host";

let dir: string;
let repo: string;
let grantsFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-grant-"));
  repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  grantsFile = path.join(dir, "host-data", "place-grants.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 場所1つ＋許可の帳簿。設定側の writable は既定で無し（読み取り専用）。 */
function setup(writable?: readonly string[]): {
  places: PlaceRegistry;
  grants: PlaceGrantStore;
  request: NamespacedToolDefinition;
  admin: Record<string, NamespacedToolDefinition>;
  write: NamespacedToolDefinition;
} {
  const grants = new PlaceGrantStore(grantsFile);
  const places = new PlaceRegistry(
    [
      createStaticPlaceProvider([
        { id: "repo", label: "リポジトリ", path: repo, ...(writable ? { writable } : {}) },
      ]),
    ],
    grants
  );
  const admin = Object.fromEntries(
    createPlaceGrantAdminTools(grants).map((t) => [t.name, t])
  );
  return {
    places,
    grants,
    request: createPlaceRequestTools(places, grants)[0]!,
    admin,
    write: createFileWriteTools(places, { protectedPaths: [path.dirname(grantsFile)] })[0]!,
  };
}

describe("[task-0042/a1] 番頭は頼めるだけ", () => {
  it("要求しただけでは書けない", async () => {
    const { request, write } = setup();

    const result = await request.execute({
      place: "repo",
      patterns: ["docs/**"],
      reason: "決定を記録したい",
    });
    assert.match(result.content[0]!.text!, /まだ書けません/);

    // 頼んだ直後に書こうとしても、許可されていないので落ちる
    await assert.rejects(
      () => write.execute({ place: "repo", path: "docs/a.md", content: "x" }),
      /読み取り専用/
    );
  });

  it("承認されると書けるようになる（設定を書き換えずに効く）", async () => {
    const { request, admin, write } = setup();

    const requested = await request.execute({
      place: "repo",
      patterns: ["docs/**"],
      reason: "決定を記録したい",
    });
    const id = (requested.details as { request: { id: string } }).request.id;

    await admin["place.approve_write"]!.execute({ requestId: id });

    await write.execute({ place: "repo", path: "docs/a.md", content: "ok\n" });
    assert.equal(fs.readFileSync(path.join(repo, "docs", "a.md"), "utf-8"), "ok\n");

    // 許可した範囲の外は依然として書けない
    await assert.rejects(
      () => write.execute({ place: "repo", path: "src/x.ts", content: "x" }),
      /範囲の外/
    );
  });

  it("POは要求より狭めて許せる", async () => {
    const { request, admin, write } = setup();
    const requested = await request.execute({ place: "repo", patterns: ["**"], reason: "全部書きたい" });
    const id = (requested.details as { request: { id: string } }).request.id;

    await admin["place.approve_write"]!.execute({ requestId: id, patterns: ["docs/**"] });

    await write.execute({ place: "repo", path: "docs/a.md", content: "ok\n" });
    await assert.rejects(() => write.execute({ place: "repo", path: "README.md", content: "x" }), /範囲の外/);
  });

  it("断られたら書けないまま。記録は残る", async () => {
    const { request, admin, write, grants } = setup();
    const requested = await request.execute({ place: "repo", patterns: ["**"], reason: "全部書きたい" });
    const id = (requested.details as { request: { id: string } }).request.id;

    await admin["place.deny_write"]!.execute({ requestId: id, note: "範囲が広すぎます" });

    await assert.rejects(() => write.execute({ place: "repo", path: "a.md", content: "x" }), /読み取り専用/);
    const record = grants.requests().find((r) => r.id === id)!;
    assert.equal(record.state, "denied");
    assert.equal(record.note, "範囲が広すぎます");
  });

  it("同じ頼みを繰り返しても要求は積み増さない", async () => {
    const { request, grants } = setup();
    await request.execute({ place: "repo", patterns: ["docs/**"], reason: "1回目" });
    await request.execute({ place: "repo", patterns: ["docs/**"], reason: "2回目" });
    assert.equal(grants.requests().length, 1);
  });

  it("知らない場所への要求は受け付けない（効かない許可を帳簿に残さない）", async () => {
    const { request } = setup();
    await assert.rejects(
      () => request.execute({ place: "どこか", patterns: ["**"], reason: "x" }),
      /Unknown place/
    );
  });
});

describe("[task-0042/a2] 番頭は自分で承認できない（機構で分ける）", () => {
  it("承認・拒否・取り消しは番頭のTool一覧に出ない", () => {
    const grants = new PlaceGrantStore(grantsFile);
    const places = new PlaceRegistry([createStaticPlaceProvider([{ id: "repo", path: repo }])], grants);
    const module = createWorkspaceModule(places, {}, grants);

    const forBanto: string[] = module.tools.map((t) => t.name);
    for (const forbidden of ["place.approve_write", "place.deny_write", "place.revoke_write"]) {
      assert.ok(!forBanto.includes(forbidden), `${forbidden} は番頭へ渡さない`);
    }
    // 頼む口は持っている
    assert.ok(forBanto.includes("place.request_write"));

    // 承認の口は internalTools 側（HTTP からは呼べる＝GUI が使う）にある
    const internal: string[] = (module.internalTools ?? []).map((t) => t.name);
    for (const expected of ["place.list_requests", "place.approve_write", "place.deny_write", "place.revoke_write"]) {
      assert.ok(internal.includes(expected), `${expected} は internalTools にある`);
    }
  });

  it("許可の帳簿は番頭が書けない場所にある（自己昇格を塞ぐ・決定38b）", async () => {
    // 帳簿をリポジトリの中に置き、しかも全部書ける状態にしてなお、番頭は触れないこと
    const inRepo = path.join(repo, "host-data", "place-grants.json");
    const grants = new PlaceGrantStore(inRepo);
    const places = new PlaceRegistry(
      [createStaticPlaceProvider([{ id: "repo", path: repo, writable: ["**"] }])],
      grants
    );
    const write = createFileWriteTools(places, { protectedPaths: [path.dirname(inRepo)] })[0]!;

    await assert.rejects(
      () => write.execute({ place: "repo", path: "host-data/place-grants.json", content: "{}" }),
      /データ置き場/
    );
  });
});

describe("[task-0042/a3・a5] 画面と取り消し", () => {
  it("保留中の要求と現在の許可が1つの口から取れる", async () => {
    const { request, admin } = setup();
    await request.execute({ place: "repo", patterns: ["docs/**"], reason: "A" });
    const second = await request.execute({ place: "repo", patterns: ["work/**"], reason: "B" });
    await admin["place.approve_write"]!.execute({
      requestId: (second.details as { request: { id: string } }).request.id,
    });

    const view = await admin["place.list_requests"]!.execute({});
    const details = view.details as {
      pending: Array<{ patterns: string[] }>;
      grants: Record<string, string[]>;
    };
    assert.deepEqual(details.pending.map((p) => p.patterns), [["docs/**"]]);
    assert.deepEqual(details.grants, { repo: ["work/**"] });
  });

  it("与えた許可を取り消せる（広げすぎたときに戻せる）", async () => {
    const { request, admin, write } = setup();
    const requested = await request.execute({ place: "repo", patterns: ["docs/**"], reason: "A" });
    await admin["place.approve_write"]!.execute({
      requestId: (requested.details as { request: { id: string } }).request.id,
    });
    await write.execute({ place: "repo", path: "docs/a.md", content: "ok\n" });

    await admin["place.revoke_write"]!.execute({ place: "repo", pattern: "docs/**" });
    await assert.rejects(() => write.execute({ place: "repo", path: "docs/b.md", content: "x" }), /読み取り専用/);

    // I2: 無いものを取り消したことにしない
    await assert.rejects(
      () => admin["place.revoke_write"]!.execute({ place: "repo", pattern: "docs/**" }),
      /許可されていません/
    );
  });

  it("設定で与えた範囲は承認の取り消しで消えない", async () => {
    const { admin, write } = setup(["work/**"]);
    await assert.rejects(
      () => admin["place.revoke_write"]!.execute({ place: "repo", pattern: "work/**" }),
      /許可されていません/
    );
    await write.execute({ place: "repo", path: "work/a.md", content: "ok\n" });
    assert.ok(fs.existsSync(path.join(repo, "work", "a.md")));
  });

  it("番頭が canvas.open で開けるGUIとして登録されている（a5）", () => {
    const grants = new PlaceGrantStore(grantsFile);
    const places = new PlaceRegistry([createStaticPlaceProvider([{ id: "repo", path: repo }])], grants);
    const module = createWorkspaceModule(places, {}, grants);
    const view = module.views.find((v) => v.kind === PLACE_PERMISSIONS_VIEW_KIND);
    assert.ok(view, "place.permissions が views にある");
    assert.equal(view!.component, "PlacePermissions");
  });
});

describe("[task-0042/a4] 許可はホストが書く", () => {
  it("承認するとホストのデータ置き場に残り、起動し直しても効く", async () => {
    const { request, admin } = setup();
    const requested = await request.execute({ place: "repo", patterns: ["docs/**"], reason: "A" });
    await admin["place.approve_write"]!.execute({
      requestId: (requested.details as { request: { id: string } }).request.id,
    });
    assert.ok(fs.existsSync(grantsFile), "帳簿がファイルとして残る");

    // 別のインスタンス＝再起動した想定
    const reloaded = new PlaceGrantStore(grantsFile);
    assert.deepEqual([...reloaded.writableFor("repo")], ["docs/**"]);
  });

  it("帳簿が壊れていたら黙って空にしない（許可が消える方が危ない）", () => {
    fs.mkdirSync(path.dirname(grantsFile), { recursive: true });
    fs.writeFileSync(grantsFile, "{ これはJSONではない");
    assert.throws(() => new PlaceGrantStore(grantsFile), /許可の帳簿が壊れています/);
  });

  it("二重承認で範囲が意図せず広がらない", async () => {
    const { request, admin } = setup();
    const requested = await request.execute({ place: "repo", patterns: ["docs/**"], reason: "A" });
    const id = (requested.details as { request: { id: string } }).request.id;
    await admin["place.approve_write"]!.execute({ requestId: id });
    await assert.rejects(
      () => admin["place.approve_write"]!.execute({ requestId: id, patterns: ["**"] }),
      /既に許可されています/
    );
  });
});
