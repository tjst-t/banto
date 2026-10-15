// **変換役（`documents`）を中継で呼ぶ**（決定・2026-10-15、`docs/specs/v4-modules.md` §2.2「変換役」、Backlog #304）。
//
// FileSystem は Project のコンテナ（別のサーバの Project ではそのサーバ）で動き、変換役は banto 全体の道具用のコンテナで
// 動く。間は host の中継（`relayCallTool`）——人に聞かずに通るのは、変換役の tool が `dev.banto/statelessTransform` を
// 名乗り、両方が同梱だから（host が確かめる）。宛先の名前は決め打ちせず、中継に役割（`documents`）で引く
// （`relayListTargets`。まだ起きていない変換役も載る——呼べば host が起こす）。
//
// 変換役を初めて使うときは host がコンテナを用意して LibreOffice を入れる（数分）。その間の頼みは host が
// `TOOLS_PREPARING_MARKER` 付きで断る——ここではそれを「変換役を入れています」に言い換えて返す

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS_PREPARING_MARKER } from "@banto/module-contract";
import { ConverterPreparingError, type Converter, type ConverterDescriptor, type ConvertTarget } from "./converted.js";

/** 変換役の役割の名前（宣言の `satisfies`） */
export const DOCUMENTS_ROLE = "documents";

export const INSTALLING_MESSAGE = "変換役を入れています（初回だけ、数分）。あとでもう一度読み直してください";
export const STARTING_MESSAGE = "変換役を起こしています。あとでもう一度読み直してください";

/** host が「用意している途中」で断った文を、人に見せる文にする。そうでなければ undefined */
export function preparingMessageOf(text: string): string | undefined {
  if (!text.includes(TOOLS_PREPARING_MARKER)) return undefined;
  return text.includes("入れています") ? INSTALLING_MESSAGE : STARTING_MESSAGE;
}

export class RelayConverter implements Converter {
  private client?: Promise<Client>;
  private target?: string;

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private connect(): Promise<Client> {
    if (!this.client) {
      const c = new Client({ name: "banto-module-filesystem", version: "0.1.0" });
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

  private forget(): void {
    const old = this.client;
    this.client = undefined;
    void old?.then((c) => c.close()).catch(() => undefined);
  }

  /** 中継の口を1本呼ぶ。宛先の途中経過（順番待ち・変換中）で上限を数え直す */
  private async relay(tool: string, args: Record<string, unknown>): Promise<string> {
    try {
      const client = await this.connect();
      const result = await client.callTool({ name: tool, arguments: args }, undefined, {
        resetTimeoutOnProgress: true,
        onprogress: () => undefined,
      });
      const text = (result.content as { type: string; text?: string }[])[0]?.text ?? "";
      if (result.isError) throw new Error(text || `${tool} が失敗しました`);
      return text;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const preparing = preparingMessageOf(message);
      if (preparing) throw new ConverterPreparingError(preparing);
      if (!(err instanceof McpError) || err.code === ErrorCode.ConnectionClosed || err.code === ErrorCode.RequestTimeout) {
        this.forget();
      }
      throw err;
    }
  }

  /** 変換役の Module の名前（役割で引く。見つからなければ理由つきで投げる） */
  private async targetModule(): Promise<string> {
    if (this.target) return this.target;
    const listed = JSON.parse(await this.relay("relayListTargets", {})) as Array<{ name: string; roles: string[] }>;
    const found = listed.find((t) => t.roles.includes(DOCUMENTS_ROLE));
    if (!found) throw new Error("変換役（documents）が有効になっていません。設定（banto 全体の「Module」）で確かめてください");
    return (this.target = found.name);
  }

  private async callDocuments(name: string, args: Record<string, unknown>): Promise<string> {
    return this.relay("relayCallTool", { targetModule: await this.targetModule(), name, arguments: args });
  }

  async describe(): Promise<ConverterDescriptor> {
    return parseDescriptor(JSON.parse(await this.callDocuments("describe", {})));
  }

  async convert(target: ConvertTarget, extension: string, data: Buffer) {
    const r = JSON.parse(
      await this.callDocuments(target === "pdf" ? "convertToPdf" : "recalculate", { data: data.toString("base64"), extension }),
    ) as { data?: unknown; ms?: unknown; converter?: unknown };
    if (typeof r.data !== "string") throw new Error("変換役の返事に中身がありません");
    return { data: Buffer.from(r.data, "base64"), converter: parseDescriptor(r.converter), ms: typeof r.ms === "number" ? r.ms : 0 };
  }
}

function parseDescriptor(v: unknown): ConverterDescriptor {
  const d = v as Partial<ConverterDescriptor> | null;
  if (typeof d?.version !== "string" || typeof d.fonts !== "string") throw new Error("変換役の版・フォントの印が読めません");
  return { version: d.version, fonts: d.fonts };
}
