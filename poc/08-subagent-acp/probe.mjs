// 捨てる。SubAgent の backend を ACP で繋ぐときの未決を、Claude Code と OpenCode で測る。
//
// usage: node probe.mjs <claude|opencode> [--model <id>] [--landlock]
//
// 測るもの：
//   1. initialize で名乗る能力（loadSession・MCP の受け取り・認証の方法）と、session/new の設定項目（モデル等）
//   2. 1つの仕事（ファイル一覧 → ファイルを作る → banto から渡した MCP の tool を呼ぶ）
//      ——途中経過の種類・tool 呼び出し・人への確認（request_permission）・使用量
//   3. 途中での cancel（止まるまでの時間と stopReason）
//   4. 別プロセスで resume（session/load）して、前の仕事を覚えているか
//
// **人の設定・記録に触らない**：Claude は CLAUDE_CONFIG_DIR を使い捨てに（認証だけ本物）、
// OpenCode は XDG の置き場を使い捨てにして、認証と設定（個人の MCP は外す）だけ写す。
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const agentName = process.argv[2];
const modelArg = process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1] : undefined;
// --landlock: banto の Module と同じ導出（@banto/landlock の deriveProjectRuleset）で閉じ込める。
//   HOME・XDG・TMPDIR は使い捨ての専用ホームに向け、人の ~/.claude・~/.config は読ませない。
//   Claude の資格情報は ~/.claude から読まず、access token だけを env（CLAUDE_CODE_OAUTH_TOKEN）で渡す。
const landlock = process.argv.includes("--landlock");
// --ask: OpenCode の permission を "ask" に上書きして、人への確認がどう来るかを見る
const ask = process.argv.includes("--ask");
// --bad-key: 壊れた API キーを渡して、認証の失敗がどう返るかを見る
const badKey = process.argv.includes("--bad-key");
// --env-key: OpenCode に auth.json を渡さず、鍵を env（OPENCODE_API_KEY）だけで渡す。設定も最小にする
const envKey = process.argv.includes("--env-key");
const BANTO = "/home/ubuntu/worktrees/banto-v4/banto";
const here = new URL(".", import.meta.url).pathname;
const scratch = mkdtempSync(join(tmpdir(), `acp-probe-${agentName}-`));
const project = join(scratch, "project");
mkdirSync(project);
writeFileSync(join(project, "existing.txt"), "前からあるファイル\n");
const t0 = Date.now();
const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`, ...a);
const result = { agent: agentName, landlock, ask, badKey, envKey };
const landlockLib = landlock ? await import(join(BANTO, "packages/landlock/dist/index.js")) : undefined;

// ---- banto から渡す MCP サーバ（HTTP、tool 1つ）----------------------------------
let mcpCalls = 0;
const mcp = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  let msg;
  try { msg = JSON.parse(body); } catch { res.writeHead(202).end(); return; }
  const reply = (r) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: r })); };
  if (msg.method === "initialize") return reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "banto-probe", version: "0" } });
  if (msg.method === "tools/list") return reply({ tools: [{ name: "probe_ping", description: "banto の Module の代わり。合言葉を返す", inputSchema: { type: "object", properties: {} } }] });
  if (msg.method === "tools/call") { mcpCalls++; return reply({ content: [{ type: "text", text: "PONG-7F3A" }] }); }
  if (msg.id !== undefined) return reply({});
  res.writeHead(202).end();
});
await new Promise((r) => mcp.listen(0, "127.0.0.1", r));
const mcpServers = [{ type: "http", name: "banto-probe", url: `http://127.0.0.1:${mcp.address().port}/mcp`, headers: [] }];

// ---- エージェントの起こし方 -----------------------------------------------------
let lastStderr = () => "";
function launch() {
  const env = { ...process.env };
  let command, args;
  const home = join(scratch, "home");
  if (landlock) {
    mkdirSync(join(home, "tmp"), { recursive: true });
    env.HOME = home;
    env.TMPDIR = join(home, "tmp");
  }
  const xdgBase = landlock ? home : scratch;
  if (agentName === "claude") {
    env.CLAUDE_CONFIG_DIR = join(landlock ? home : scratch, ".claude");
    if (badKey) {
      env.ANTHROPIC_API_KEY = "sk-ant-api03-invalid-probe-key";
    } else if (landlock) {
      const cred = JSON.parse(readFileSync(join(homedir(), ".claude/.credentials.json"), "utf8"));
      env.CLAUDE_CODE_OAUTH_TOKEN = cred.claudeAiOauth.accessToken; // 表示しない
    } else {
      env.CLAUDE_SECURESTORAGE_CONFIG_DIR = join(homedir(), ".claude");
    }
    command = process.execPath;
    args = [join(here, "node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js")];
  } else {
    const data = join(xdgBase, "xdg-data", "opencode");
    const config = join(xdgBase, "xdg-config", "opencode");
    if (!existsSync(data)) {
      mkdirSync(data, { recursive: true });
      mkdirSync(config, { recursive: true });
      let cfg;
      if (envKey) {
        cfg = { permission: ask ? "ask" : "allow" };
      } else {
        copyFileSync(join(homedir(), ".local/share/opencode/auth.json"), join(data, "auth.json"));
        const raw = readFileSync(join(homedir(), ".config/opencode/opencode.jsonc"), "utf8");
        cfg = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));
        delete cfg.mcp; // 個人の MCP は混ぜない
        if (ask) cfg.permission = "ask";
      }
      writeFileSync(join(config, "opencode.json"), JSON.stringify(cfg, null, 2));
    }
    if (envKey) env.OPENCODE_API_KEY = JSON.parse(readFileSync(join(homedir(), ".local/share/opencode/auth.json"), "utf8"))["opencode-go"].key; // 表示しない
    env.XDG_DATA_HOME = join(xdgBase, "xdg-data");
    env.XDG_CONFIG_HOME = join(xdgBase, "xdg-config");
    env.XDG_STATE_HOME = join(xdgBase, "xdg-state");
    env.XDG_CACHE_HOME = join(xdgBase, "xdg-cache");
    command = join(here, "node_modules/.bin/opencode");
    args = ["acp", "--cwd", project];
  }
  if (landlock) ({ command, args } = confine(command, args, home));
  const child = spawn(command, args, { cwd: project, env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  lastStderr = () => stderr;
  child.on("exit", (code, sig) => log(`[agent exited] code=${code} sig=${sig}${code ? " stderr=" + stderr.slice(-600) : ""}`));
  return { child, stderr: () => stderr };
}

function confine(command, args, home) {
  const { deriveProjectRuleset, assertRulesetIsSafe, writeRulesetFile, wrapCommand, READ_EXEC } = landlockLib;
  const { ruleset, omitted } = deriveProjectRuleset({
    projectRoot: realpathSync(project),
    pathEntries: (process.env.PATH ?? "").split(":").filter(Boolean),
    profile: "exec",
    nodeExecPath: process.execPath,
    moduleDataDir: realpathSync(home),
    moduleInstallDirs: [],
  });
  // エージェント本体の置き場（node_modules の中のネイティブ実行ファイルを含む）は実行が要る
  ruleset.rules.push({ path: realpathSync(here), access: READ_EXEC });
  // Bun の単体実行ファイル（claude も opencode も）は /proc/self が読めないと起動時に abort する（実測）。
  // "/proc/self" だけでは足りない——Claude は node（ACP の口）が CLI を別プロセスで起こすので、
  // CLI の pid は launcher が開いた時点の self と違う。/proc を読み取りで許す。
  // 他のドメインの environ は Landlock の ptrace 制限で読めない（/tmp/ll-proc-probe.mjs で実測）
  ruleset.rules.push({ path: "/proc", access: ["read_file", "read_dir"] });
  assertRulesetIsSafe(ruleset, { dataDir: join(homedir(), ".local/share/banto"), configDir: join(homedir(), ".config/banto"), projectRoot: realpathSync(project) });
  result.landlock = { rules: ruleset.rules.length, omitted: omitted.length };
  const file = writeRulesetFile(join(scratch, "run"), agentName, ruleset);
  return wrapCommand(file, { command, args }, join(BANTO, "packages/landlock/rust-launcher/target/release/banto-landlock-exec"));
}

function connect(child, state) {
  const client = {
    async requestPermission(p) {
      state.permissions.push({ title: p.toolCall?.title, options: p.options.map((o) => o.kind) });
      const allow = p.options.find((o) => o.kind === "allow_once") ?? p.options.find((o) => o.kind.startsWith("allow"));
      log(`  [permission] ${p.toolCall?.title} → ${allow?.kind}`);
      return { outcome: { outcome: "selected", optionId: allow.optionId } };
    },
    async sessionUpdate(n) {
      const u = n.update;
      state.kinds[u.sessionUpdate] = (state.kinds[u.sessionUpdate] ?? 0) + 1;
      if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") state.text += u.content.text;
      if (u.sessionUpdate === "tool_call") { state.tools.push(u.title); log(`  [tool_call] ${u.title} (${u.kind ?? "?"})`); }
      if (u.sessionUpdate === "usage_update") state.usageUpdate = { used: u.used, size: u.size, cost: u.cost };
    },
    async writeTextFile() { throw new Error("クライアントはファイル操作を引き受けない（名乗っていない）"); },
    async readTextFile() { throw new Error("クライアントはファイル操作を引き受けない（名乗っていない）"); },
  };
  const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  return new ClientSideConnection(() => client, stream);
}

const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}: ${ms}ms で返らない`)), ms))]);
const fresh = () => ({ kinds: {}, tools: [], permissions: [], text: "", usageUpdate: undefined });

async function start() {
  const proc = launch();
  const state = fresh();
  const conn = connect(proc.child, state);
  const init = await withTimeout(
    conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }),
    60000,
    "initialize",
  );
  return { proc, state, conn, init };
}

async function pickModel(conn, sessionId, configOptions) {
  const modelOpt = (configOptions ?? []).find((o) => o.category === "model" || /model/i.test(o.id));
  if (!modelOpt) return "（モデルの設定項目なし）";
  const values = (modelOpt.options ?? []).flatMap((o) => (o.options ? o.options : [o])).map((o) => o.value);
  const want = modelArg ?? (agentName === "claude" ? values.find((v) => /haiku/i.test(v)) : undefined);
  if (!want) return `（既定のまま: ${modelOpt.currentValue}、候補 ${values.length}件）`;
  await conn.setSessionConfigOption({ sessionId, configId: modelOpt.id, value: want });
  return `${modelOpt.id}=${want}（候補 ${values.length}件）`;
}

try {
  // ---- 1. 起動と能力 ----------------------------------------------------------
  let s = await start();
  result.agentInfo = s.init.agentInfo;
  result.capabilities = s.init.agentCapabilities;
  result.authMethods = (s.init.authMethods ?? []).map((m) => m.id ?? m.name);
  log("initialize:", JSON.stringify({ agentInfo: s.init.agentInfo, caps: s.init.agentCapabilities, auth: result.authMethods }));
  const session = await withTimeout(s.conn.newSession({ cwd: project, mcpServers }), 60000, "session/new");
  result.configOptions = (session.configOptions ?? []).map((o) => ({ id: o.id, category: o.category, current: o.currentValue }));
  result.modes = session.modes ? { current: session.modes.currentModeId, available: session.modes.availableModes.map((m) => m.id) } : null;
  log("session/new:", session.sessionId, JSON.stringify({ configOptions: result.configOptions, modes: result.modes }));
  result.model = await pickModel(s.conn, session.sessionId, session.configOptions);
  log("model:", result.model);

  // ---- 2. 1つの仕事 -----------------------------------------------------------
  const r1 = await withTimeout(
    s.conn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "次を順にやって。(1) いまのフォルダのファイル一覧を見る (2) hello.txt というファイルを作り、中身をちょうど hi にする (3) banto-probe の MCP の tool probe_ping を呼ぶ。最後に、probe_ping の返事を含めて1行で報告して。" }],
    }),
    240000,
    "prompt(仕事)",
  );
  result.task = {
    stopReason: r1.stopReason,
    usage: r1.usage ?? null,
    usageUpdate: s.state.usageUpdate ?? null,
    kinds: s.state.kinds,
    tools: s.state.tools,
    permissions: s.state.permissions,
    wroteFile: existsSync(join(project, "hello.txt")) ? readFileSync(join(project, "hello.txt"), "utf8") : null,
    mcpCalls,
    reply: s.state.text.slice(-200),
  };
  log("task:", JSON.stringify(result.task));

  // ---- 2b. 閉じ込めの中から見えるもの（--landlock のとき）------------------------------
  if (landlock) {
    const before = s.state.tools.length;
    writeFileSync(join(project, "probe-check.sh"), [
      'printenv | grep -c -E "^(CLAUDE_CODE_OAUTH_TOKEN|[A-Z_]*API_KEY)=" > probe-env.txt',
      "ls /home/ubuntu/.claude > probe-ls.txt 2>&1",
      "echo $HOME > probe-home.txt",
      // 同じドメインのプロセス（エージェント本体）の environ から秘密が読めるか
      'for p in /proc/[0-9]*; do tr "\\0" "\\n" < $p/environ 2>/dev/null | grep -q -E "^(CLAUDE_CODE_OAUTH_TOKEN|[A-Z_]*API_KEY)=" && echo $p; done | wc -l > probe-proc.txt',
      "",
    ].join("\n"));
    await withTimeout(
      s.conn.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "ターミナルで sh probe-check.sh をそのまま1回だけ実行して。結果の説明は要らない。" }],
      }),
      120000,
      "prompt(閉じ込め)",
    );
    const rd = (f) => (existsSync(join(project, f)) ? readFileSync(join(project, f), "utf8").trim().slice(0, 120) : null);
    result.inside = { tools: s.state.tools.slice(before), secretEnvVarsVisibleToShell: rd("probe-env.txt"), lsRealClaudeDir: rd("probe-ls.txt"), home: rd("probe-home.txt"), processesWithSecretInReadableEnviron: rd("probe-proc.txt") };
    log("inside:", JSON.stringify(result.inside));
  }

  // ---- 3. cancel --------------------------------------------------------------
  const conn = s.conn;
  const toolsBefore = s.state.tools.length;
  s.state.text = "";
  const cancelStarted = Date.now();
  let settledAt;
  const p2 = conn
    .prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "ターミナルで for i in $(seq 1 45); do sleep 1; done を実行して（バックグラウンドにせず、終わるまで待って）、終わったら「終わった」とだけ言って。" }] })
    .then((r) => { settledAt = Date.now(); return r; });
  // tool 呼び出しが始まってから3秒待って止める
  for (let i = 0; i < 60 && s.state.tools.length === toolsBefore && !settledAt; i++) await new Promise((r) => setTimeout(r, 500));
  await new Promise((r) => setTimeout(r, 3000));
  const alreadyDone = Boolean(settledAt);
  const cancelSentAt = Date.now();
  await conn.cancel({ sessionId: session.sessionId });
  const r2 = await withTimeout(p2, 60000, "prompt(cancel)").catch((e) => ({ stopReason: `error: ${e.message}` }));
  result.cancel = {
    stopReason: r2.stopReason,
    alreadyDoneBeforeCancel: alreadyDone,
    cancelSentAfterMs: cancelSentAt - cancelStarted,
    stoppedWithinMs: (settledAt ?? Date.now()) - cancelSentAt,
    toolsDuring: s.state.tools.slice(toolsBefore),
    reply: s.state.text.slice(0, 120),
  };
  log("cancel:", JSON.stringify(result.cancel));
  s.proc.child.kill();
  await new Promise((r) => setTimeout(r, 1000));

  // ---- 4. 別プロセスで resume ---------------------------------------------------
  if (result.capabilities?.loadSession) {
    const s2 = await start();
    const replayed = s2.state;
    await withTimeout(s2.conn.loadSession({ sessionId: session.sessionId, cwd: project, mcpServers }), 60000, "session/load");
    const replayKinds = { ...replayed.kinds };
    s2.state.text = "";
    const r3 = await withTimeout(
      s2.conn.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "さっき hello.txt に書いた中身は何？ 中身だけを答えて。" }] }),
      120000,
      "prompt(resume)",
    );
    result.resume = { stopReason: r3.stopReason, replayedKinds: replayKinds, reply: s2.state.text.trim().slice(0, 100) };
    log("resume:", JSON.stringify(result.resume));
    s2.proc.child.kill();
  } else {
    result.resume = "loadSession を名乗らない";
  }
} catch (err) {
  result.error = String(err?.message ?? err) + (err?.data ? " " + JSON.stringify(err.data).slice(0, 800) : "");
  result.stderrTail = lastStderr().slice(-1500);
  log("ERROR", result.error);
}
console.log("RESULT " + JSON.stringify(result));
rmSync(scratch, { recursive: true, force: true }); // 資格情報の写し（OpenCode の auth.json）を残さない
mcp.close();
setTimeout(() => process.exit(0), 500);
