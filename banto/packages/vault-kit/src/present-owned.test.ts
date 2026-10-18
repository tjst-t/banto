// **banto が置く秘密は、持ち主が作った値で渡す**（追加・2026-10-18、Backlog #405。仕様 §2.1）。
//
// 期限の切れた GitHub のログイン（refresh token 込みの JSON）が、Shell の envSecrets でそのまま AI に渡っていた。種別
// `oauth-token` を持ち主でない呼び元（host が刻んだ呼び元の Module が持ち主と違う）に渡すときは、置いてある値を添えて
// 持ち主の `presentOwnedSecret` を中継で呼び、その答えを渡す。見るのは：
//   1. 持ち主自身・host の直接の呼び出し（呼び元の Module の刻印なし）・ほかの種別は、置いてある値のまま
//   2. 持ち主でない呼び元には持ち主の答え。在りかは窓口と同じ形、受けた呼び出しの印を添える
//   3. 持ち主が答えない・中継が無い・持ち主の記録が無いなら、置いてある値に落とさず理由つきで断る（参照なら参照の名前で）
//   4. resolveAliases：置き場ごとに1回、全部か何もなし
//   5. 持ち主が答える前に同じ Vault へ putSecret で書き戻せる（Vault が持ち主を待つ間に詰まらない）
//   6. exportOwnedSecret：人の管理操作の中で、oauth-token だけを丸ごと
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createVaultModuleServer } from "./server.js";
import { LocalFileAliasStore } from "./alias-store.js";
import type { VaultBackend } from "./backend.js";
import type { OwnerRelay } from "./owner-relay.js";

function memoryBackend() {
  const secrets = new Map<string, string>();
  const backend: VaultBackend = {
    async getSecret(path) {
      const v = secrets.get(path);
      if (v === undefined) throw new Error(`vault secret not found: ${path}`);
      return v;
    },
    async putSecret(path, value) {
      secrets.set(path, String(value));
    },
    async deleteSecret(path) {
      secrets.delete(path);
    },
    async listPaths() {
      return [...secrets.keys()];
    },
    async generateKeypair() {
      throw new Error("使わない");
    },
    async publicKeyOf() {
      throw new Error("使わない");
    },
    async loadIntoAgent() {
      throw new Error("使わない");
    },
    async listGroups() {
      return [];
    },
    async createGroup() {},
  };
  return { backend, secrets };
}

/** 中継が刻む形。呼び元の Module が無ければ host の直接の呼び出し */
const via = (module?: string, extra: Record<string, unknown> = {}) => ({
  "dev.banto/caller": { instance: true },
  ...(module ? { "dev.banto/callerModule": { name: module, conn: `${module}-conn` } } : {}),
  ...extra,
});
const ADMIN = { "dev.banto/caller": { admin: true } };

interface RelayCall {
  target: string;
  name: string;
  args: Record<string, unknown>;
  callId?: string;
}

async function withKit(
  fn: (ctx: { c: Client; secrets: Map<string, string>; store: LocalFileAliasStore; calls: RelayCall[]; answer: { fn: (call: RelayCall) => Promise<string> } }) => Promise<void>,
  opts: { relay?: boolean } = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "vault-kit-present-"));
  const calls: RelayCall[] = [];
  const answer = { fn: async (_call: RelayCall): Promise<string> => "ghu_fresh" };
  const relay: OwnerRelay = {
    async callTool(target, name, args, callId) {
      const call = { target, name, args, ...(callId ? { callId } : {}) };
      calls.push(call);
      return answer.fn(call);
    },
  };
  try {
    const { backend, secrets } = memoryBackend();
    const store = new LocalFileAliasStore(dir);
    const server = createVaultModuleServer({
      moduleName: "vault-test",
      backend,
      aliasStore: store,
      dataDir: dir,
      ...(opts.relay === false ? {} : { ownerRelay: relay }),
    });
    const [s, cl] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(s), c.connect(cl)]);
    try {
      await fn({ c, secrets, store, calls, answer });
    } finally {
      await c.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function call(c: Client, name: string, args: Record<string, unknown>, meta: Record<string, unknown>): Promise<string> {
  const r = await c.callTool({ name, arguments: args, _meta: meta });
  const text = (r.content as { text: string }[])[0]!.text;
  if (r.isError) throw new Error(text);
  return text;
}

const STORED = JSON.stringify({ format: "github-app-user-token/1", accessToken: "ghu_old", refreshToken: "ghr_secret" });

test("持ち主自身・host の直接の呼び出し・ほかの種別は置いてある値のまま、持ち主でない呼び元には持ち主の答えを渡す", async () => {
  await withKit(async ({ c, calls }) => {
    await call(c, "putSecret", { name: "repositories-github-x", value: STORED }, via("repositories"));
    await call(c, "createAlias", { name: "plain", kind: "secret", value: "p-1" }, ADMIN);

    assert.equal(await call(c, "resolveAlias", { name: "repositories-github-x" }, via("repositories")), STORED, "持ち主に組を渡していない");
    assert.equal(await call(c, "resolveAlias", { name: "repositories-github-x" }, via()), STORED, "host の直接の読みが変わった");
    assert.equal(await call(c, "resolveAlias", { name: "repositories-github-x" }, ADMIN), STORED, "人の画面の API の直接の読みが変わった");
    assert.equal(await call(c, "resolveAlias", { name: "plain" }, via("shell")), "p-1");
    assert.deepEqual(calls, [], "持ち主を呼ぶ必要の無いときに呼んだ");

    const handed = await call(c, "resolveAlias", { name: "repositories-github-x" }, via("shell", { "dev.banto/callId": "call-7" }));
    assert.equal(handed, "ghu_fresh");
    assert.doesNotMatch(handed, /ghr_secret/);
    assert.deepEqual(calls, [
      { target: "repositories", name: "presentOwnedSecret", args: { name: "repositories-github-x", group: "instance", value: STORED }, callId: "call-7" },
    ]);
    // Module の画面から中継で来た（`admin` の刻印があっても呼び元の Module の刻印がある）なら、持ち主でない呼び元として扱う
    assert.equal(await call(c, "resolveAlias", { name: "repositories-github-x" }, { ...ADMIN, "dev.banto/callerModule": { name: "third", conn: "third" } }), "ghu_fresh");
  });
});

test("持ち主が答えない・中継が無い・持ち主の記録が無いなら、置いてある値に落とさず理由つきで断る", async () => {
  await withKit(async ({ c, secrets, answer }) => {
    await call(c, "putSecret", { name: "repositories-github-x", value: STORED }, via("repositories"));
    answer.fn = async () => {
      throw new Error("@x のログインを更新できませんでした：GitHub が更新の鍵（refresh token）を受け付けませんでした");
    };
    await assert.rejects(
      () => call(c, "resolveAlias", { name: "repositories-github-x" }, via("shell")),
      /"repositories-github-x" は banto が置いたログインで、持ち主の repositories が使える値を用意できませんでした：@x のログインを更新できませんでした.*置いてある値は渡しません/,
    );
    answer.fn = async () => {
      throw new Error("vault-test は repositories を呼ぶ権限がありません（宣言された依存に含まれない）");
    };
    await assert.rejects(
      () => call(c, "resolveAlias", { name: "repositories-github-x" }, via("shell")),
      /repositories が入っていないか、渡す値を作る口を持っていません。入れ直すか、Vault の画面でこの alias を消してください/,
    );
    answer.fn = async () => "";
    await assert.rejects(() => call(c, "resolveAlias", { name: "repositories-github-x" }, via("shell")), /空の値を返しました/);

    // 持ち主の記録が無い行（記録を始める前に置かれたもの）——持ち主を名乗る呼び元でも断る。host の直接の読みは今までどおり
    await call(c, "putSecret", { name: "oauth-remote", value: "old-login" }, via());
    for (const who of ["shell", "repositories"]) {
      await assert.rejects(
        () => call(c, "resolveAlias", { name: "oauth-remote" }, via(who)),
        /"oauth-remote" は banto が置いたログインですが、どの Module が置いたかの記録がありません。置いた Module でもう一度ログインすると使えます/,
      );
    }
    assert.equal(await call(c, "resolveAlias", { name: "oauth-remote" }, via()), "old-login");
    assert.equal(secrets.get("instance/repositories-github-x"), STORED);
  });
  await withKit(
    async ({ c }) => {
      await call(c, "putSecret", { name: "repositories-github-x", value: STORED }, via("repositories"));
      await assert.rejects(
        () => call(c, "resolveAlias", { name: "repositories-github-x" }, via("shell")),
        /持ち主の repositories が使える値を用意できませんでした：この Vault（vault-test）は中継に繋がっていないので、repositories を呼べません/,
      );
      // 持ち主自身は中継が無くても読める
      assert.equal(await call(c, "resolveAlias", { name: "repositories-github-x" }, via("repositories")), STORED);
    },
    { relay: false },
  );
});

test("参照を引いたときは、持ち主の理由の中の元の置き場の名前を、引いた参照の名前に言い換える", async () => {
  await withKit(async ({ c, calls, answer }) => {
    await call(c, "putSecret", { name: "repositories-github-x", value: STORED }, via("repositories"));
    await call(c, "linkAlias", { name: "repositories-github-x", toGroup: "pg", toName: "gh" }, ADMIN);
    await call(c, "setGroupBinding", { projectId: "p", group: "pg" }, ADMIN);
    const asProject = { "dev.banto/caller": { project: "p" }, "dev.banto/callerModule": { name: "shell", conn: "shell-p" } };
    assert.equal(await call(c, "resolveAlias", { name: "gh" }, asProject), "ghu_fresh");
    // 持ち主に渡すのは元の置き場（持ち主が記録しているのはそちら）
    assert.deepEqual(calls.at(-1)?.args, { name: "repositories-github-x", group: "instance", value: STORED });
    answer.fn = async () => {
      throw new Error("repositories-github-x は Repositories がブラウザでログインして置いた GitHub のログインではありません");
    };
    const err = await call(c, "resolveAlias", { name: "gh" }, asProject).then(
      () => assert.fail("断られずに通った"),
      (e: Error) => e.message,
    );
    assert.match(err, /"gh" は banto が置いたログインで、持ち主の repositories が使える値を用意できませんでした：gh は Repositories/);
    assert.doesNotMatch(err, /repositories-github-x/, "元の置き場の名前を Project に言った");
  });
});

test("resolveAliases：持ち主への問い合わせは置き場ごとに1回、1件でも用意できなければ値は1つも返さない", async () => {
  await withKit(async ({ c, calls, answer }) => {
    await call(c, "putSecret", { name: "repositories-github-x", value: STORED }, via("repositories"));
    await call(c, "putSecret", { name: "repositories-github-y", value: STORED.replace("ghu_old", "ghu_old_y") }, via("repositories"));
    await call(c, "createAlias", { name: "plain", kind: "secret", value: "p-1" }, ADMIN);
    answer.fn = async (x) => (x.args.name === "repositories-github-x" ? "ghu_x" : "ghu_y");
    const items = [{ name: "repositories-github-x" }, { name: "plain" }, { name: "repositories-github-x" }, { name: "repositories-github-y" }];
    const body = JSON.parse(await call(c, "resolveAliases", { items }, via("shell", { "dev.banto/callId": "c-1" }))) as {
      values: Array<{ name: string; value: string }>;
    };
    assert.deepEqual(body.values.map((v) => v.value), ["ghu_x", "p-1", "ghu_x", "ghu_y"]);
    assert.deepEqual(calls.map((x) => [x.args.name, x.callId]).sort(), [
      ["repositories-github-x", "c-1"],
      ["repositories-github-y", "c-1"],
    ]);

    answer.fn = async (x) => {
      if (x.args.name === "repositories-github-y") throw new Error("GitHub に繋がりません");
      return "ghu_x";
    };
    await assert.rejects(
      () => call(c, "resolveAliases", { items }, via("shell")),
      /4 件のうち 1 件を引けませんでした（値は1つも渡していません）：.*repositories-github-y.*GitHub に繋がりません/,
    );
    // 持ち主の記録が無いものは、値を読みに行かずに（持ち主も呼ばずに）断る
    await call(c, "putSecret", { name: "oauth-remote", value: "old" }, via());
    const before = calls.length;
    await assert.rejects(
      () => call(c, "resolveAliases", { items: [{ name: "repositories-github-x" }, { name: "oauth-remote" }] }, via("shell")),
      /どの Module が置いたかの記録がありません/,
    );
    assert.equal(calls.length, before, "引けないものがあるのに持ち主を呼んだ");
  });
});

test("持ち主が答える前に、同じ Vault へ putSecret で取り直した組を書き戻せる（Vault が持ち主を待つ間に詰まらない）", async () => {
  await withKit(async ({ c, secrets, answer }) => {
    await call(c, "putSecret", { name: "repositories-github-x", value: STORED }, via("repositories"));
    const rotated = JSON.stringify({ format: "github-app-user-token/1", accessToken: "ghu_new", refreshToken: "ghr_new" });
    // 持ち主（Repositories）は答える前に、中継で同じ Vault の putSecret を呼ぶ——その答えを待ってから返す
    answer.fn = async () => {
      await call(c, "putSecret", { name: "repositories-github-x", value: rotated }, via("repositories"));
      return "ghu_new";
    };
    const body = JSON.parse(await call(c, "resolveAliases", { items: [{ name: "repositories-github-x" }] }, via("shell"))) as {
      values: Array<{ value: string }>;
    };
    assert.equal(body.values[0]?.value, "ghu_new");
    assert.equal(secrets.get("instance/repositories-github-x"), rotated, "書き戻した組が Vault に無い");
  });
});

test("exportOwnedSecret：人の管理操作の中で、oauth-token だけを丸ごと読む", async () => {
  await withKit(async ({ c, calls }) => {
    await call(c, "putSecret", { name: "repositories-github-x", value: STORED }, via("repositories"));
    await call(c, "createAlias", { name: "plain", kind: "secret", value: "p-1" }, ADMIN);
    await call(c, "linkAlias", { name: "repositories-github-x", toGroup: "pg", toName: "gh" }, ADMIN);
    // 窓口は移動の中で、Module の刻印つきの人の管理操作として呼ぶ——それでも丸ごと（持ち主は呼ばない）
    const asDirectory = { ...ADMIN, "dev.banto/callerModule": { name: "vault-directory", conn: "vault-directory" } };
    assert.equal(await call(c, "exportOwnedSecret", { name: "repositories-github-x", group: "instance" }, asDirectory), STORED);
    assert.deepEqual(calls, []);
    await assert.rejects(() => call(c, "exportOwnedSecret", { name: "repositories-github-x" }, via("shell")), /人の管理画面からしか行えません/);
    await assert.rejects(() => call(c, "exportOwnedSecret", { name: "plain" }, asDirectory), /banto が置く秘密ではありません（secret）/);
    await assert.rejects(() => call(c, "exportOwnedSecret", { name: "gh", group: "pg" }, asDirectory), /参照です/);
  });
});
