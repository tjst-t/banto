// GitHub App の Install の分かりにくさを減らす（2026-10-04）。偽の GitHub で：Install 先と権限を読む・slug は
// インストールの返事が正で、無いときだけ設定のもの・その App のものだけ・PAT のアカウントは関係ない・公開の画面の
// 持ち主に Install のページを添える。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GithubAccounts } from "./accounts.js";
import { httpGithub } from "./github.js";
import { LedgerStore } from "./ledger.js";
import { Publisher } from "./publish.js";
import { FAKE_CLIENT_ID, MemoryVault, RecordingNotices, startFakeGithub } from "./test-fakes.js";

async function world() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "banto-repositories-installs-")));
  const gh = await startFakeGithub();
  const vault = new MemoryVault();
  const store = new LedgerStore(join(home, ".data"));
  const github = httpGithub(gh.endpoints);
  const accounts = new GithubAccounts({ store, vault, github, notices: new RecordingNotices(), sleep: async () => undefined });
  const publisher = new Publisher({ store, accounts, vault, github, endpoints: gh.endpoints, home, dataDir: join(home, ".data") });
  const appAccount = async (login: string) => {
    await accounts.setAppClientId(FAKE_CLIENT_ID);
    gh.loginForDevice = login;
    gh.script = ["authorized"];
    const flow = await accounts.startLogin({}, "c");
    assert.equal((await accounts.pollLogin(flow.flowId, "c")).state, "done");
  };
  return { gh, accounts, publisher, appAccount, done: async () => { await gh.close(); rmSync(home, { recursive: true, force: true }); } };
}

test("Install 先と権限を読む。Install のページは、インストールの返事の slug から（無ければ設定のもの、どちらも無ければ出さない）", async () => {
  const w = await world();
  try {
    await w.appAccount("alice");
    w.gh.orgs.set("acme", { login: "acme", members: new Map([["alice", "member"]]), membersCanCreate: true });
    w.gh.installations.set("alice", [{ account: "alice", administration: "write", contents: "write" }, { account: "acme", administration: "read" }]);
    const web = w.gh.endpoints.web;
    assert.deepEqual(await w.accounts.installations("alice", "c"), {
      installations: [
        { account: "alice", accountType: "User", administration: "write", contents: "write", repositorySelection: "all" },
        { account: "acme", accountType: "Organization", administration: "read", repositorySelection: "all" },
      ],
      installUrl: `${web}/apps/banto-fake-app/installations/new`,
    });
    // 「確かめる」は同じトークンで Install 先も返す（PAT のアカウントは返さない）
    assert.equal((await w.accounts.verify("alice", "c")).installs!.installations.length, 2);
    // どこにも Install されていない——slug は返事に無い。設定に無ければ Install のページは出せない
    w.gh.installations.set("alice", []);
    assert.deepEqual(await w.accounts.installations("alice", "c"), { installations: [] });
    // 設定に App のページを入れると、そこから
    assert.deepEqual(await w.accounts.setAppSlug("https://github.com/apps/My-Banto/"), { appSlug: "my-banto" });
    assert.deepEqual(await w.accounts.installations("alice", "c"), { installations: [], installUrl: `${web}/apps/my-banto/installations/new` });
    // Install されていれば、設定より GitHub の返事の slug が正
    w.gh.installations.set("alice", [{ account: "alice", administration: "write", contents: "write" }]);
    assert.equal((await w.accounts.installations("alice", "c")).installUrl, `${web}/apps/banto-fake-app/installations/new`);
    assert.deepEqual(await w.accounts.setAppSlug("banto-x"), { appSlug: "banto-x" });
    await assert.rejects(() => w.accounts.setAppSlug("https://evil.example/x y"), /App のページの形が違います/);
    assert.deepEqual(await w.accounts.setAppSlug(null), {});
    // PAT のアカウントは App と関係ない
    const place = (w.accounts as unknown as { deps: { vault: MemoryVault } }).deps.vault.seed({ implementation: "vault-local", name: "bob-pat", group: "instance", kind: "secret" }, "ghp_bob");
    w.gh.users.set("ghp_bob", "bob");
    await w.accounts.addWithPat({ patAlias: place }, "c");
    await assert.rejects(() => w.accounts.installations("bob", "c"), /PAT のアカウントです/);
    assert.deepEqual(await w.accounts.verify("bob", "c"), { login: "bob" });
  } finally {
    await w.done();
  }
});

test("その App のインストールだけを見る（client ID が違う返事は数えない）。公開の画面の持ち主に Install のページを添える", async () => {
  const w = await world();
  try {
    await w.appAccount("alice");
    // 設定の client ID を別の App に替えた——返事の client_id（偽物の App）と違うので、その App のものとして数えない
    const github = httpGithub(w.gh.endpoints);
    const token = [...w.gh.users.entries()].find(([, l]) => l === "alice")![0];
    assert.deepEqual(await github.appInstallations(token, { clientId: "Iv23liOTHERAPP" }), { installations: [] });

    // 公開の画面：App が入っていない Organization に、Install のページ
    w.gh.orgs.set("acme", { login: "acme", members: new Map([["alice", "member"]]), membersCanCreate: true });
    w.gh.installations.set("alice", [{ account: "alice", administration: "write", contents: "write" }]);
    const acme = (await w.publisher.targets(undefined, "c")).accounts[0]!.owners.find((o) => o.login === "acme")!;
    assert.equal(acme.create, "no");
    assert.match(acme.note!, /GitHub App が acme に入っていません/);
    assert.equal(acme.installUrl, `${w.gh.endpoints.web}/apps/banto-fake-app/installations/new`);
    // どこにも入っていなければ、設定の App のページから
    w.gh.installations.set("alice", []);
    await w.accounts.setAppSlug("my-banto");
    const self = (await w.publisher.targets(undefined, "c")).accounts[0]!.owners[0]!;
    assert.equal(self.installUrl, `${w.gh.endpoints.web}/apps/my-banto/installations/new`);
  } finally {
    await w.done();
  }
});
