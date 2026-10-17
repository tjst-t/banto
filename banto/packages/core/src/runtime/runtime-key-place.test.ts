import { test } from "node:test";
import assert from "node:assert/strict";
import { RemoteRuntimeError } from "./remote-runtimes.js";
import { RuntimeKeyPlaceWatch, cardFor, type RuntimeKeyCard, type VaultSshKey, type VaultSshKeyListing } from "./runtime-key-place.js";

const key = (name: string, group: string, extra: Partial<VaultSshKey> = {}): VaultSshKey => ({
  implementation: "vault-local",
  name,
  group,
  runtime: group === "banto-runtime",
  link: false,
  ...extra,
});

function setup(initial: { runtimes: Array<{ name: string; identity: string }>; listing: VaultSshKeyListing | Error }) {
  const state = { ...initial };
  const cards = new Map<string, RuntimeKeyCard>();
  const raised: RuntimeKeyCard[] = [];
  const closed: string[] = [];
  const reconnected: string[] = [];
  let listCalls = 0;
  const w = new RuntimeKeyPlaceWatch({
    runtimes: () => state.runtimes,
    listKeys: async () => {
      listCalls++;
      if (state.listing instanceof Error) throw state.listing;
      return state.listing;
    },
    affected: (n) => (n === "dev" ? { projects: [{ id: "p1", name: "banto" }], modules: 6 } : { projects: [], modules: 0 }),
    openCard: (n) => cards.get(n),
    openCardRuntimes: () => [...cards.keys()],
    raise: async (c) => {
      raised.push(c);
      cards.set(c.runtime, c);
    },
    close: async (n) => {
      closed.push(n);
      cards.delete(n);
    },
    reconnect: async (n) => void reconnected.push(n),
    log: () => undefined,
  });
  return { w, state, cards, raised, closed, reconnected, listCalls: () => listCalls };
}

test("(1) 鍵がほかのグループに1つだけあれば、実行場所ごとに1枚「移す」付きで出す。影響する Project と Module の数を添える", async () => {
  const s = setup({
    runtimes: [
      { name: "dev", identity: "dev-key" },
      { name: "kaggle", identity: "kaggle-key" },
    ],
    listing: { keys: [key("dev-key", "instance"), key("kaggle-key", "proj-g")], failures: [] },
  });
  await s.w.check();
  assert.equal(s.raised.length, 2);
  const dev = s.cards.get("dev")!;
  assert.equal(dev.title, "別のサーバ dev に繋げません：SSH 鍵が置き場の外にあります");
  assert.deepEqual(dev.from, { implementation: "vault-local", group: "instance" });
  assert.deepEqual(dev.projectIds, ["p1"]);
  assert.match(dev.detail, /影響している Project：「banto」・止まっている Module 6 個/);
  assert.match(dev.detail, /vault-local の「instance」/);
  assert.equal(s.w.blocks("dev"), true);
  assert.equal(s.w.blocks("kaggle"), true);
  // もう一度確かめても積まない
  await s.w.check();
  assert.equal(s.raised.length, 2);
});

test("(2) 置き場にあれば出さない・開いていれば閉じる（人が Vault の管理画面で手で移した）", async () => {
  const s = setup({ runtimes: [{ name: "dev", identity: "dev-key" }], listing: { keys: [key("dev-key", "instance")], failures: [] } });
  await s.w.check();
  assert.equal(s.cards.size, 1);
  s.state.listing = { keys: [key("dev-key", "banto-runtime")], failures: [] };
  s.w.tick();
  await s.w.check();
  assert.equal(s.cards.size, 0);
  assert.deepEqual(s.closed, ["dev"]);
  assert.equal(s.w.blocks("dev"), false);
});

test("(3) どこにも無い：「移す」を出さず、読めなかった Vault の名前を理由に出す", async () => {
  const s = setup({
    runtimes: [{ name: "dev", identity: "dev-key" }],
    listing: { keys: [], failures: ["vault-infisical（401）"] },
  });
  await s.w.check();
  const c = s.cards.get("dev")!;
  assert.equal(c.from, undefined);
  assert.equal(c.title, "別のサーバ dev に繋げません：SSH 鍵が見つかりません");
  assert.match(c.detail, /読めなかった Vault があります：vault-infisical（401）/);
  await assert.rejects(s.w.movePlan("dev"), (err: unknown) => err instanceof RemoteRuntimeError && err.status === 409);
});

test("(4) 複数の置き場にある・参照しか無い：「移す」を出さない", () => {
  const affected = { projects: [], modules: 0 };
  const r = { name: "dev", identity: "k" };
  const many = cardFor(r, { keys: [key("k", "a"), key("k", "b")], failures: [] }, affected)!;
  assert.equal(many.from, undefined);
  assert.match(many.detail, /複数の置き場/);
  const linkOnly = cardFor(r, { keys: [key("k", "a", { link: true })], failures: [] }, affected)!;
  assert.equal(linkOnly.from, undefined);
  assert.match(linkOnly.detail, /参照/);
  // 同じ名前の別の鍵があっても、置き場にあれば出さない
  assert.equal(cardFor(r, { keys: [key("k", "a"), key("k", "banto-runtime")], failures: [] }, affected), undefined);
});

test("(5) Vault が読めないときは出しも閉じもしない", async () => {
  const s = setup({ runtimes: [{ name: "dev", identity: "dev-key" }], listing: { keys: [key("dev-key", "instance")], failures: [] } });
  await s.w.check();
  s.state.listing = new Error("Vault が繋がっていません");
  await s.w.check();
  assert.equal(s.cards.size, 1);
  assert.deepEqual(s.closed, []);
});

test("(6) 登録を外した実行場所のカードは閉じる。鍵を替えた登録は確かめ直す", async () => {
  const s = setup({ runtimes: [{ name: "dev", identity: "dev-key" }], listing: { keys: [key("dev-key", "instance"), key("new", "banto-runtime")], failures: [] } });
  await s.w.check();
  s.state.runtimes = [];
  await s.w.check();
  assert.equal(s.cards.size, 0);
  assert.equal(s.w.blocks("dev"), false);
  s.state.runtimes = [{ name: "dev", identity: "new" }];
  await s.w.check();
  assert.equal(s.cards.size, 0);
});

test("(7) 断られた（refused）ら、その鍵の実行場所に印を付けて確かめる。繋がったら閉じる", async () => {
  const s = setup({ runtimes: [{ name: "dev", identity: "dev-key" }], listing: { keys: [key("dev-key", "instance")], failures: [] } });
  s.w.refused("dev-key");
  assert.equal(s.w.blocks("dev"), true, "確かめ終わる前から印が付く（Module ごとのお知らせを出さない）");
  await s.w.check();
  assert.equal(s.cards.size, 1);
  s.w.connected("dev");
  await new Promise((r) => setImmediate(r));
  assert.equal(s.cards.size, 0);
  assert.equal(s.w.blocks("dev"), false);
});

test("(8) 移したあと：同じ鍵の実行場所のカードを全部閉じ、すぐ繋ぎ直す", async () => {
  const s = setup({
    runtimes: [
      { name: "dev", identity: "shared-key" },
      { name: "kaggle", identity: "shared-key" },
    ],
    listing: { keys: [key("shared-key", "instance")], failures: [] },
  });
  await s.w.check();
  assert.deepEqual(await s.w.movePlan("dev"), { alias: "shared-key", implementation: "vault-local", group: "instance" });
  s.state.listing = { keys: [key("shared-key", "banto-runtime")], failures: [] };
  await s.w.moved("dev");
  await new Promise((r) => setImmediate(r));
  assert.equal(s.cards.size, 0);
  assert.deepEqual(s.reconnected.sort(), ["dev", "kaggle"]);
});

test("(9) 内容が変わったら出し直す（移す元が変わった）", async () => {
  const s = setup({ runtimes: [{ name: "dev", identity: "dev-key" }], listing: { keys: [key("dev-key", "a")], failures: [] } });
  await s.w.check();
  s.state.listing = { keys: [key("dev-key", "b")], failures: [] };
  await s.w.check();
  assert.equal(s.raised.length, 2);
  assert.deepEqual(s.closed, ["dev"]);
  assert.equal(s.cards.get("dev")!.from!.group, "b");
});

test("(10) 同時に頼まれても Vault は1回ずつ読む（走っている間の頼みは1回にまとめる）", async () => {
  const s = setup({ runtimes: [{ name: "dev", identity: "dev-key" }], listing: { keys: [key("dev-key", "a")], failures: [] } });
  await Promise.all([s.w.check(), s.w.check(), s.w.check()]);
  assert.equal(s.listCalls(), 2);
  assert.equal(s.raised.length, 1);
});
