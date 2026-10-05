// M3：CLI を起こした親（host の代わり、m3-host.mjs）だけに signal を送ったとき、子の CLI と tool の子（Bash の sleep）が残るか
// 使い方: node m3.mjs <SIGTERM|SIGKILL> [見る時間ms（既定 15000）]
// プローブでは cgroup を作れないので、systemd の control-group の刈り取りは真似ない（親1つだけに送る）
import { spawn, execFileSync } from "node:child_process";
import { join } from "node:path";
import { startFakeApi } from "./fake-api.mjs";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { freshDirs, descendants, sleep, PROBES, readJsonl } from "./lib.mjs";

const signal = process.argv[2] === "SIGKILL" ? "SIGKILL" : "SIGTERM";
const log = (...a) => console.log(...a);
const observeMs = Number(process.argv[3] ?? 15000);
const d = freshDirs(`M3-${signal}-${observeMs}`);
const apiCount = () => (existsSync(join(d.root, "api.jsonl")) ? readFileSync(join(d.root, "api.jsonl"), "utf8").split("\n").filter(Boolean).length : 0);
const jsonlFile = () => {
  const pdir = join(d.config, "projects");
  if (!existsSync(pdir)) return undefined;
  for (const sub of readdirSync(pdir)) for (const f of readdirSync(join(pdir, sub))) if (f.endsWith(".jsonl")) return join(pdir, sub, f);
};
const jsonlTypes = () => {
  const f = jsonlFile();
  return f ? readJsonl(f).map((e) => e.type + (e.type === "user" && Array.isArray(e.message?.content) && e.message.content.some((b) => b.type === "tool_result") ? "(tool_result)" : "")).join(",") : "記録なし";
};
const api = await startFakeApi({ logFile: join(d.root, "api.jsonl") });

const ps = () =>
  new Map(
    execFileSync("ps", ["-eo", "pid=,ppid=,pgid=,stat=,args="], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
      .map((m) => [+m[1], { pid: +m[1], ppid: +m[2], pgid: +m[3], stat: m[4], args: m[5] }]),
  );

// host は自分のプロセスグループの頭にする（片付けのため。signal は host の pid 1つだけに送る）
const host = spawn(process.execPath, [join(PROBES, "m3-host.mjs"), d.config, api.url, d.work], { cwd: PROBES, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
host.stdout.on("data", (b) => {
  out += b;
  for (const l of String(b).split("\n").filter(Boolean)) log(`  [host] ${l}`);
});
host.stderr.on("data", (b) => log(`  [host stderr] ${String(b).trim().slice(0, 300)}`));
let hostExit;
const exited = new Promise((r) => host.on("exit", (code, sig) => r((hostExit = { code, sig }))));

const until = Date.now() + 60000;
while (!out.includes("TOOL_STARTED") && Date.now() < until) await sleep(100);
if (!out.includes("TOOL_STARTED")) throw new Error("tool が始まらなかった");
await sleep(2000);
const tree = descendants(host.pid);
log(`host pid ${host.pid}。signal 前のプロセス木:`);
for (const r of tree) log(`  ${r.pid} ppid=${r.ppid} pgid=${r.pgid} ${r.args.slice(0, 110)}`);

const apiBefore = apiCount();
const jsonlBefore = jsonlTypes();
log(`  signal 前：API 要求 ${apiBefore} 件、記録 = ${jsonlBefore}`);
log(`\n→ host（${host.pid}）だけに ${signal}`);
const t0 = Date.now();
process.kill(host.pid, signal);
await Promise.race([exited, sleep(10000)]);
log(`  host の終わり: ${hostExit ? JSON.stringify(hostExit) + `（${Date.now() - t0}ms）` : "10秒で終わらなかった"}`);

const points = [250, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 5000, 15000, 30000, 60000, 90000, 120000, 130000, 140000].filter((x) => x <= observeMs);
let lastLine = "";
for (const at of points) {
  await sleep(at - (Date.now() - t0) > 0 ? at - (Date.now() - t0) : 0);
  const now = ps();
  const rows = tree.map((r) => {
    const n = now.get(r.pid);
    return `${r.pid}(${r.args.split(" ")[0].split("/").pop()}${r.args.includes("sleep 120") && !r.args.startsWith("/bin/bash") ? " sleep" : ""}) ${n && !n.stat.startsWith("Z") ? `生きている ppid=${n.ppid}(${(now.get(n.ppid)?.args ?? "?").slice(0, 40)})` : n ? "ゾンビ" : "止まった"}`;
  });
  const line = `${rows.join(" / ")}  ｜API 要求 ${apiCount()} 件`;
  if (line !== lastLine) log(`  +${at}ms: ${line}`);
  lastLine = line;
}
log(`  signal 後の記録の増え方：前 = ${jsonlBefore}`);
log(`                          後 = ${jsonlTypes()}`);

// 片付け：残ったものは SIGKILL
const now = ps();
const left = tree.filter((r) => now.has(r.pid) && !now.get(r.pid).stat.startsWith("Z"));
for (const r of left) try { process.kill(r.pid, "SIGKILL"); } catch {}
await sleep(300);
log(`\n片付け：${left.length ? left.map((r) => r.pid).join(",") + " を SIGKILL" : "残りなし"}`);
await api.close();
log("(done)");
