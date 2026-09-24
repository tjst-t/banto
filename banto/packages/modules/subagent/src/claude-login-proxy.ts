// **banto 本体の Claude ログインを、トークンを渡さずにサブエージェントに使わせる中継**
// （決定・2026-09-24、ユーザー——「Host で Claude を使っているのに、別途ログインが要るのは違和感」）。
//
// エージェントに渡すのは `ANTHROPIC_BASE_URL`＝この中継と、`CLAUDE_CODE_OAUTH_TOKEN`＝**この1回だけの
// 合言葉**。中継は合言葉を確かめてから、Authorization を本体の access token に差し替えて
// api.anthropic.com へ流す。**本物のトークン（と refresh token）はエージェントのドメインに入らない**
// ——サブエージェントのシェルは渡されたものを読める（v4-security.md）ので、渡さないのが唯一の守り方。
//
// 資格情報で認証を差し込む中継は既知の形（規則12——サンドボックスの外で鍵を足す egress proxy）。
// 実測（poc/08-subagent-acp/proxy-probe.mjs）：Claude Code が中継に投げたのは `/v1/messages` だけ。

import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

const UPSTREAM = "https://api.anthropic.com";
/**
 * **通すのは推論だけ**。本体のトークンは会話の履歴・claude.ai のコネクタ・ファイルの
 * 送り込みまで触れる広さを持つ——サブエージェントに要るのは推論だけなので、他は断る
 */
const ALLOWED_PATH = /^\/v1\/messages(\/count_tokens)?(\?|$)/;
const HOP_BY_HOP = ["host", "connection", "content-length", "authorization", "x-api-key", "keep-alive", "transfer-encoding"];

/**
 * 本体（main の Runner）が使っている資格情報の置き場。CLI と同じ順で決める——
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR`（E2E・疎通確認が本物を指すのに使う）→ `CLAUDE_CONFIG_DIR` → `~/.claude`
 */
export function hostClaudeCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(dir, ".credentials.json");
}

export interface HostClaudeAccount {
  /** 契約の種類と上限の段——**トークンではない**。エージェントに渡すと、既定のモデルと文脈の上限が
   *  本体と揃う（env のトークンのとき CLI はここから読む。実測：既定が Opus 5.5・文脈100万になった） */
  subscriptionType?: string;
  rateLimitTier?: string;
}

/** 設定画面に出す、本体のログインの様子（トークンは読むが返さない） */
export async function readHostClaudeAccount(
  path: string,
): Promise<({ loggedIn: true } & HostClaudeAccount) | { loggedIn: false; reason: string }> {
  try {
    const { account } = await readAccessToken(path);
    return { loggedIn: true, ...account };
  } catch (err) {
    // 読めなかった理由をそのまま出す（壊れたファイルを「未ログイン」に丸めない）
    return { loggedIn: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** 毎回読み直す——本体の CLI が更新したトークンを、そのまま拾う（写しを持たない・規則3） */
async function readAccessToken(path: string): Promise<{ token: string; account: HostClaudeAccount }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new ClaudeLoginError(`banto 本体が Claude にログインしていません（${path} がありません）`);
  }
  const oauth = (
    JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string; subscriptionType?: string; rateLimitTier?: string } }
  ).claudeAiOauth;
  if (!oauth?.accessToken) throw new ClaudeLoginError(`banto 本体の Claude ログインにトークンがありません（${path}）`);
  return {
    token: oauth.accessToken,
    account: {
      ...(oauth.subscriptionType ? { subscriptionType: oauth.subscriptionType } : {}),
      ...(oauth.rateLimitTier ? { rateLimitTier: oauth.rateLimitTier } : {}),
    },
  };
}

export class ClaudeLoginError extends Error {
  override name = "ClaudeLoginError";
}

export interface ClaudeLoginProxy {
  url: string;
  /** エージェントに渡す合言葉（この中継の中でしか意味を持たない） */
  secret: string;
  /** 本体の契約の種類（起動した時点）。エージェントの既定を本体と揃えるのに渡す */
  account: HostClaudeAccount;
  /** 上流が 401 を返した回数——**期限切れ**を、呼び出し元が理由つきで伝えるため */
  upstreamAuthFailures: () => number;
  close: () => Promise<void>;
}

export async function startClaudeLoginProxy(opts: { credentialsPath: string; upstream?: string }): Promise<ClaudeLoginProxy> {
  // 起こす前に確かめる——ログインしていないなら、エージェントを起こさずに理由を返す（規則2）
  const { account } = await readAccessToken(opts.credentialsPath);
  const upstream = opts.upstream ?? UPSTREAM;
  const secret = `banto-${randomUUID()}`;
  let authFailures = 0;

  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.headers.authorization !== `Bearer ${secret}`) {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "合言葉が違います" } }));
        return;
      }
      if (!ALLOWED_PATH.test(req.url ?? "")) {
        res
          .writeHead(403, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { message: `banto の中継は推論（/v1/messages）だけを通します: ${req.method} ${req.url}` } }));
        return;
      }
      let token: string;
      try {
        token = (await readAccessToken(opts.credentialsPath)).token;
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: (err as Error).message } }));
        return;
      }
      const abort = new AbortController();
      res.on("close", () => abort.abort());
      const upstreamRes = await fetch(`${upstream}${req.url}`, {
        method: req.method ?? "POST",
        headers: { ...forwardedHeaders(req), authorization: `Bearer ${token}` },
        body: req.method === "GET" || req.method === "HEAD" ? undefined : (Readable.toWeb(req) as ReadableStream<Uint8Array>),
        // Node の fetch で本文を流しながら送るには要る
        duplex: "half",
        signal: abort.signal,
      } as RequestInit);
      if (upstreamRes.status === 401) authFailures++;
      const headers: Record<string, string> = {};
      // fetch は圧縮を解いて渡すので、長さと符号化の見出しは付け直さない
      upstreamRes.headers.forEach((v, k) => {
        if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) headers[k] = v;
      });
      res.writeHead(upstreamRes.status, headers);
      if (upstreamRes.body) Readable.fromWeb(upstreamRes.body as import("node:stream/web").ReadableStream).pipe(res);
      else res.end();
    })().catch((err: unknown) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `中継できませんでした: ${(err as Error).message}` } }));
      } else res.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("中継の待ち受けを開けませんでした");
  return {
    url: `http://127.0.0.1:${address.port}`,
    secret,
    account,
    upstreamAuthFailures: () => authFailures,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function forwardedHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || HOP_BY_HOP.includes(k)) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}
