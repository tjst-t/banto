// B：ACP のエージェント（claude-agent-acp／opencode）を tool の途中で殺し、別プロセスで session/load して続けられるかを測る。
// 使い方: node b-acp.mjs <claude|opencode> [SIGKILL|SIGTERM] [mid-tool|after-new]
//   mid-tool : ターン1を完了 → ターン2の sleep 120 の途中で kill → load → prompt
//   after-new: session/new の直後（prompt を1つも送らないうち）に kill → load → prompt
// モデルは偽の API（fake-api.mjs）。CLI／opencode が API に送った要求を記録する。
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { startFakeApi, summarizeRequest } from "./fake-api.mjs";
import { freshDirs, childEnv, killLikeSystemd, findJsonl, dumpJsonl, sleep, descendants } from "./lib.mjs";

const [agentName = "claude", signal = "SIGKILL", mode = "mid-tool"] = process.argv.slice(2);
const log = (...a) => console.log(...a);
const require = createRequire(import.meta.url);
const RESUME_PROMPT =
  "banto を起こし直したので直前のターンが途中で切れました。続けてください。直前に何をしていて、その結果はどうなったと理解していますか？";

const d = freshDirs(`B-${agentName}-${signal}-${mode}`);
const apiLog = join(d.root, "api.jsonl");
const api = await startFakeApi({ logFile: apiLog });
const env = childEnv({ configDir: d.config, baseUrl: api.url });

function launch() {
  if (agentName === "claude") {
    const dir = dirname(require.resolve("@agentclientprotocol/claude-agent-acp/package.json"));
    return { command: process.execPath, args: [join(dir, "dist", "index.js")], env };
  }
  // opencode：データ・設定の置き場を作業場所の中に分け、anthropic の baseURL を偽の API に向ける
  const dir = dirname(require.resolve("opencode-ai/package.json"));
  const xdg = join(d.root, "xdg");
  const cfg = join(d.root, "opencode.json");
  writeFileSync(
    cfg,
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "anthropic/claude-haiku-4-5",
      provider: { anthropic: { options: { baseURL: `${api.url}/v1`, apiKey: "sk-ant-fake-probe" } } },
      permission: { bash: "allow", edit: "allow" },
      autoupdate: false,
      share: "disabled",
    }),
  );
  return {
    command: join(dir, "bin", "opencode.exe"),
    args: ["acp", "--cwd", d.work],
    env: { ...env, XDG_DATA_HOME: join(xdg, "data"), XDG_CONFIG_HOME: join(xdg, "config"), XDG_CACHE_HOME: join(xdg, "cache"), XDG_STATE_HOME: join(xdg, "state"), OPENCODE_CONFIG: cfg, OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_LSP_DOWNLOAD: "1" },
  };
}

function describeUpdate(u) {
  switch (u.sessionUpdate) {
    case "agent_message_chunk":
    case "user_message_chunk":
    case "agent_thought_chunk":
      return `${u.sessionUpdate} ${u.content.type === "text" ? JSON.stringify(u.content.text.slice(0, 100)) : u.content.type}`;
    case "tool_call":
      return `tool_call id=${u.toolCallId} title=${JSON.stringify(u.title)} kind=${u.kind} status=${u.status}`;
    case "tool_call_update":
      return `tool_call_update id=${u.toolCallId} status=${u.status}${u.content ? " content=" + JSON.stringify(u.content).slice(0, 160) : ""}${u.rawOutput !== undefined ? " rawOutput=" + JSON.stringify(u.rawOutput).slice(0, 160) : ""}`;
    default:
      return u.sessionUpdate;
  }
}

/** 1プロセス起こし、body(ctx, state) を走らせる。killOn が立ったらグループごと殺す */
async function withAgent(label, body) {
  log(`\n=== ${label} ===`);
  const l = launch();
  const child = spawn(l.command, l.args, { cwd: d.work, env: l.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (x) => (stderr = (stderr + x).slice(-3000)));
  const exited = new Promise((_, rej) => child.once("exit", (c, s) => rej(new Error(`agent exited code=${c} signal=${s}`))));
  exited.catch(() => {});
  const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  const state = { phase: "", updates: [], onUpdate: null, killP: null };
  const app = client({ name: "resume-probe" })
    .onNotification(methods.client.session.update, (ctx) => {
      const line = `  [${state.phase}] ${describeUpdate(ctx.params.update)}`;
      state.updates.push(ctx.params.update);
      if (!/available_commands_update|usage_update|config_option_update|current_mode_update|session_info_update/.test(ctx.params.update.sessionUpdate)) log(line);
      state.onUpdate?.(ctx.params.update);
    })
    .onRequest(methods.client.session.requestPermission, async (ctx) => {
      const allow = ctx.params.options.find((o) => o.kind === "allow_once") ?? ctx.params.options.find((o) => o.kind.startsWith("allow"));
      log(`  [${state.phase}] requestPermission ${JSON.stringify(ctx.params.toolCall.title)} → ${allow?.optionId}`);
      return { outcome: { outcome: "selected", optionId: allow.optionId } };
    });
  state.kill = (delayMs) => {
    if (state.killP) return;
    log(`  → ${delayMs}ms 後に ${signal}（agent pid ${child.pid}、プロセスグループごと）`);
    state.killP = sleep(delayMs).then(() => killLikeSystemd(child.pid, signal, { log }));
  };
  try {
    return await Promise.race([exited, app.connectWith(stream, (ctx) => body(ctx, state))]);
  } catch (e) {
    log(`  失敗: ${e.message.split("\n")[0]}`);
    return { error: e };
  } finally {
    if (state.killP) await state.killP;
    else if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await sleep(500);
    }
    const left = descendants(child.pid);
    if (left.length) {
      log(`  !! 残っている: ${left.map((r) => r.pid + " " + r.args.slice(0, 60)).join("; ")} → SIGKILL`);
      for (const r of left) try { process.kill(r.pid, "SIGKILL"); } catch {}
    }
    if (stderr.trim()) log(`  stderr(末尾): ${stderr.trim().slice(-600).replace(/\n/g, "\n          ")}`);
  }
}

const INIT = { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } };
async function prompt(ctx, state, phase, sessionId, text) {
  state.phase = phase;
  const res = await ctx.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] });
  log(`  [${phase}] stopReason=${res.stopReason}`);
  return res;
}

let apiFrom = 0;
function dumpApi(label) {
  const reqs = existsSync(apiLog) ? readFileSync(apiLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  log(`\n--- ${label}: API に送られた要求 ---`);
  for (const r of reqs.slice(apiFrom)) {
    if (!r.path.startsWith("/v1/messages")) continue;
    log(`  API要求 #${r.n} ${r.path} model=${r.model} messages=${r.messages?.length ?? 0} tools=${(r.tools ?? []).length}本`);
    for (const line of summarizeRequest(r)) log(line);
  }
  apiFrom = reqs.length;
}

// 1つ目のプロセス
let sid;
const first = await withAgent(`プロセス1（${mode}）`, async (ctx, state) => {
  const init = await ctx.request(methods.agent.initialize, INIT);
  log(`  agent=${init.agentInfo?.name}@${init.agentInfo?.version} loadSession=${init.agentCapabilities?.loadSession}`);
  state.phase = "new";
  const created = await ctx.request(methods.agent.session.new, { cwd: d.work, mcpServers: [] });
  const sessionId = created.sessionId;
  log(`  session/new → sessionId=${sessionId}`);
  sid = sessionId;
  if (mode === "after-new") {
    state.kill(0);
    await state.killP;
    await new Promise(() => {}); // 殺されて exited で抜ける
  }
  await prompt(ctx, state, "turn1", sessionId, "合言葉は pineapple-42 です。覚えておいてください。");
  state.onUpdate = (u) => {
    if (u.sessionUpdate === "tool_call" || (u.sessionUpdate === "tool_call_update" && u.status === "in_progress")) state.kill(3000);
  };
  await prompt(ctx, state, "turn2", sessionId, "SLEEP_TOOL：sleep 120 を Bash で実行してください。");
  return { sessionId };
});
dumpApi("プロセス1");

// kill 直後の記録（claude は CLAUDE_CONFIG_DIR/projects の jsonl。opencode は XDG_DATA_HOME の中）
log(`\n--- kill 直後の記録（session ${sid}） ---`);
let before = [];
if (agentName === "claude") before = dumpJsonl(findJsonl(d.config, sid), { log });
else dumpOpencodeDb("kill 直後");

// 2つ目のプロセス：initialize → session/load → prompt
await withAgent("プロセス2（load して続ける）", async (ctx, state) => {
  const init = await ctx.request(methods.agent.initialize, INIT);
  log(`  agent=${init.agentInfo?.name}@${init.agentInfo?.version} loadSession=${init.agentCapabilities?.loadSession}`);
  state.phase = "load(再生)";
  const loaded = await ctx.request(methods.agent.session.load, { sessionId: sid, cwd: d.work, mcpServers: [] });
  log(`  session/load 成功（応答のキー: ${Object.keys(loaded ?? {}).join(",")}）`);
  await prompt(ctx, state, "resume", sid, RESUME_PROMPT);
});
dumpApi("プロセス2");
if (agentName === "claude") {
  log(`\n--- load・prompt 後の記録（追加分） ---`);
  dumpJsonl(findJsonl(d.config, sid), { from: before.length, log });
} else dumpOpencodeDb("load・prompt 後");
await api.close();
log("\n(done)");

/** opencode の会話の記録（sqlite の message・part）を要約する */
function dumpOpencodeDb(label) {
  const file = join(d.root, "xdg", "data", "opencode", "opencode.db");
  if (!existsSync(file)) return log(`  ${label}: opencode.db が無い`);
  const db = new DatabaseSync(file, { readOnly: true });
  const sess = db.prepare("select id from session where id = ?").all(sid);
  log(`  ${label}: opencode.db（session 行 ${sess.length}件）`);
  for (const m of db.prepare("select id, data from message where session_id = ? order by time_created, id").all(sid)) {
    const md = JSON.parse(m.data);
    log(`    message ${m.id.slice(-8)} role=${md.role}${md.finish ? " finish=" + md.finish : ""}${md.error ? " error=" + JSON.stringify(md.error).slice(0, 120) : ""}${md.time?.completed ? " completed" : " (completed なし)"}`);
    for (const p of db.prepare("select data from part where message_id = ? order by time_created, id").all(m.id)) {
      const pd = JSON.parse(p.data);
      if (pd.type === "text") log(`      part text ${JSON.stringify(pd.text.slice(0, 70))}`);
      else if (pd.type === "tool") log(`      part tool ${pd.tool} callID=${pd.callID} status=${pd.state?.status}${pd.state?.error ? " error=" + JSON.stringify(pd.state.error).slice(0, 100) : ""}${pd.state?.output ? " output=" + JSON.stringify(pd.state.output).slice(0, 80) : ""}`);
      else log(`      part ${pd.type}`);
    }
  }
  db.close();
}

function listOpencodeData() {
  const out = [];
  const walk = (p, depth) => {
    if (depth > 6 || !existsSync(p)) return;
    for (const f of readdirSync(p, { withFileTypes: true })) {
      const q = join(p, f.name);
      if (f.isDirectory()) walk(q, depth + 1);
      else out.push(q.split("/xdg/")[1]);
    }
  };
  walk(join(d.root, "xdg", "data"), 0);
  return `opencode のデータ: ${out.length}件\n    ${out.slice(0, 40).join("\n    ")}`;
}
