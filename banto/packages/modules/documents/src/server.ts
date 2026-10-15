#!/usr/bin/env node
// **変換役 `documents`**（決定・2026-10-15、ユーザー、`docs/specs/v4-modules.md` §2.2「変換役（LibreOffice）」）。
//
// banto 全体で1つ、同梱の道具用のコンテナで、中の root で動く（`meta.toolsContainer.runAsRoot`）。LibreOffice・poppler・
// 日本語フォント・bubblewrap は core が初めて起こすときに入れる。tool はどれも可視性 `module`（AI には見せない——AI は
// FileSystem を通す）で、`dev.banto/statelessTransform`（受けた中身を残さず変換して返すだけ）を名乗る。
//
// 中身は base64 で受けて base64 で返す（入力・出力とも 7MB まで）。変換は同時に1件、待ちは Project ごとに3件まで、
// Project の間は順番（`queue.ts`）。1件ごとの囲いと打ち切りは `converter.ts`

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CALLER_META_KEY, MODULE_META_KEY, STATELESS_TRANSFORM_META_KEY, VISIBILITY_META_KEY } from "@banto/module-contract";
import {
  MAX_BYTES,
  TOO_LARGE_MESSAGE,
  bwrapRunner,
  checkSandbox,
  convertOne,
  describeInstalled,
  type ConvertKind,
  type ConverterDescriptor,
  type SandboxRunner,
} from "./converter.js";
import { FairQueue } from "./queue.js";

/** この Module の申告。目録（core の DEFAULT_MODULE_DECLARATIONS）の宣言と同じ */
export const DOCUMENTS_MODULE_META = {
  satisfies: ["documents"],
  dependsOn: [],
  isolation: "subprocess",
  scope: "instance",
  toolsContainer: {
    aptPackages: [
      "libreoffice-writer-nogui",
      "libreoffice-calc-nogui",
      "libreoffice-impress-nogui",
      "poppler-utils",
      "fonts-noto-cjk",
      "bubblewrap",
    ],
    runAsRoot: true,
  },
} as const;

const TRANSFORM_META = { [VISIBILITY_META_KEY]: "module", [STATELESS_TRANSFORM_META_KEY]: true };

/** 途中経過を送る間隔（MCP の既定の上限 60 秒より十分短く） */
const PROGRESS_INTERVAL_MS = 10_000;

/** base64 の長さの上限（7MB を base64 にした長さ。中身を読む前に断る） */
const MAX_BASE64_LENGTH = Math.ceil(MAX_BYTES / 3) * 4;

/** 待ちの鍵：どの Project のための頼みか（host が刻んだもの。刻まれていなければ1つの組にまとめる） */
export function queueKeyOf(meta: Record<string, unknown> | undefined): string {
  const c = meta?.[CALLER_META_KEY] as { project?: unknown; forProject?: unknown; admin?: unknown } | undefined;
  if (typeof c?.project === "string") return `project:${c.project}`;
  if (typeof c?.forProject === "string") return `project:${c.forProject}`;
  return c?.admin === true ? "admin" : "unknown";
}

/** 拡張子（小文字、点なし）。英数字だけ受ける——作業フォルダのファイル名になる */
function extensionArg(v: unknown): string {
  if (typeof v !== "string" || !/^[a-zA-Z0-9]{1,8}$/.test(v)) throw new Error("extension は拡張子（docx など、点なし）");
  return v.toLowerCase();
}

function dataArg(v: unknown): Buffer {
  if (typeof v !== "string" || v.length === 0) throw new Error("data は中身の base64");
  if (v.length > MAX_BASE64_LENGTH) throw new Error(TOO_LARGE_MESSAGE);
  return Buffer.from(v, "base64");
}

function intArg(v: unknown, name: string, min: number, max: number, fallback?: number): number {
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new Error(`${name} は ${min}〜${max} の整数`);
  return v;
}

export interface DocumentsDeps {
  runner: SandboxRunner;
  /** 動いている uid（root でなければ囲えない） */
  uid: number | undefined;
  describe(): ConverterDescriptor;
  /** 作業フォルダを渡す uid（既定 nobody。試験だけが null） */
  chownTo?: number | null;
  log?(line: string): void;
}

export function createDocumentsServer(deps: DocumentsDeps) {
  const server = new Server({ name: "banto-module-documents", version: "0.1.0" }, { capabilities: { tools: {}, resources: {} } });
  const queue = new FairQueue(3);
  const log = deps.log ?? ((line: string) => console.error(line));
  let descriptor: ConverterDescriptor | undefined;
  const describe = () => (descriptor ??= deps.describe());
  /** 囲えると確かめたか。だめなら毎回確かめ直す（直ったら使える） */
  let sandboxOk = false;

  async function transform(
    kind: ConvertKind,
    extension: string,
    input: Buffer,
    key: string,
    progress: (message: string) => void,
    opts: { page?: number; dpi?: number } = {},
  ) {
    return queue.run(key, async (waitedMs) => {
      progress("変換しています");
      if (!sandboxOk) {
        const problem = await checkSandbox(deps.runner, deps.uid);
        if (problem) throw new Error(problem);
        sandboxOk = true;
      }
      const converter = describe();
      const r = await convertOne(deps.runner, kind, extension, input, {
        ...opts,
        ...(deps.chownTo !== undefined ? { chownTo: deps.chownTo } : {}),
      });
      // **かかった時間を記録する**（変換だけの時間と、待った時間を分けて）。中身・ファイル名は書かない
      log(`[documents] ${kind} ${extension} ${input.length}B → ${r.data.length}B 変換 ${r.ms}ms 待ち ${waitedMs}ms（${key}）`);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ data: r.data.toString("base64"), mimeType: r.mimeType, bytes: r.data.length, ms: r.ms, waitedMs, converter }),
          },
        ],
      };
    });
  }

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: "documents://module",
        name: "この Module の申告",
        mimeType: "application/json",
        _meta: { [VISIBILITY_META_KEY]: "admin", [MODULE_META_KEY]: DOCUMENTS_MODULE_META },
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== "documents://module") throw new Error(`知らない資源です: ${request.params.uri}`);
    return { contents: [{ uri: request.params.uri, mimeType: "application/json", text: JSON.stringify(DOCUMENTS_MODULE_META) }] };
  });

  const contentInput = (extra: Record<string, unknown> = {}) => ({
    type: "object",
    properties: {
      data: { type: "string", description: "中身（base64、7MB まで）" },
      extension: { type: "string", description: "元のファイルの拡張子（docx など、点なし）" },
      ...extra,
    },
    required: ["data", "extension"],
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "describe",
        description: "入っている LibreOffice・poppler の版と、フォント一式の印（変換したものを残す鍵に使う）",
        inputSchema: { type: "object", properties: {} },
        _meta: TRANSFORM_META,
      },
      {
        name: "convertToPdf",
        description: "Office の文書（docx・pptx・xlsx・doc・ppt・xls・odt・odp・ods）を PDF にする。返すのは PDF の base64",
        inputSchema: contentInput(),
        _meta: TRANSFORM_META,
      },
      {
        name: "recalculate",
        description: "表（xlsx・xlsm・xls・ods）を LibreOffice で計算し直し、式の値が入った xlsx を返す",
        inputSchema: contentInput(),
        _meta: TRANSFORM_META,
      },
      {
        name: "renderPage",
        description: "PDF の1ページを PNG にする（pdftoppm）",
        inputSchema: {
          type: "object",
          properties: {
            data: { type: "string", description: "PDF の中身（base64、7MB まで）" },
            page: { type: "integer", minimum: 1 },
            dpi: { type: "integer", minimum: 36, maximum: 300 },
          },
          required: ["data", "page"],
        },
        _meta: TRANSFORM_META,
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const key = queueKeyOf(request.params._meta as Record<string, unknown> | undefined);
    // **待っている間・変換している間も途中経過を送る**——中継（host）と呼び元は途中経過で上限を数え直す。順番を待つ間は
    // 60 秒を超えうる（打ち切りは変換だけで 60 秒、`converter.ts`）
    const progressToken = request.params._meta?.progressToken;
    let state = "変換の順番を待っています";
    let count = 0;
    const send = () => {
      if (progressToken === undefined) return;
      void extra
        .sendNotification({ method: "notifications/progress", params: { progressToken, progress: ++count, message: state } })
        .catch(() => undefined);
    };
    const heartbeat = progressToken !== undefined ? setInterval(send, PROGRESS_INTERVAL_MS) : undefined;
    const progress = (message: string) => {
      state = message;
      send();
    };
    try {
      switch (request.params.name) {
        case "describe":
          return { content: [{ type: "text", text: JSON.stringify(describe()) }] };
        case "convertToPdf":
          return await transform("pdf", extensionArg(args.extension), dataArg(args.data), key, progress);
        case "recalculate":
          return await transform("recalculate", extensionArg(args.extension), dataArg(args.data), key, progress);
        case "renderPage":
          return await transform("pageImage", "pdf", dataArg(args.data), key, progress, {
            page: intArg(args.page, "page", 1, 100_000),
            dpi: intArg(args.dpi, "dpi", 36, 300, 110),
          });
        default:
          throw new Error(`知らない tool です: ${request.params.name}`);
      }
    } catch (err) {
      return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
    } finally {
      clearInterval(heartbeat);
    }
  });

  return server;
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const server = createDocumentsServer({ runner: bwrapRunner, uid: process.getuid?.(), describe: describeInstalled });
  await server.connect(new StdioServerTransport());
}
