// **中継だけを受ける専用の待ち受け**（決定・2026-10-08、`docs/specs/v4-security.md` §1「Project の実行場所——別のサーバ」）。
//
// 別のサーバからは SSH の逆向きのトンネルで来る。トンネルの先を core の口にすると、`/api/*`・人のログイン・
// `/agent-relay` まで向こうの機械の 127.0.0.1 に出る。そこで host は 127.0.0.1 の専用のポートに、host 中継 `/relay` と
// Claude のログインの中継だけを受ける待ち受けを立て、トンネルはそこへ繋ぐ（実行場所ごとに1つ）。
// **送り元は全部 127.0.0.1 に見える**ので、Claude の中継は送り元を縛らず、この待ち受けが受ける Project だけを通す。
// host 中継も同じ——**その実行場所の Project の Module の合言葉だけ**を受ける（banto 全体の Module・別の Project の合言葉は断る）。

import { createServer, type Server } from "node:http";
import { CLAUDE_LOGIN_PATH, type ClaudeLoginRelay } from "../claude-login/relay.js";
import { BodyTooLargeError } from "../http/app.js";
import type { HostRelayEndpoint } from "./host-relay-endpoint.js";

export interface RelayListenerDeps {
  relayEndpoint: Pick<HostRelayEndpoint, "handleRequest">;
  claudeLogin?: Pick<ClaudeLoginRelay, "handle">;
  /** この待ち受けで受ける Project（その実行場所の Project）。聞くたびに引く */
  acceptsProject(projectId: string): boolean;
  /** 本文を読む（上限を超えたら `BodyTooLargeError`——core の口と同じ上限） */
  readJsonBody(req: import("node:http").IncomingMessage): Promise<unknown>;
}

/** 立てるだけ（待ち受けるのは呼び元——`listen(0, "127.0.0.1")` で、トンネルにはそのポートを渡す） */
export function createRelayListener(deps: RelayListenerDeps): Server {
  return createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path === "/relay") {
        const body = req.method === "POST" ? await deps.readJsonBody(req) : undefined;
        await deps.relayEndpoint.handleRequest(
          req,
          res,
          body,
          (identity) => identity.projectId !== undefined && deps.acceptsProject(identity.projectId),
        );
        return;
      }
      if (deps.claudeLogin && path.startsWith(`${CLAUDE_LOGIN_PATH}/`)) {
        await deps.claudeLogin.handle(req, res, { acceptsProject: deps.acceptsProject, bindSource: false, acceptsRunner: false });
        return;
      }
      // ほかの口（`/api/*`・人のログイン・`/agent-relay`）はこの待ち受けには無い
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "この待ち受けは中継だけを受けます" }));
    })().catch((err: unknown) => {
      if (!res.headersSent && err instanceof BodyTooLargeError) {
        res.writeHead(413, { "content-type": "application/json" }).end(JSON.stringify({ error: `${err.message}——中継で送れるのは 10MB までです` }));
      } else if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      } else res.destroy();
    });
  });
}
