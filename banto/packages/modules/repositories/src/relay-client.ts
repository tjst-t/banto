// host の中継（docs/specs/v4-architecture.md §2.5）のうち、この Module が使う口——**Project の一覧だけ**。
// publish-directory・vault-directory の `relay-client.ts` と同じ形（共有にはまだしない、`module-kit-extract`）。

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { CALL_ID_META_KEY } from "@banto/module-contract";
import type { ProjectSummary } from "./repositories.js";

/**
 * この Module が中継に求めるのはこれだけ（試験では偽物を渡す）。
 *
 * **`callId` は host がこの Module を呼んだときの呼び出しの印**（`dev.banto/callId`）。必ず添える——host は
 * それで「人の画面からの呼び出しを処理している最中か」を1件ずつ引く（中継は人の画面の中でだけ一覧を答える）
 */
export interface ProjectsSource {
  listProjects(callId?: string): Promise<ProjectSummary[]>;
}

export class HostRelayProjects implements ProjectsSource {
  private client?: Promise<Client>;

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private connect(): Promise<Client> {
    if (!this.client) {
      const c = new Client({ name: "banto-module-repositories", version: "0.1.0" });
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

  async listProjects(callId?: string): Promise<ProjectSummary[]> {
    try {
      const client = await this.connect();
      const result = await client.callTool({
        name: "relayListProjects",
        arguments: {},
        ...(callId ? { _meta: { [CALL_ID_META_KEY]: callId } } : {}),
      });
      const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
      if (result.isError) throw new Error(text || "中継が Project の一覧を返しませんでした");
      return JSON.parse(text) as ProjectSummary[];
    } catch (err) {
      // 中継の口が理由つきで断ったもの（JSON-RPC のエラー）は繋ぎ直しても同じ。中継に届かなかったときだけ作り直す
      if (!(err instanceof McpError) || err.code === ErrorCode.ConnectionClosed || err.code === ErrorCode.RequestTimeout) {
        this.forget();
      }
      throw err;
    }
  }
}
