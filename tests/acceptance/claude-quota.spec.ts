/**
 * **Claude サブスクの枠の監視**（クオータ節約）。
 *
 * 枠が尽きかけたら `shouldStop()` を真にし、Claude Agent SDK 経路を pi へ落とす。
 * ここで守りたいのは:
 *   - **計測できなければ「尽きた」と混同しない**（I2）——認証が無い／API が返さない
 *     ときは `shouldStop()` は `false` のまま
 *   - **残量は `100 - seven_day.utilization` で出す**（実測 2026-08-17 の形）
 *   - **false → true の変化だけ契機を出す**（自動フォールバックで何度も持ち替えない）
 *
 * ネットワークは呼ばない（`fetch` と `readCredentials` を差し替える）。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createClaudeBackend } from "@banto/host";
import { createClaudeQuotaMonitor, parseUsagePayload } from "@banto/worker-pool";

function makeMonitor(options: {
  fetched?: (url: string) => { status: number; payload?: unknown };
  credentials?: { accessToken?: string };
  stopRemainingPct?: number;
}) {
  const { fetched, credentials = { accessToken: "tok" }, stopRemainingPct } = options;
  const calls: string[] = [];
  return createClaudeQuotaMonitor({
    stopRemainingPct,
    readCredentials: () => credentials,
    fetch: async (url) => {
      calls.push(String(url));
      const r = fetched?.(String(url)) ?? { status: 404 };
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        json: async () => r.payload,
        text: async () => JSON.stringify(r.payload ?? {}),
      } as Response;
    },
  });
}

describe("[クオータ] usage 応答からの残量", () => {
  it("seven_day.utilization から残量を出す（100 - 使用率）", () => {
    const r = parseUsagePayload({
      seven_day: { utilization: 98.0, resets_at: "2026-08-20T03:59:59Z" },
      limits: [{ kind: "weekly_all", percent: 98 }],
    });
    assert.equal(r.remainingPct, 2);
    assert.equal(r.resetsAt, "2026-08-20T03:59:59Z");
  });

  it("seven_day が無ければ weekly_all の limits で代用する", () => {
    const r = parseUsagePayload({
      limits: [{ kind: "weekly_all", percent: 80, resets_at: "2026-08-20T00:00:00Z" }],
    });
    assert.equal(r.remainingPct, 20);
  });

  it("どちらも無ければ undefined（「分からない」を数で埋めない・I2）", () => {
    assert.deepEqual(parseUsagePayload({}), {});
    assert.deepEqual(parseUsagePayload(["garbage"]), {});
  });

  it("残量は 0〜100 に収める", () => {
    const r = parseUsagePayload({ seven_day: { utilization: 120 } });
    assert.equal(r.remainingPct, 0);
  });
});

describe("[クオータ] shouldStop と契機", () => {
  it("残量がしきい値未満で真になる", async () => {
    const m = makeMonitor({
      stopRemainingPct: 20,
      fetched: () => ({ status: 200, payload: { seven_day: { utilization: 98 } } }),
    });
    await m.refresh();
    assert.equal(m.shouldStop(), true);
    assert.equal(m.snapshot().remainingPct, 2);
  });

  it("計測できなければ false のまま（I2）", async () => {
    const m = makeMonitor({ credentials: undefined, fetched: () => ({ status: 200 }) });
    await m.refresh();
    assert.equal(m.shouldStop(), false);
  });

  it("残量がしきい値以上なら true にならない", async () => {
    const m = makeMonitor({
      stopRemainingPct: 20,
      fetched: () => ({ status: 200, payload: { seven_day: { utilization: 10 } } }),
    });
    await m.refresh();
    assert.equal(m.shouldStop(), false);
  });

  it("false → true の変化のときだけ契機が出る（何度も持ち替えない）", async () => {
    let payload = { seven_day: { utilization: 10 } };
    const m = makeMonitor({
      stopRemainingPct: 20,
      fetched: () => ({ status: 200, payload }),
    });
    let crossed = 0;
    m.onStopCrossing(() => {
      crossed += 1;
    });
    await m.refresh(); // false のまま → 契機なし
    assert.equal(crossed, 0);
    payload = { seven_day: { utilization: 98 } }; // 尽きかけた
    await m.refresh();
    assert.equal(crossed, 1);
    await m.refresh(); // 続けて尽きかけ → 契機は増えない
    assert.equal(crossed, 1);
    payload = { seven_day: { utilization: 10 } }; // 戻った
    await m.refresh();
    payload = { seven_day: { utilization: 98 } }; // 再度尽きかけ
    await m.refresh();
    assert.equal(crossed, 2, "戻った後にまた尽きたら、改めて契機を出す");
  });
});

describe("[決定98a] 枠が尽きかけた Claude バックエンド", () => {
  // 認証・可用性の判定口から差し替え、認証が無い検証環境でも自己完結させる（task-0267）
  const authOk = () => ({ ok: true, detail: "mocked" });

  it("認証はあるが枠が尽きかけなら unavailable を返し、理由に残量を書く", async () => {
    const quota = makeMonitor({
      stopRemainingPct: 20,
      fetched: () => ({ status: 200, payload: { seven_day: { utilization: 98 } } }),
    });
    await quota.refresh();
    const backend = createClaudeBackend({ quota, ask: async () => [], availability: authOk });
    const unavailable = backend.unavailable();
    assert.ok(unavailable, "枠が尽きかけなら選べなくする");
    assert.match(unavailable, /残り 2%/, "理由に残量を載せる");
    assert.match(unavailable, /pi/, "直し方（自動で pi に切り替え）を書く");
  });

  it("枠に余裕があるなら unavailable にならない", async () => {
    const quota = makeMonitor({
      stopRemainingPct: 20,
      fetched: () => ({ status: 200, payload: { seven_day: { utilization: 10 } } }),
    });
    await quota.refresh();
    const backend = createClaudeBackend({ quota, ask: async () => [], availability: authOk });
    assert.equal(backend.unavailable(), undefined);
  });

  it("監視を渡さなければ元の挙動のまま（認証の有無だけを見る）", () => {
    const withAuth = createClaudeBackend({ ask: async () => [], availability: authOk });
    assert.equal(withAuth.unavailable(), undefined);
  });
});
