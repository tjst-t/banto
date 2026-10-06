// GitHub のアカウント：PAT・ブラウザでログイン（デバイスフロー）・更新・同時更新の直列化・失敗の知らせ・外す。
// **GitHub は偽物を HTTP で立てる**（`test-fakes.ts`。refresh token は本物どおり1回で無効になる）。Vault と受信箱は
// 偽物で、**置いた秘密が Vault の外（返り値・台帳の置き場・ログ）に出ていないか**を照らす。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GithubAccounts, REFRESH_MARGIN_MS } from "./accounts.js";
import { GithubError, httpGithub } from "./github.js";
import { LedgerStore } from "./ledger.js";
import { FAKE_CLIENT_ID, MemoryVault, RecordingNotices, startFakeGithub, type FakeGithub } from "./test-fakes.js";

const T0 = 1_800_000_000_000;

interface World {
  gh: FakeGithub;
  vault: MemoryVault;
  notices: RecordingNotices;
  store: LedgerStore;
  accounts: GithubAccounts;
  dataDir: string;
  clock: { now: number; slept: number[] };
  /** 台帳の置き場の中身（全部のファイル） */
  files(): string;
}

async function withWorld(fn: (w: World) => Promise<void>): Promise<void> {
  const gh = await startFakeGithub();
  const dataDir = mkdtempSync(join(tmpdir(), "banto-repositories-accounts-"));
  const clock = { now: T0, slept: [] as number[] };
  const vault = new MemoryVault();
  const notices = new RecordingNotices();
  const store = new LedgerStore(dataDir);
  const accounts = new GithubAccounts({
    store,
    vault,
    github: httpGithub(gh.endpoints, () => clock.now),
    notices,
    now: () => clock.now,
    // 待つ代わりに時計を進める（待った長さは残す——間隔を守っているかを見る）
    sleep: async (ms) => {
      clock.slept.push(ms);
      clock.now += ms;
    },
  });
  const files = () => readdirSync(dataDir).map((f) => readFileSync(join(dataDir, f), "utf8")).join("\n");
  const logs: string[] = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  for (const k of ["log", "error", "warn"] as const) console[k] = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  try {
    await fn({ gh, vault, notices, store, accounts, dataDir, clock, files });
    // **何も書き出さない**（ログに秘密が混ざる道を作らない）
    assert.deepEqual(logs, [], "ログに何か書いた");
  } finally {
    Object.assign(console, original);
    await gh.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/** 偽の GitHub が出したトークン（と貼った PAT）が、渡したものの中に入っていないか */
function assertNoSecrets(where: string, text: string, gh: FakeGithub, extra: string[] = []): void {
  for (const secret of [...gh.users.keys(), ...gh.refreshTokens.keys(), ...extra]) {
    assert.ok(!text.includes(secret), `${where} に秘密（${secret.slice(0, 8)}…）が出ている`);
  }
  assert.doesNotMatch(text, /gh[upr]_fake|ghp_/, `${where} にトークンの形のものが出ている`);
}

async function loginWithDevice(w: World, login = "tjst-t") {
  w.gh.loginForDevice = login;
  w.gh.script = ["authorized"];
  const start = await w.accounts.startLogin({}, "call-1");
  const done = await w.accounts.pollLogin(start.flowId, "call-2");
  assert.equal(done.state, "done");
  return done;
}

test("PAT を貼ると、GitHub で login を確かめてから Vault に預け、アカウントには alias の在りかだけを書く", async () => {
  await withWorld(async (w) => {
    const pat = "ghp_pasted_token_value_1";
    w.gh.users.set(pat, "tjst-t");
    const added = await w.accounts.addWithPat({ pat: ` ${pat}\n` }, "call-1");
    assert.deepEqual(added, {
      login: "tjst-t",
      credential: { kind: "pat", alias: { implementation: "vault-local", name: "github-tjst-t-pat", group: "instance" } },
    });
    assert.equal(w.vault.values.get("vault-local|instance|github-tjst-t-pat"), pat, "貼った値（前後の空白は落とす）が Vault に無い");
    assert.deepEqual((await w.accounts.list()).accounts, [added]);
    assertNoSecrets("返り値", JSON.stringify(added), w.gh, [pat]);
    assertNoSecrets("台帳の置き場", w.files(), w.gh, [pat]);
    // GitHub に見せたのは Authorization の見出しだけ
    assert.equal(w.gh.requests.at(-1)!.authorization, `Bearer ${pat}`);
    // Vault の口は呼び出しの印つき（人の画面の中の呼び出しだと host が分かるように）
    assert.ok(w.vault.calls.every((c) => c.callId === "call-1"), JSON.stringify(w.vault.calls));

    await assert.rejects(() => w.accounts.addWithPat({ pat }, "call-3"), /@tjst-t は、もう登録してあります/);
  });
});

test("通らない PAT は Vault に預けない——理由を言って断る", async () => {
  await withWorld(async (w) => {
    await assert.rejects(() => w.accounts.addWithPat({ pat: "ghp_wrong_value" }, "c"), (err: Error) => {
      assert.match(err.message, /この PAT では GitHub に入れませんでした：.*401/);
      assert.ok(!err.message.includes("ghp_wrong_value"));
      return true;
    });
    assert.equal(w.vault.aliases.length, 0, "通らなかった PAT を預けた");
    assert.deepEqual((await w.accounts.list()).accounts, []);
    await assert.rejects(() => w.accounts.addWithPat({}, "c"), /PAT を貼るか/);
  });
});

test("Vault に前からある alias を PAT に選べる——写さず、その在りかを覚える。SSH 鍵は種別まで確かめる", async () => {
  await withWorld(async (w) => {
    const place = w.vault.seed({ implementation: "vault-infisical", name: "work-pat", group: "shared", kind: "secret" }, "ghp_existing_1");
    const key = w.vault.seed({ implementation: "vault-local", name: "work-ssh", group: "instance", kind: "ssh-identity" }, "-----BEGIN");
    w.gh.users.set("ghp_existing_1", "Work-Org-Bot");
    await assert.rejects(() => w.accounts.addWithPat({ patAlias: place, ssh: place }, "c"), /work-pat は SSH 鍵ではありません/);
    await assert.rejects(
      () => w.accounts.addWithPat({ patAlias: place, ssh: { implementation: "vault-local", name: "nope" } }, "c"),
      /SSH 鍵 nope が Vault にありません/,
    );
    const added = await w.accounts.addWithPat({ patAlias: place, ssh: key }, "c");
    assert.deepEqual(added, { login: "Work-Org-Bot", credential: { kind: "pat", alias: place }, ssh: key });
    assert.equal(w.vault.aliases.length, 2, "選んだ alias を写した");
    const choices = await w.accounts.credentialChoices("c");
    assert.deepEqual(
      [choices.secrets.map((a) => a.name), choices.sshKeys.map((a) => a.name)],
      [["work-pat"], ["work-ssh"]],
    );
    assert.equal(await w.accounts.tokenFor("work-org-bot", "c"), "ghp_existing_1", "大文字小文字違いの login で引けない");
  });
});

test("ブラウザでログイン：client ID が無ければ始めない。始めたら interval より早く聞かず、slow_down で間隔を延ばし、許可で登録する", async () => {
  await withWorld(async (w) => {
    await assert.rejects(() => w.accounts.startLogin({}, "c"), /client ID が設定されていません/);
    await assert.rejects(() => w.accounts.setAppClientId("12345"), /client ID の形が違います/);
    await w.accounts.setAppClientId(` ${FAKE_CLIENT_ID} `);
    assert.equal((await w.accounts.list()).appClientId, FAKE_CLIENT_ID);

    w.gh.script = ["pending", "slow_down", "pending", "authorized"];
    const start = await w.accounts.startLogin({}, "c");
    assert.deepEqual(
      { userCode: start.userCode, uri: start.verificationUri, expiresAt: start.expiresAt, interval: start.interval },
      { userCode: "WDJB-MJHT", uri: "https://github.com/login/device", expiresAt: T0 + 900_000, interval: 5 },
    );
    assert.ok(!JSON.stringify(start).includes("dc_"), "device_code を画面に返した");

    const pollsAt = () => w.gh.requests.filter((r) => r.form.grant_type?.endsWith("device_code")).length;
    assert.deepEqual(await w.accounts.pollLogin(start.flowId, "c"), { state: "pending", expiresAt: T0 + 900_000 });
    assert.deepEqual(w.clock.slept, [5000], "最初の問いを interval より早く聞いた");
    await w.accounts.pollLogin(start.flowId, "c"); // slow_down
    await w.accounts.pollLogin(start.flowId, "c"); // pending——延びた間隔（10秒）を待ってから
    assert.deepEqual(w.clock.slept, [5000, 5000, 10000], "slow_down の後も同じ間隔で聞いた");
    // 画面が待たずに続けて呼んでも、待ってから聞く
    const done = await w.accounts.pollLogin(start.flowId, "c");
    assert.equal(pollsAt(), 4);
    assert.deepEqual(w.clock.slept, [5000, 5000, 10000, 10000]);
    assert.equal(done.state, "done");
    if (done.state !== "done") return;
    assert.equal(done.relogin, false);
    assert.deepEqual(done.account, {
      login: "tjst-t",
      credential: {
        kind: "app",
        alias: { implementation: "vault-local", name: "repositories-github-tjst-t", group: "instance" },
        clientId: FAKE_CLIENT_ID,
      },
    });
    // Vault には種別 oauth-token で、トークンの組が1つの alias にまとまっている
    const stored = JSON.parse(w.vault.values.get("vault-local|instance|repositories-github-tjst-t")!);
    assert.equal(w.vault.aliases[0]!.kind, "oauth-token");
    assert.match(stored.accessToken, /^ghu_fake_access_/);
    assert.match(stored.refreshToken, /^ghr_fake_refresh_/);
    assert.equal(stored.expiresAt, w.clock.now + 8 * 3600 * 1000);
    assertNoSecrets("返り値", JSON.stringify([start, done]), w.gh);
    assertNoSecrets("台帳の置き場", w.files(), w.gh);
    // 終わったログインはもう聞けない
    await assert.rejects(() => w.accounts.pollLogin(start.flowId, "c"), /もう終わっています/);
  });
});

test("期限切れ・断られた・デバイスフローが無効は、それぞれそう言い、ログインを終わらせる", async () => {
  await withWorld(async (w) => {
    await w.accounts.setAppClientId(FAKE_CLIENT_ID);
    for (const [step, state] of [
      ["expired_token", "expired"],
      ["access_denied", "denied"],
    ] as const) {
      w.gh.script = [step];
      const s = await w.accounts.startLogin({}, "c");
      assert.deepEqual(await w.accounts.pollLogin(s.flowId, "c"), { state });
      await assert.rejects(() => w.accounts.pollLogin(s.flowId, "c"), /もう終わっています/);
    }
    // GitHub が答える前に、こちらの時計で期限が来た——聞かずに期限切れ
    w.gh.script = ["pending"];
    const s = await w.accounts.startLogin({}, "c");
    w.clock.now += 901_000;
    const before = w.gh.requests.length;
    assert.deepEqual(await w.accounts.pollLogin(s.flowId, "c"), { state: "expired" });
    assert.equal(w.gh.requests.length, before, "期限が過ぎたのに GitHub に聞いた");

    w.gh.script = ["device_flow_disabled"];
    const d = await w.accounts.startLogin({}, "c");
    await assert.rejects(() => w.accounts.pollLogin(d.flowId, "c"), /Enable Device Flow/);
    await assert.rejects(() => w.accounts.pollLogin(d.flowId, "c"), /もう終わっています/);
    assert.deepEqual((await w.accounts.list()).accounts, []);
  });
});

test("同じ login で、もう一度ログインすると前の置き場を置き換え、更新の失敗の印も消える。PAT のアカウントには重ねない", async () => {
  await withWorld(async (w) => {
    await w.accounts.setAppClientId(FAKE_CLIENT_ID);
    await loginWithDevice(w);
    // 更新を失敗させて印を付ける
    w.clock.now += 8 * 3600 * 1000;
    w.gh.refreshError = "bad_refresh_token";
    await assert.rejects(() => w.accounts.tokenFor("tjst-t", "c"));
    assert.ok((await w.accounts.list()).accounts[0]!.refreshFailure);
    w.gh.refreshError = undefined;

    const again = await loginWithDevice(w);
    assert.equal(again.state === "done" && again.relogin, true);
    assert.equal(w.vault.aliases.length, 1, "もう一度ログインして、2つ目の alias を作った");
    const [account] = (await w.accounts.list()).accounts;
    assert.equal(account!.refreshFailure, undefined, "ログインし直しても失敗の印が残っている");
    assert.match(await w.accounts.tokenFor("tjst-t", "c"), /^ghu_/);

    w.gh.users.set("ghp_bot", "bot-user");
    await w.accounts.addWithPat({ pat: "ghp_bot" }, "c");
    w.gh.loginForDevice = "bot-user";
    w.gh.script = ["authorized"];
    const s = await w.accounts.startLogin({}, "c");
    await assert.rejects(() => w.accounts.pollLogin(s.flowId, "c"), /@bot-user は PAT で登録してあります/);
  });
});

test("期限が近ければ使う前に取り直し、回った refresh token ごと Vault の同じ置き場に置き換える。遠ければ取り直さない", async () => {
  await withWorld(async (w) => {
    await w.accounts.setAppClientId(FAKE_CLIENT_ID);
    await loginWithDevice(w);
    const first = JSON.parse(w.vault.values.get("vault-local|instance|repositories-github-tjst-t")!);
    assert.equal(await w.accounts.tokenFor("tjst-t", "c"), first.accessToken);
    assert.equal(w.gh.refreshCalls, 0, "期限が遠いのに取り直した");

    // 期限の5分前を切った
    w.clock.now = first.expiresAt - REFRESH_MARGIN_MS + 1;
    const token = await w.accounts.tokenFor("tjst-t", "c");
    assert.equal(w.gh.refreshCalls, 1);
    const second = JSON.parse(w.vault.values.get("vault-local|instance|repositories-github-tjst-t")!);
    assert.equal(token, second.accessToken);
    assert.notEqual(second.refreshToken, first.refreshToken, "回った refresh token を置き換えていない");
    assert.equal(second.expiresAt, w.clock.now + 8 * 3600 * 1000);
    assert.equal(w.vault.aliases.length, 1);
    // 取り直したトークンで GitHub に入れる
    // ブラウザでログイン（GitHub App）のアカウントは、同じトークンで Install 先も返す（2026-10-04）
    const verified = await w.accounts.verify("tjst-t", "c");
    assert.equal(verified.login, "tjst-t");
    assert.deepEqual(verified.installs!.installations.map((i) => i.account), ["tjst-t"]);
  });
});

test("同じアカウントの更新は1本ずつ——同時に3つ頼まれても GitHub に取り直しに行くのは1回で、皆が同じ新しいトークンを受け取る", async () => {
  await withWorld(async (w) => {
    await w.accounts.setAppClientId(FAKE_CLIENT_ID);
    await loginWithDevice(w);
    const first = JSON.parse(w.vault.values.get("vault-local|instance|repositories-github-tjst-t")!);
    w.clock.now = first.expiresAt + 1;
    w.gh.refreshDelayMs = 50;
    const tokens = await Promise.all([1, 2, 3].map((i) => w.accounts.tokenFor("tjst-t", `c${i}`)));
    assert.equal(w.gh.refreshCalls, 1, "同時に何本も取り直した（refresh token は1回で無効になる）");
    assert.equal(new Set(tokens).size, 1);
    assert.equal(tokens[0], JSON.parse(w.vault.values.get("vault-local|instance|repositories-github-tjst-t")!).accessToken);
    assert.deepEqual(w.notices.raised, []);
  });
});

test("更新に失敗したら、アカウントに理由を残し、受信箱に1件出して、理由つきで断る（秘密は文言に入らない）", async () => {
  await withWorld(async (w) => {
    await w.accounts.setAppClientId(FAKE_CLIENT_ID);
    await loginWithDevice(w);
    const first = JSON.parse(w.vault.values.get("vault-local|instance|repositories-github-tjst-t")!);
    w.clock.now = first.expiresAt + 1;
    w.gh.refreshError = "bad_refresh_token";
    await assert.rejects(() => w.accounts.tokenFor("tjst-t", "c"), (err: Error) => {
      assert.match(err.message, /@tjst-t のログインを更新できませんでした：GitHub が更新の鍵/);
      assertNoSecrets("断りの文言", err.message, w.gh);
      return true;
    });
    assert.equal(w.notices.raised.length, 1);
    assert.equal(w.notices.raised[0]!.key, "github-refresh:tjst-t");
    assert.match(w.notices.raised[0]!.title, /@tjst-t のログインを更新できませんでした/);
    assert.match(w.notices.raised[0]!.detail, /もう一度「ブラウザでログイン」/);
    assertNoSecrets("受信箱", JSON.stringify(w.notices.raised), w.gh);
    const [account] = (await w.accounts.list()).accounts;
    assert.match(account!.refreshFailure!.message, /refresh token/);
    // Vault の組は触っていない（失敗した更新で上書きしない）
    assert.deepEqual(JSON.parse(w.vault.values.get("vault-local|instance|repositories-github-tjst-t")!), first);

    // 通るようになれば、印は消える
    w.gh.refreshError = undefined;
    w.gh.refreshTokens.set(first.refreshToken, "tjst-t");
    await w.accounts.tokenFor("tjst-t", "c");
    assert.equal((await w.accounts.list()).accounts[0]!.refreshFailure, undefined);
  });
});

test("更新に失敗して受信箱にも出せなかった——黙らず、両方を言う", async () => {
  await withWorld(async (w) => {
    await w.accounts.setAppClientId(FAKE_CLIENT_ID);
    await loginWithDevice(w);
    const first = JSON.parse(w.vault.values.get("vault-local|instance|repositories-github-tjst-t")!);
    w.clock.now = first.expiresAt + 1;
    w.gh.refreshError = "bad_refresh_token";
    w.notices.fail = "中継に届きません";
    await assert.rejects(() => w.accounts.tokenFor("tjst-t", "c"), /受信箱にも出せませんでした：中継に届きません/);
  });
});

// **取り直した組を Vault に置けなかったら、メモリに持って次に使い、置き直す**（2026-10-06）。GitHub はもう前の鍵を
// 無効にしているので、以前のように投げて終わると、Vault に残るのは使えない鍵だけ——以後の更新は毎回断られていた
// （本番：AI のターンの中の書き戻しが承認待ちのまま切れた）
test("取り直した組を Vault に置けなかったら、トークンは返し、組をメモリに持って受信箱に1件出す——次に使うときにそれを使い、置き直す", async () => {
  await withWorld(async (w) => {
    await w.accounts.setAppClientId(FAKE_CLIENT_ID);
    await loginWithDevice(w);
    const at = "vault-local|instance|repositories-github-tjst-t";
    const first = JSON.parse(w.vault.values.get(at)!);
    w.clock.now = first.expiresAt + 1;
    w.vault.failPut = "人の承認が得られませんでした";
    const token = await w.accounts.tokenFor("tjst-t", "c");
    assert.equal(w.gh.users.get(token), "tjst-t", "GitHub が出した、使えるトークンを返していない");
    assert.equal(w.gh.refreshCalls, 1);
    assert.deepEqual(JSON.parse(w.vault.values.get(at)!), first, "置けなかったのに Vault が変わった");
    assert.equal(w.notices.raised.length, 1);
    assert.equal(w.notices.raised[0]!.key, "github-save:tjst-t");
    assert.match(w.notices.raised[0]!.title, /@tjst-t の新しいログインを Vault に保存できていません/);
    assert.match(w.notices.raised[0]!.detail, /Vault に置けませんでした（人の承認が得られませんでした）/);
    assert.match(w.notices.raised[0]!.detail, /起こし直すと/);
    assertNoSecrets("受信箱", JSON.stringify(w.notices.raised), w.gh);
    assert.equal((await w.accounts.list()).accounts[0]!.refreshFailure, undefined, "更新は通ったのに失敗の印を付けた");

    // まだ置けない間に、また期限が来た——Vault の（もう無効な）鍵ではなく、メモリの組で取り直す
    w.clock.now += 8 * 3600 * 1000;
    const again = await w.accounts.tokenFor("tjst-t", "c");
    assert.equal(w.gh.refreshCalls, 2);
    assert.equal(w.gh.users.get(again), "tjst-t");
    assert.deepEqual(JSON.parse(w.vault.values.get(at)!), first);

    // 置けるようになった——次に使うとき、取り直さずに、手元の最新の組を置き直す
    w.vault.failPut = undefined;
    assert.equal(await w.accounts.tokenFor("tjst-t", "c"), again);
    assert.equal(w.gh.refreshCalls, 2, "期限が遠いのに取り直した");
    const saved = JSON.parse(w.vault.values.get(at)!);
    assert.equal(saved.accessToken, again, "メモリの組を Vault に置き直していない");
    assert.ok(w.gh.refreshTokens.has(saved.refreshToken), "Vault に置いた更新の鍵が、GitHub で生きている最新のものではない");

    // 置き直したあとは Vault の組で回る（起こし直しても続く——メモリを持たない別の実体で確かめる）
    w.clock.now = saved.expiresAt + 1;
    const restarted = new GithubAccounts({ store: w.store, vault: w.vault, github: httpGithub(w.gh.endpoints, () => w.clock.now), notices: w.notices, now: () => w.clock.now });
    assert.equal(w.gh.users.get(await restarted.tokenFor("tjst-t", "c")), "tjst-t");
    assert.equal(w.gh.refreshCalls, 3);
  });
});

test("置けないまま起こし直すと、Vault の鍵はもう無効——更新は「鍵が無効」と言い（client ID とは言わない）、もう一度ログインを頼む", async () => {
  await withWorld(async (w) => {
    await w.accounts.setAppClientId(FAKE_CLIENT_ID);
    await loginWithDevice(w);
    const first = JSON.parse(w.vault.values.get("vault-local|instance|repositories-github-tjst-t")!);
    w.clock.now = first.expiresAt + 1;
    w.vault.failPut = "Vault が止まっています";
    await w.accounts.tokenFor("tjst-t", "c");
    w.vault.failPut = undefined;
    // 起こし直した——メモリの組は失われ、Vault には GitHub が無効にした鍵だけ
    const restarted = new GithubAccounts({ store: w.store, vault: w.vault, github: httpGithub(w.gh.endpoints, () => w.clock.now), notices: w.notices, now: () => w.clock.now });
    await assert.rejects(() => restarted.tokenFor("tjst-t", "c"), (err: Error) => {
      assert.equal(
        err.message,
        "@tjst-t のログインを更新できませんでした：更新の鍵（refresh token）が無効になっています（前の更新を保存できなかった・取り消された等）。もう一度ブラウザでログインしてください",
      );
      return true;
    });
    const refresh = w.notices.raised.find((n) => n.key === "github-refresh:tjst-t");
    assert.match(refresh!.detail, /更新の鍵（refresh token）が無効になっています/);
    assert.doesNotMatch(refresh!.detail, /client ID/);
  });
});

test("置けていない組があっても、もう一度ログインすれば新しいログインが正——古い組を置き直さない。外せば捨てる", async () => {
  await withWorld(async (w) => {
    await w.accounts.setAppClientId(FAKE_CLIENT_ID);
    await loginWithDevice(w);
    const at = "vault-local|instance|repositories-github-tjst-t";
    w.clock.now = JSON.parse(w.vault.values.get(at)!).expiresAt + 1;
    w.vault.failPut = "Vault が止まっています";
    await w.accounts.tokenFor("tjst-t", "c");
    w.vault.failPut = undefined;
    await loginWithDevice(w);
    const relogged = JSON.parse(w.vault.values.get(at)!);
    assert.equal(await w.accounts.tokenFor("tjst-t", "c"), relogged.accessToken, "もう一度ログインしたのに、古い組を使った");
    assert.equal(JSON.parse(w.vault.values.get(at)!).accessToken, relogged.accessToken, "古い組で新しいログインを上書きした");

    // 外す：置けていない組があっても、あとで置き直さない
    w.clock.now = relogged.expiresAt + 1;
    w.vault.failPut = "Vault が止まっています";
    await w.accounts.tokenFor("tjst-t", "c");
    w.vault.failPut = undefined;
    await w.accounts.remove("tjst-t", "c");
    assert.deepEqual(w.vault.aliases, []);
    await assert.rejects(() => w.accounts.tokenFor("tjst-t", "c"), /登録されていません/);
    assert.deepEqual(w.vault.aliases, [], "外したアカウントの組を置き直した");
  });
});

test("外す：ブラウザでログインしたものは Vault のログイン情報も消す（先に消えていても止まらない）。PAT は残す", async () => {
  await withWorld(async (w) => {
    await w.accounts.setAppClientId(FAKE_CLIENT_ID);
    await loginWithDevice(w);
    w.gh.users.set("ghp_keep", "pat-user");
    await w.accounts.addWithPat({ pat: "ghp_keep" }, "c");
    assert.equal(w.vault.aliases.length, 2);

    const app = await w.accounts.remove("TJST-T", "c");
    assert.equal(app.loginRemoved, true);
    assert.deepEqual(w.vault.aliases.map((a) => a.name), ["github-pat-user-pat"]);
    const pat = await w.accounts.remove("pat-user", "c");
    assert.equal(pat.loginRemoved, false);
    assert.deepEqual(w.vault.aliases.map((a) => a.name), ["github-pat-user-pat"], "人が預けた PAT を消した");
    assert.deepEqual((await w.accounts.list()).accounts, []);
    await assert.rejects(() => w.accounts.remove("pat-user", "c"), /登録されていません/);

    // Vault の画面で先にログアウトしてあった
    await loginWithDevice(w);
    w.vault.aliases.splice(w.vault.aliases.findIndex((a) => a.name === "repositories-github-tjst-t"), 1);
    assert.equal((await w.accounts.remove("tjst-t", "c")).loginRemoved, false);
    assert.deepEqual((await w.accounts.list()).accounts, []);
  });
});

test("確かめる：資格情報の持ち主が登録と違えば、そう言う", async () => {
  await withWorld(async (w) => {
    const place = w.vault.seed({ implementation: "vault-local", name: "shared-pat", group: "instance", kind: "secret" }, "ghp_shared");
    w.gh.users.set("ghp_shared", "alice");
    await w.accounts.addWithPat({ patAlias: place }, "c");
    assert.deepEqual(await w.accounts.verify("alice", "c"), { login: "alice" });
    // Vault の値が別の人の PAT に差し替えられた
    w.vault.values.set("vault-local|instance|shared-pat", "ghp_other");
    w.gh.users.set("ghp_other", "bob");
    await assert.rejects(() => w.accounts.verify("alice", "c"), /この資格情報は @bob のものです（登録は @alice）/);
  });
});

test("更新したトークンは、ログインを置いた元の置き場に戻す——既定の Vault が後で変わっても、2つ目を作らない", async () => {
  await withWorld(async (w) => {
    await w.accounts.setAppClientId(FAKE_CLIENT_ID);
    await loginWithDevice(w);
    // ログインしたあとで、置き場が既定（vault-local の instance）でなくなった形——別の Vault に移した。名前も前の形
    // （`oauth-github-<login>`、2026-10-06 に改名）——アカウントは記録した在りかを使い続けるので、前の名前のままで回る
    const moved = { implementation: "vault-infisical", name: "oauth-github-tjst-t", group: "shared" };
    const value = w.vault.values.get("vault-local|instance|repositories-github-tjst-t")!;
    w.vault.aliases.splice(0, 1);
    w.vault.values.clear();
    w.vault.seed({ ...moved, kind: "oauth-token" }, value);
    await w.store.updateAccounts((accounts) => ({
      accounts: accounts.map((a) => (a.credential.kind === "app" ? { ...a, credential: { ...a.credential, alias: moved } } : a)),
      result: undefined,
    }));
    w.clock.now = JSON.parse(value).expiresAt + 1;
    const token = await w.accounts.tokenFor("tjst-t", "c");
    assert.deepEqual(w.vault.aliases.map((a) => `${a.implementation}/${a.group}/${a.name}`), ["vault-infisical/shared/oauth-github-tjst-t"], "既定の置き場に2つ目を作った");
    assert.equal(JSON.parse(w.vault.values.get("vault-infisical|shared|oauth-github-tjst-t")!).accessToken, token);
  });
});

test("待っている間に「やめる」を押されたら、起きたあとで GitHub に聞かず、聞いている間なら許可されていても何も置かない", async () => {
  await withWorld(async (w) => {
    await w.accounts.setAppClientId(FAKE_CLIENT_ID);
    w.gh.script = ["authorized"];
    const pollsAt = () => w.gh.requests.filter((r) => r.form.grant_type?.endsWith("device_code")).length;

    // interval を待っている間にやめた
    const a = await w.accounts.startLogin({}, "c");
    const sleeping = new GithubAccounts({
      store: w.store,
      vault: w.vault,
      github: httpGithub(w.gh.endpoints, () => w.clock.now),
      notices: w.notices,
      now: () => w.clock.now,
      sleep: async (ms) => {
        w.clock.now += ms;
        sleeping.cancelLogin(flowId);
      },
    });
    const s = await sleeping.startLogin({}, "c");
    const flowId = s.flowId;
    assert.deepEqual(await sleeping.pollLogin(flowId, "c"), { state: "cancelled" });
    assert.equal(pollsAt(), 0, "やめたのに GitHub に聞いた");

    // GitHub に聞いている間にやめた——許可が返っても、Vault にもアカウントにも何も残さない
    w.gh.pollDelayMs = 100;
    const asking = w.accounts.pollLogin(a.flowId, "c");
    setTimeout(() => w.accounts.cancelLogin(a.flowId), 30);
    assert.deepEqual(await asking, { state: "cancelled" });
    assert.equal(pollsAt(), 1);
    assert.deepEqual(w.vault.aliases, [], "やめたのにログイン情報を置いた");
    assert.deepEqual((await w.accounts.list()).accounts, []);
  });
});

test("許可されたあとで保存に失敗したら、保存していないことと GitHub での取り消し方を言う", async () => {
  await withWorld(async (w) => {
    await w.accounts.setAppClientId(FAKE_CLIENT_ID);
    w.gh.script = ["authorized"];
    w.vault.failPut = "Vault が止まっています";
    const s = await w.accounts.startLogin({}, "c");
    await assert.rejects(() => w.accounts.pollLogin(s.flowId, "c"), (err: Error) => {
      assert.match(err.message, /Vault が止まっています/);
      assert.match(err.message, /このログインは banto に保存していません/);
      assert.match(err.message, /Authorized GitHub Apps から取り消せます/);
      assertNoSecrets("断りの文言", err.message, w.gh);
      return true;
    });
    assert.deepEqual((await w.accounts.list()).accounts, []);
  });
});

test("外すとき、ログイン情報の Vault が読めなければ「もう無い」と見なさず断る（登録も残す）", async () => {
  await withWorld(async (w) => {
    await w.accounts.setAppClientId(FAKE_CLIENT_ID);
    await loginWithDevice(w);
    w.vault.failures.push({ implementation: "vault-local", error: "sops が鍵を読めません" });
    await assert.rejects(() => w.accounts.remove("tjst-t", "c"), /Vault（vault-local）が読めないので外せません：sops が鍵を読めません/);
    assert.equal((await w.accounts.list()).accounts.length, 1, "Vault が読めないのに登録だけ消した");
    assert.equal(w.vault.aliases.length, 1);
    // 別の Vault が読めないだけなら外せる
    w.vault.failures.splice(0, 1, { implementation: "vault-infisical", error: "繋がりません" });
    assert.equal((await w.accounts.remove("tjst-t", "c")).loginRemoved, true);
  });
});

test("外すとき、Vault から消せなければ手元の組は捨てない（登録も残る）——消せたら捨てる", async () => {
  await withWorld(async (w) => {
    await w.accounts.setAppClientId(FAKE_CLIENT_ID);
    await loginWithDevice(w);
    const at = "vault-local|instance|repositories-github-tjst-t";
    w.clock.now = JSON.parse(w.vault.values.get(at)!).expiresAt + 1;
    w.vault.failPut = "Vault が止まっています";
    const held = await w.accounts.tokenFor("tjst-t", "c");
    w.vault.failRemove = "Vault が止まっています";
    await assert.rejects(() => w.accounts.remove("tjst-t", "c"), /Vault が止まっています/);
    assert.equal((await w.accounts.list()).accounts.length, 1);
    // 手元の組がまだある——Vault の無効な鍵ではなく、それを使い、置き直す
    w.vault.failPut = undefined;
    w.vault.failRemove = undefined;
    assert.equal(await w.accounts.tokenFor("tjst-t", "c"), held, "消せなかったのに手元の組を捨てた");
    assert.equal(JSON.parse(w.vault.values.get(at)!).accessToken, held);
  });
});

test("更新を GitHub が断ったら手元の組を捨て（無効な鍵を置き直し続けない）、繋がらないだけなら残す", async () => {
  await withWorld(async (w) => {
    await w.accounts.setAppClientId(FAKE_CLIENT_ID);
    // 繋がらない形を作れる GitHub（偽の GitHub の前に、一時の失敗を挟む）
    const real = httpGithub(w.gh.endpoints, () => w.clock.now);
    let offline = false;
    const accounts = new GithubAccounts({
      store: w.store,
      vault: w.vault,
      github: {
        ...real,
        refresh: (clientId, token) => (offline ? Promise.reject(new GithubError("GitHub に繋がりませんでした（ECONNREFUSED）", "network")) : real.refresh(clientId, token)),
      },
      notices: w.notices,
      now: () => w.clock.now,
      sleep: async (ms) => void (w.clock.now += ms),
    });
    w.gh.script = ["authorized"];
    const start = await accounts.startLogin({}, "c");
    assert.equal((await accounts.pollLogin(start.flowId, "c")).state, "done");
    const at = "vault-local|instance|repositories-github-tjst-t";
    w.clock.now = JSON.parse(w.vault.values.get(at)!).expiresAt + 1;
    w.vault.failPut = "Vault が止まっています";
    const held = await accounts.tokenFor("tjst-t", "c");

    // 繋がらない（一時の失敗）——手元の組は残り、繋がれば手元の組の鍵で取り直せる
    w.clock.now += 8 * 3600 * 1000;
    offline = true;
    await assert.rejects(() => accounts.tokenFor("tjst-t", "c"), /GitHub に繋がりませんでした/);
    offline = false;
    const after = await accounts.tokenFor("tjst-t", "c");
    assert.notEqual(after, held);
    assert.equal(w.gh.users.get(after), "tjst-t", "繋がらなかっただけなのに手元の組を捨てた");

    // GitHub が断った——手元の組を捨てる。次は Vault の（もう無効な）鍵を読み、置き直しには行かない
    w.clock.now += 8 * 3600 * 1000;
    w.gh.refreshError = "bad_refresh_token";
    await assert.rejects(() => accounts.tokenFor("tjst-t", "c"), /GitHub が更新の鍵（refresh token）を受け付けませんでした/);
    w.gh.refreshError = undefined;
    w.vault.failPut = undefined;
    const puts = w.vault.calls.filter((c) => c.op === "putOwned").length;
    await assert.rejects(() => accounts.tokenFor("tjst-t", "c"), /更新の鍵（refresh token）が無効になっています/);
    assert.equal(w.vault.calls.filter((c) => c.op === "putOwned").length, puts, "断られた組を Vault に置き直しに行った");
  });
});
