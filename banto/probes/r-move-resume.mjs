// runtime-move（Backlog #262）：作業ディレクトリ A で作った会話の記録（<id>.jsonl と <id>/）を
// 作業ディレクトリ B のフォルダへ写したとき、B で resume・resumeSessionAt・forkSession が通るかを測る。
// 使い方: node probes/r-move-resume.mjs [copy|nocopy]（既定 copy）
// モデルは偽の API（fake-api.mjs）。CLI・SDK は本物（banto が使っている版）。
import { query } from "@anthropic-ai/claude-agent-sdk";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { startFakeApi, summarizeRequest } from "./fake-api.mjs";
import { childEnv, detachedSpawner, readJsonl } from "./lib.mjs";

const log = (...a) => console.log(...a);
const COPY = (process.argv[2] ?? "copy") === "copy";
const root = mkdtempSync(join(tmpdir(), "banto-move-resume-"));
const config = join(root, "config");
const A = join(root, "rootA", "work");
const B = join(root, "runner-cwd", "proj-1");
for (const d of [config, A, B]) mkdirSync(d, { recursive: true });
const apiLog = join(root, "api.jsonl");
const api = await startFakeApi({ logFile: apiLog });

const nm = join(import.meta.dirname, "..", "node_modules", "@anthropic-ai");
const sdkPkg = JSON.parse(readFileSync(join(nm, "claude-agent-sdk", "package.json"), "utf8"));
const cliBin = join(nm, "claude-agent-sdk-linux-x64", "claude");
log(`SDK ${sdkPkg.version}（claudeCodeVersion ${sdkPkg.claudeCodeVersion}）、CLI ${execFileSync(cliBin, ["--version"], { encoding: "utf8" }).trim()}`);
log(`A=${A}\nB=${B}`);

const apiLines = () => (existsSync(apiLog) ? readFileSync(apiLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
// CLI がフォルダの名前にする形（英数字以外を - に）。実際のフォルダと合うかは下で確かめる
const encode = (p) => p.replace(/[^a-zA-Z0-9]/g, "-");
const projDir = (cwd) => join(config, "projects", encode(cwd));

async function turn({ label, cwd, prompt, resume, resumeSessionAt, forkSession }) {
  log(`\n=== ${label}（cwd=${cwd === A ? "A" : "B"}${resume ? ` resume=${resume.slice(0, 8)}` : ""}${resumeSessionAt ? ` at=${resumeSessionAt.slice(0, 8)}` : ""}${forkSession ? " fork" : ""}） ===`);
  const apiFrom = apiLines().length;
  const h = {};
  let closeInput;
  const keepOpen = new Promise((r) => (closeInput = r));
  async function* promptStream() {
    yield { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null };
    await keepOpen;
  }
  const out = { sessionId: undefined, assistants: [], result: undefined, error: undefined };
  const q = query({
    prompt: promptStream(),
    options: {
      cwd,
      model: "claude-haiku-4-5",
      env: childEnv({ configDir: config, baseUrl: api.url }),
      settingSources: [],
      strictMcpConfig: true,
      tools: ["Bash", "Agent"],
      allowedTools: ["Bash", "Agent"],
      ...(resume ? { resume } : {}),
      ...(resumeSessionAt ? { resumeSessionAt } : {}),
      ...(forkSession ? { forkSession } : {}),
      spawnClaudeCodeProcess: detachedSpawner(h),
    },
  });
  try {
    for await (const m of q) {
      if (m.type === "system" && m.subtype === "init") out.sessionId = m.session_id;
      else if (m.type === "assistant" && !m.parent_tool_use_id) {
        out.assistants.push(m.uuid);
        const c = m.message.content.map((b) => (b.type === "text" ? `text:${JSON.stringify(b.text.slice(0, 70))}` : b.type === "tool_use" ? `tool_use(${b.name})` : b.type)).join(" | ");
        log(`  assistant uuid=${m.uuid.slice(0, 8)} ${c}`);
      } else if (m.type === "result") {
        out.result = m;
        log(`  result ${m.subtype} is_error=${m.is_error} session_id=${m.session_id} ${m.subtype === "success" ? JSON.stringify(m.result.slice(0, 120)) : JSON.stringify(m.errors)}`);
        closeInput();
      }
    }
  } catch (e) {
    out.error = e;
    log(`  query が投げた: ${e.message.split("\n")[0]}`);
    log(`  stderr: ${(h.stderr ?? "").slice(-600)}`);
  }
  closeInput();
  out.requests = apiLines().slice(apiFrom);
  // 本筋（サブエージェントでない）の最後の要求＝モデルが見た履歴
  const main = out.requests.filter((r) => (r.messages ?? []).some((m) => JSON.stringify(m.content).includes(prompt.slice(0, 20))));
  out.lastMain = main.at(-1);
  if (out.lastMain) {
    log(`  モデルが見た履歴（API要求 #${out.lastMain.n}）:`);
    for (const l of summarizeRequest(out.lastMain)) log(l);
  }
  return out;
}

const seen = (req, word) => JSON.stringify(req?.messages ?? []).includes(word);
const results = {};

// --- A で会話を作る：1ターン目でサブエージェント、2ターン目で文だけ ---
const t1 = await turn({ label: "A-1（サブエージェントを起こす）", cwd: A, prompt: "first: 合言葉は apple-17。AGENT_TOOL" });
const sid = t1.sessionId;
const t2 = await turn({ label: "A-2", cwd: A, prompt: "second: 合言葉は banana-29", resume: sid });
const cutAt = t1.assistants.at(-1); // 1ターン目の最後の assistant（ここで切ると second は消える）

const srcDir = projDir(A);
log(`\nA のフォルダ ${srcDir}: ${existsSync(srcDir) ? readdirSync(srcDir).join(", ") : "無い（名前の付け方が想定と違う）"}`);
log(`  ${sid}/ の中: ${existsSync(join(srcDir, sid)) ? execFileSync("find", [join(srcDir, sid), "-type", "f"], { encoding: "utf8" }).trim().replaceAll(srcDir + "/", "") : "無い"}`);

// --- 写す：<id>.jsonl と <id>/ だけ（フォルダ丸ごとは写さない）。元は残す ---
// nocopy では写さない（CLI が別の作業ディレクトリのフォルダまで探しに行くかの対照）
const dstDir = projDir(B);
const srcFile = join(srcDir, `${sid}.jsonl`);
const dstFile = join(dstDir, `${sid}.jsonl`);
const lines = (f) => (existsSync(f) ? readJsonl(f).length : 0);
if (COPY) {
  mkdirSync(dstDir, { recursive: true });
  cpSync(srcFile, dstFile);
  if (existsSync(join(srcDir, sid))) cpSync(join(srcDir, sid), join(dstDir, sid), { recursive: true });
  log(`\n写した: ${sid}.jsonl（${lines(dstFile)}行）と ${sid}/ → ${dstDir}`);
} else log(`\n写さない（nocopy）。B のフォルダ: ${existsSync(dstDir) ? "ある" : "無い"}`);

// 各段で、A・B どちらの記録に足されたか
async function step(name, args, check) {
  const before = { A: lines(srcFile), B: lines(dstFile) };
  const r = await turn({ ...args, cwd: B });
  const appended = { A: lines(srcFile) - before.A, B: lines(dstFile) - before.B };
  results[name] = { ok: !r.error && r.result?.subtype === "success" && check(r), sessionId: r.sessionId, appended, error: r.error?.message.split("\n")[0] };
  return r;
}

// --- 1. resume ---
await step("resume", { label: "B-resume", prompt: "third: 前の合言葉を2つ言って", resume: sid }, (r) => r.sessionId === sid && seen(r.lastMain, "apple-17") && seen(r.lastMain, "banana-29"));
// --- 2. resumeSessionAt（1ターン目の最後で切る：second・third は見えないはず） ---
await step("resumeSessionAt", { label: "B-resumeSessionAt", prompt: "fourth: 取り消し後", resume: sid, resumeSessionAt: cutAt }, (r) => seen(r.lastMain, "apple-17") && !seen(r.lastMain, "banana-29") && !seen(r.lastMain, "third:"));
// --- 3. forkSession（新しい id、切った後の履歴が見える） ---
const r3 = await step("forkSession", { label: "B-forkSession", prompt: "fifth: 分けた先", resume: sid, forkSession: true }, (r) => r.sessionId !== sid && seen(r.lastMain, "apple-17") && seen(r.lastMain, "fourth:"));
results.forkSession.forkFile = { inB: existsSync(join(dstDir, `${r3.sessionId}.jsonl`)), inA: existsSync(join(srcDir, `${r3.sessionId}.jsonl`)) };
// --- 4. 分けた先を B で続ける（Fork の2ターン目） ---
if (r3.sessionId && r3.sessionId !== sid) {
  const r4 = await turn({ label: "B-fork の続き", cwd: B, prompt: "sixth: 分けた先の続き", resume: r3.sessionId });
  results.forkContinue = { ok: !r4.error && r4.result?.subtype === "success" && r4.sessionId === r3.sessionId && seen(r4.lastMain, "fifth:") && seen(r4.lastMain, "apple-17") };
}
const cwds = (f) => [...new Set((existsSync(f) ? readJsonl(f) : []).map((e) => e.cwd).filter(Boolean))].map((c) => (c === A ? "A" : c === B ? "B" : c));
results.cwdFields = { A: cwds(srcFile), B: cwds(dstFile) };

if (COPY) log(`\n記録の中の元の根: B の ${sid}.jsonl に A のパスが ${readFileSync(dstFile, "utf8").split(A).length - 1} 箇所`);
log(`\n=== 結果 ===\n${JSON.stringify(results, null, 2)}`);
log(`作業場所: ${root}`);
await api.close();
