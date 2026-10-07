#!/usr/bin/env node
// 試験用の偽の ACP エージェント（本物の Claude Code・OpenCode の代わり）。
// 単体試験と E2E の両方が使う——**本物のモデルを呼ばずに、Module の口を端から端まで通す**。
//
// 振る舞いは頼まれた文の中の印で決まる：
//   [permission]  人への確認を1回出し、選ばれた kind を返答に含める
//   [slow N]      tool を1つ始めて N 秒待つ（取り消されたら cancelled で返る）
//   [draft]       [slow N] で待つ前に「書きかけ…」と返答の頭を送る（走っている間の返答が見えるかの試験用）
//   [crash]       プロセスごと落ちる
//   [env NAME]    環境変数 NAME が渡っているかだけを答える（値は出さない）
//   [write PATH]  作業場所に PATH を書く（閉じ込めの試験用）
//   [anthropic PATH]  ANTHROPIC_BASE_URL＋PATH へ CLAUDE_CODE_OAUTH_TOKEN で POST し、状態と本文の頭を返す
//                     （banto 本体のログインを共有する中継の試験用）
//   [has VALUE]   環境変数のどれかに VALUE が含まれるかだけを答える（本物のトークンが入っていないことの試験用）
//   [sha NAME]    環境変数 NAME の sha256 を答える（値を会話に出さずに、何が届いたかを確かめる）
//   [child N]     子プロセスを1つ起こして N 秒走らせる（claude-agent-acp が CLI を子で起こすのと同じ形——ACP の管が
//                 切れても子は走り続ける。起こし直しで古いエージェントが残るかの試験用。子の引数に fake-agent-child）
//   [done-tool]   最初に tool を1つ呼んで、すぐ終わらせる（tool_call_update の completed。実行中の tool の数え方の試験用）
//   [then-slow N] この頼みのあと、同じ会話の次の頼み（起こし直しのあと続けたとき）で tool を1つ始めて N 秒待つ
//                 （続けている間の画面の試験用）
//   [cwd]         会話の作業場所（session/new の cwd）を答える（作業場所を選べるかの試験用）
//   [json-b64 B]  B（base64）を解いた文をそのまま返答にする（決まった形で返させる試験用。JSON は ] を含むので base64）
//   [commit PATH]  作業場所に PATH を書いて git commit する（Factory の実装役の試験用）。「レビュー役」の頼みでは何もしない
//                 （[slow N]・[child N]・[crash] も同じ——レビュー役の頼みにもタスクの本文が入るので、印は実装役にだけ効かせる）
//   [then-commit PATH]  この頼みのあと、同じ会話の次の頼みで PATH を書いて git commit する
//   [review-b64 B]  「レビュー役」の頼みに B（base64）を解いた文を返す。印が無ければ {"verdict":"pass","items":[]}
//   [bad-then-json-b64 B]  この頼みには JSON でない文を返し、同じ会話の次の頼みから B を解いた文を返す（直させる試験用）
// それ以外は「受け取った：<頼まれた文>」と返す。
//
// 会話は `$HOME/.fake-agent/<sessionId>.json` に残す——別プロセスでの再開（session/load）を試せる。頼まれた文は
// 頼まれた時点で残す（本物の CLI が API に送る前に人の発言を書くのと同じ。追加・2026-10-05）——途中で殺されても、
// 続きの会話に残る

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION, type AgentContext, type SessionConfigOption } from "@agentclientprotocol/sdk";

interface Stored {
  cwd: string;
  model: string;
  effort: string;
  mode: string;
  turns: { user: string; agent: string }[];
}

const store = join(homedir(), ".fake-agent");
const pathOf = (id: string) => join(store, `${id.replace(/[^A-Za-z0-9-]/g, "")}.json`);
const load = (id: string): Stored | undefined =>
  existsSync(pathOf(id)) ? (JSON.parse(readFileSync(pathOf(id), "utf8")) as Stored) : undefined;
const save = (id: string, s: Stored) => {
  mkdirSync(store, { recursive: true });
  writeFileSync(pathOf(id), JSON.stringify(s));
};

function configOptions(s: Stored): SessionConfigOption[] {
  return [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: s.model,
      options: [
        { value: "fake-small", name: "Fake Small" },
        { value: "fake-large", name: "Fake Large" },
      ],
    },
    {
      type: "select",
      id: "effort",
      name: "Effort",
      category: "thought_level",
      currentValue: s.effort,
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    },
    {
      type: "select",
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: s.mode,
      options: [
        { value: "default", name: "Default" },
        { value: "auto", name: "Auto" },
      ],
    },
  ];
}

const running = new Map<string, AbortController>();

async function say(cx: AgentContext, sessionId: string, text: string) {
  await cx.notify(methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  });
}

async function prompt(sessionId: string, text: string, cx: AgentContext) {
  const s = load(sessionId);
  if (!s) throw new Error(`session ${sessionId} がありません`);
  const abort = new AbortController();
  running.set(sessionId, abort);
  let reply = `受け取った：${text}`;
  const previous = s.turns.slice();
  s.turns.push({ user: text, agent: "" });
  save(sessionId, s);
  const toolCall = async (title: string) =>
    cx.notify(methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "tool_call", toolCallId: randomUUID(), title, kind: "other", status: "in_progress" },
    });
  // 「レビュー役」の頼み（Factory）にはタスクの本文が入る——実装役に向けた [slow]・[child]・[crash] は効かせない
  const reviewer = text.includes("レビュー役");
  try {
    if (!reviewer && text.includes("[crash]")) process.exit(3);
    const child = reviewer ? null : /\[child (\d+)\]/.exec(text);
    if (child) {
      spawn(process.execPath, ["-e", `setTimeout(() => {}, ${Number(child[1]) * 1000})`, "fake-agent-child", sessionId], {
        stdio: "ignore",
      }).unref();
    }
    if (text.includes("[done-tool]")) {
      const toolCallId = randomUUID();
      await cx.notify(methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "tool_call", toolCallId, title: "look around", kind: "read", status: "in_progress" },
      });
      await cx.notify(methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "tool_call_update", toolCallId, status: "completed" },
      });
    }
    const thenSlow = previous.map((t) => /\[then-slow (\d+)\]/.exec(t.user)).find((m) => m !== null);
    const slow = reviewer ? null : (/\[slow (\d+)\]/.exec(text) ?? thenSlow ?? null);
    if (slow) {
      await toolCall(`sleep ${slow[1]}`);
      if (text.includes("[draft]")) await say(cx, sessionId, "書きかけ…");
      await new Promise<void>((res, rej) => {
        const t = setTimeout(res, Number(slow[1]) * 1000);
        abort.signal.addEventListener("abort", () => {
          clearTimeout(t);
          rej(new Error("cancelled"));
        });
      });
    }
    if (text.includes("[permission]")) {
      await toolCall("write danger.txt");
      const res = await cx.request(methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId: randomUUID(), title: "write danger.txt", kind: "edit" },
        options: [
          { optionId: "yes", name: "Allow", kind: "allow_once" },
          { optionId: "always", name: "Always allow", kind: "allow_always" },
          { optionId: "no", name: "Reject", kind: "reject_once" },
        ],
      });
      reply = res.outcome.outcome === "selected" ? `確認の答え：${res.outcome.optionId}` : "確認は取り消された";
    }
    const env = /\[env ([A-Z0-9_]+)\]/.exec(text);
    if (env) reply = `${env[1]} は${process.env[env[1]] ? "渡っている" : "渡っていない"}`;
    const write = /\[write ([^\]]+)\]/.exec(text);
    if (write) {
      await toolCall(`write ${write[1]}`);
      try {
        writeFileSync(resolve(s.cwd, write[1]), "fake\n");
        reply = `書いた：${write[1]}`;
      } catch (err) {
        reply = `書けなかった：${(err as Error).message}`;
      }
    }
    const anthropic = /\[anthropic ([^\]]+)\]/.exec(text);
    if (anthropic) {
      const res = await fetch(`${process.env.ANTHROPIC_BASE_URL}${anthropic[1]}`, {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.CLAUDE_CODE_OAUTH_TOKEN}`, "content-type": "application/json" },
        body: "{}",
      });
      reply = `anthropic: ${res.status} ${(await res.text()).slice(0, 120)}`;
    }
    const sha = /\[sha ([A-Z0-9_]+)\]/.exec(text);
    if (sha) {
      const v = process.env[sha[1]];
      reply = `${sha[1]} の sha256：${v === undefined ? "（無い）" : createHash("sha256").update(v).digest("hex")}`;
    }
    const has = /\[has ([^\]]+)\]/.exec(text);
    if (has) reply = `環境に ${Object.values(process.env).some((v) => v?.includes(has[1])) ? "含む" : "含まない"}`;
    if (text.includes("前に")) reply = `前に頼まれたこと：${previous.map((t) => t.user).join(" / ") || "（無い）"}`;
    if (text.includes("[cwd]")) reply = `cwd=${s.cwd}`;
    const commit = (path: string) => {
      writeFileSync(resolve(s.cwd, path), `${sessionId} ${previous.length}\n`);
      execFileSync("git", ["add", path], { cwd: s.cwd });
      execFileSync("git", ["-c", "user.name=fake-agent", "-c", "user.email=fake@localhost", "commit", "-q", "-m", `fake: ${path}`], { cwd: s.cwd });
    };
    if (reviewer) {
      const review = /\[review-b64 ([A-Za-z0-9+/=]+)\]/.exec(text);
      reply = review ? Buffer.from(review[1]!, "base64").toString("utf8") : JSON.stringify({ verdict: "pass", items: [] });
    } else {
      for (const m of text.matchAll(/\[commit ([^\]]+)\]/g)) {
        await toolCall(`git commit ${m[1]}`);
        commit(m[1]!);
      }
      if (previous.length > 0) {
        for (const m of previous.flatMap((t) => [...t.user.matchAll(/\[then-commit ([^\]]+)\]/g)])) {
          await toolCall(`git commit ${m[1]}`);
          commit(m[1]!);
        }
      }
    }
    const b64 = (b: string) => Buffer.from(b, "base64").toString("utf8");
    const json = /\[json-b64 ([A-Za-z0-9+/=]+)\]/.exec(text);
    if (json) reply = b64(json[1]!);
    const badThen = /\[bad-then-json-b64 ([A-Za-z0-9+/=]+)\]/.exec(text);
    const laterJson = previous.map((t) => /\[bad-then-json-b64 ([A-Za-z0-9+/=]+)\]/.exec(t.user)).find((m) => m !== null);
    if (badThen) reply = "まだ JSON にしていません";
    else if (laterJson) reply = b64(laterJson[1]!);
    reply += `（model=${s.model} effort=${s.effort} mode=${s.mode}）`;
    await say(cx, sessionId, reply);
    await cx.notify(methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "usage_update", used: 1200, size: 200000, cost: { amount: 0.001, currency: "USD" } },
    });
    s.turns[s.turns.length - 1] = { user: text, agent: reply };
    save(sessionId, s);
    return {
      stopReason: "end_turn" as const,
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    };
  } catch (err) {
    if (abort.signal.aborted) return { stopReason: "cancelled" as const };
    throw err;
  } finally {
    running.delete(sessionId);
  }
}

agent({ name: "fake-agent" })
  .onRequest("initialize", () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: { name: "fake-agent", version: "0.0.0" },
    agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false } },
    authMethods: [],
  }))
  .onRequest("session/new", (ctx) => {
    const sessionId = randomUUID();
    const s: Stored = { cwd: ctx.params.cwd, model: "fake-small", effort: "low", mode: "default", turns: [] };
    save(sessionId, s);
    return { sessionId, configOptions: configOptions(s) };
  })
  .onRequest("session/load", async (ctx) => {
    const s = load(ctx.params.sessionId);
    if (!s) throw new Error(`session ${ctx.params.sessionId} がありません`);
    // 本物と同じく、履歴を再生してから返る
    for (const t of s.turns) {
      await ctx.client.notify(methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: t.user } },
      });
      if (t.agent !== "") await say(ctx.client, ctx.params.sessionId, t.agent);
    }
    return { configOptions: configOptions(s) };
  })
  .onRequest("session/set_config_option", (ctx) => {
    const s = load(ctx.params.sessionId);
    if (!s) throw new Error(`session ${ctx.params.sessionId} がありません`);
    const value = String(ctx.params.value);
    if (ctx.params.configId === "model") s.model = value;
    if (ctx.params.configId === "effort") s.effort = value;
    if (ctx.params.configId === "mode") s.mode = value;
    save(ctx.params.sessionId, s);
    return { configOptions: configOptions(s) };
  })
  .onRequest("session/prompt", (ctx) => {
    const text = ctx.params.prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
    return prompt(ctx.params.sessionId, text, ctx.client);
  })
  .onNotification("session/cancel", (ctx) => {
    running.get(ctx.params.sessionId)?.abort();
  })
  .connect(
    ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    ),
  );
