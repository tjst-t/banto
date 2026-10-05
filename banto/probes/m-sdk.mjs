// M1・M2（2026-10-05）：巻き戻したあとの鎖の選び方／最初のターンの記録の有無の見分け
// 使い方: node m-sdk.mjs <M1|M1k-tool|M1k-text|M2a|M2b|M2c|F1|P4>
// モデルは偽の API（fake-api.mjs）。CLI が API に送った要求（＝モデルが見るもの）を記録する。
import { query, getSessionMessages, getSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startFakeApi, summarizeRequest } from "./fake-api.mjs";
import { freshDirs, childEnv, detachedSpawner, killLikeSystemd, findJsonl, dumpJsonl, readJsonl, sleep, descendants } from "./lib.mjs";

const [caseName, signalArg] = process.argv.slice(2);
const signal = signalArg === "SIGTERM" ? "SIGTERM" : "SIGKILL";
const log = (...a) => console.log(...a);

function apiLines(file) {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

/** 要求に入っている TURNn の目印（人の発言の頭）を順に */
function turnMarkers(entry) {
  const out = [];
  for (const m of entry.messages ?? []) {
    if (m.role !== "user") continue;
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    for (const b of blocks) if (b.type === "text") for (const x of b.text.matchAll(/TURN\d+[a-z]?/g)) out.push(x[0]);
  }
  return [...new Set(out)];
}

/** 1ターン走らせる。killOn(m, state) が真を返したら（killDelayMs 後に）CLI をグループごと signal（SIGTERM なら 5 秒後に残りを SIGKILL） */
async function turn(ctx, { label, prompt, resume, resumeSessionAt, killOn, killDelayMs = 3000, partial = false, sessionId, forkSession, extraEnv }) {
  log(`\n=== ${label} ===`);
  log(`  options: ${JSON.stringify({ resume, resumeSessionAt, sessionId, forkSession, ...(extraEnv ? { extraEnv } : {}) })}`);
  const apiFrom = apiLines(ctx.apiLog).length;
  const h = {};
  let closeInput;
  const keepOpen = new Promise((r) => (closeInput = r));
  async function* promptStream() {
    yield { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null };
    await keepOpen;
  }
  const state = { textDeltas: 0, sessionId: undefined, killed: false, msgs: [], results: [] };
  let killP;
  const q = query({
    prompt: promptStream(),
    options: {
      cwd: ctx.work,
      model: "claude-haiku-4-5",
      env: { ...childEnv({ configDir: ctx.config, baseUrl: ctx.api.url }), ...(extraEnv ?? {}) },
      settingSources: [],
      strictMcpConfig: true,
      tools: ["Bash"],
      allowedTools: ["Bash"],
      ...(resume ? { resume } : {}),
      ...(resumeSessionAt ? { resumeSessionAt } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(forkSession ? { forkSession: true } : {}),
      includePartialMessages: partial,
      spawnClaudeCodeProcess: detachedSpawner(h),
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
        state.msgs.push({ type: m.type, uuid: m.uuid });
        const c = m.message.content;
        const desc = typeof c === "string" ? `text:${JSON.stringify(c.slice(0, 80))}` : c.map((b) => (b.type === "text" ? `text:${JSON.stringify(b.text.slice(0, 80))}` : b.type === "tool_use" ? `tool_use(${b.name})` : b.type === "tool_result" ? `tool_result(is_error=${b.is_error ?? false})` : b.type)).join(" | ");
        log(`  ${m.type} uuid=${m.uuid} ${desc}`);
      } else if (m.type === "result") {
        state.results.push(m);
        if (m.subtype === "success") log(`  result subtype=success session_id=${m.session_id} result=${JSON.stringify(m.result.slice(0, 160))}`);
        // 失敗の結果は形のまま全部（M2）
        else log(`  result（全体）: ${JSON.stringify(m)}`);
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
    log(`  query が投げた: ${JSON.stringify(e.message)}`);
  }
  closeInput();
  if (killP) await killP;
  await sleep(300);
  if (h.pid) {
    const left = descendants(h.pid);
    if (left.length) log(`  !! まだ残っている: ${left.map((r) => r.pid + " " + r.args).join("; ")}`);
  }
  if (!state.killed && (error || state.results.some((r) => r.subtype !== "success"))) log(`  stderr（末尾）: ${JSON.stringify(h.stderr?.slice(-1500) ?? "")}`);
  const reqs = apiLines(ctx.apiLog).slice(apiFrom).filter((r) => r.path?.startsWith("/v1/messages") && !r.path.includes("count_tokens"));
  for (const r of reqs) {
    log(`  API要求 #${r.n} messages=${r.messages?.length ?? 0}  入っている発言の目印=${JSON.stringify(turnMarkers(r))}`);
    for (const line of summarizeRequest(r)) log(line);
  }
  if (!reqs.length) log(`  API要求: 無し`);
  return { ...state, error, reqs };
}

async function setup(name) {
  const d = freshDirs(name);
  const apiLog = join(d.root, "api.jsonl");
  const api = await startFakeApi({ logFile: apiLog });
  return { ...d, api, apiLog, name };
}

/** 同じ時点の記録から別々に試すため、config を写した ctx を作る（work は同じパス＝記録の置き場が同じ） */
function branchCtx(ctx, tag) {
  const config = join(ctx.root, `config-${tag}`);
  cpSync(ctx.config, config, { recursive: true });
  return { ...ctx, config };
}

/** SDK の公式の口で会話の鎖を読む（banto の findRewindBeforePrompt と同じ口） */
async function sdkChain(ctx, sid, label) {
  process.env.CLAUDE_CONFIG_DIR = ctx.config;
  const msgs = await getSessionMessages(sid, { dir: ctx.work });
  const info = await getSessionInfo(sid, { dir: ctx.work });
  log(`  getSessionMessages（${label}）: ${msgs.length} 件 → ${msgs.map((m) => `${m.type}:${m.uuid.slice(0, 8)}${(() => { const c = m.message?.content; const t = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join(" ") : ""; const mk = t.match(/TURN\d+/); return mk ? `(${mk[0]})` : ""; })()}`).join(" ")}`);
  log(`  getSessionInfo（${label}）: ${info === undefined ? "undefined" : JSON.stringify(info).slice(0, 300)}`);
  return msgs;
}

const lastAssistant = (t) => [...t.msgs].reverse().find((m) => m.type === "assistant")?.uuid;

/** M1 の前半：ターン1・ターン2（tool あり）を完了させる */
async function turns12(ctx) {
  const t1 = await turn(ctx, { label: "ターン1（完了）", prompt: "TURN1：合言葉は pineapple-42 です。覚えておいてください。" });
  const sid = t1.sessionId;
  const t2 = await turn(ctx, { label: "ターン2（完了、tool あり）", prompt: "TURN2 QUICK_TOOL：echo を Bash で実行してください。", resume: sid });
  const at = lastAssistant(t1);
  log(`\n  ターン1の最後の assistant の uuid = ${at}`);
  return { sid, at, t2 };
}

const cases = {
  // 1→2→（ターン1の最後で切って）3→（切らずに）4
  async M1() {
    const ctx = await setup("M1");
    const { sid, at } = await turns12(ctx);
    await turn(ctx, { label: "ターン3（resumeSessionAt＝ターン1の最後の assistant、完了）", prompt: "TURN3：新しい鎖です。", resume: sid, resumeSessionAt: at });
    log(`\n--- ターン3のあとの記録 ---`);
    const before = dumpJsonl(findJsonl(ctx.config, sid), { log });
    await sdkChain(ctx, sid, "ターン3のあと");
    const t4 = await turn(ctx, { label: "ターン4（resumeSessionAt 無し）", prompt: "TURN4：どの鎖から続いていますか。", resume: sid });
    log(`\n--- ターン4で足された記録 ---`);
    dumpJsonl(findJsonl(ctx.config, sid), { from: before.length, log });
    await sdkChain(ctx, sid, "ターン4のあと");
    const mk = t4.reqs[0] ? turnMarkers(t4.reqs[0]) : [];
    log(`\n  判定: ターン4の最初の要求の目印=${JSON.stringify(mk)} → ターン2が${mk.includes("TURN2") ? "入っている" : "入っていない"}、ターン3が${mk.includes("TURN3") ? "入っている" : "入っていない"}`);
    await ctx.api.close();
  },
  // M1 と同じく 3 まで完了させ、記録の最後の last-prompt（ターン3の葉を指す）だけを消してから切らずに resume
  // ——CLI が last-prompt の leafUuid を辿っているなら、ターン2の鎖に戻るはず
  async M1x() {
    const ctx = await setup("M1x");
    const { sid, at } = await turns12(ctx);
    await turn(ctx, { label: "ターン3（resumeSessionAt＝ターン1の最後の assistant、完了）", prompt: "TURN3：新しい鎖です。", resume: sid, resumeSessionAt: at });
    const file = findJsonl(ctx.config, sid);
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    const idx = lines.map((l) => JSON.parse(l).type).lastIndexOf("last-prompt");
    log(`\n  消す行 #${idx}: ${lines[idx].slice(0, 200)}`);
    writeFileSync(file, lines.filter((_, i) => i !== idx).join("\n") + "\n");
    await sdkChain(ctx, sid, "last-prompt を1行消したあと");
    const t4 = await turn(ctx, { label: "ターン4（resumeSessionAt 無し）", prompt: "TURN4：どの鎖から続いていますか。", resume: sid });
    log(`\n  判定: 目印=${JSON.stringify(t4.reqs[0] ? turnMarkers(t4.reqs[0]) : null)}`);
    await ctx.api.close();
  },
  // 1→2→（ターン1の最後で切って）3 を途中で SIGKILL →（a）切らずに resume／（b）同じ resumeSessionAt を渡して resume
  async "M1k-tool"() {
    await m1k("tool", { prompt: "TURN3 SLEEP_TOOL：sleep 120 を Bash で実行してください。", killOn: (m) => m.type === "assistant" && m.message.content.some((b) => b.type === "tool_use") });
  },
  async "M1k-text"() {
    await m1k("text", { prompt: "TURN3 LONG_TEXT：長い文を書いてください。", partial: true, killDelayMs: 0, killOn: (m, s) => s.textDeltas >= 30 });
  },

  // M1k-<tool|text>（SIGKILL）の kill 直後の記録を写し、resumeSessionAt＝getSessionMessages が返す鎖の最後の uuid で resume
  // ——SDK の読む口が辿る新しい鎖（切れたターン3）を、CLI にも続けさせられるか
  async M1leaf() {
    const tag = process.argv[3] === "text" ? "text" : "tool";
    const src = join(freshDirs("M1leaf-dummy").root, "..", `M1k-${tag}`);
    const d = freshDirs(`M1leaf-${tag}`);
    cpSync(join(src, "config"), d.config, { recursive: true });
    const apiLog = join(d.root, "api.jsonl");
    const api = await startFakeApi({ logFile: apiLog });
    const ctx = { ...d, work: join(src, "work"), api, apiLog };
    const { readdirSync } = await import("node:fs");
    const sub = readdirSync(join(d.config, "projects"))[0];
    const sid = readdirSync(join(d.config, "projects", sub)).find((f) => f.endsWith(".jsonl")).replace(".jsonl", "");
    const before = readJsonl(findJsonl(d.config, sid)).length;
    const chain = await sdkChain(ctx, sid, "resume 前");
    const leaf = chain.at(-1);
    log(`  resumeSessionAt に渡す：getSessionMessages の最後 ${leaf.type}:${leaf.uuid}`);
    const t = await turn(ctx, { label: "ターン4：resumeSessionAt＝新しい鎖の最後", prompt: "TURN4：続けてください。", resume: sid, resumeSessionAt: leaf.uuid });
    dumpJsonl(findJsonl(d.config, sid), { from: before, log, label: "足された" });
    log(`  判定: 目印=${JSON.stringify(t.reqs[0] ? turnMarkers(t.reqs[0]) : null)}`);
    await api.close();
  },
  // M3（host に SIGTERM）で残った記録を、写してから切らずに resume する——SIGTERM の CLI が書いた「Exit code 137」の
  // tool_result（last-prompt の葉より後ろ）が API の要求に入るか
  async R3() {
    const src = join(freshDirs("R3-dummy").root, "..", "M3-SIGTERM-15000");
    const d = freshDirs("R3");
    cpSync(join(src, "config"), d.config, { recursive: true });
    const apiLog = join(d.root, "api.jsonl");
    const api = await startFakeApi({ logFile: apiLog });
    const ctx = { ...d, work: join(src, "work"), api, apiLog };
    const { readdirSync } = await import("node:fs");
    const sub = readdirSync(join(d.config, "projects"))[0];
    const sid = readdirSync(join(d.config, "projects", sub)).find((f) => f.endsWith(".jsonl")).replace(".jsonl", "");
    const before = readJsonl(findJsonl(d.config, sid)).length;
    await sdkChain(ctx, sid, "resume 前");
    await turn(ctx, { label: "resume（切らずに）", prompt: "TURN2：続けてください。", resume: sid });
    dumpJsonl(findJsonl(d.config, sid), { from: before, log, label: "足された" });
    await api.close();
  },
  // init を受けた瞬間に kill（記録が無い）→ resume。結果メッセージの形を全部残す
  async M2a() {
    const ctx = await setup("M2a");
    const sid = randomUUID();
    log(`呼ぶ側で決めた session id: ${sid}`);
    const t = await turn(ctx, { label: "ターン1（init で即 SIGKILL）", prompt: "TURN1：合言葉は pineapple-42。", sessionId: sid, killDelayMs: 0, killOn: (m) => m.type === "system" && m.subtype === "init" });
    log(`  init の session id ${t.sessionId === sid ? "＝" : "≠"} 渡した id`);
    const file = findJsonl(ctx.config, sid);
    dumpJsonl(file, { log, label: "kill 直後の" });
    await sdkChain(ctx, sid, "kill 直後");
    const snap = branchCtx(ctx, "after-kill");
    await turn(ctx, { label: "resume（既定の env）", prompt: "TURN2：続けてください。", resume: sid });
    await turn(branchCtx(snap, "startupfail"), { label: "resume（CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1）", prompt: "TURN2：続けてください。", resume: sid, extraEnv: { CLAUDE_CODE_STARTUP_FAILURE_RESULTS: "1" } });
    // 比べる：一度も使っていない id を resume
    const never = randomUUID();
    await turn(ctx, { label: `比較：一度も使っていない id（${never}）を resume`, prompt: "TURN2：続けてください。", resume: never });
    await ctx.api.close();
  },
  // init を受けた瞬間に kill（記録が無い）→ 同じ sessionId を渡して、新しい会話として最初から
  async M2b() {
    const ctx = await setup("M2b");
    const sid = randomUUID();
    log(`呼ぶ側で決めた session id: ${sid}`);
    await turn(ctx, { label: "ターン1（init で即 SIGKILL）", prompt: "TURN1：合言葉は pineapple-42。", sessionId: sid, killDelayMs: 0, killOn: (m) => m.type === "system" && m.subtype === "init" });
    dumpJsonl(findJsonl(ctx.config, sid), { log, label: "kill 直後の" });
    const t = await turn(ctx, { label: "ターン1をやり直す（同じ sessionId、resume 無し）", prompt: "TURN1b：合言葉は pineapple-42。", sessionId: sid });
    log(`  init の session id ${t.sessionId === sid ? "＝" : "≠"} 渡した id`);
    const after = dumpJsonl(findJsonl(ctx.config, sid), { log, label: "やり直し後の" });
    await turn(ctx, { label: "ターン2（resume）", prompt: "TURN2：合言葉は何でしたか。", resume: sid });
    dumpJsonl(findJsonl(ctx.config, sid), { from: after.length, log, label: "ターン2で足された" });
    await ctx.api.close();
  },
  // 記録がある（最初のターンを tool の途中で kill）のに、同じ sessionId を渡して新しい会話として走らせたら
  async M2c() {
    const ctx = await setup("M2c");
    const sid = randomUUID();
    log(`呼ぶ側で決めた session id: ${sid}`);
    await turn(ctx, { label: "ターン1（tool の途中で SIGKILL）", prompt: "TURN1 SLEEP_TOOL：合言葉は pineapple-42。", sessionId: sid, killOn: (m) => m.type === "assistant" && m.message.content.some((b) => b.type === "tool_use") });
    const before = dumpJsonl(findJsonl(ctx.config, sid), { log, label: "kill 直後の" });
    await sdkChain(ctx, sid, "kill 直後");
    await turn(ctx, { label: "同じ sessionId で新しい会話として（resume 無し）", prompt: "TURN1b：合言葉は pineapple-42。", sessionId: sid });
    dumpJsonl(findJsonl(ctx.config, sid), { from: before.length, log, label: "足された" });
    await ctx.api.close();
  },
  // F1（2026-10-05、Fable のレビュー）：forkSession と一緒に sessionId を渡すと、分けた先の会話がその id になるか。
  // 新しい会話の sessionId も同じく見る。init の id・記録ファイルの名前・親の記録が変わらないか・引き継いだ中身
  async F1() {
    const ctx = await setup("F1");
    const lineCount = (sid) => { const f = findJsonl(ctx.config, sid); return f ? readJsonl(f).length : 0; };
    const A = randomUUID();
    log(`新しい会話に渡す id A=${A}`);
    const t1 = await turn(ctx, { label: "ターン1（新しい会話、sessionId=A）", prompt: "TURN1：合言葉は pineapple-42。", sessionId: A });
    log(`  判定: init の id ${t1.sessionId === A ? "＝" : "≠"} A ／ 記録ファイル ${findJsonl(ctx.config, A) ? "A.jsonl がある" : "A.jsonl が無い"}`);
    await sdkChain(ctx, A, "ターン1のあと");
    const parentLines = lineCount(A);

    const F = randomUUID();
    log(`\nFork に渡す id F=${F}`);
    const t2 = await turn(ctx, { label: "ターン2（resume A・forkSession・sessionId=F）", prompt: "TURN2：分けた先です。合言葉は？", resume: A, forkSession: true, sessionId: F });
    log(`  判定: init の id ${t2.sessionId === F ? "＝" : "≠"} F ／ 記録ファイル ${findJsonl(ctx.config, F) ? "F.jsonl がある" : "F.jsonl が無い"} ／ 親 A の記録 ${lineCount(A) === parentLines ? "変わらない" : `変わった（${parentLines}→${lineCount(A)} 行）`}`);
    log(`  判定: ターン2の最初の要求の目印=${JSON.stringify(t2.reqs[0] ? turnMarkers(t2.reqs[0]) : null)}（TURN1 が入っていれば親の会話を引き継いでいる）`);
    await sdkChain(ctx, F, "ターン2のあと（F）");

    const t3 = await turn(ctx, { label: "ターン3（resume F、sessionId 無し）", prompt: "TURN3：続きです。", resume: F });
    log(`  判定: init の id ${t3.sessionId === F ? "＝" : "≠"} F ／ 目印=${JSON.stringify(t3.reqs[0] ? turnMarkers(t3.reqs[0]) : null)}`);

    // Fork の最初のターンが init の直後に切れた（M2 の Fork 版）——記録があるか、同じ id でやり直せるか
    const G = randomUUID();
    log(`\nFork に渡す id G=${G}`);
    const t4 = await turn(ctx, { label: "ターン4（resume A・forkSession・sessionId=G、init で即 SIGKILL）", prompt: "TURN4：切れる Fork。", resume: A, forkSession: true, sessionId: G, killDelayMs: 0, killOn: (m) => m.type === "system" && m.subtype === "init" });
    log(`  判定: init の id ${t4.sessionId === G ? "＝" : "≠"} G ／ 記録ファイル ${findJsonl(ctx.config, G) ? "G.jsonl がある" : "G.jsonl が無い"}`);
    await sdkChain(ctx, G, "ターン4の kill 後");
    const t5 = await turn(ctx, { label: "ターン4をやり直す（resume A・forkSession・同じ sessionId=G）", prompt: "TURN4b：やり直した Fork。", resume: A, forkSession: true, sessionId: G });
    log(`  判定: init の id ${t5.sessionId === G ? "＝" : "≠"} G ／ 結果 ${t5.results.map((r) => r.subtype).join(",") || "無し"} ／ 目印=${JSON.stringify(t5.reqs[0] ? turnMarkers(t5.reqs[0]) : null)}`);
    const t6 = await turn(ctx, { label: "G を resume（forkSession 無し）", prompt: "TURN4c：G の続き。", resume: G });
    log(`  判定: init の id ${t6.sessionId === G ? "＝" : "≠"} G ／ 結果 ${t6.results.map((r) => r.subtype).join(",") || "無し"} ／ 目印=${JSON.stringify(t6.reqs[0] ? turnMarkers(t6.reqs[0]) : null)}`);
    const H = randomUUID();
    const t7 = await turn(ctx, { label: `新しい id で分け直す（resume A・forkSession・sessionId=H=${H}）`, prompt: "TURN4d：分け直した Fork。", resume: A, forkSession: true, sessionId: H });
    log(`  判定: init の id ${t7.sessionId === H ? "＝" : "≠"} H ／ 結果 ${t7.results.map((r) => r.subtype).join(",") || "無し"} ／ 目印=${JSON.stringify(t7.reqs[0] ? turnMarkers(t7.reqs[0]) : null)}`);

    // 窓の大きさ：Fork の最初のターンを init で即 SIGKILL したとき、記録ファイルと getSessionInfo がどうなるかを数える
    const n = Number(process.argv[3] ?? 5);
    let file = 0, info = 0;
    for (let i = 0; i < n; i++) {
      const id = randomUUID();
      await turn(ctx, { label: `#${i + 1} Fork を init で即 SIGKILL`, prompt: "TURN9：x", resume: A, forkSession: true, sessionId: id, killDelayMs: 0, killOn: (m) => m.type === "system" && m.subtype === "init" });
      const f = findJsonl(ctx.config, id);
      if (f) file++;
      process.env.CLAUDE_CONFIG_DIR = ctx.config;
      const got = await getSessionInfo(id, { dir: ctx.work });
      if (got !== undefined) info++;
      log(`  記録ファイル: ${f ? `ある（${readJsonl(f).map((l) => l.type).join(",")}）` : "無い"} ／ getSessionInfo: ${got === undefined ? "undefined" : "ある"}`);
    }
    log(`\n  判定: Fork を init で切った ${n} 回中、記録ファイルがあった ${file} 回・getSessionInfo が返した ${info} 回`);
    await ctx.api.close();
  },
  // P4（2026-10-05、Fable のレビュー 4）：本物の CLI の記録で、続ける処理（planContinuation）が「切れたとき実行中だった
  // 呼び出し」を正しく拾うか。banto の dist の planContinuation を、SDK の本物の読み口（sdkSessionReader）のまま呼ぶ
  //   L：線形の会話で、ターン2を Bash の途中で SIGKILL
  //   R1：巻き戻しの上（resumeSessionAt＝ターン1の最後）のターン2を Bash の途中で SIGKILL
  //   R2：R1 の続きのターン3（同じ resumeSessionAt）を、CLI が何も書く前（init）で SIGKILL——鎖はターン2のまま
  async P4() {
    const { planContinuation } = await import("../packages/core/dist/delivery/turn-continuation.js");
    const plan = async (ctx, label, { sid, rewindTo, sent }) => {
      process.env.CLAUDE_CONFIG_DIR = ctx.config;
      const thread = { id: "t", projectId: "p", ownsSession: true, resumePoint: sid, messages: [{ seq: 2, role: "user", text: sent }], deliveries: [] };
      const turn = { threadId: "t", turnId: "x", startedSeq: 1, stackedMessages: 1, startedAt: new Date().toISOString(), cause: "human", attempt: 0, sessionId: sid, resumePoint: sid, ...(rewindTo ? { rewindTo } : {}), hop: 0, fromSeq: 1 };
      const deps = {
        projectThread: { getThread: () => thread, getProject: () => ({ root: ctx.work }) },
        inbox: { listJudgmentsForThread: () => [] },
      };
      const out = await planContinuation(deps, turn);
      const lines = out.text.split("\n\n").filter((l) => /実行中だった呼び出し|入れ直します/.test(l));
      log(`  planContinuation（${label}）: ${lines.map((l) => JSON.stringify(l.slice(0, 110))).join("\n                              ")}`);
      return out.text;
    };
    const atTool = (m) => m.type === "assistant" && m.message.content.some((b) => b.type === "tool_use");
    const atInit = (m) => m.type === "system" && m.subtype === "init";

    const L = await setup("P4-L");
    const l1 = await turn(L, { label: "L ターン1（完了）", prompt: "TURN1：合言葉は pineapple-42 です。" });
    const lSent = "TURN2 SLEEP_TOOL：sleep 120 を Bash で実行してください。";
    await turn(L, { label: "L ターン2（Bash の途中で SIGKILL）", prompt: lSent, resume: l1.sessionId, killOn: atTool });
    dumpJsonl(findJsonl(L.config, l1.sessionId), { log, label: "L kill 後の" });
    await sdkChain(L, l1.sessionId, "L kill 後");
    await plan(L, "L", { sid: l1.sessionId, sent: lSent });
    await L.api.close();

    const R = await setup("P4-R");
    const r1 = await turn(R, { label: "R ターン1（完了）", prompt: "TURN1：合言葉は pineapple-42 です。" });
    const at = lastAssistant(r1);
    const sid = r1.sessionId;
    const r2Sent = "TURN2 SLEEP_TOOL：sleep 120 を Bash で実行してください。";
    await turn(R, { label: "R1 ターン2（resumeSessionAt＝ターン1の最後、Bash の途中で SIGKILL）", prompt: r2Sent, resume: sid, resumeSessionAt: at, killOn: atTool });
    const afterR1 = dumpJsonl(findJsonl(R.config, sid), { log, label: "R1 kill 後の" });
    await sdkChain(R, sid, "R1 kill 後");
    await plan(R, "R1", { sid, rewindTo: at, sent: r2Sent });
    const r3Sent = "TURN3：banto を起こし直したため、直前のターンが途中で切れました。続きをお願いします。";
    await turn(R, { label: "R2 ターン3（同じ resumeSessionAt、init で即 SIGKILL）", prompt: r3Sent, resume: sid, resumeSessionAt: at, killDelayMs: 0, killOn: atInit });
    dumpJsonl(findJsonl(R.config, sid), { log, from: afterR1.length, label: "R2 kill 後に足された" });
    await sdkChain(R, sid, "R2 kill 後");
    await plan(R, "R2", { sid, rewindTo: at, sent: r3Sent });
    // 比べる：巻き戻しの印が無いと読んだら（＝この直しの前の拾い方）
    await plan(R, "R2 を巻き戻し無しとして読んだら（直しの前の拾い方）", { sid, sent: r3Sent });
    await R.api.close();
  },
  // init 直後の kill で、記録ファイルがあるかを何回か数える（窓の大きさの目安）
  async M2n() {
    const ctx = await setup("M2n");
    const n = Number(process.argv[4] ?? 5);
    let present = 0;
    for (let i = 0; i < n; i++) {
      const sid = randomUUID();
      await turn(ctx, { label: `#${i + 1} init で即 SIGKILL`, prompt: "TURN1：x", sessionId: sid, killDelayMs: 0, killOn: (m) => m.type === "system" && m.subtype === "init" });
      const f = findJsonl(ctx.config, sid);
      if (f) present++;
      log(`  記録ファイル: ${f ? "ある" : "無い"}`);
    }
    log(`\n  ${n} 回中 ${present} 回、記録ファイルがあった`);
    await ctx.api.close();
  },
};

async function m1k(tag, t3opts) {
  const ctx = await setup(`M1k-${tag}-${signal}`);
  const { sid, at } = await turns12(ctx);
  await turn(ctx, { label: `ターン3（resumeSessionAt＝ターン1の最後の assistant、途中で ${signal}）`, resume: sid, resumeSessionAt: at, ...t3opts });
  log(`\n--- ターン3を kill したあとの記録 ---`);
  const before = dumpJsonl(findJsonl(ctx.config, sid), { log });
  await sdkChain(ctx, sid, "kill 後");
  const a = branchCtx(ctx, "a-plain");
  const b = branchCtx(ctx, "b-keepAt");
  const ta = await turn(a, { label: "（a）ターン4：resumeSessionAt 無し", prompt: "TURN4：続けてください。", resume: sid });
  log(`--- （a）で足された記録 ---`);
  dumpJsonl(findJsonl(a.config, sid), { from: before.length, log });
  const tb = await turn(b, { label: "（b）ターン4：同じ resumeSessionAt（ターン1の最後の assistant）を渡す", prompt: "TURN4：続けてください。", resume: sid, resumeSessionAt: at });
  log(`--- （b）で足された記録 ---`);
  dumpJsonl(findJsonl(b.config, sid), { from: before.length, log });
  for (const [k, t] of [["a", ta], ["b", tb]]) log(`  判定（${k}）: 最初の要求の目印=${JSON.stringify(t.reqs[0] ? turnMarkers(t.reqs[0]) : null)}`);
  await ctx.api.close();
}

if (!cases[caseName]) throw new Error(`case: ${Object.keys(cases).join("|")}`);
await cases[caseName]();
log("\n(done)");
