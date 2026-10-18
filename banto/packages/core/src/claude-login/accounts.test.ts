import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAccountStore, HOST_ACCOUNT_ID, freshUsage, usageFromHeaders } from "./accounts.js";

function withDir(fn: (dir: string) => void | Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-accounts-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

// **移り方**（§2「Claude のアカウントを複数持つ」の 8.）：入れた最初の起動で `~/.claude` を1つ目にし、既定の並びをそれだけに
test(
  "最初の起動で ~/.claude が1つ目になり、既定の並びはそれだけ。起こし直しても作り直さない",
  withDir((dir) => {
    const hostPath = "/home/someone/.claude/.credentials.json";
    const store = new ClaudeAccountStore({ dataDir: dir, hostCredentialsPath: hostPath, now: () => new Date("2026-10-18T00:00:00Z") });
    assert.deepEqual(store.list(), [{ id: HOST_ACCOUNT_ID, kind: "host", label: "このマシンの Claude Code のログイン", addedAt: "2026-10-18T00:00:00.000Z" }]);
    assert.deepEqual(store.defaultOrder(), [HOST_ACCOUNT_ID]);
    assert.equal(store.credentialsPathOf(HOST_ACCOUNT_ID), hostPath);
    assert.equal(statSync(join(dir, "claude-accounts.json")).mode & 0o777, 0o600);
    // 足したあと起こし直す——台帳から読み、1つ目を足し直さない
    const b = store.add({ email: "b@example.com", oauth: { accessToken: "B" } });
    const again = new ClaudeAccountStore({ dataDir: dir, hostCredentialsPath: hostPath, now: () => new Date("2026-10-19T00:00:00Z") });
    assert.deepEqual(again.list().map((a) => a.id), [HOST_ACCOUNT_ID, b.id]);
    assert.equal(again.get(HOST_ACCOUNT_ID)!.addedAt, "2026-10-18T00:00:00.000Z");
    assert.deepEqual(again.defaultOrder(), [HOST_ACCOUNT_ID, b.id]);
  }),
);

test(
  "足したアカウントの置き場は banto のデータの下（フォルダ 0700・ファイル 0600）。台帳にトークンを書かない。外すと消える",
  withDir((dir) => {
    const store = new ClaudeAccountStore({ dataDir: dir, hostCredentialsPath: join(dir, "host.json") });
    const b = store.add({ email: "b@example.com", subscriptionType: "max", rateLimitTier: "t", oauth: { accessToken: "SECRET-A", refreshToken: "SECRET-R" } });
    assert.equal(b.label, "b@example.com");
    const path = store.credentialsPathOf(b.id);
    assert.equal(path, join(dir, "claude-accounts", b.id, ".credentials.json"));
    assert.equal(statSync(join(dir, "claude-accounts")).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "claude-accounts", b.id)).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { claudeAiOauth: { accessToken: "SECRET-A", refreshToken: "SECRET-R" } });
    assert.doesNotMatch(readFileSync(join(dir, "claude-accounts.json"), "utf8"), /SECRET/);

    assert.throws(() => store.remove(HOST_ACCOUNT_ID), /外せません/);
    store.remove(b.id);
    assert.equal(existsSync(join(dir, "claude-accounts", b.id)), false);
    assert.deepEqual(store.defaultOrder(), [HOST_ACCOUNT_ID]);
    assert.throws(() => store.setDefaultOrder([b.id]), /台帳にありません/);
  }),
);

test(
  "使用率はアカウントごとに覚え、リセットを過ぎたら分からないに戻す。台帳に残り、起こし直しても読める",
  withDir((dir) => {
    let now = new Date("2026-10-18T00:00:00Z");
    const store = new ClaudeAccountStore({ dataDir: dir, hostCredentialsPath: join(dir, "host.json"), now: () => now });
    const sec = (iso: string) => String(Date.parse(iso) / 1000);
    store.recordUsage(
      HOST_ACCOUNT_ID,
      new Headers({
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": sec("2026-10-18T02:00:00Z"),
        "anthropic-ratelimit-unified-representative-claim": "five_hour",
        "anthropic-ratelimit-unified-5h-utilization": "1",
        "anthropic-ratelimit-unified-5h-reset": sec("2026-10-18T02:00:00Z"),
        "anthropic-ratelimit-unified-7d-utilization": "0.3",
        "anthropic-ratelimit-unified-7d-reset": sec("2026-10-21T00:00:00Z"),
      }),
    );
    store.flush();
    const reloaded = new ClaudeAccountStore({ dataDir: dir, hostCredentialsPath: join(dir, "host.json"), now: () => now });
    assert.deepEqual(reloaded.get(HOST_ACCOUNT_ID)!.usage, {
      fiveHour: { utilization: 1, resetsAt: "2026-10-18T02:00:00.000Z" },
      sevenDay: { utilization: 0.3, resetsAt: "2026-10-21T00:00:00.000Z" },
      status: "rejected",
      statusResetsAt: "2026-10-18T02:00:00.000Z",
      representativeClaim: "five_hour",
      readAt: "2026-10-18T00:00:00.000Z",
    });
    // 5時間の窓のリセットを過ぎた：5時間の率と status は分からない、週は残る
    now = new Date("2026-10-18T02:00:01Z");
    assert.deepEqual(reloaded.get(HOST_ACCOUNT_ID)!.usage, {
      sevenDay: { utilization: 0.3, resetsAt: "2026-10-21T00:00:00.000Z" },
      readAt: "2026-10-18T00:00:00.000Z",
    });
    // 週も過ぎれば何も分からない
    now = new Date("2026-10-21T00:00:01Z");
    assert.equal(reloaded.get(HOST_ACCOUNT_ID)!.usage, undefined);
  }),
);

test("見出しが無い返事からは何も読まない。窓の見出しが片方だけでも読める", () => {
  const now = new Date("2026-10-18T00:00:00Z");
  assert.equal(usageFromHeaders(new Headers({ "content-type": "application/json" }), now), undefined);
  assert.deepEqual(usageFromHeaders(new Headers({ "anthropic-ratelimit-unified-7d-utilization": "0.5" }), now), {
    sevenDay: { utilization: 0.5 },
    readAt: "2026-10-18T00:00:00.000Z",
  });
  // リセットの時刻が無い値は、次の見出しまで残す
  assert.deepEqual(freshUsage({ status: "allowed", readAt: "x" }, now), { status: "allowed", readAt: "x" });
});

test(
  "台帳が壊れていたら止まる（黙って作り直さない）",
  withDir((dir) => {
    writeFileSync(join(dir, "claude-accounts.json"), JSON.stringify({ version: 1, accounts: [], defaultOrder: ["gone"] }));
    assert.throws(() => new ClaudeAccountStore({ dataDir: dir, hostCredentialsPath: "/x" }), /壊れています/);
    writeFileSync(join(dir, "claude-accounts.json"), "{");
    assert.throws(() => new ClaudeAccountStore({ dataDir: dir, hostCredentialsPath: "/x" }), /JSON ではありません/);
  }),
);

// **Project の並びと閾値**（§2「Claude のアカウントを複数持つ」の 5.・6.）
test(
  "Project の並び：無ければ既定のまま。外したアカウントは並びから抜け、空になれば既定に戻る。閾値は既定 95%・95%。起こし直しても残る",
  withDir((dir) => {
    const hostPath = join(dir, "host.json");
    const store = new ClaudeAccountStore({ dataDir: dir, hostCredentialsPath: hostPath });
    const b = store.add({ email: "b@example.com", oauth: { accessToken: "B" } });
    const c = store.add({ email: "c@example.com", oauth: { accessToken: "C" } });
    assert.equal(store.projectOrder("p1"), undefined);
    assert.deepEqual(store.orderFor("p1"), [HOST_ACCOUNT_ID, b.id, c.id]);
    store.setProjectOrder("p1", [c.id, b.id]);
    store.setProjectOrder("p2", [b.id]);
    assert.deepEqual(store.orderFor("p1"), [c.id, b.id]);
    assert.throws(() => store.setProjectOrder("p1", []), /1つ以上/);
    assert.throws(() => store.setProjectOrder("p1", [b.id, b.id]), /2回/);
    assert.throws(() => store.setProjectOrder("p1", ["nope"]), /台帳にありません/);
    assert.deepEqual(store.thresholds(), { fiveHour: 0.95, sevenDay: 0.95 });
    store.setThresholds({ fiveHour: 0.8, sevenDay: 0.9 });
    assert.throws(() => store.setThresholds({ fiveHour: 0, sevenDay: 0.9 }), /5時間/);
    assert.throws(() => store.setThresholds({ fiveHour: 0.5, sevenDay: 1.5 }), /週/);

    store.remove(b.id);
    assert.deepEqual(store.orderFor("p1"), [c.id]);
    // p2 は空になったので既定に戻る
    assert.equal(store.projectOrder("p2"), undefined);
    assert.deepEqual(store.orderFor("p2"), [HOST_ACCOUNT_ID, c.id]);

    const again = new ClaudeAccountStore({ dataDir: dir, hostCredentialsPath: hostPath });
    assert.deepEqual(again.orderFor("p1"), [c.id]);
    assert.deepEqual(again.thresholds(), { fiveHour: 0.8, sevenDay: 0.9 });
    // 既定に戻す
    again.setProjectOrder("p1", undefined);
    assert.deepEqual(again.orderFor("p1"), [HOST_ACCOUNT_ID, c.id]);
  }),
);
