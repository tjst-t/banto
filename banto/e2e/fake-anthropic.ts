// **E2E の偽の Anthropic API**（1つだけ。`docs/specs/v4-security.md` §2「Claude のアカウントを複数持つ」の 2.「E2E」）。
//
// 会話の本体（Runner）も Claude のログインの中継を通るので、本物の CLI を当てる spec も、コンテナから中継を呼ぶ spec も、
// 上流はこれ（`BANTO_CLAUDE_RELAY_UPSTREAM`）。どんな Bearer も通す。持つ口：
//   - `/v1/oauth/token`（取り直しの口、`BANTO_CLAUDE_RELAY_TOKEN_URL`）：いつも refresh token が無効と答える——本物の鍵を
//     回さず、人が直すしかない知らせの道を通すため
//   - `/v1/messages`：会話（`messages` のある本文）には短い文で返し、受けた要求（＝モデルが見る履歴）と Authorization を
//     とっておく。見出し `x-e2e-upstream-status` があるか本文が会話でなければ、その状態で受けたパスと Authorization を返す
//     （中継が本物のトークンに差し替えたか・上流の 401 を見る spec 用。中継は見出しをそのまま上流へ渡す）
import { createServer, type Server } from "node:http";

export interface ApiRequest {
  /** 受けた Authorization（中継が差し替えたもの） */
  auth: string | null;
  /** 届いた Thread の印（中継が剥がすので、届いていれば漏れている） */
  threadHeader: string | null;
  path: string;
  /** その要求の会話（各発言の文を1つにつないだもの） */
  messages: Array<{ role: string; text: string }>;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: { type?: string; text?: string; content?: unknown }) =>
      b.type === "text" ? (b.text ?? "") : b.type === "tool_result" ? textOf(b.content) : "",
    )
    .join(" ");
}

export interface FakeAnthropic {
  url: string;
  requests: ApiRequest[];
  seen: string[];
  close: () => Promise<void>;
}

export async function startFakeAnthropic(): Promise<FakeAnthropic> {
  const requests: ApiRequest[] = [];
  /** 受けた要求の全部（メソッドとパス） */
  const seen: string[] = [];
  let seq = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: { model?: string; stream?: boolean; messages?: Array<{ role: string; content: unknown }> } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as typeof body;
      } catch {
        // 本文の無い要求
      }
      const path = req.url ?? "";
      seen.push(`${req.method} ${path}`);
      if (path === "/v1/oauth/token") {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      const auth = req.headers.authorization ?? null;
      const forced = req.headers["x-e2e-upstream-status"];
      if (path.startsWith("/v1/messages") && (forced !== undefined || !Array.isArray(body.messages))) {
        res.writeHead(Number(forced ?? 200), { "content-type": "application/json" }).end(JSON.stringify({ fakeUpstream: true, path, auth }));
        return;
      }
      if (!path.startsWith("/v1/messages")) {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "fake" } }));
        return;
      }
      if (path.startsWith("/v1/messages/count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 100 }));
        return;
      }
      const messages = (body.messages ?? []).map((m) => ({ role: m.role, text: textOf(m.content) }));
      const threadHeader = req.headers["x-banto-thread-id"];
      requests.push({ path, messages, auth, threadHeader: typeof threadHeader === "string" ? threadHeader : null });
      const n = ++seq;
      const lastUser = [...messages].reverse().find((m) => m.role === "user")?.text ?? "";
      const said = /合言葉は ([a-z]+-\d+)/.exec(lastUser)?.[1];
      const text = said ? `覚えました：${said}` : `ack(${messages.length})`;
      const id = `msg_fake_${n}`;
      const usage = { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ id, type: "message", role: "assistant", model: body.model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const ev = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev("message_start", { message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } });
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
      ev("message_stop", {});
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("偽の Anthropic API の待ち受けを読めません");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
