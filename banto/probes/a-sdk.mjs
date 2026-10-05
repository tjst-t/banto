// A：Agent SDK（query）のターンを途中で殺し、resume で続けたときに何が起きるかを測る。
// 使い方: node a-sdk.mjs <A1|A2|A3|A4|A6> [SIGKILL|SIGTERM]
// モデルは偽の API（fake-api.mjs）。CLI が API に送った要求（＝モデルが見るもの）を記録する。
import { query } from "@anthropic-ai/claude-agent-sdk";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeApi, summarizeRequest } from "./fake-api.mjs";
import { startSlowMcp } from "./slow-mcp.mjs";
import { freshDirs, childEnv, detachedSpawner, killLikeSystemd, findJsonl, dumpJsonl, readJsonl, sleep, descendants } from "./lib.mjs";

const [caseName, signal = "SIGKILL"] = process.argv.slice(2);
const log = (...a) => console.log(...a);

const RESUME_PROMPT =
  "banto を起こし直したので直前のターンが途中で切れました。続けてください。直前に何をしていて、その結果はどうなったと理解していますか？";

function apiLines(file) {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

/** 1ターン走らせる。killOn(m, state) が真を返したら（delayMs 後に）CLI をグループごと殺す */
async function turn(ctx, { label, prompt, resume, resumeSessionAt, resumeDropsTurn, killOn, killDelayMs = 3000, partial = false, mcpServers, sessionId }) {
  log(`\n=== ${label} ===`);
  const apiFrom = apiLines(ctx.apiLog).length;
  const h = {};
  let closeInput;
  const keepOpen = new Promise((r) => (closeInput = r));
  async function* promptStream() {
    yield { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null };
    await keepOpen;
  }
  const state = { textDeltas: 0, sessionId: undefined, killed: false, uuids: [] };
  let killP;
  const q = query({
    prompt: promptStream(),
    options: {
      cwd: ctx.work,
      model: "claude-haiku-4-5",
      env: childEnv({ configDir: ctx.config, baseUrl: ctx.api.url }),
      settingSources: [],
      strictMcpConfig: true,
      tools: ["Bash"],
      allowedTools: ["Bash", "mcp__slow__slow_task"],
      ...(mcpServers ? { mcpServers } : {}),
      ...(resume ? { resume } : {}),
      ...(resumeSessionAt ? { resumeSessionAt } : {}),
      ...(resumeDropsTurn ? { resumeDropsTurn } : {}),
      ...(sessionId ? { sessionId } : {}),
      includePartialMessages: partial,
      spawnClaudeCodeProcess: detachedSpawner(h),
      ...(process.env.PROBE_CLI ? { pathToClaudeCodeExecutable: process.env.PROBE_CLI } : {}),
    },
  });
  let error;
  try {
    for await (const m of q) {
      if (m.type === "system" && m.subtype === "init") {
        state.sessionId = m.session_id;
        log(`  system/init session_id=${m.session_id}`);
      } else if (m.type === "stream_event") {
        if (m.event.type === "content_block_delta" && m.event.delta.type === "text_delta") state.textDeltas++;
      } else if (m.type === "assistant" || m.type === "user") {
        state.uuids.push({ type: m.type, uuid: m.uuid });
        const c = m.message.content;
        const desc = typeof c === "string" ? `text:${JSON.stringify(c.slice(0, 80))}` : c.map((b) => (b.type === "text" ? `text:${JSON.stringify(b.text.slice(0, 80))}` : b.type === "tool_use" ? `tool_use(${b.name})` : b.type === "tool_result" ? `tool_result(is_error=${b.is_error ?? false}):${JSON.stringify(JSON.stringify(b.content).slice(0, 100))}` : b.type)).join(" | ");
        log(`  ${m.type} uuid=${m.uuid?.slice(0, 8)} ${desc}`);
      } else if (m.type === "result") {
        log(`  result subtype=${m.subtype} is_error=${m.is_error} session_id=${m.session_id} ${m.subtype === "success" ? "result=" + JSON.stringify(m.result.slice(0, 200)) : "errors=" + JSON.stringify(m.errors)}`);
        closeInput();
      } else if (m.type === "system") {
        log(`  system/${m.subtype}`);
      }
      if (killOn && !state.killed && killOn(m, state)) {
        state.killed = true;
        log(`  → ${killDelayMs}ms 後に ${signal}（CLI pid ${h.pid}、プロセスグループごと）`);
        killP = sleep(killDelayMs).then(() => killLikeSystemd(h.pid, signal, { log }));
      }
    }
  } catch (e) {
    error = e;
    log(`  query が投げた: ${e.message.split("\n")[0]}`);
  }
  closeInput();
  if (killP) await killP;
  await sleep(300);
  if (h.pid) {
    const left = descendants(h.pid);
    if (left.length) log(`  !! まだ残っている: ${left.map((r) => r.pid + " " + r.args).join("; ")}`);
  }
  if (error && !state.killed) log(`  stderr: ${h.stderr?.slice(-1500)}`);
  // このターンで API に送られた要求（＝モデルが見たもの）
  const reqs = apiLines(ctx.apiLog).slice(apiFrom);
  for (const r of reqs) {
    log(`  API要求 #${r.n} ${r.path} stream=${r.stream} max_tokens=${r.max_tokens} messages=${r.messages?.length ?? 0} tools=${(r.tools ?? []).join(",")}`);
    for (const line of summarizeRequest(r)) log(line);
  }
  return { ...state, error };
}

const hasToolUse = (name) => (m) => m.type === "assistant" && m.message.content.some((b) => b.type === "tool_use" && (!name || b.name === name));

async function setup(name) {
  const d = freshDirs(name);
  const apiLog = join(d.root, "api.jsonl");
  const api = await startFakeApi({ logFile: apiLog });
  return { ...d, api, apiLog, name };
}

async function killedThenResume(ctx, { firstTurn = true, killPrompt, killOn, partial, killDelayMs, mcpServers }) {
  let sid;
  if (firstTurn) {
    const t1 = await turn(ctx, { label: "ターン1（完了させる）", prompt: "合言葉は pineapple-42 です。覚えておいてください。", mcpServers });
    sid = t1.sessionId;
  }
  const t2 = await turn(ctx, { label: `ターン2（途中で ${signal}）`, prompt: killPrompt, resume: sid, killOn, partial, killDelayMs, mcpServers });
  sid = sid ?? t2.sessionId;
  const file = findJsonl(ctx.config, sid);
  log(`\n--- kill 直後の記録（session ${sid}） ---`);
  const before = dumpJsonl(file, { log });
  // A3 で使うため、resume 前の記録を取っておく
  cpSync(ctx.config, join(ctx.root, "config-after-kill"), { recursive: true });
  const t3 = await turn(ctx, { label: "ターン3（resume）", prompt: RESUME_PROMPT, resume: sid, mcpServers });
  log(`\n--- resume 後の記録（追加分） ---`);
  dumpJsonl(findJsonl(ctx.config, sid), { from: before.length, log });
  if (t3.sessionId && t3.sessionId !== sid) {
    log(`  （resume で session id が変わった: ${t3.sessionId}）`);
    dumpJsonl(findJsonl(ctx.config, t3.sessionId), { log });
  }
  return { sid };
}

const cases = {
  // Bash の長い tool の途中で kill → resume
  async A1() {
    const ctx = await setup(`A1-${signal}`);
    await killedThenResume(ctx, { killPrompt: "SLEEP_TOOL：sleep 120 を Bash で実行してください。", killOn: hasToolUse("Bash") });
    await ctx.api.close();
  },
  // 長い文のストリーミング中に kill → resume
  async A2() {
    const ctx = await setup(`A2-${signal}`);
    await killedThenResume(ctx, { killPrompt: "LONG_TEXT：長い文を書いてください。", partial: true, killDelayMs: 0, killOn: (m, s) => s.textDeltas >= 50 });
    await ctx.api.close();
  },
  // 新しいセッションの最初のターンを kill（tool 実行中）→ init の session id で resume
  async A4() {
    const ctx = await setup(`A4-${signal}`);
    await killedThenResume(ctx, { firstTurn: false, killPrompt: "SLEEP_TOOL：合言葉は pineapple-42。sleep 120 を Bash で実行してください。", killOn: hasToolUse("Bash") });
    await ctx.api.close();
  },
  // 新しいセッションの最初のターンを、assistant の記録が1つも無いうち（ストリーミング中）に kill
  async A4b() {
    const ctx = await setup(`A4b-${signal}`);
    await killedThenResume(ctx, { firstTurn: false, killPrompt: "LONG_TEXT：合言葉は pineapple-42。長い文を書いてください。", partial: true, killDelayMs: 0, killOn: (m, s) => s.textDeltas >= 30 });
    await ctx.api.close();
  },
  // 新しいセッションの最初のターンを、system/init を受けた瞬間に kill。session id は呼ぶ側が先に決めて渡す（options.sessionId）
  async A4c() {
    const ctx = await setup(`A4c-${signal}`);
    const sid = randomUUID();
    log(`呼ぶ側で決めた session id: ${sid}`);
    const t = await turn(ctx, { label: `ターン1（init で即 ${signal}）`, prompt: "SLEEP_TOOL：合言葉は pineapple-42。", sessionId: sid, killDelayMs: 0, killOn: (m) => m.type === "system" && m.subtype === "init" });
    log(`  init の session id ${t.sessionId === sid ? "＝" : "≠"} 渡した id`);
    const file = findJsonl(ctx.config, sid);
    const before = dumpJsonl(file, { log, label: "kill 直後の" });
    await turn(ctx, { label: "ターン2（resume）", prompt: RESUME_PROMPT, resume: sid });
    dumpJsonl(findJsonl(ctx.config, sid), { from: before.length, log, label: "resume 後の" });
    await ctx.api.close();
  },
  // A1 の kill 直後の記録を、そのまま（resumeSessionAt なしで）resume する。PROBE_CLI で CLI を差し替えて版の差を見る
  async R() {
    const src = join(freshDirs("R-dummy").root, "..", `A1-${signal}`);
    const tag = process.env.PROBE_CLI ? "altcli" : "default";
    const d = freshDirs(`R-${signal}-${tag}`);
    cpSync(join(src, "config-after-kill"), d.config, { recursive: true });
    const apiLog = join(d.root, "api.jsonl");
    const api = await startFakeApi({ logFile: apiLog });
    const pdir = join(d.config, "projects");
    const { readdirSync } = require_fs();
    const sub = readdirSync(pdir)[0];
    const sid = readdirSync(join(pdir, sub)).find((f) => f.endsWith(".jsonl")).replace(".jsonl", "");
    log(`CLI: ${process.env.PROBE_CLI ?? "SDK 既定"}`);
    const ctx = { ...d, work: join(src, "work"), api, apiLog };
    const before = readJsonl(findJsonl(d.config, sid)).length;
    await turn(ctx, { label: "resume", prompt: RESUME_PROMPT, resume: sid });
    dumpJsonl(findJsonl(d.config, sid), { from: before, log });
    await api.close();
  },
  // http の MCP の長い tool の途中で kill → resume
  async A6() {
    const ctx = await setup(`A6-${signal}`);
    const mcp = await startSlowMcp({ log: (s) => log(`  [mcp] ${s}`) });
    const mcpServers = { slow: { type: "http", url: mcp.url } };
    await killedThenResume(ctx, { killPrompt: "MCP_TOOL：slow_task を呼んでください。", killOn: hasToolUse("mcp__slow__slow_task"), mcpServers });
    await mcp.close();
    await ctx.api.close();
  },
  // A1 の kill 直後の記録を、resumeSessionAt でいろいろな点から resume する
  async A3() {
    const src = join(freshDirs("A3-dummy").root, "..", `A1-${signal}`);
    if (!existsSync(join(src, "config-after-kill"))) throw new Error(`先に A1 ${signal} を走らせる`);
    // A1 の work と同じパスで resume しないと記録が見つからない——A1 の work をそのまま使う
    const sidFile = readJsonl(
      (() => {
        const { readdirSync } = require_fs();
        const pdir = join(src, "config-after-kill", "projects");
        const d = readdirSync(pdir)[0];
        return join(pdir, d, readdirSync(join(pdir, d)).find((f) => f.endsWith(".jsonl")));
      })(),
    );
    const sid = sidFile.find((e) => e.sessionId)?.sessionId;
    const chain = sidFile.filter((e) => e.uuid);
    log(`A1 の kill 直後の記録（session ${sid}）:`);
    chain.forEach((e, i) => log(`  #${i} uuid=${e.uuid} type=${e.type} ${e.message ? (typeof e.message.content === "string" ? "text" : e.message.content.map((b) => b.type).join(",")) : ""}`));
    const userPrompts = chain.filter((e) => e.type === "user" && !e.isMeta && (typeof e.message.content === "string" || e.message.content.some((b) => b.type === "text")));
    const turn2Prompt = userPrompts[1];
    const idx2 = chain.indexOf(turn2Prompt);
    const lastOfTurn1 = chain[idx2 - 1];
    const lastAssistantOfTurn1 = [...chain.slice(0, idx2)].reverse().find((e) => e.type === "assistant");
    const danglingToolUse = [...chain].reverse().find((e) => e.type === "assistant" && e.message.content.some((b) => b.type === "tool_use"));
    const variants = [
      { key: "a-lastOfTurn1", at: lastOfTurn1.uuid, note: `ターン1の最後の記録 #${chain.indexOf(lastOfTurn1)}（${lastOfTurn1.type}）` },
      { key: "b-lastOfTurn1+dropsTurn", at: lastOfTurn1.uuid, drops: turn2Prompt.uuid, note: `ターン1の最後＋resumeDropsTurn=ターン2の prompt` },
      { key: "c-turn2Prompt", at: turn2Prompt.uuid, note: `ターン2の人の発言 #${idx2}` },
      { key: "d-danglingToolUse", at: danglingToolUse.uuid, note: `ターン2の tool_use の assistant #${chain.indexOf(danglingToolUse)}` },
      { key: "e-lastAssistantOfTurn1", at: lastAssistantOfTurn1.uuid, note: `ターン1の最後の assistant #${chain.indexOf(lastAssistantOfTurn1)}（SDK の stream に出る uuid）` },
      { key: "f-lastAssistantOfTurn1+dropsTurn", at: lastAssistantOfTurn1.uuid, drops: turn2Prompt.uuid, note: `ターン1の最後の assistant＋resumeDropsTurn=ターン2の prompt` },
    ];
    const only = process.argv[4]?.split(",");
    for (const v of variants.filter((v) => !only || only.some((o) => v.key.startsWith(o)))) {
      const name = `A3-${signal}-${v.key}`;
      const d = freshDirs(name);
      cpSync(join(src, "config-after-kill"), d.config, { recursive: true });
      const apiLog = join(d.root, "api.jsonl");
      const api = await startFakeApi({ logFile: apiLog });
      const ctx = { ...d, work: join(src, "work"), api, apiLog, name };
      log(`\n##### ${v.key}: resumeSessionAt=${v.at.slice(0, 8)}（${v.note}）`);
      const t = await turn(ctx, { label: `resume（${v.key}）`, prompt: RESUME_PROMPT, resume: sid, resumeSessionAt: v.at, ...(v.drops ? { resumeDropsTurn: v.drops } : {}) });
      const f1 = findJsonl(d.config, sid);
      log(`--- 元の session の記録（resume 後） ---`);
      dumpJsonl(f1, { from: chain.length, log });
      if (t.sessionId && t.sessionId !== sid) {
        log(`--- resume が使った session ${t.sessionId} の記録 ---`);
        dumpJsonl(findJsonl(d.config, t.sessionId), { log });
      }
      await api.close();
    }
  },
};

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
function require_fs() {
  return createRequire(import.meta.url)("node:fs");
}

if (!cases[caseName]) throw new Error(`case: ${Object.keys(cases).join("|")}`);
await cases[caseName]();
log("\n(done)");
