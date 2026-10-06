// ターンの終わりのまとめ（2026-10-06）：Stop hook で差し戻すと CLI はどう続けるか。
// モデルは偽の API。1回目は文だけ返して終わろうとする → Stop hook が block → CLI が差し戻しの理由を
// どんな形でモデルに見せるか・その後に tool を呼べば同じターンの中で走るか・2回目の Stop で stop_hook_active が立つか。
// 実行：node probes/turn-summary-stop-hook.mjs（banto/ で）
import { createServer } from "node:http";
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { childEnv, freshDirs } from "./lib.mjs";

const requests = [];
function respond(body) {
  const msgs = body.messages ?? [];
  const last = msgs[msgs.length - 1];
  const blocks = typeof last?.content === "string" ? [{ type: "text", text: last.content }] : (last?.content ?? []);
  if (blocks.some((b) => b.type === "tool_result")) return { text: "（まとめを出しました）" };
  const all = blocks.filter((b) => b.type === "text").map((b) => b.text).join(" ");
  if (all.includes("REPORT_NOW")) {
    return { tool: { name: "mcp__banto-thread__report_turn", input: { request: "挨拶を返す", headline: "挨拶した" } } };
  }
  return { text: "こんにちは" };
}

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  if (req.url.startsWith("/v1/messages/count_tokens")) {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 100 }));
    return;
  }
  if (!req.url.startsWith("/v1/messages")) {
    res.writeHead(404).end("{}");
    return;
  }
  // 本筋の会話だけ数える（タイトル作り等の別の要求を除く：tools を持つもの）
  const main = Array.isArray(body.tools) && body.tools.length > 0;
  if (main) requests.push(body.messages);
  const p = main ? respond(body) : { text: "x" };
  const id = `msg_${requests.length}_${Math.random().toString(36).slice(2, 6)}`;
  const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  res.writeHead(200, { "content-type": "text/event-stream" });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev("message_start", { message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } });
  if (p.tool) {
    ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_${id}`, name: p.tool.name, input: {} } });
    ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(p.tool.input) } });
    ev("content_block_stop", { index: 0 });
    ev("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } });
  } else {
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: p.text } });
    ev("content_block_stop", { index: 0 });
    ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
  }
  ev("message_stop", {});
  res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const mode = process.argv[2] ?? "block-once";
const dirs = freshDirs(`turn-summary-${mode}`);
let reported = 0;
const hookCalls = [];
const canUseCalls = [];
const mcp = createSdkMcpServer({
  name: "banto-thread",
  alwaysLoad: true,
  tools: [
    tool("report_turn", "まとめ", { request: z.string(), headline: z.string() }, async () => {
      reported += 1;
      return { content: [{ type: "text", text: "記録した。" }] };
    }),
  ],
});

async function* prompt() {
  yield { type: "user", message: { role: "user", content: "挨拶して" }, parent_tool_use_id: null };
}
const q = query({
  prompt: prompt(),
  options: {
    env: childEnv({ configDir: dirs.config, baseUrl }),
    cwd: dirs.work,
    mcpServers: { "banto-thread": mcp },
    strictMcpConfig: true,
    settingSources: [],
    tools: [],
    ...(mode.startsWith("default")
      ? {
          permissionMode: "default",
          ...(mode === "default-allowed" ? { allowedTools: ["mcp__banto-thread__report_turn"] } : {}),
          canUseTool: async (name, input) => {
            canUseCalls.push(name);
            return { behavior: "allow", updatedInput: input };
          },
        }
      : { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true }),
    systemPrompt: { type: "custom", prompt: ["試験"], snapshot: false },
    hooks: {
      Stop: [
        {
          hooks: [
            async (input) => {
              hookCalls.push({ stop_hook_active: input.stop_hook_active, reported, last: input.last_assistant_message });
              if (mode === "always-block") return { decision: "block", reason: "REPORT_NOW：report_turn を呼んでから終えて" };
              if (!input.stop_hook_active && reported === 0) {
                return { decision: "block", reason: "REPORT_NOW：report_turn を呼んでから終えて" };
              }
              return {};
            },
          ],
        },
      ],
    },
  },
});

const seen = [];
for await (const m of q) {
  if (m.type === "assistant") {
    for (const b of m.message.content) seen.push(b.type === "text" ? `assistant:text:${b.text}` : `assistant:${b.type}:${b.name ?? ""}`);
  } else if (m.type === "user") {
    const c = m.message.content;
    const parts = Array.isArray(c) ? c.map((b) => (b.type === "text" ? `text:${b.text.slice(0, 120)}` : b.type)) : [`text:${String(c).slice(0, 120)}`];
    seen.push(`user:${parts.join("|")}${m.isSynthetic ? "(synthetic)" : ""}`);
  } else if (m.type === "result") {
    seen.push(`result:${m.subtype}:num_turns=${m.num_turns}`);
  } else if (m.type === "system") {
    seen.push(`system:${m.subtype}`);
  }
}
console.log("MODE", mode);
console.log("STREAM\n " + seen.join("\n "));
console.log("HOOK", JSON.stringify(hookCalls, null, 1));
console.log("REPORTED", reported);
console.log("CAN_USE_TOOL", JSON.stringify(canUseCalls));
console.log("REQUESTS", requests.length);
for (const [i, msgs] of requests.entries()) {
  const lastMsg = msgs[msgs.length - 1];
  const c = typeof lastMsg.content === "string" ? lastMsg.content : lastMsg.content.map((b) => (b.type === "text" ? `text:${b.text.slice(0, 200)}` : b.type)).join(" | ");
  console.log(` req${i + 1}: ${msgs.length} msgs; last ${lastMsg.role}: ${c}`);
}
server.close();
