// 捨てる。Bun の単体実行ファイル（claude / opencode）が Landlock の中で起動できるか、/proc の許し方ごとに測る
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const BANTO = "/home/ubuntu/worktrees/banto-v4/banto";
const L = await import(join(BANTO, "packages/landlock/dist/index.js"));
const here = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const dir = mkdtempSync(join(tmpdir(), "ll-bun-"));
const bins = { claude: join(here, "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude"), opencode: realpathSync(join(here, "node_modules/.bin/opencode")) };
const RO = ["read_file", "read_dir"];
const variants = {
  none: [],
  procSelf: [{ path: "/proc/self", access: RO }],
  cpuinfo: [{ path: "/proc/cpuinfo", access: ["read_file"] }],
  selfAndCpu: [{ path: "/proc/self", access: RO }, { path: "/proc/cpuinfo", access: ["read_file"] }],
  proc: [{ path: "/proc", access: RO }],
};
for (const [name, bin] of Object.entries(bins)) {
  for (const [v, extra] of Object.entries(variants)) {
    const { ruleset } = L.deriveProjectRuleset({ projectRoot: dir, pathEntries: process.env.PATH.split(":"), profile: "exec", nodeExecPath: process.execPath, moduleInstallDirs: [] });
    ruleset.rules.push({ path: here, access: L.READ_EXEC });
    ruleset.rules.push(...extra);
    const f = L.writeRulesetFile(join(dir, "run"), `${name}-${v}`, ruleset);
    const w = L.wrapCommand(f, { command: bin, args: ["--version"] }, join(BANTO, "packages/landlock/rust-launcher/target/release/banto-landlock-exec"));
    const r = spawnSync(w.command, w.args, { env: { ...process.env, HOME: dir, TMPDIR: dir }, encoding: "utf8", timeout: 20000 });
    const err = (r.stderr || "").split("\n").filter((l) => !l.includes("banto-landlock-exec")).find((l) => /panic|error|denied|EACCES/i.test(l)) ?? "";
    console.log(name.padEnd(9), v.padEnd(16), `status=${r.status} sig=${r.signal}`, (r.stdout || "").trim().slice(0, 40), err.slice(0, 100));
  }
}
rmSync(dir, { recursive: true, force: true });
