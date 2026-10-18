// **持ち主を呼ぶための中継**（追加・2026-10-18、Backlog #405。v4-modules.md §2.1「banto が置く秘密は、持ち主が作った値で渡す」）。
//
// Vault が中継で呼ぶのは、持ち主の `presentOwnedSecret`（`dev.banto/presentsOwnedSecret` を名乗る口）だけ——Vault の宣言の依存は
// 空のままで、host はこの口に限って依存の確かめを外す（アーキ仕様 §2.5）。ほかの宛先は「宣言された依存に含まれない」で断られる。
// 形は repositories・vault-directory の `relay-client.ts` と同じ（共有にはまだしない、`module-kit-extract`）。

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { CALL_ID_META_KEY } from "@banto/module-contract";

/** Vault が中継に求めるのはこれだけ（試験では偽物を渡す）。返るのは宛先の返事の文字列。断られたら理由つきで投げる */
export interface OwnerRelay {
  callTool(targetModule: string, name: string, args: Record<string, unknown>, callId?: string): Promise<string>;
}

export class HostOwnerRelay implements OwnerRelay {
  private client?: Promise<Client>;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly moduleName: string,
  ) {}

  private connect(): Promise<Client> {
    if (!this.client) {
      const c = new Client({ name: `banto-module-${this.moduleName}`, version: "0.1.0" });
      this.client = c
        .connect(
          new StreamableHTTPClientTransport(new URL(this.url), {
            requestInit: { headers: { authorization: `Bearer ${this.token}` } },
          }),
        )
        .then(() => c);
      this.client.catch(() => this.forget());
    }
    return this.client;
  }

  /** 繋いだ後にセッションが切れたら、次の呼び出しで作り直す */
  private forget(): void {
    const old = this.client;
    this.client = undefined;
    void old?.then((c) => c.close()).catch(() => undefined);
  }

  /**
   * 相手の tool を1本呼ぶ。**受けた呼び出しの印を添える**——host が親の呼び出しをたどり、Project・出所・人待ちを持ち主への
   * 中継に継ぐ（持ち主の中の `putSecret` もその下に繋がる）。持ち主は GitHub と往復するので、進捗で上限を延ばす
   */
  async callTool(targetModule: string, name: string, args: Record<string, unknown>, callId?: string): Promise<string> {
    try {
      const client = await this.connect();
      const result = await client.callTool(
        {
          name: "relayCallTool",
          arguments: { targetModule, name, arguments: args },
          ...(callId ? { _meta: { [CALL_ID_META_KEY]: callId } } : {}),
        },
        undefined,
        { resetTimeoutOnProgress: true, onprogress: () => undefined },
      );
      const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
      if (result.isError) throw new Error(text || `${targetModule} の ${name} が失敗しました`);
      return text;
    } catch (err) {
      // 中継の口が理由つきで断ったもの（JSON-RPC のエラー）は繋ぎ直しても同じ。中継に届かなかったときだけ作り直す
      if (!(err instanceof McpError) || err.code === ErrorCode.ConnectionClosed || err.code === ErrorCode.RequestTimeout) {
        this.forget();
      }
      throw err;
    }
  }
}

/**
 * 起動の環境（`BANTO_HOST_MCP_URL`・`BANTO_HOST_MCP_TOKEN`）から中継を作る。**無ければ undefined**——そのときは持ち主を
 * 呼べないので、持ち主でない呼び元への `oauth-token` は理由つきで断る（置いてある値に落とさない）。Vault 自体は立つ
 * （人の秘密・持ち主自身の読みは今までどおり）
 */
export function ownerRelayFromEnv(moduleName: string, env: NodeJS.ProcessEnv = process.env): OwnerRelay | undefined {
  const url = env.BANTO_HOST_MCP_URL;
  const token = env.BANTO_HOST_MCP_TOKEN;
  if (!url || !token) {
    console.error(`[${moduleName}] 中継の合言葉がありません——banto が置いたログインを、持ち主でない呼び元には渡せません`);
    return undefined;
  }
  return new HostOwnerRelay(url, token, moduleName);
}
