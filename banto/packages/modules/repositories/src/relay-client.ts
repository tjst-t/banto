// host の中継（docs/specs/v4-architecture.md §2.5）のうち、この Module が使う口——**Project の一覧・呼び出し元の Project・
// Vault・受信箱**。
// publish-directory・vault-directory の `relay-client.ts` と同じ形（共有にはまだしない、`module-kit-extract`）。

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { CALL_ID_META_KEY } from "@banto/module-contract";
import type { ProjectSummary } from "./repositories.js";

/**
 * この Module が中継に求める Project の一覧（試験では偽物を渡す）。
 *
 * **`callId` は host がこの Module を呼んだときの呼び出しの印**（`dev.banto/callId`）。必ず添える——host は
 * それで「人の画面からの呼び出しを処理している最中か」を1件ずつ引く（中継は人の画面の中でだけ一覧を答える）
 */
export interface ProjectsSource {
  listProjects(callId?: string): Promise<ProjectSummary[]>;
  /**
   * いま処理している呼び出しが、どの Project のためか（`relayCallerProject`、追加・2026-10-04）。**host の台帳が決める**
   * ——呼び出し元（Backlog）の名乗りではない。決められなければ理由つきで投げる
   */
  callerProject?(callId?: string): Promise<ProjectSummary>;
}

/** 他の Module の道具を中継で1本呼ぶ（Vault）。返るのは宛先の返事の文字列。断られたら理由つきで投げる */
export interface ModuleCaller {
  callTool(targetModule: string, name: string, args: Record<string, unknown>, callId?: string): Promise<string>;
}

/** 受信箱に1件出す（banto 全体の知らせ）。同じ `key` が開いている間は積まない（host が見る） */
export interface NoticeSink {
  raiseNotice(input: { key: string; title: string; detail: string }): Promise<void>;
}

/**
 * 中継が返した Project の一覧を読む。**形が違えば理由つきで投げる**——黙って空や半端な一覧にしない（規則2）。
 * 呼ぶ側（一覧）は投げられたら「どの Project が使っているかを読めませんでした」と添えて、台帳の一覧は出す
 */
export function parseProjectSummaries(text: string): ProjectSummary[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("中継の Project の一覧が JSON ではありません");
  }
  if (!Array.isArray(raw)) throw new Error("中継の Project の一覧の形が違います（配列ではありません）");
  return raw.map((p: unknown, i) => {
    const r = p as Record<string, unknown> | null;
    if (
      typeof r !== "object" ||
      r === null ||
      typeof r.id !== "string" ||
      typeof r.name !== "string" ||
      typeof r.root !== "string" ||
      (r.status !== "active" && r.status !== "closed")
    ) {
      throw new Error(`中継の Project の一覧の ${i + 1} 件目の形が違います（id・name・root・status が要ります）`);
    }
    return { id: r.id, name: r.name, root: r.root, status: r.status };
  });
}

export class HostRelay implements ProjectsSource, ModuleCaller, NoticeSink {
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

  /** 中継の口を1本呼び、返った文字列を返す。**呼び出しの印を添える**（人の画面の中かを host が1件ずつ引く） */
  private async relay(tool: string, args: Record<string, unknown>, callId: string | undefined, what: string): Promise<string> {
    try {
      const client = await this.connect();
      const result = await client.callTool({
        name: tool,
        arguments: args,
        ...(callId ? { _meta: { [CALL_ID_META_KEY]: callId } } : {}),
      });
      const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
      if (result.isError) throw new Error(text || what);
      return text;
    } catch (err) {
      // 中継の口が理由つきで断ったもの（JSON-RPC のエラー）は繋ぎ直しても同じ。中継に届かなかったときだけ作り直す
      if (!(err instanceof McpError) || err.code === ErrorCode.ConnectionClosed || err.code === ErrorCode.RequestTimeout) {
        this.forget();
      }
      throw err;
    }
  }

  async listProjects(callId?: string): Promise<ProjectSummary[]> {
    return parseProjectSummaries(await this.relay("relayListProjects", {}, callId, "中継が Project の一覧を返しませんでした"));
  }

  async callerProject(callId?: string): Promise<ProjectSummary> {
    const text = await this.relay("relayCallerProject", {}, callId, "中継が呼び出し元の Project を返しませんでした");
    return parseProjectSummaries(`[${text}]`)[0]!;
  }

  callTool(targetModule: string, name: string, args: Record<string, unknown>, callId?: string): Promise<string> {
    return this.relay("relayCallTool", { targetModule, name, arguments: args }, callId, `${targetModule} の ${name} が失敗しました`);
  }

  async raiseNotice(input: { key: string; title: string; detail: string }): Promise<void> {
    await this.relay("relayRaiseNotice", input, undefined, "受信箱に出せませんでした");
  }
}
