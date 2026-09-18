// **試験のための、ログインが要るリモート MCP**（追加・2026-09-18）。
//
// 本物（claude.ai のコネクタ等）を叩かない——外の都合で落ちる試験は、機構が
// 壊れた合図と見分けが付かなくなる（規則6）。ここでは**認可サーバと資源
// サーバを1つのプロセスで**立てる。実装するのは MCP の仕様が求める最小：
//
//   - `/.well-known/oauth-protected-resource`（RFC 9728）——資源が「どこで
//     認可を取るか」を示す
//   - `/.well-known/oauth-authorization-server`（RFC 8414）——認可サーバの目録
//   - `/register`（RFC 7591）——動的クライアント登録
//   - `/authorize`・`/token`——認可コード + PKCE
//   - `/mcp`——**Bearer が正しいときだけ**答える。違えば 401 に
//     `WWW-Authenticate` を付ける（ここが無いと client は探索を始めない）

import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export interface OAuthFixture {
  url: string;
  /** 人がブラウザで押す代わりに、承認画面を「押した」ことにする。戻り先を返す。 */
  approve(authorizationUrl: string): { redirectTo: string };
  /** いま有効なアクセストークン（試験が中身を確かめるため）。 */
  issuedTokens(): string[];
  close(): Promise<void>;
}

export async function startOAuthMcpFixture(port: number): Promise<OAuthFixture> {
  const base = `http://127.0.0.1:${port}`;
  /** 発行したコード → PKCE のチャレンジ。 */
  const codes = new Map<string, { challenge: string }>();
  const tokens = new Set<string>();
  const refreshTokens = new Set<string>();

  function buildMcp(): { mcp: McpServer; transport: StreamableHTTPServerTransport } {
    const mcp = new McpServer({ name: "e2e-oauth-remote", version: "0.0.0" });
    mcp.registerTool(
      "secretWord",
      { description: "ログインできた人にだけ答える（試験用）" },
      async () => ({ content: [{ type: "text" as const, text: "ログインできています" }] }),
    );
    mcp.registerTool(
      "echo",
      { description: "受け取った言葉を返す（試験用）", inputSchema: { word: z.string() } },
      async ({ word }) => ({ content: [{ type: "text" as const, text: `oauth-said:${word}` }] }),
    );
    return { mcp, transport: new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }) };
  }

  const send = (res: Parameters<Parameters<typeof createServer>[0]>[1], status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(text);
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", base);

    // --- 資源が「どこで認可を取るか」を示す（RFC 9728）---------------------
    if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname.startsWith("/.well-known/oauth-protected-resource/")) {
      return send(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
    }
    // --- 認可サーバの目録（RFC 8414）--------------------------------------
    if (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration") {
      return send(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    // --- 動的クライアント登録（RFC 7591）----------------------------------
    if (url.pathname === "/register" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const meta = JSON.parse(body || "{}") as Record<string, unknown>;
        send(res, 201, { ...meta, client_id: `client-${randomUUID()}`, client_id_issued_at: 0 });
      });
      return;
    }
    // --- 認可（人が押すところ。試験は approve() で代わりに押す）-----------
    if (url.pathname === "/authorize") {
      const challenge = url.searchParams.get("code_challenge") ?? "";
      const code = `code-${randomUUID()}`;
      codes.set(code, { challenge });
      const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
      redirect.searchParams.set("code", code);
      const state = url.searchParams.get("state");
      if (state) redirect.searchParams.set("state", state);
      res.writeHead(302, { location: redirect.toString() });
      return res.end();
    }
    // --- 交換（PKCE を実際に検証する）-------------------------------------
    if (url.pathname === "/token" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const form = new URLSearchParams(body);
        if (form.get("grant_type") === "refresh_token") {
          if (!refreshTokens.has(form.get("refresh_token") ?? "")) {
            return send(res, 400, { error: "invalid_grant" });
          }
        } else {
          const entry = codes.get(form.get("code") ?? "");
          if (!entry) return send(res, 400, { error: "invalid_grant" });
          // **本当に PKCE を確かめる**——確かめない試験は、壊れても通る
          const verifier = form.get("code_verifier") ?? "";
          const computed = createHash("sha256").update(verifier).digest("base64url");
          if (computed !== entry.challenge) return send(res, 400, { error: "invalid_grant" });
          codes.delete(form.get("code") ?? "");
        }
        const access = `at-${randomUUID()}`;
        const refresh = `rt-${randomUUID()}`;
        tokens.add(access);
        refreshTokens.add(refresh);
        send(res, 200, {
          access_token: access,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: refresh,
        });
      });
      return;
    }
    // --- 資源（Bearer が正しいときだけ）------------------------------------
    if (url.pathname === "/mcp") {
      const auth = req.headers.authorization ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!tokens.has(token)) {
        // **ここが無いと client は探索を始めない**（どこで認可を取るか分からない）
        res.writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
          "content-type": "application/json",
        });
        return res.end(JSON.stringify({ error: "unauthorized" }));
      }
      void (async () => {
        const { mcp, transport } = buildMcp();
        res.on("close", () => {
          void transport.close();
          void mcp.close();
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res);
      })();
      return;
    }
    send(res, 404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  return {
    url: `${base}/mcp`,
    approve(authorizationUrl: string) {
      // 実際の `/authorize` は 302 を返すので、押した結果は「戻り先」
      const u = new URL(authorizationUrl);
      const challenge = u.searchParams.get("code_challenge") ?? "";
      const code = `code-${randomUUID()}`;
      codes.set(code, { challenge });
      const redirect = new URL(u.searchParams.get("redirect_uri") ?? "");
      redirect.searchParams.set("code", code);
      const state = u.searchParams.get("state");
      if (state) redirect.searchParams.set("state", state);
      return { redirectTo: redirect.toString() };
    },
    issuedTokens: () => [...tokens],
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
