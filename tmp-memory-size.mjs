// banto の Project Memory が土台の指示（system prompt）のどれだけを占めるかを測る（一度きりの測り、host で打つ）。
//   node memory-size.mjs <Project の id>
// 読むもの：~/.config/banto/config.json（port・authToken）、~/.claude/.credentials.json（count_tokens に使う）。
// 送るもの：Anthropic の count_tokens に、組み立てた各節の文だけ（会話は送らない）。書き込みはしない。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const projectId = process.argv[2];
if (!projectId) { console.error("Project の id を渡してください"); process.exit(1); }
const release = join(homedir(), ".local/share/banto-release/current/banto");
const { buildSystemPrompt } = await import(join(release, "packages/core/dist/runner/system-prompt.js"));
const config = JSON.parse(readFileSync(join(homedir(), ".config/banto/config.json"), "utf8"));
const base = `http://127.0.0.1:${config.port ?? 4737}`;
const api = async (p) => {
  const r = await fetch(base + p, { headers: { authorization: `Bearer ${config.authToken}` } });
  if (!r.ok) throw new Error(`${p}: ${r.status}`);
  return r.json();
};
const memory = (await api(`/api/projects/${projectId}/memory`)).filter((m) => !m.invalidated);
const globalMemory = (await api(`/api/global/memory`)).map((m) => m.text);
const instruction = (await api(`/api/projects/${projectId}/instruction`)).text ?? "";
const project = (await api(`/api/projects`)).find((p) => p.id === projectId) ?? { name: "?", root: "?" };

const blocks = buildSystemPrompt({
  globalMemory,
  project: { name: project.name, root: project.root ?? "?" },
  memory: memory.map((m) => ({ seq: m.seq, text: m.text, invalidated: false })),
  model: { name: "Opus 5.5 with 1M context", id: "claude-opus-5-5[1m]" },
  turnSummary: true,
  ...(instruction ? { projectInstruction: instruction } : {}),
});

const cred = JSON.parse(readFileSync(join(homedir(), ".claude/.credentials.json"), "utf8")).claudeAiOauth.accessToken;
async function tokens(text) {
  const r = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cred}`, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20" },
    body: JSON.stringify({ model: "claude-opus-5-5", messages: [{ role: "user", content: text || "x" }] }),
  });
  if (!r.ok) throw new Error(`count_tokens: ${r.status} ${await r.text()}`);
  return (await r.json()).input_tokens;
}
const empty = await tokens("x");
const label = (b) => (b.startsWith("#") ? b.split("\n")[0] : "土台（骨格）");
let total = 0;
const rows = [];
for (const b of blocks) {
  if (typeof b !== "string" || b.length < 5) continue;
  const t = (await tokens(b)) - empty + 1;
  total += t;
  rows.push([label(b), b.length, t]);
}
console.log(`Project Memory：${memory.length} 行、Global Memory：${globalMemory.length} 行、AI への指示：${instruction.length} 字`);
for (const [name, chars, t] of rows) console.log(`${name}\t${chars} 字\t${t} トークン`);
console.log(`土台の指示の合計\t${total} トークン`);
const lens = memory.map((m) => m.text.length).sort((a, b) => b - a);
console.log(`Memory の1行の長さ：最長 ${lens[0]} 字・中央 ${lens[Math.floor(lens.length / 2)]} 字・500字を超える行 ${lens.filter((n) => n > 500).length} 行`);
