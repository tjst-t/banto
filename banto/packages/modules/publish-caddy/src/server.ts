#!/usr/bin/env node
// docs/specs/v4-modules.md §4.3 Publish——`publish` 役割の最初の実装：**Caddy のサブドメイン**。
//
// **AI には何も見せない**（口はすべて `module`＝窓口から呼ばれる部品の口か、`admin`＝人の設定画面）。
// AI の道具と承認の画面は窓口（publish-directory）が持つ。ここが守る線：
//
// - **道を張る（`publishRoute`）のは、人が押したときだけ**——host が刻む `{admin: true}` があるときだけ通す
//   （Vault の「紐付けを変える口は人の刻印があるときだけ」と同じ形）。AI のターンからは刻印が Project になるので、
//   窓口がどう呼ばれても、ここで止まる
// - やめる・一覧・見積もりは、その Project のためなら通す（公開を狭める・見るだけ）
// - Basic 認証のパスワードは bcrypt にしてから持つ。**返り値にも記録にも出さない**

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  AUDIT_ARGS_META_KEY,
  CANVAS_META_KEY,
  MODULE_META_KEY,
  VALUE_FREE_META_KEY,
  VISIBILITY_META_KEY,
  callerOf,
  type CallerStamp,
} from "@banto/module-contract";
import { connect } from "node:net";
import { CaddyAdminError, HttpCaddyAdmin } from "./caddy-admin.js";
import { CONFIG_APP_HTML, CONFIG_APP_URI, UI_APP_MIME } from "./config-app.js";
import { CaddyPublisher } from "./publisher.js";
import { PublishError } from "./route.js";
import { PublishStore } from "./store.js";

const SELF_REPORT_URI = "publish-caddy://module";

/** 窓口から呼ばれる部品の口（AI には見せない） */
const part = (valueFree: boolean) => ({ [VISIBILITY_META_KEY]: "module", ...(valueFree ? { [VALUE_FREE_META_KEY]: true } : {}) });

const TARGET_PROPS = {
  projectId: { type: "string" },
  service: { type: "string" },
  port: { type: "number" },
};

/**
 * その呼び出しがどの Project のためか。**人の刻印なら引数の Project、Project の刻印なら自分の Project に限る**。
 * 刻印が無い・banto 全体のための呼び出しは断る（どの Project か決められない——規則2）
 */
function projectFor(stamp: CallerStamp | undefined, args: Record<string, unknown>): string {
  if (!stamp || "instance" in stamp) throw new PublishError("どの Project のための呼び出しか決められません");
  if ("admin" in stamp) {
    if (typeof args.projectId !== "string" || args.projectId === "") throw new PublishError("projectId が要ります");
    return args.projectId;
  }
  if (args.projectId !== undefined && args.projectId !== stamp.project) throw new PublishError("別の Project の公開は触れません");
  return stamp.project;
}

export function createPublishCaddyServer(publisher: CaddyPublisher, store: PublishStore) {
  const server = new Server({ name: "banto-module-publish-caddy", version: "0.1.0" }, { capabilities: { tools: {}, resources: {} } });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: CONFIG_APP_URI,
        name: "Caddy で公開",
        description: "Caddy の admin の場所・公開の URL の基のドメイン・どこまで届くか",
        mimeType: UI_APP_MIME,
        _meta: { [VISIBILITY_META_KEY]: "admin", [CANVAS_META_KEY]: "config", ui: { prefersBorder: false } },
      },
      {
        uri: SELF_REPORT_URI,
        name: "この Module の申告",
        mimeType: "application/json",
        _meta: {
          [VISIBILITY_META_KEY]: "admin",
          [MODULE_META_KEY]: {
            satisfies: ["publish"],
            dependsOn: [],
            isolation: "subprocess",
            scope: "instance",
            // 人が承認の画面で打った Basic 認証のパスワードがここを通る
            handlesSecrets: true,
          },
        },
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    if (uri === SELF_REPORT_URI) return { contents: [{ uri, mimeType: "application/json", text: "{}" }] };
    if (uri === CONFIG_APP_URI) return { contents: [{ uri, mimeType: UI_APP_MIME, text: CONFIG_APP_HTML }] };
    throw new Error(`unknown resource: ${uri}`);
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "describePublishMethod",
        description: "この出し方の名前・どこまで届くか・使えるか・公開ごとの設定項目（JSON Schema）",
        inputSchema: { type: "object", properties: {} },
        _meta: part(true),
      },
      {
        name: "planPublish",
        description: "公開したらどの URL になり、どこまで届くか（何も変えない）",
        inputSchema: { type: "object", properties: { ...TARGET_PROPS, config: { type: "object" } }, required: ["service", "port"] },
        _meta: part(true),
      },
      {
        name: "publishRoute",
        description: "Caddy にルートを足して公開する。**人の操作からだけ**",
        inputSchema: {
          type: "object",
          properties: { ...TARGET_PROPS, config: { type: "object" } },
          required: ["projectId", "service", "port", "config"],
        },
        // 記録に残すのは何を公開したか（識別子）だけ——config（パスワード）は入れない
        _meta: { ...part(false), [AUDIT_ARGS_META_KEY]: ["projectId", "service"] },
      },
      {
        name: "unpublishRoute",
        description: "公開をやめる（Caddy のルートも消す）",
        inputSchema: { type: "object", properties: TARGET_PROPS, required: ["service", "port"] },
        _meta: { ...part(false), [AUDIT_ARGS_META_KEY]: ["projectId", "service"] },
      },
      {
        name: "listRoutes",
        description: "公開の一覧と状態（Caddy と突き合わせてから）",
        inputSchema: { type: "object", properties: { projectId: { type: "string" } } },
        _meta: part(true),
      },
      {
        name: "getCaddySettings",
        description: "この実装の設定",
        inputSchema: { type: "object", properties: {} },
        _meta: { [VISIBILITY_META_KEY]: "admin" },
      },
      {
        name: "setCaddySettings",
        description: "この実装の設定を変える",
        inputSchema: {
          type: "object",
          properties: {
            adminUrl: { type: "string" },
            baseDomain: { type: "string" },
            serverName: { type: "string" },
            reach: { type: "string", enum: ["machine", "lan", "internet"] },
          },
        },
        _meta: { [VISIBILITY_META_KEY]: "admin" },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const stamp = callerOf(request.params._meta as Record<string, unknown> | undefined);
    const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
    try {
      switch (request.params.name) {
        case "describePublishMethod":
          return json(await publisher.describe());
        case "planPublish":
          return json(await publisher.plan({ ...args, projectId: projectFor(stamp, args) }, args.config));
        case "publishRoute":
          if (!stamp || !("admin" in stamp)) throw new PublishError("公開は人が承認の画面で押したときだけできます");
          return json(await publisher.publish({ ...args, projectId: projectFor(stamp, args) }, args.config));
        case "unpublishRoute":
          return json(await publisher.unpublish({ ...args, projectId: projectFor(stamp, args) }));
        case "listRoutes": {
          if (stamp && "admin" in stamp && args.projectId === undefined) return json({ routes: await publisher.list() });
          return json({ routes: await publisher.list(projectFor(stamp, args)) });
        }
        case "getCaddySettings":
        case "setCaddySettings": {
          if (!stamp || !("admin" in stamp)) throw new PublishError(`${request.params.name} は人の操作からだけ呼べます`);
          const settings = request.params.name === "setCaddySettings" ? await store.setSettings(args) : await store.settings();
          return json({ settings, method: await publisher.describe() });
        }
        default:
          throw new Error(`unknown tool: ${request.params.name}`);
      }
    } catch (err) {
      // 頼み方の誤り・Caddy の断りは、理由ごと返す（黙って空を返さない——規則2）
      if (err instanceof PublishError || err instanceof CaddyAdminError) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
      throw err;
    }
  });

  return server;
}

/** host からそのアドレスとポートに TCP で届くか（繋がったらすぐ閉じる） */
export function tcpProbe(address: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: address, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** 突き合わせの間隔。DHCP でアドレスが変わってから、ここまでの間は古い行き先を指しうる */
const RECONCILE_INTERVAL_MS = 15_000;

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const dataDir = process.env.BANTO_MODULE_DATA_DIR;
  const hostUrl = process.env.BANTO_HOST_MCP_URL;
  const hostToken = process.env.BANTO_HOST_MCP_TOKEN;
  if (!dataDir || !hostUrl || !hostToken) {
    console.error("BANTO_MODULE_DATA_DIR, BANTO_HOST_MCP_URL, BANTO_HOST_MCP_TOKEN が必要です");
    process.exit(1);
  }
  const { HostRelay } = await import("./host-relay.js");
  const relay = new HostRelay(hostUrl, hostToken);
  const store = new PublishStore(dataDir);
  const publisher = new CaddyPublisher({
    store,
    caddyFor: (s) => new HttpCaddyAdmin(s.adminUrl),
    resolveAddress: (projectId) => relay.projectAddress(projectId),
    probe: (address, port) => tcpProbe(address, port),
    owner: dataDir,
  });
  await createPublishCaddyServer(publisher, store).connect(new StdioServerTransport());
  // **写しを見張る**——Caddy の読み込み直しで消えたルート・コンテナのアドレスの変化を、道具が呼ばれなくても直す。
  // 同じ理由を何度も書かない（15 秒ごとに同じ行が積もると、他のことが読めなくなる）
  let lastProblem = "";
  const tick = () =>
    publisher.reconcile().then(
      (routes) => {
        const problem = routes
          .filter((r) => r.state === "caddy-unreachable")
          .map((r) => `${r.url}: ${r.problem}`)
          .join(" / ");
        if (problem && problem !== lastProblem) console.error(`[publish-caddy] 突き合わせで直せなかったもの：${problem}`);
        lastProblem = problem;
      },
      (err: unknown) => {
        const text = err instanceof Error ? err.message : String(err);
        if (text !== lastProblem) console.error(`[publish-caddy] 突き合わせに失敗しました：${text}`);
        lastProblem = text;
      },
    );
  void tick();
  setInterval(() => void tick(), RECONCILE_INTERVAL_MS).unref();
}
