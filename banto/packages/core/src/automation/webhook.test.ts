import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import type { Automation, AutomationReceived } from "./fold.js";
import { AutomationInputError, AutomationStore } from "./store.js";
import { AutomationWebhooks, WEBHOOK_BODY_MAX_BYTES, issueWebhookToken, signatureMatches, type AutomationWebhooksDeps } from "./webhook.js";
import type { AutomationRunStarted } from "./runner.js";

const KEY = "s3cret-hook-key";

const hookFields = (source: Record<string, unknown> = {}) => ({
  name: "CI が落ちたら",
  instruction: "落ちたジョブのログを読んで",
  source: { kind: "webhook", signature: { alias: "hook-secret" }, batchSeconds: 0, ...source },
});

function sign(body: string | Buffer, key = KEY): string {
  return `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;
}

interface Harness {
  store: AutomationStore;
  hooks: AutomationWebhooks;
  url: string;
  calls: Array<{ id: string; received: AutomationReceived[] }>;
  /** 届け先が終わっていないふりをする */
  busy: Set<string>;
  /** コンテナの住所の代わり：要求に付けたヘッダの Project をコンテナとみなす */
  turnEnded: (threadId: string) => void;
  dir: string;
  close(): Promise<void>;
}

async function harness(
  dir: string,
  opts: { limits?: AutomationWebhooksDeps["limits"]; container?: (remote: string) => Promise<string | undefined> } = {},
): Promise<Harness> {
  const log = new EventLog(dir);
  await log.init();
  const store = new AutomationStore(dir, log);
  await store.load();
  const calls: Harness["calls"] = [];
  const busy = new Set<string>();
  let ended: (threadId: string) => void = () => {};
  const hooks = new AutomationWebhooks({
    dataDir: dir,
    automations: store,
    runner: {
      run: async (a: Automation, cause, _extras, received = []): Promise<AutomationRunStarted> => {
        assert.equal(cause, "webhook");
        if (busy.has(a.id)) return { runId: "x", result: "skipped", reason: "前の回のターンがまだ走っています", deferred: true };
        calls.push({ id: a.id, received: [...received] });
        await store.recordRun(
          a.id,
          { runId: `r${calls.length}`, at: new Date().toISOString(), cause, result: "running", received: received.length },
          received.map((r) => r.receivedId),
        );
        return { runId: `r${calls.length}`, result: "running" };
      },
    },
    onTurnEnded: (listener) => {
      ended = listener;
    },
    containerProjectOf: opts.container ?? (async () => undefined),
    resolveSecret: async (alias) => {
      if (alias !== "hook-secret") throw new Error(`alias "${alias}" はどの Vault にもありません`);
      return KEY;
    },
    projectClosed: () => false,
    ...(opts.limits ? { limits: opts.limits } : {}),
    log: () => {},
  });
  const server: Server = createServer((req, res) => {
    const m = (req.url ?? "").match(/^\/hooks\/([^/]*)$/);
    void hooks.handle(req, res, m ? m[1]! : "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  hooks.start();
  return {
    store,
    hooks,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    busy,
    turnEnded: (threadId) => ended(threadId),
    dir,
    close: async () => {
      hooks.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function withHarness(fn: (h: Harness) => Promise<void>, opts?: Parameters<typeof harness>[1]): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "banto-webhook-test-"));
  const h = await harness(dir, opts);
  try {
    await fn(h);
  } finally {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** 作る口（HTTP）と同じ順：鍵を置いてから、印のハッシュつきで作る */
async function createHook(h: Harness, source: Record<string, unknown> = {}): Promise<{ a: Automation; token: string }> {
  const { token, hash } = issueWebhookToken();
  const id = `auto-${Math.random().toString(36).slice(2)}`;
  const fields = hookFields(source);
  const signature = (fields.source as { signature?: unknown }).signature === false ? undefined : { header: "X-Hub-Signature-256", alias: "hook-secret" };
  await h.hooks.storeSecret(id, "p1", signature);
  const a = await h.store.create({ projectId: "p1", createdBy: { kind: "human" }, fields, id, webhookTokenHash: hash });
  await h.store.setDedicatedThread(a.id, "fork-1");
  return { a: h.store.get(a.id)!, token };
}

function post(h: Harness, token: string, body: string | Buffer, headers: Record<string, string> = {}) {
  return fetch(`${h.url}/hooks/${token}`, { method: "POST", body: typeof body === "string" ? body : new Uint8Array(body), headers: { "content-type": "application/json", ...headers } });
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("待ちきれませんでした");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("印は32文字で推測できず、台帳にはハッシュだけ残る。印が無い・合わないは 404、知っている印でも POST 以外は 405", async () => {
  await withHarness(async (h) => {
    const { a, token } = await createHook(h);
    assert.ok(token.length >= 32);
    assert.match(a.webhookTokenHash!, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(a).includes(token), "印そのものが台帳に入っている");
    assert.equal((await post(h, "nope", "{}")).status, 404);
    assert.equal((await post(h, "", "{}")).status, 404);
    assert.equal((await fetch(`${h.url}/hooks/${token}`)).status, 405);
  });
});

test("署名が合えば 202 で受けて残し、合わない・無いものは 401 で AI を動かさず rejected を残す", async () => {
  await withHarness(async (h) => {
    const { a, token } = await createHook(h);
    // 生のバイト列で確かめる——JSON に起こし直すと空白が変わる本文でも合う
    const body = '{ "build":  "failed",\n "job": 7 }';
    const ok = await post(h, token, body, { "X-Hub-Signature-256": sign(body) });
    assert.equal(ok.status, 202);
    await until(() => h.calls.length === 1);
    assert.equal(h.calls[0]!.received[0]!.body, body);

    const bad = await post(h, token, body, { "X-Hub-Signature-256": sign(body, "wrong") });
    assert.equal(bad.status, 401);
    const missing = await post(h, token, body);
    assert.equal(missing.status, 401);
    const runs = h.store.get(a.id)!.runs.filter((r) => r.result === "rejected");
    assert.equal(runs.length, 2);
    assert.match(runs[0]!.reason!, /ヘッダ X-Hub-Signature-256 がありません/);
    assert.match(runs[1]!.reason!, /合いません/);
    assert.equal(h.calls.length, 1, "署名の合わないもので AI を動かした");
    assert.deepEqual(h.store.get(a.id)!.received, []);
  });
});

test("signatureMatches：sha256= の有無・大文字の hex を受け、長さ違い・hex でないものは合わない", () => {
  const body = Buffer.from("x");
  const hex = createHmac("sha256", KEY).update(body).digest("hex");
  assert.equal(signatureMatches(KEY, body, `sha256=${hex}`), true);
  assert.equal(signatureMatches(KEY, body, hex.toUpperCase()), true);
  assert.equal(signatureMatches(KEY, body, hex.slice(2)), false);
  assert.equal(signatureMatches(KEY, body, "zz".repeat(32)), false);
  assert.equal(signatureMatches(KEY, body, undefined), false);
});

test("署名の鍵は dataDir に 0600 で置かれ、Vault に無い alias なら作る前に断る。消したら鍵も消える", async () => {
  await withHarness(async (h) => {
    const { a, token } = await createHook(h);
    const file = join(h.dir, "automation-webhook-secrets.json");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await assert.rejects(h.hooks.storeSecret("auto-x", "p1", { header: "X-Sig", alias: "missing" }), /どの Vault にもありません/);
    // 鍵を捨てた署名つきの Webhook は、正しい署名でも通らない（rejected と理由が残る）
    h.hooks.forgetSecret(a.id);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const res = await post(h, token, "{}", { "X-Hub-Signature-256": sign("{}") });
    assert.equal(res.status, 401);
    assert.match(h.store.get(a.id)!.runs[0]!.reason!, /署名の鍵が banto に置かれていません/);
  });
});

test("Project のコンテナからは既定で断る（403）。許した自動化でも、ほかの Project のコンテナからは断る。分からなければ 503", async () => {
  let answer: string | undefined | Error = "p1";
  await withHarness(
    async (h) => {
      const { token } = await createHook(h, { signature: false });
      assert.equal((await post(h, token, "{}")).status, 403);
      const { token: allowed } = await createHook(h, { signature: false, allowProjectContainer: true });
      assert.equal((await post(h, allowed, "{}")).status, 202);
      answer = "p2";
      assert.equal((await post(h, allowed, "{}")).status, 403);
      answer = new Error("Incus が答えません");
      assert.equal((await post(h, allowed, "{}")).status, 503);
    },
    {
      container: async () => {
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  );
});

test("本文は全体で署名を確かめてから先頭 64KB に切り、1MB を超えるものは 413", async () => {
  await withHarness(async (h) => {
    const { a, token } = await createHook(h);
    h.busy.add(a.id);
    const big = Buffer.alloc(WEBHOOK_BODY_MAX_BYTES + 10, "a");
    assert.equal((await post(h, token, big, { "X-Hub-Signature-256": sign(big) })).status, 202);
    const kept = h.store.get(a.id)!.received[0]!;
    assert.equal(kept.body.length, WEBHOOK_BODY_MAX_BYTES);
    assert.equal(kept.truncatedFrom, WEBHOOK_BODY_MAX_BYTES + 10);
    const huge = Buffer.alloc(1024 * 1024 + 1, "a");
    assert.equal((await post(h, token, huge, { "X-Hub-Signature-256": sign(huge) })).status, 413);
  });
});

test("速さ（自動化ごと・口全体）と溜める件数の上限を超えたら 429", async () => {
  await withHarness(
    async (h) => {
      const { a, token } = await createHook(h, { signature: false });
      h.busy.add(a.id);
      assert.equal((await post(h, token, "1")).status, 202);
      assert.equal((await post(h, token, "2")).status, 202);
      // 溜めた件数が上限（2）
      assert.equal((await post(h, token, "3")).status, 429);
      // 自動化ごとの上限（3回/分）
      assert.equal((await post(h, token, "4")).status, 429);
      // 口全体の上限（5回/分）——知らない印でも数える
      assert.equal((await post(h, "nope", "5")).status, 404);
      assert.equal((await post(h, "nope", "6")).status, 429);
    },
    { limits: { pendingMax: 2, perAutomationPerMinute: 3, allPerMinute: 5 } },
  );
});

test("待つ時間の間に来たものは1回にまとめて届け、前の回が終わっていなければ溜めたまま、終わったら届ける", async () => {
  await withHarness(async (h) => {
    const { a, token } = await createHook(h, { signature: false, batchSeconds: 1 });
    assert.equal((await post(h, token, "first")).status, 202);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await post(h, token, "second")).status, 202);
    assert.equal(h.calls.length, 0, "待つ時間の前に届けた");
    await until(() => h.store.get(a.id)!.received.length === 0);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.calls[0]!.received.map((r) => r.body), ["first", "second"]);
    assert.equal(h.store.get(a.id)!.runs[0]!.received, 2);

    // 前の回が終わっていない：溜めたまま。記録も書かない
    h.busy.add(a.id);
    assert.equal((await post(h, token, "third")).status, 202);
    await new Promise((r) => setTimeout(r, 1300));
    assert.equal(h.calls.length, 1);
    assert.equal(h.store.get(a.id)!.received.length, 1);
    assert.equal(h.store.get(a.id)!.runs.length, 1, "溜めている間に記録を書いた");
    h.busy.delete(a.id);
    h.turnEnded("fork-1");
    await until(() => h.calls.length === 2);
    assert.deepEqual(h.calls[1]!.received.map((r) => r.body), ["third"]);
  });
});

test("起き直したら、残っている受けたものからまとめ直す", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-webhook-test-"));
  try {
    const first = await harness(dir);
    const { a, token } = await createHook(first, { signature: false, batchSeconds: 0 });
    first.busy.add(a.id);
    assert.equal((await post(first, token, "before-restart")).status, 202);
    await first.close();
    await first.store.save();

    const second = await harness(dir);
    try {
      await until(() => second.calls.length === 1);
      assert.deepEqual(second.calls[0]!.received.map((r) => r.body), ["before-restart"]);
    } finally {
      await second.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("一時停止中に受けたものは 409 で届けず、skipped を残す", async () => {
  await withHarness(async (h) => {
    const { a, token } = await createHook(h, { signature: false });
    await h.store.pause(a.id, "人が一時停止しました");
    assert.equal((await post(h, token, "x")).status, 409);
    assert.equal(h.store.get(a.id)!.runs[0]!.result, "skipped");
    assert.deepEqual(h.store.get(a.id)!.received, []);
  });
});

test("台帳：Webhook は印のハッシュ無しでは作れず（AI の tool の口）、きっかけの種類は変えられない。署名は既定で要る", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-webhook-test-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const store = new AutomationStore(dir, log);
    await store.load();
    await assert.rejects(store.create({ projectId: "p1", createdBy: { kind: "human" }, fields: hookFields() }), AutomationInputError);
    await assert.rejects(
      store.create({
        projectId: "p1",
        createdBy: { kind: "human" },
        fields: { ...hookFields(), source: { kind: "webhook" } },
        webhookTokenHash: "h",
      }),
      /signature/,
    );
    const a = await store.create({ projectId: "p1", createdBy: { kind: "human" }, fields: hookFields(), webhookTokenHash: "h" });
    assert.deepEqual(a.source, { kind: "webhook", signature: { header: "X-Hub-Signature-256", alias: "hook-secret" }, batchSeconds: 0, allowProjectContainer: false });
    await assert.rejects(
      store.update(a.id, { source: { kind: "time", repeat: { kind: "daily", time: "9:00" }, timeZone: "UTC" } }),
      /種類/,
    );
    const changed = await store.update(a.id, { source: { kind: "webhook", signature: false, batchSeconds: 60 } });
    assert.deepEqual(changed.source, { kind: "webhook", batchSeconds: 60, allowProjectContainer: false });
    assert.equal(changed.webhookTokenHash, "h");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
