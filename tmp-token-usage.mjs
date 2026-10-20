// Claude Code の会話の記録（~/.claude/projects/**/*.jsonl）から、要求ごとのトークンの使い方を数える（一度きりの測り）。
//   node tmp-token-usage.mjs <projects のフォルダ> [フォルダ名に含む文字]
// 読むだけ。外へは何も送らない。会話の中身は出さない（数と tool の名前だけ）。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
const filter = process.argv[3] ?? "";
if (!root) { console.error("projects のフォルダを渡してください"); process.exit(1); }

// API の値段の比（Opus の入力を1とした目安）。サブスクリプションの上限での数え方は公表されていないので、目安として並べる
const W = { in: 1, cw5m: 1.25, cw1h: 2, cr: 0.1, out: 5 };
const files = [];
for (const dir of readdirSync(root)) {
  if (filter && !dir.includes(filter)) continue;
  const p = join(root, dir);
  if (!statSync(p).isDirectory()) continue;
  for (const f of readdirSync(p)) if (f.endsWith(".jsonl")) files.push(join(p, f));
}

const total = { req: 0, in: 0, cw5m: 0, cw1h: 0, cr: 0, out: 0 };
const buckets = [50e3, 100e3, 200e3, 400e3, Infinity].map((max) => ({ max, req: 0, cost: 0 }));
let breaks = { req: 0, tokens: 0, cost: 0 };
// 書き直しの前に空いた時間ごと（1時間のキャッシュが切れたのか、それ以外か）
const gaps = [5 * 60e3, 60 * 60e3, 2 * 3600e3, 4 * 3600e3, 8 * 3600e3, 24 * 3600e3, Infinity].map((max) => ({ max, req: 0, cost: 0 }));
let images = 0;
const breakDays = new Map();
const shortBreaks = new Map();
let syntheticCount = 0;
const modelPairs = new Map(); // 5分以内の書き直しで、前の要求のモデル → このモデル // 5分以内の書き直しの形 → [回数, 値段の比] // 日付（UTC）→ [回数, 値段の比]
const kinds = new Map(); // 履歴の中身の種類 → 文字数
const tools = new Map(); // tool の名前 → 結果の文字数
const sessions = [];
const add = (m, k, n) => m.set(k, (m.get(k) ?? 0) + n);
const cost = (u) => u.in * W.in + u.cw5m * W.cw5m + u.cw1h * W.cw1h + u.cr * W.cr + u.out * W.out;

for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  const byId = new Map();
  let lastUserKind = "?";
  const toolName = new Map();
  for (const line of lines) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const msg = e.message;
    if (!msg || !Array.isArray(msg.content) && typeof msg.content !== "string") continue;
    if (e.type === "user") {
      const p0 = typeof msg.content === "string" ? "text" : msg.content.some((c) => c.type === "tool_result") ? "tool" : "text";
      lastUserKind = e.isCompactSummary ? "compact" : p0;
    }
    if (e.type === "assistant" && msg.usage && msg.id && !byId.has(msg.id)) byId.set(msg.id, { ...msg, at: Date.parse(e.timestamp ?? ""), after: lastUserKind });
    else if (e.type === "assistant" && msg.usage && msg.id) byId.set(msg.id, { ...byId.get(msg.id), usage: msg.usage });
    const parts = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content;
    for (const c of parts) {
      if (c.type === "text") add(kinds, e.type === "assistant" ? "AI の文" : "人・届いたものの文", (c.text ?? "").length);
      else if (c.type === "thinking") add(kinds, "考え（thinking）", (c.thinking ?? "").length);
      else if (c.type === "tool_use") { toolName.set(c.id, c.name); add(kinds, "tool の呼び出し（引数）", JSON.stringify(c.input ?? {}).length); }
      else if (c.type === "tool_result") {
        if (Array.isArray(c.content)) images += c.content.filter((x) => x?.type === "image").length;
        const n = typeof c.content === "string" ? c.content.length : JSON.stringify(c.content ?? "").length;
        add(kinds, "tool の結果", n);
        add(tools, toolName.get(c.tool_use_id) ?? "(不明)", n);
      }
    }
  }
  // 中断や「No response requested.」などで CLI が書く合成の発言（model "<synthetic>"・使った量 0）は要求ではないので外す
  const synthetic = [...byId.values()].filter((m) => m.model === "<synthetic>" || !(m.usage.input_tokens || m.usage.cache_read_input_tokens || m.usage.cache_creation_input_tokens));
  syntheticCount += synthetic.length;
  const reqs = [...byId.values()].filter((m) => !synthetic.includes(m));
  if (reqs.length === 0) continue;
  const s = { file: file.slice(root.length + 1), req: reqs.length, in: 0, cw5m: 0, cw1h: 0, cr: 0, out: 0, maxPrompt: 0 };
  reqs.forEach((m, i) => {
    const u = m.usage;
    const cw = u.cache_creation_input_tokens ?? 0;
    const cw1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const r = { in: u.input_tokens ?? 0, cw5m: cw - cw1h, cw1h, cr: u.cache_read_input_tokens ?? 0, out: u.output_tokens ?? 0 };
    const prompt = r.in + cw + r.cr;
    for (const k of Object.keys(r)) { s[k] += r[k]; total[k] += r[k]; }
    total.req++;
    s.maxPrompt = Math.max(s.maxPrompt, prompt);
    const b = buckets.find((b) => prompt <= b.max);
    b.req++; b.cost += cost(r);
    // 会話の途中で書き直した（キャッシュが切れた）——最初の要求ではなく、書き込みが2万を超えたもの
    if (i > 0 && cw > 20_000) {
      const c = cw1h * W.cw1h + (cw - cw1h) * W.cw5m;
      breaks.req++; breaks.tokens += cw; breaks.cost += c;
      const gap = m.at - reqs[i - 1].at;
      const g = gaps.find((g) => (Number.isFinite(gap) ? gap : 0) <= g.max);
      g.req++; g.cost += c;
      if (Number.isFinite(gap) && gap <= 5 * 60e3) {
        const shape = `${r.cr < 10_000 ? "丸ごと（読み出し1万未満）" : "途中から（読み出し" + Math.round(r.cr / 1000) / 10 * 1 + "万前後は効いた）"}`.replace(/（読み出し[\d.]+万前後は効いた）/, (m) => (r.cr >= 50_000 ? "（前の5万以上は効いた）" : "（前の1〜5万は効いた）"));
        const key = `${shape}・直前は${m.after === "text" ? "人の発言（ターンの始まり）" : m.after === "tool" ? "tool の結果（ターンの途中）" : m.after}・モデル${m.model === reqs[i - 1].model ? "同じ" : "替わった"}`;
        const v = shortBreaks.get(key) ?? [0, 0]; v[0]++; v[1] += c; shortBreaks.set(key, v);
        const pair = `${reqs[i - 1].model} → ${m.model}`;
        const pv = modelPairs.get(pair) ?? [0, 0]; pv[0]++; pv[1] += c; modelPairs.set(pair, pv);
      }
      const day = Number.isFinite(m.at) ? new Date(m.at).toISOString().slice(0, 10) : "?";
      const d = breakDays.get(day) ?? [0, 0]; d[0]++; d[1] += c; breakDays.set(day, d);
    }
  });
  s.cost = cost(s);
  sessions.push(s);
}

const all = cost(total);
const pct = (x) => `${((x / all) * 100).toFixed(1)}%`;
const fmt = (n) => Math.round(n).toLocaleString("ja-JP");
console.log(`会話の記録 ${sessions.length} 本・要求 ${fmt(total.req)} 回`);
console.log(`入力（キャッシュ外） ${fmt(total.in)}・キャッシュ書き込み 5分 ${fmt(total.cw5m)}／1時間 ${fmt(total.cw1h)}・キャッシュ読み出し ${fmt(total.cr)}・出力 ${fmt(total.out)}`);
console.log(`値段の比で見た内訳：入力 ${pct(total.in * W.in)}・書き込み ${pct(total.cw5m * W.cw5m + total.cw1h * W.cw1h)}・読み出し ${pct(total.cr * W.cr)}・出力 ${pct(total.out * W.out)}`);
console.log(`1要求あたり：送った量（入力＋書き込み＋読み出し）の平均 ${fmt((total.in + total.cw5m + total.cw1h + total.cr) / total.req)}・出力の平均 ${fmt(total.out / total.req)}`);
console.log(`途中でキャッシュを書き直した要求 ${fmt(breaks.req)} 回・${fmt(breaks.tokens)} トークン・値段の比で ${pct(breaks.cost)}`);
console.log("書き直しの前の要求から空いた時間：");
let glo = 0;
for (const g of gaps) { console.log(`  ${glo / 60e3}分〜${g.max === Infinity ? "" : g.max / 60e3 + "分"}：${fmt(g.req)} 回・${pct(g.cost)}`); glo = g.max; }
console.log("5分以内の書き直しの形：");
for (const [k, [n, c]] of [...shortBreaks].sort((a, b) => b[1][1] - a[1][1])) console.log(`  ${k}：${n} 回・${pct(c)}`);
console.log(`（合成の発言 ${fmt(syntheticCount)} 件は要求に数えていない）`);
console.log("5分以内の書き直しの、前の要求のモデル → このモデル：");
for (const [k, [n, c]] of [...modelPairs].sort((a, b) => b[1][1] - a[1][1]).slice(0, 6)) console.log(`  ${k}：${n} 回・${pct(c)}`);
console.log("書き直しの日ごと（新しい10日）：" + [...breakDays].sort().slice(-10).map(([d, [n, c]]) => `${d.slice(5)} ${n}回 ${pct(c)}`).join("・"));
console.log(`tool の結果の中の画像：${fmt(images)} 枚（文字数では base64 で大きく見えるが、トークンは1枚おおよそ千〜数千）`);
console.log("送った量の大きさごとの要求（回数・値段の比）：");
let lo = 0;
for (const b of buckets) {
  console.log(`  ${fmt(lo)}〜${b.max === Infinity ? "" : fmt(b.max)}：${fmt(b.req)} 回・${pct(b.cost)}`);
  lo = b.max;
}
const kindTotal = [...kinds.values()].reduce((a, b) => a + b, 0);
console.log("会話の履歴の中身（文字数の割合）：");
for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1])) console.log(`  ${k}：${((n / kindTotal) * 100).toFixed(1)}%`);
const toolTotal = [...tools.values()].reduce((a, b) => a + b, 0);
console.log("tool の結果の大きい順（上位12、結果の文字数の割合）：");
for (const [k, n] of [...tools].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${k}：${((n / toolTotal) * 100).toFixed(1)}%`);
console.log("値段の比の大きい会話（上位8）：");
for (const s of sessions.sort((a, b) => b.cost - a.cost).slice(0, 8)) {
  console.log(`  ${s.file.slice(0, 60)}：要求 ${s.req}・最大 ${fmt(s.maxPrompt)}・全体の ${pct(s.cost)}・読み出し ${fmt(s.cr)}・書き込み ${fmt(s.cw5m + s.cw1h)}・出力 ${fmt(s.out)}`);
}
