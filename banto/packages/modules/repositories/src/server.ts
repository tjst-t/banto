#!/usr/bin/env node
// docs/specs/v4-modules.md §2.4「Repositories——手元のリポジトリの台帳」の同梱 Module（段階1）。
//
// **既定で入っていて消せない**（`DEFAULT_MODULE_DECLARATIONS`）・banto 全体に1本・banto 本体で動く。
// 段階1で持つもの：台帳（Import・一覧から外す・元に戻す・origin との突き合わせ）、既定の置き場の設定、
// 一覧の画面（launcher）と設定の面。clone・新しいリポジトリ・GitHub に公開・アカウントはまだ無い。
//
// **AI 向けの道具は持たない**（段階1、判断・2026-10-01）。台帳はこのマシンのフォルダの場所で、Project の
// コンテナの中の AI からは届かない場所を指す——渡しても AI が次の一手に使えない。道具の説明で文脈を取られる
// だけになる（§2.4 が GitHub 公式の MCP を繋がないのと同じ理由）。AI が「新しい開発を始めて」と頼む道具は
// §2.4 の「まだ決めていないこと」にある。
//
// 道具はどれも**人の画面からだけ**（可視性 `admin`、呼び出しの刻印 `{admin: true}` でも確かめる）。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CANVAS_META_KEY, MODULE_META_KEY, VISIBILITY_META_KEY, callIdOf, callerOf } from "@banto/module-contract";
import { LIST_APP_URI, SETTINGS_APP_URI, UI_APP_MIME, repositoriesAppHtml } from "./app.js";
import { LedgerStore } from "./ledger.js";
import type { ProjectsSource } from "./relay-client.js";
import {
  dismissCorrection,
  importRepository,
  inspectImport,
  listFolders,
  listRepositories,
  removeRepository,
  repoHomeView,
  restoreRepository,
  setRepoHome,
  type ProjectsLookup,
} from "./repositories.js";

const SELF_REPORT_URI = "repositories://module";

export interface RepositoriesServerDeps {
  /** この Module の置き場（host が渡す `BANTO_MODULE_DATA_DIR`）。台帳と設定を置く */
  dataDir: string;
  /** どの Project がそのフォルダを根にしているかを引く口（host の中継） */
  projects: ProjectsSource;
  /** home（試験で差し替える）。既定は `os.homedir()` */
  home?: string;
}

function adminTool(name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required },
    _meta: { [VISIBILITY_META_KEY]: "admin" },
  };
}

function json(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
}

function str(v: unknown, name: string): string {
  if (typeof v !== "string" || v === "") throw new Error(`${name} が要ります`);
  return v;
}

export function createRepositoriesServer(deps: RepositoriesServerDeps) {
  const store = new LedgerStore(deps.dataDir);
  const home = deps.home;
  const server = new Server(
    { name: "banto-module-repositories", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      adminTool("list_repositories", "台帳のリポジトリと、フォルダの事実・使っている Project（origin と食い違えば台帳を直す）"),
      adminTool("browse_folders", "そのフォルダの中のフォルダ（名前だけ）", { path: { type: "string" } }),
      adminTool("inspect_import", "そのフォルダを Import すると何が起きるか", { path: { type: "string" } }, ["path"]),
      adminTool("import_repository", "そのフォルダを、その場所のまま台帳に足す", { path: { type: "string" } }, ["path"]),
      adminTool("remove_repository", "台帳から外す（フォルダは消さない）。外した行を返す", { path: { type: "string" } }, ["path"]),
      adminTool("restore_repository", "外した行を台帳に戻す", { entry: { type: "object" } }, ["entry"]),
      adminTool("dismiss_correction", "origin に合わせて直したお知らせを消す", { path: { type: "string" } }, ["path"]),
      adminTool("get_repository_settings", "既定の置き場"),
      adminTool("set_repository_home", "既定の置き場を変える（null で既定に戻す）", { repoHome: { type: ["string", "null"] } }, [
        "repoHome",
      ]),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const name = request.params.name;
    const meta = request.params._meta as Record<string, unknown> | undefined;
    try {
      // **人の操作だけ**。可視性で AI からは見えないが、呼び出しの刻印でも確かめる
      // ——人の画面からの呼び出しには、host が `{admin: true}` を刻む
      const caller = callerOf(meta);
      if (!caller || !("admin" in caller)) throw new Error(`${name} は人の操作からだけ呼べます`);
      switch (name) {
        case "list_repositories": {
          let lookup: ProjectsLookup;
          try {
            lookup = { ok: true, projects: await deps.projects.listProjects(callIdOf(meta)) };
          } catch (err) {
            // 引けなかったことを「どの Project も使っていない」に化けさせない（規則2）——一覧は出し、理由を添える
            lookup = { ok: false, error: (err as Error).message };
          }
          return json(await listRepositories(store, lookup, home));
        }
        case "browse_folders":
          return json(await listFolders(store, typeof args.path === "string" ? args.path : undefined, home));
        case "inspect_import":
          return json(await inspectImport(store, str(args.path, "path"), home));
        case "import_repository":
          return json(await importRepository(store, str(args.path, "path"), home));
        case "remove_repository":
          return json({ removed: await removeRepository(store, str(args.path, "path")) });
        case "restore_repository":
          return json({ restored: await restoreRepository(store, args.entry) });
        case "dismiss_correction":
          await dismissCorrection(store, str(args.path, "path"));
          return json({ ok: true });
        case "get_repository_settings":
          return json(await repoHomeView(store, home));
        case "set_repository_home": {
          const next = args.repoHome === null ? null : str(args.repoHome, "repoHome");
          return json(await setRepoHome(store, next, home));
        }
        default:
          throw new Error(`unknown tool: ${name}`);
      }
    } catch (err) {
      // **理由をそのまま返す**——画面はこれを人に見せる（黙って失敗しない、規則2）
      return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        // **入口**（launcher）——どの Project からも開ける（banto 全体の Module、v4-frontend.md §6.2）
        uri: LIST_APP_URI,
        name: "リポジトリ",
        description: "このマシンで扱うリポジトリの一覧。フォルダを Import する・一覧から外す",
        mimeType: UI_APP_MIME,
        _meta: { [VISIBILITY_META_KEY]: "admin", [CANVAS_META_KEY]: "launcher", ui: { prefersBorder: false } },
      },
      {
        // **banto 全体の設定の面**——同じ一覧と、既定の置き場
        uri: SETTINGS_APP_URI,
        name: "Repositories",
        description: "リポジトリの一覧と、clone・新しく作るときの既定の置き場",
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
            satisfies: ["repositories"],
            dependsOn: [],
            isolation: "subprocess",
            scope: "instance",
          },
        },
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    if (uri === SELF_REPORT_URI) return { contents: [{ uri, mimeType: "application/json", text: "{}" }] };
    if (uri === LIST_APP_URI) return { contents: [{ uri, mimeType: UI_APP_MIME, text: repositoriesAppHtml("launcher") }] };
    if (uri === SETTINGS_APP_URI) return { contents: [{ uri, mimeType: UI_APP_MIME, text: repositoriesAppHtml("config") }] };
    throw new Error(`unknown resource: ${uri}`);
  });

  return server;
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const dataDir = process.env.BANTO_MODULE_DATA_DIR;
  const hostUrl = process.env.BANTO_HOST_MCP_URL;
  const hostToken = process.env.BANTO_HOST_MCP_TOKEN;
  // 黙って欠けたまま動かない（規則2）——中継が無いと、どの Project が使っているかを引けない
  if (!dataDir || !hostUrl || !hostToken) {
    console.error("BANTO_MODULE_DATA_DIR・BANTO_HOST_MCP_URL・BANTO_HOST_MCP_TOKEN が要ります");
    process.exit(1);
  }
  const { HostRelayProjects } = await import("./relay-client.js");
  const server = createRepositoriesServer({ dataDir, projects: new HostRelayProjects(hostUrl, hostToken) });
  await server.connect(new StdioServerTransport());
}
