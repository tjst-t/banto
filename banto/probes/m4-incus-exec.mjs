// M4: host（incus exec の呼び出し元）が止まったとき、コンテナの中の Module（と、その子）が止まるか
// banto と同じ形（stdio は pipe、tty なし、incus exec <name> -- /bin/sh -c ... exec node ...）で起こし、
// 呼び出し元の incus クライアントを SIGTERM／SIGKILL して、中のプロセスを数える。
import { spawn, execFileSync } from "node:child_process";

const NAME = "rs-probe";
const sh = (args) => execFileSync("sudo", ["incus", ...args], { encoding: "utf8" });
const inside = () => sh(["exec", NAME, "--", "sh", "-c", "ps -eo pid,pgid,args | grep -E '[m]\.js|[s]leep 600' || true"]).trim();

// 中の「Module」：stdin を読み続け（MCP stdio 相当）、子に長い sleep を抱える
const moduleScript = `
const { spawn } = require("node:child_process");
spawn("sleep", ["600"], { stdio: "ignore" });          // 同じグループの子（Shell の runCommand 相当）
spawn("sleep", ["600"], { stdio: "ignore", detached: true }); // 別グループの子
process.stdin.on("data", () => {});
process.stdin.on("end", () => { console.error("stdin end"); });
setInterval(() => {}, 1000);

`;

async function trial(signal) {
  sh(["exec", NAME, "--", "sh", "-c", "pkill -x sleep; pkill -f '[f]ake-module'; pkill -f '[m].js'; true"]);
  sh(["exec", NAME, "--", "sh", "-c", `cat > /tmp/m.js <<'EOF'\n${moduleScript}\nEOF`]);
  const child = spawn("sudo", ["incus", "exec", NAME, "--", "/bin/sh", "-c", "exec node /tmp/m.js"], {
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  child.stderr.on("data", (d) => process.stdout.write(`[${signal} stderr] ${d}`));
  await new Promise((r) => setTimeout(r, 3000));
  console.log(`--- ${signal}: before\n${inside()}`);
  // sudo の子の incus クライアントへ送る（banto では host の子が incus そのもの）
  const incusPid = execFileSync("pgrep", ["-P", String(child.pid)], { encoding: "utf8" }).trim().split("\n")[0];
  execFileSync("sudo", ["kill", "-" + signal.replace("SIG",""), incusPid]);
  for (const wait of [2000, 10000]) {
    await new Promise((r) => setTimeout(r, wait));
    console.log(`--- ${signal}: +${wait}ms\n${inside() || "(none)"}`);
  }
  try { execFileSync("sudo", ["kill", "-KILL", "--", "-" + child.pid]); } catch {}
}

const hasNode = sh(["exec", NAME, "--", "sh", "-c", "command -v node || echo none"]).trim();
if (hasNode === "none") {
  console.log("node が中に無いので入れる");
  sh(["exec", NAME, "--", "sh", "-c", "apt-get update -q >/dev/null && apt-get install -y -q nodejs >/dev/null"]);
}
await trial("SIGTERM");
await trial("SIGKILL");
sh(["exec", NAME, "--", "sh", "-c", "pkill -x sleep; pkill -f '[f]ake-module'; pkill -f '[m].js'; true"]);
