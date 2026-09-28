// host の中継（docs/specs/v4-architecture.md §2.5）のうち、この実装が使う口だけ。
// Shell・vault-directory・subagent もそれぞれ小さな写しを持っている——共有にするかは `module-kit-extract`
// （docs/tasks.json）で差分を見て決める。ここでその判断を先取りしない。

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { AddressLookup } from "./publisher.js";

export class HostRelay {
  private client?: Promise<Client>;

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private connect(): Promise<Client> {
    if (!this.client) {
      const c = new Client({ name: "banto-module-publish-caddy", version: "0.1.0" });
      this.client = c
        .connect(new StreamableHTTPClientTransport(new URL(this.url), { requestInit: { headers: { authorization: `Bearer ${this.token}` } } }))
        .then(() => c);
      // 繋げなかったら次にやり直す（一度の失敗を覚え続けない）
      this.client.catch(() => this.forget());
    }
    return this.client;
  }

  /**
   * **繋ぎ直す**（追加・2026-09-28、Fable のレビュー）。以前は繋げなかったときだけ忘れていたので、繋いだ後に
   * セッションが切れる（host 側がセッションを失う・通信が途切れる）と、Module を起こし直すまで毎回同じ失敗を返した
   */
  private forget(): void {
    const old = this.client;
    this.client = undefined;
    void old?.then((c) => c.close()).catch(() => undefined);
  }

  /**
   * host からその Project のコンテナに届くアドレス。**覚えない**——変わりうる（DHCP）。
   * 確かに届かない（止まっている・無い）は `{unavailable}`、**確かめられない**（host が答えない・中継が切れた）は投げる
   */
  async projectAddress(projectId: string): Promise<AddressLookup> {
    let text: string;
    let isError: boolean;
    try {
      const client = await this.connect();
      const result = await client.callTool({ name: "relayProjectAddress", arguments: { projectId } });
      text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
      isError = result.isError === true;
    } catch (err) {
      // 中継の口が断ったのではなく、中継そのものに届かなかった——次は繋ぎ直す
      if (isConnectionFailure(err)) this.forget();
      throw err;
    }
    if (isError) throw new Error(text || "アドレスを引けませんでした");
    const found = JSON.parse(text) as { address?: unknown; unavailable?: unknown };
    if (typeof found.unavailable === "string" && found.unavailable !== "") return { unavailable: found.unavailable };
    if (typeof found.address !== "string" || found.address === "") throw new Error("host がアドレスを返しませんでした");
    return { address: found.address };
  }
}

/**
 * **中継そのものに届かなかったか**。host の口が理由つきで断ったもの（JSON-RPC のエラー）は繋ぎ直しても同じなので
 * 数えない。繋ぎ直すのは、HTTP の段で落ちた（セッションが無い・届かない）・接続が閉じた・時間切れ
 */
export function isConnectionFailure(err: unknown): boolean {
  if (!(err instanceof McpError)) return true;
  return err.code === ErrorCode.ConnectionClosed || err.code === ErrorCode.RequestTimeout;
}
