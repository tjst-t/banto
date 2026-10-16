// 組み立て済みの様子を GitHub に聞く（prebuilt-probe.ts）。GitHub は偽の fetch
import { test } from "node:test";
import assert from "node:assert/strict";
import { githubRepoOf, probePrebuilt } from "./prebuilt-probe.js";

const COMMIT = "0123456789ab".padEnd(40, "c");
const ORIGIN = "git@github.com:o/r.git";

/** HEAD が `head`（200 か 404）、runs が `runs`（配列）か `apiStatus` を返す偽の fetch。呼ばれた URL を残す */
function fakeFetch(opts: { head?: number; runs?: unknown[]; apiStatus?: number; throws?: boolean }) {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (opts.throws) throw new Error("届きません");
    if (init?.method === "HEAD") return new Response(null, { status: opts.head ?? 404 });
    if (opts.apiStatus) return new Response("{}", { status: opts.apiStatus });
    return new Response(JSON.stringify({ workflow_runs: opts.runs ?? [] }), { status: 200 });
  }) as typeof fetch;
  return { f, calls };
}

test("ファイルがあれば available（API には聞かない）。URL は Release build-<頭12> の決まった名前", async () => {
  const { f, calls } = fakeFetch({ head: 200 });
  const p = await probePrebuilt(COMMIT, ORIGIN, { fetch: f, arch: "x64", now: () => 0 });
  assert.equal(p.status, "available");
  assert.equal(p.checkedAt, "1970-01-01T00:00:00.000Z");
  assert.deepEqual(calls, [`HEAD https://github.com/o/r/releases/download/build-0123456789ab/banto-${COMMIT}-linux-x64.tar.zst`]);
});

test("回の状態で決める：走っている回があれば building（止められた回が新しくても）、テストが落ちたら tests-failed、止められたら cancelled", async () => {
  const run = (n: number, status: string, conclusion: string | null) => ({ run_number: n, status, conclusion, html_url: `https://github.com/o/r/actions/runs/${n}` });
  const cases: Array<[unknown[], string, string | undefined]> = [
    [[run(3, "completed", "cancelled"), run(2, "in_progress", null)], "building", "https://github.com/o/r/actions/runs/2"],
    [[run(1, "queued", null)], "building", "https://github.com/o/r/actions/runs/1"],
    [[run(1, "completed", "failure")], "tests-failed", "https://github.com/o/r/actions/runs/1"],
    [[run(2, "completed", "failure"), run(1, "completed", "cancelled")], "tests-failed", "https://github.com/o/r/actions/runs/2"],
    [[run(1, "completed", "timed_out")], "cancelled", "https://github.com/o/r/actions/runs/1"],
    [[run(1, "completed", "success")], "none", undefined],
    [[], "none", undefined],
  ];
  for (const [runs, status, url] of cases) {
    const p = await probePrebuilt(COMMIT, ORIGIN, { fetch: fakeFetch({ runs }).f, arch: "x64" });
    assert.equal(p.status, status, JSON.stringify(runs));
    assert.equal(p.run, url);
  }
});

test("run の URL は GitHub の Actions の形だけ通す（画面でリンクになる）", async () => {
  const p = await probePrebuilt(COMMIT, ORIGIN, {
    fetch: fakeFetch({ runs: [{ run_number: 1, status: "completed", conclusion: "failure", html_url: "javascript:alert(1)" }] }).f,
    arch: "x64",
  });
  assert.equal(p.status, "tests-failed");
  assert.equal(p.run, undefined);
});

test("回数制限・届かないは unknown（理由つき）。GitHub 以外・x64 以外は none（理由つき）で、どこにも聞かない", async () => {
  assert.match((await probePrebuilt(COMMIT, ORIGIN, { fetch: fakeFetch({ apiStatus: 403 }).f, arch: "x64" })).detail ?? "", /回数制限/);
  assert.equal((await probePrebuilt(COMMIT, ORIGIN, { fetch: fakeFetch({ throws: true }).f, arch: "x64" })).status, "unknown");
  const none = fakeFetch({});
  const gitlab = await probePrebuilt(COMMIT, "https://gitlab.com/o/r.git", { fetch: none.f, arch: "x64" });
  assert.equal(gitlab.status, "none");
  assert.match(gitlab.detail ?? "", /GitHub ではありません/);
  const arm = await probePrebuilt(COMMIT, ORIGIN, { fetch: none.f, arch: "arm64" });
  assert.match(arm.detail ?? "", /arm64/);
  assert.deepEqual(none.calls, []);
});

test("試験の差し替え（base と api）はその口に聞く", async () => {
  const { f, calls } = fakeFetch({ runs: [] });
  await probePrebuilt(COMMIT, undefined, { fetch: f, arch: "x64", base: "http://127.0.0.1:1/dl/", api: "http://127.0.0.1:1/runs" });
  assert.deepEqual(calls, [
    `HEAD http://127.0.0.1:1/dl/build-0123456789ab/banto-${COMMIT}-linux-x64.tar.zst`,
    `GET http://127.0.0.1:1/runs?head_sha=${COMMIT}&per_page=20`,
  ]);
});

test("origin の読み方（写し：scripts/prebuilt.mjs と同じ）", () => {
  for (const [url, want] of [
    ["git@github.com:o/r.git", "o/r"],
    ["ssh://git@github.com:22/o/r", "o/r"],
    ["https://github.com/o/r/", "o/r"],
    ["https://gitlab.com/o/r", undefined],
    [undefined, undefined],
  ] as const) {
    assert.equal(githubRepoOf(url), want, String(url));
  }
});
