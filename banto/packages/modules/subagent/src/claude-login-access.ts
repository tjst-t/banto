// **banto 本体の Claude ログインを、サブエージェントに使わせる口**（決定・2026-09-25、`docs/specs/v4-security.md` §1）。
//
// サブエージェントの Module は Project のコンテナの中で動く。本体のログイン（`~/.claude`）は中に無く、入れては
// いけない（中では AI が root で何でも読める）。**中継は host に残し、banto 全体の `subagent-settings` が持つ**
// ——サブエージェントはその中継を開いてもらい、中継の住所と1回ごとの合言葉だけを受け取る。
//
// ここはその「開いてもらう口」の形。本番は中継（relay）で `subagent-settings` を呼ぶ（`relayClaudeLogin`）。
// 試験は同じ中継をその場で立てる（`localClaudeLogin`——中継そのものの振る舞いは同じ）。

import { readHostClaudeAccount, startClaudeLoginProxy, type HostClaudeAccount } from "./claude-login-proxy.js";

export type HostLoginStatus = ({ loggedIn: true } & HostClaudeAccount) | { loggedIn: false; reason: string };

export interface OpenedClaudeProxy {
  url: string;
  /** エージェントに渡す合言葉（この中継の中でしか意味を持たない） */
  secret: string;
  subscriptionType?: string;
  rateLimitTier?: string;
  /** 閉じる。上流が 401 を返した回数を返す——**期限切れ**を理由つきで伝えるため */
  close(): Promise<{ upstreamAuthFailures: number }>;
}

export interface ClaudeLoginAccess {
  /** 本体のログインの状態（契約の種類）。値は返さない */
  status(): Promise<HostLoginStatus>;
  /** その仕事のための中継を開く */
  open(): Promise<OpenedClaudeProxy>;
}

/** 中継（relay）で Module の道具を呼ぶ口（`HostRelayClient.callModuleTool`） */
export interface ModuleToolRelay {
  callModuleTool(targetModule: string, name: string, args: Record<string, unknown>): Promise<unknown>;
}

export const SETTINGS_MODULE = "subagent-settings";

/**
 * 本番：`subagent-settings` に開いてもらう。`listenHost` はコンテナから届く host 側のアドレス
 * （host が `BANTO_HOST_ADDRESS` で渡す）
 */
export function relayClaudeLogin(relay: ModuleToolRelay, listenHost: string): ClaudeLoginAccess {
  return {
    status: async () => (await relay.callModuleTool(SETTINGS_MODULE, "claudeLoginStatus", {})) as HostLoginStatus,
    open: async () => {
      const r = (await relay.callModuleTool(SETTINGS_MODULE, "openClaudeLoginProxy", { listenHost })) as {
        proxyId: string;
        url: string;
        secret: string;
        subscriptionType?: string;
        rateLimitTier?: string;
      };
      let closed: Promise<{ upstreamAuthFailures: number }> | undefined;
      return {
        url: r.url,
        secret: r.secret,
        ...(r.subscriptionType ? { subscriptionType: r.subscriptionType } : {}),
        ...(r.rateLimitTier ? { rateLimitTier: r.rateLimitTier } : {}),
        close: () =>
          (closed ??= relay.callModuleTool(SETTINGS_MODULE, "closeClaudeLoginProxy", { proxyId: r.proxyId }) as Promise<{
            upstreamAuthFailures: number;
          }>),
      };
    },
  };
}

/** 試験：同じ中継をその場で立てる */
export function localClaudeLogin(opts: { credentialsPath: string; upstream?: string; listenHost?: string }): ClaudeLoginAccess {
  return {
    status: () => readHostClaudeAccount(opts.credentialsPath),
    open: async () => {
      const proxy = await startClaudeLoginProxy({
        credentialsPath: opts.credentialsPath,
        ...(opts.upstream ? { upstream: opts.upstream } : {}),
        ...(opts.listenHost ? { host: opts.listenHost } : {}),
      });
      let closed: Promise<{ upstreamAuthFailures: number }> | undefined;
      return {
        url: proxy.url,
        secret: proxy.secret,
        ...(proxy.account.subscriptionType ? { subscriptionType: proxy.account.subscriptionType } : {}),
        ...(proxy.account.rateLimitTier ? { rateLimitTier: proxy.account.rateLimitTier } : {}),
        close: () => (closed ??= proxy.close().then(() => ({ upstreamAuthFailures: proxy.upstreamAuthFailures() }))),
      };
    },
  };
}
