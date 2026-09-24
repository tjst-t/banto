import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSubagent, SubagentError, type RunDeps } from "./acp-run.js";

const fakeAgent = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-agent.js");

function setup(): { deps: Omit<RunDeps, "askPermission">; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "subagent-run-"));
  return {
    deps: {
      launch: { command: process.execPath, args: [fakeAgent], env: { ...process.env, HOME: dir } },
      cwd: dir,
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const neverAsked = async () => {
  throw new Error("確認は来ないはず");
};

test("頼んだ文への返答・使用量・session id が返る", async () => {
  const { deps, cleanup } = setup();
  try {
    const r = await runSubagent({ prompt: "こんにちは" }, { ...deps, askPermission: neverAsked });
    assert.equal(r.stopReason, "end_turn");
    assert.match(r.text, /受け取った：こんにちは/);
    assert.equal(r.agent.name, "fake-agent");
    assert.equal(r.usage?.outputTokens, 20);
    assert.deepEqual(r.context, { used: 1200, size: 200000 });
    assert.deepEqual(r.cost, { amount: 0.001, currency: "USD" });
    assert.ok(r.sessionId.length > 0);
  } finally {
    cleanup();
  }
});

test("モデル・effort・モードを設定項目で掛ける", async () => {
  const { deps, cleanup } = setup();
  try {
    const r = await runSubagent(
      { prompt: "x", model: "fake-large", effort: "high" },
      { ...deps, mode: "auto", askPermission: neverAsked },
    );
    assert.match(r.text, /model=fake-large effort=high mode=auto/);
    assert.deepEqual(r.notes, []);
  } finally {
    cleanup();
  }
});

test("候補に無いモデルは、候補を添えて断る", async () => {
  const { deps, cleanup } = setup();
  try {
    await assert.rejects(
      runSubagent({ prompt: "x", model: "gpt-9" }, { ...deps, askPermission: neverAsked }),
      (err: unknown) => err instanceof SubagentError && /"gpt-9" はありません.*fake-small, fake-large/.test(err.message),
    );
  } finally {
    cleanup();
  }
});

test("掛けられないモードは止めずに notes で伝える", async () => {
  const { deps, cleanup } = setup();
  try {
    const r = await runSubagent({ prompt: "x" }, { ...deps, mode: "yolo", askPermission: neverAsked });
    assert.equal(r.stopReason, "end_turn");
    assert.match(r.notes.join("\n"), /モード yolo を掛けられませんでした/);
  } finally {
    cleanup();
  }
});

test("人への確認：選んだ答えがエージェントに届き、記録に残る", async () => {
  const { deps, cleanup } = setup();
  try {
    const asked: string[] = [];
    const r = await runSubagent(
      { prompt: "[permission]" },
      {
        ...deps,
        askPermission: async (q) => {
          asked.push(`${q.title}:${q.options.map((o) => o.kind).join(",")}`);
          return { optionId: "yes" };
        },
      },
    );
    assert.deepEqual(asked, ["write danger.txt:allow_once,allow_always,reject_once"]);
    assert.match(r.text, /確認の答え：yes/);
    assert.deepEqual(r.permissions, [{ title: "write danger.txt", answer: "allow_once" }]);
  } finally {
    cleanup();
  }
});

test("人への確認に答えられなければ cancelled を返す", async () => {
  const { deps, cleanup } = setup();
  try {
    const r = await runSubagent({ prompt: "[permission]" }, { ...deps, askPermission: async () => "cancelled" });
    assert.match(r.text, /確認は取り消された/);
    assert.deepEqual(r.permissions, [{ title: "write danger.txt", answer: "cancelled" }]);
  } finally {
    cleanup();
  }
});

test("取り消すと session/cancel が届き、cancelled で返る", async () => {
  const { deps, cleanup } = setup();
  try {
    const ac = new AbortController();
    const started = Date.now();
    const r = await runSubagent(
      { prompt: "[slow 30]" },
      {
        ...deps,
        signal: ac.signal,
        askPermission: neverAsked,
        onProgress: (m) => {
          if (m.startsWith("ツール：sleep")) ac.abort();
        },
      },
    );
    assert.equal(r.stopReason, "cancelled");
    assert.ok(Date.now() - started < 10_000, `止まるまで ${Date.now() - started}ms`);
  } finally {
    cleanup();
  }
});

test("続きから走らせる：前の会話を覚えていて、履歴の再生は返答に混ざらない", async () => {
  const { deps, cleanup } = setup();
  try {
    const first = await runSubagent({ prompt: "りんごを数えて" }, { ...deps, askPermission: neverAsked });
    const second = await runSubagent(
      { prompt: "前に何を頼んだ？", sessionId: first.sessionId },
      { ...deps, askPermission: neverAsked },
    );
    assert.equal(second.sessionId, first.sessionId);
    assert.match(second.text, /前に頼まれたこと：りんごを数えて/);
    assert.doesNotMatch(second.text, /受け取った：りんご/);
  } finally {
    cleanup();
  }
});

test("エージェントが落ちたら、そこで止まる（待ち続けない）", async () => {
  const { deps, cleanup } = setup();
  try {
    await assert.rejects(
      runSubagent({ prompt: "[crash]" }, { ...deps, askPermission: neverAsked }),
      (err: unknown) => err instanceof SubagentError && /エージェントが終了しました（code=3/.test(err.message),
    );
  } finally {
    cleanup();
  }
});

test("起動できないコマンドは、起動できないと言う", async () => {
  const { deps, cleanup } = setup();
  try {
    await assert.rejects(
      runSubagent(
        { prompt: "x" },
        { ...deps, launch: { ...deps.launch, command: "/nonexistent/agent" }, askPermission: neverAsked },
      ),
      (err: unknown) => err instanceof SubagentError && /起動できません/.test(err.message),
    );
  } finally {
    cleanup();
  }
});

test("無音が続いたら、作業中の進捗を送る", async () => {
  const { deps, cleanup } = setup();
  try {
    const seen: string[] = [];
    await runSubagent(
      { prompt: "[slow 2]" },
      { ...deps, heartbeatMs: 300, askPermission: neverAsked, onProgress: (m) => seen.push(m) },
    );
    assert.ok(seen.some((m) => m.startsWith("作業中（")), seen.join(" | "));
  } finally {
    cleanup();
  }
});
