// 偽の Anthropic Messages API。CLI が送ってきた要求（＝モデルが見るもの）をすべて記録し、
// 最後の user の中身に応じて台本どおりに返す。
//   "SLEEP_TOOL"  → Bash の tool_use（sleep 120）
//   "MCP_TOOL"    → mcp__slow__slow_task の tool_use
//   "LONG_TEXT"   → 長い文をゆっくり流す（1語/100ms、約60秒）
//   最後が tool_result → 「tool done」
//   それ以外      → 短い文（受け取った最後の user の要約を返す）
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

function lastUser(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return messages[i];
  return undefined;
}
function textOf(content) {
  if (typeof content === "string") return content;
  return content
    .map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? `[tool_result ${b.tool_use_id}]` : `[${b.type}]`))
    .join(" ");
}

function plan(body) {
  const lu = lastUser(body.messages ?? []);
  const last = lu ? (typeof lu.content === "string" ? [{ type: "text", text: lu.content }] : lu.content) : [];
  // 最後の user の「本文」（system-reminder 等の付け足しを除く）を見る
  const texts = last.filter((b) => b.type === "text").map((b) => b.text);
  const prompt = texts.filter((t) => !t.startsWith("<system-reminder>")).join(" ");
  if (last.some((b) => b.type === "tool_result")) return { kind: "text", text: "tool done" };
  if (prompt.includes("SLEEP_TOOL"))
    return { kind: "tool", name: "Bash", input: { command: "sleep 120", description: "sleep", timeout: 600000 } };
  // M1 で足した：すぐ終わる tool（完了するターンに tool を含めるため）
  if (prompt.includes("QUICK_TOOL"))
    return { kind: "tool", name: "Bash", input: { command: "echo quick-ok", description: "echo" } };
  if (prompt.includes("MCP_TOOL")) return { kind: "tool", name: "mcp__slow__slow_task", input: { seconds: 120 } };
  if (prompt.includes("LONG_TEXT")) return { kind: "slowtext", words: 600, delayMs: 100 };
  return { kind: "text", text: `ack(${(body.messages ?? []).length} messages): ${prompt.slice(0, 60)}` };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startFakeApi({ logFile, port = 0 }) {
  let seq = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {}
    const n = ++seq;
    const entry = { n, t: new Date().toISOString(), method: req.method, path: req.url, model: body.model, stream: body.stream, max_tokens: body.max_tokens, messages: body.messages, tools: body.tools?.map((t) => t.name) };
    appendFileSync(logFile, JSON.stringify(entry) + "\n");

    if (!req.url.startsWith("/v1/messages")) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "fake" } }));
      return;
    }
    if (req.url.startsWith("/v1/messages/count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 100 }));
      return;
    }
    const p = plan(body);
    const id = `msg_fake_${n}`;
    const usage = { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    if (!body.stream) {
      const content = p.kind === "tool" ? [{ type: "tool_use", id: `toolu_fake_${n}`, name: p.name, input: p.input }] : [{ type: "text", text: p.text ?? "long text" }];
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id, type: "message", role: "assistant", model: body.model, content, stop_reason: p.kind === "tool" ? "tool_use" : "end_turn", stop_sequence: null, usage }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    let closed = false;
    res.on("close", () => (closed = true));
    const ev = (type, data) => {
      if (!closed) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    };
    ev("message_start", { message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } });
    if (p.kind === "tool") {
      const tid = `toolu_fake_${n}`;
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "I'll run the tool now." } });
      ev("content_block_stop", { index: 0 });
      ev("content_block_start", { index: 1, content_block: { type: "tool_use", id: tid, name: p.name, input: {} } });
      ev("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(p.input) } });
      ev("content_block_stop", { index: 1 });
      ev("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } });
      ev("message_stop", {});
    } else if (p.kind === "slowtext") {
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      for (let i = 0; i < p.words && !closed; i++) {
        ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: `word${i} ` } });
        await sleep(p.delayMs);
      }
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: p.words } });
      ev("message_stop", {});
    } else {
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: p.text } });
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
      ev("message_stop", {});
    }
    if (!closed) res.end();
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

/** 記録した要求を「モデルが見たもの」として短く要約する */
export function summarizeRequest(entry) {
  return (entry.messages ?? []).map((m, i) => {
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    const parts = blocks.map((b) => {
      if (b.type === "text") return `text:${JSON.stringify(b.text.slice(0, 90))}`;
      if (b.type === "tool_use") return `tool_use(${b.id},${b.name})`;
      if (b.type === "tool_result") {
        const c = typeof b.content === "string" ? b.content : (b.content ?? []).map((x) => x.text ?? `[${x.type}]`).join(" ");
        return `tool_result(${b.tool_use_id},is_error=${b.is_error ?? false}):${JSON.stringify(String(c).slice(0, 120))}`;
      }
      return b.type;
    });
    return `  [${i}] ${m.role}: ${parts.join(" | ")}`;
  });
}
export { textOf };
