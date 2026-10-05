// プローブ共通：子の env・プロセスグループ・kill・会話の記録（jsonl）の要約
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const PROBES = dirname(fileURLToPath(import.meta.url));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** このプローブの作業場所を新しく作る（tmp/<name>/{config,work}） */
export function freshDirs(name) {
  const root = join(PROBES, "tmp", name);
  rmSync(root, { recursive: true, force: true });
  const config = join(root, "config");
  const work = join(root, "work");
  mkdirSync(config, { recursive: true });
  mkdirSync(work, { recursive: true });
  return { root, config, work };
}

// 親のセッション（このプローブを走らせている Claude）に紐づく変数は継がせない
const DROP = /^(CLAUDECODE|CLAUDE_CODE_SESSION_ID|CLAUDE_CODE_CHILD_SESSION|CLAUDE_CODE_MESSAGING_.*|CLAUDE_PID|CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS|CLAUDE_CODE_SESSION_ATTENDED|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_EXECPATH|CLAUDE_AGENT_SDK_VERSION|CLAUDE_EFFORT|ANTHROPIC_BASE_URL|CLAUDE_CONFIG_DIR)$/;
export function childEnv({ configDir, baseUrl }) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!DROP.test(k)) env[k] = v;
  env.CLAUDE_CONFIG_DIR = configDir;
  env.ANTHROPIC_BASE_URL = baseUrl;
  env.ANTHROPIC_API_KEY = "sk-ant-fake-probe";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.DISABLE_TELEMETRY = "1";
  env.DISABLE_AUTOUPDATER = "1";
  return env;
}

/** SDK の spawnClaudeCodeProcess：CLI をプロセスグループの頭にして起こす（systemd の cgroup kill を真似る） */
export function detachedSpawner(holder) {
  return (opts) => {
    const child = spawn(opts.command, opts.args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    holder.pid = child.pid;
    holder.stderr = "";
    child.stderr.on("data", (d) => (holder.stderr = (holder.stderr + d).slice(-4000)));
    return child;
  };
}

/** pid の子孫をすべて（pid・pgid・args） */
export function descendants(rootPid) {
  const out = execFileSync("ps", ["-eo", "pid=,ppid=,pgid=,args="], { encoding: "utf8" });
  const rows = out
    .trim()
    .split("\n")
    .map((l) => {
      const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      return { pid: +m[1], ppid: +m[2], pgid: +m[3], args: m[4] };
    });
  const set = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) if (set.has(r.ppid) && !set.has(r.pid)) (set.add(r.pid), (grew = true));
  }
  return rows.filter((r) => set.has(r.pid));
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * グループごと signal を送る。systemd（KillMode=control-group）は cgroup 全体を殺すので、
 * グループの外に出た子孫も同じ signal で殺す。SIGTERM のときは graceMs 待って残りを SIGKILL
 */
export async function killLikeSystemd(rootPid, signal, { graceMs = 5000, log = console.log } = {}) {
  const tree = descendants(rootPid);
  log(`  kill前のプロセス木: ${tree.map((r) => `${r.pid}(pgid ${r.pgid}) ${r.args.slice(0, 70)}`).join("\n                     ")}`);
  process.kill(-rootPid, signal);
  if (process.env.PROBE_GROUP_ONLY === "1") {
    // グループだけに送ったとき、グループ外の子孫が生き残るかを見る（10秒後に確かめてから片付ける）
    await sleep(10000);
    const outside = tree.filter((r) => r.pgid !== rootPid);
    log(`  グループだけに ${signal}。10秒後、グループ外の子孫: ${outside.map((r) => `${r.pid} ${alive(r.pid) ? "生きている" : "止まった"} (${r.args.slice(0, 30)})`).join(", ") || "無し"}`);
    log(`  グループ内: ${tree.filter((r) => r.pgid === rootPid).map((r) => `${r.pid} ${alive(r.pid) ? "生きている" : "止まった"}`).join(", ")}`);
    for (const r of tree) if (alive(r.pid)) try { process.kill(r.pid, "SIGKILL"); } catch {}
    await sleep(300);
    return;
  }
  for (const r of tree) if (r.pgid !== rootPid && alive(r.pid)) (log(`  グループ外の子孫 ${r.pid} にも ${signal}`), process.kill(r.pid, signal));
  if (signal === "SIGTERM") {
    const until = Date.now() + graceMs;
    while (Date.now() < until && tree.some((r) => alive(r.pid))) await sleep(100);
    const left = tree.filter((r) => alive(r.pid));
    if (left.length) {
      log(`  SIGTERM 後 ${graceMs}ms 残った: ${left.map((r) => r.pid).join(",")} → SIGKILL`);
      for (const r of left) try { process.kill(r.pid, "SIGKILL"); } catch {}
    } else log(`  SIGTERM で全部止まった`);
  }
  await sleep(300);
  const left = tree.filter((r) => alive(r.pid));
  log(`  kill後に生きているもの: ${left.length ? left.map((r) => r.pid).join(",") : "なし"}`);
}

export function findJsonl(configDir, sessionId) {
  const projects = join(configDir, "projects");
  if (!existsSync(projects)) return undefined;
  for (const d of readdirSync(projects)) {
    const f = join(projects, d, `${sessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  return undefined;
}

export function readJsonl(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const short = (u) => (u ? u.slice(0, 8) : "-");
export function describeEntry(e) {
  let what = e.type;
  if (e.subtype) what += `/${e.subtype}`;
  const c = e.message?.content;
  if (c !== undefined) {
    const blocks = typeof c === "string" ? [{ type: "text", text: c }] : c;
    what +=
      " " +
      blocks
        .map((b) => {
          if (b.type === "text") return `text:${JSON.stringify(b.text.slice(0, 70))}`;
          if (b.type === "tool_use") return `tool_use(${b.id},${b.name})`;
          if (b.type === "tool_result") {
            const t = typeof b.content === "string" ? b.content : (b.content ?? []).map((x) => x.text ?? `[${x.type}]`).join(" ");
            return `tool_result(${b.tool_use_id},is_error=${b.is_error ?? false}):${JSON.stringify(String(t).slice(0, 80))}`;
          }
          return b.type;
        })
        .join(" | ");
  } else if (e.content !== undefined) what += ` content=${JSON.stringify(String(e.content).slice(0, 80))}`;
  const extra = [];
  if (e.toolUseResult !== undefined) extra.push(`toolUseResult=${JSON.stringify(e.toolUseResult).slice(0, 80)}`);
  if (e.isMeta) extra.push("isMeta");
  if (e.isApiErrorMessage) extra.push("isApiErrorMessage");
  if (e.interrupted !== undefined) extra.push(`interrupted=${e.interrupted}`);
  if (e.message?.stop_reason !== undefined) extra.push(`stop_reason=${e.message.stop_reason}`);
  if (e.message?.id) extra.push(`msg.id=${e.message.id}`);
  return `uuid=${short(e.uuid)} parent=${short(e.parentUuid)} ${what}${extra.length ? "  {" + extra.join(", ") + "}" : ""}`;
}

export function dumpJsonl(file, { from = 0, label = "", log = console.log } = {}) {
  if (!file || !existsSync(file)) {
    log(`  ${label}記録ファイル: 無い`);
    return [];
  }
  const entries = readJsonl(file);
  log(`  ${label}記録 ${file.split("/tmp/")[1]}（${entries.length}行、${from}行目から）`);
  entries.slice(from).forEach((e, i) => log(`    #${from + i} ${describeEntry(e)}`));
  return entries;
}
