// host の中継（docs/specs/v4-architecture.md §2.5）のうち、窓口が使う口。
// vault-directory の `relay-client.ts` と同じ形——**共有にはまだしない**（`module-kit-extract`、docs/tasks.json）。
// 違いは **isError を捨てない**こと：公開の実装の断り（「もう公開しています」等）を、解釈できる形で受け取る。

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { CALL_ID_META_KEY, ON_BEHALF_OF_META_KEY } from "@banto/module-contract";

export interface RelayTarget {
  name: string;
  roles: string[];
}

/** 宛先の一覧と、中継が**どの Project のための呼び出しとして**一覧を作ったか（決められなければ無い） */
export interface RelayTargets {
  targets: RelayTarget[];
  onBehalfOf?: string;
}

export interface RelayResult {
  text: string;
  isError: boolean;
}

/**
 * 窓口が中継に求めるのはこれだけ（試験では偽の Service と本物の実装に直接繋ぐ）。
 *
 * **`callId` は host がこの窓口を呼んだときの呼び出しの印**（`dev.banto/callId`、追加・2026-09-28）。その呼び出しの
 * 処理中に中継を呼ぶなら必ず添える——host はそれで出所（人の画面か AI のターンか）と Project を1件ずつ引く。
 * 添えないと、同時に走っている別の呼び出しと混ぜて厳しいほうで扱われる（人の承認が AI のターンの刻印で断られる）
 */
export interface RelayLike {
  /** 自分が呼んでよい相手（role つき）。**Project の Module は、その Project のための呼び出しの中でだけ出る** */
  listTargets(callId?: string): Promise<RelayTargets>;
  callTool(targetModule: string, name: string, args: Record<string, unknown>, callId?: string): Promise<RelayResult>;
  /** 返信用の札で、呼び出し元の Thread に届ける（届いたらその Thread の AI が起きる） */
  deliver(input: { replyTo: string; title: string; text: string; final: boolean }): Promise<void>;
}

export class HostRelayClient implements RelayLike {
  private client?: Promise<Client>;

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private connect(): Promise<Client> {
    if (!this.client) {
      const c = new Client({ name: "banto-module-publish-directory", version: "0.1.0" });
      this.client = c
        .connect(new StreamableHTTPClientTransport(new URL(this.url), { requestInit: { headers: { authorization: `Bearer ${this.token}` } } }))
        .then(() => c);
      this.client.catch(() => this.forget());
    }
    return this.client;
  }

  /**
   * **繋ぎ直す**（追加・2026-09-28、Fable のレビュー）。繋いだ後にセッションが切れたら、次の呼び出しで作り直す
   * ——以前は繋げなかったときだけ忘れていたので、Module を起こし直すまで毎回同じ失敗を返した
   */
  private forget(): void {
    const old = this.client;
    this.client = undefined;
    void old?.then((c) => c.close()).catch(() => undefined);
  }

  private async call(
    name: string,
    args: Record<string, unknown>,
    callId?: string,
  ): Promise<RelayResult & { meta?: Record<string, unknown> }> {
    try {
      const client = await this.connect();
      // 中継の初回は host が人に承認を聞く——待っている間、既定の60秒で切れないよう進捗で上限を延ばす
      const result = await client.callTool(
        { name, arguments: args, ...(callId ? { _meta: { [CALL_ID_META_KEY]: callId } } : {}) },
        undefined,
        { resetTimeoutOnProgress: true, onprogress: () => undefined },
      );
      return {
        text: (result.content as { type: string; text: string }[])[0]?.text ?? "",
        isError: result.isError === true,
        ...(result._meta ? { meta: result._meta as Record<string, unknown> } : {}),
      };
    } catch (err) {
      // 中継の口が理由つきで断ったもの（JSON-RPC のエラー）は繋ぎ直しても同じ。中継に届かなかったときだけ作り直す
      if (!(err instanceof McpError) || err.code === ErrorCode.ConnectionClosed || err.code === ErrorCode.RequestTimeout) this.forget();
      throw err;
    }
  }

  async listTargets(callId?: string): Promise<RelayTargets> {
    const r = await this.call("relayListTargets", {}, callId);
    if (r.isError) throw new Error(r.text || "中継が相手の一覧を返しませんでした");
    const onBehalfOf = r.meta?.[ON_BEHALF_OF_META_KEY];
    return { targets: JSON.parse(r.text) as RelayTarget[], ...(typeof onBehalfOf === "string" ? { onBehalfOf } : {}) };
  }

  callTool(targetModule: string, name: string, args: Record<string, unknown>, callId?: string): Promise<RelayResult> {
    return this.call("relayCallTool", { targetModule, name, arguments: args }, callId);
  }

  async deliver(input: { replyTo: string; title: string; text: string; final: boolean }): Promise<void> {
    const r = await this.call("relayDeliverToThread", input);
    if (r.isError) throw new Error(r.text || "Thread に届けられませんでした");
  }
}
