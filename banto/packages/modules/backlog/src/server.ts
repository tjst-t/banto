#!/usr/bin/env node
// docs/specs/v4-modules.md §4.4 Backlog——仕事の一覧（ストーリー・タスク・バグと依存）。
// Project ごとにつき、Project の根のリポジトリの**一覧のブランチ**（既定 `backlog`。中は tasks.json 1つ、`banto-backlog/1`）を
// git の低レベルのコマンドで読み書きする。送る・取ってくるは Repositories に頼む（中継）——無ければリポジトリの git の設定で。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CANVAS_META_KEY, EventOutbox, EventPublisher, MODULE_META_KEY, VISIBILITY_META_KEY, type EmittedEvent } from "@banto/module-contract";
import { join } from "node:path";
import { BacklogStore, type BacklogBackend, type MutateResult, type Snapshot } from "./store.js";
import type { BranchRemote } from "./remote.js";
import { readSettings } from "./settings.js";
import { BacklogError, type BacklogDocument, type Change } from "./model.js";
import { GITHUB_API, GistStore, createGist, type GistApi } from "./gist.js";
import { TOOLS, callTool } from "./tools.js";
import { BOARD_APP_URI, CONFIG_APP_URI, UI_APP_MIME, appHtml } from "./ui-app.js";

/** Gist の置き場に要るもの（§4.4「Gist の置き場」）。無ければ Gist を選べない */
export interface GistDeps {
  /** 選べるトークン（Vault の目録） */
  tokens: (callId?: string) => Promise<{ names: string[]; warning?: string }>;
  /** トークンの値（Vault から、使うたびに） */
  resolveToken: (alias: string, callId?: string) => Promise<string>;
  /** GitHub の REST API（Gist を作る）。**試験で差し替える穴** */
  api?: GistApi;
  /** Gist の git の URL。**試験で差し替える穴** */
  remoteUrl?: (gistId: string) => string;
}

/**
 * 設定が選んだ置き場（一覧のブランチ・Gist）へ渡す。**呼ぶたびに設定を読む**——画面で置き場を変えたら、次の読み書きから
 * そちらになる。Gist の店は Gist（と使うトークン）ごとに1つ持ち続ける——書く操作の列を、呼び出しをまたいで1本にするため
 */
class SelectedBackend implements BacklogBackend {
  private readonly gists = new Map<string, GistStore>();

  constructor(
    private readonly branchStore: BacklogStore,
    private readonly gist: GistDeps | undefined,
  ) {}

  private current(): BacklogBackend {
    const s = readSettings();
    if (s.backend !== "gist") return this.branchStore;
    if (!this.gist) throw new BacklogError("この Backlog は Vault を呼べないので、Gist に置いた一覧を読み書きできません");
    const dataDir = process.env.BANTO_MODULE_DATA_DIR;
    if (!dataDir) throw new BacklogError("Gist の写しの置き場が渡されていません（BANTO_MODULE_DATA_DIR）");
    const gistId = s.gistId!;
    const alias = s.gistToken!;
    const key = `${gistId}\0${alias}`;
    let store = this.gists.get(key);
    if (!store) {
      const gist = this.gist;
      store = new GistStore({
        dataDir,
        gistId,
        token: (callId) => gist.resolveToken(alias, callId),
        ...(gist.remoteUrl ? { remoteUrl: gist.remoteUrl(gistId) } : {}),
      });
      this.gists.set(key, store);
    }
    return store;
  }

  async read(): Promise<Snapshot> {
    return this.current().read();
  }

  async refresh(callId?: string): Promise<void> {
    return this.current().refresh(callId);
  }

  async mutate<T>(change: (doc: BacklogDocument) => Change<T>, message: (result: T) => string, callId?: string): Promise<MutateResult<T>> {
    return this.current().mutate(change, message, callId);
  }
}

export function createBacklogServer(deps: {
  projectRoot: string;
  now?: () => string;
  remote?: BranchRemote;
  sshIdentities?: (callId?: string) => Promise<{ names: string[]; warning?: string }>;
  /** 出来事を出す口（出口の箱に書いてから host へ）。無ければ出さない */
  emitEvent?: (event: EmittedEvent) => void;
  /** Gist の置き場（Vault のトークン）。無ければ Gist を選べない */
  gist?: GistDeps;
}) {
  const server = new Server(
    { name: "banto-module-backlog", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );
  const branchStore = new BacklogStore({
    root: deps.projectRoot,
    branch: () => readSettings().branch,
    ...(deps.remote ? { remote: deps.remote } : {}),
  });
  const gist = deps.gist;
  const ctx = {
    store: new SelectedBackend(branchStore, gist),
    ...(gist
      ? {
          gist: {
            tokens: gist.tokens,
            create: async (alias: string, description: string, callId?: string) =>
              createGist(await gist.resolveToken(alias, callId), description, gist.api ?? GITHUB_API),
          },
        }
      : {}),
    root: deps.projectRoot,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.sshIdentities ? { sshIdentities: deps.sshIdentities } : {}),
    ...(deps.emitEvent ? { emitEvent: deps.emitEvent } : {}),
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(ctx, request.params.name, request.params.arguments, request.params._meta as Record<string, unknown> | undefined),
  );

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        // **人が直接開く入口**（launcher）。一覧を見る・足す・並べ替えるは AI に頼む用事ではない
        uri: BOARD_APP_URI,
        name: "Backlog",
        description: "この Project の仕事の一覧（ストーリー・タスク・バグと依存）",
        mimeType: UI_APP_MIME,
        _meta: { [VISIBILITY_META_KEY]: "admin", [CANVAS_META_KEY]: "launcher", ui: { prefersBorder: false } },
      },
      {
        // 設定 Canvas——一覧の置き場（ブランチ・Gist）・一覧を置くブランチ・送るときに使う SSH 鍵・Gist
        uri: CONFIG_APP_URI,
        name: "Backlog",
        mimeType: UI_APP_MIME,
        _meta: { [VISIBILITY_META_KEY]: "admin", [CANVAS_META_KEY]: "config", ui: { prefersBorder: false } },
      },
      {
        uri: "backlog://module",
        name: "この Module の申告",
        mimeType: "application/json",
        _meta: {
          [VISIBILITY_META_KEY]: "admin",
          [MODULE_META_KEY]: {
            satisfies: ["backlog"],
            // 一覧のブランチを origin へ送る・取ってくるのを頼む（資格情報は Repositories が持つ）。無くても動く
            // ——そのときはリポジトリ自身の git の設定で試す。自分の git で送るとき、設定した SSH 鍵を Vault から借りる
            // （窓口で在りかを引き、金庫に ssh-agent を立ててもらう）。鍵を選ばなければ要らない
            dependsOn: [
              { role: "repositories", required: false },
              { role: "vault-directory", required: false },
              { role: "vault", required: false },
            ],
            isolation: "subprocess",
            scope: "project",
            // git を走らせる（作業ツリーには触らない——低レベルのコマンドで ref と object だけ）
            confinement: { kind: "landlock", root: "project", profile: "exec" },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    if (uri === BOARD_APP_URI) return { contents: [{ uri, mimeType: UI_APP_MIME, text: appHtml("board") }] };
    if (uri === CONFIG_APP_URI) return { contents: [{ uri, mimeType: UI_APP_MIME, text: appHtml("config") }] };
    throw new Error(`unknown resource: ${uri}`);
  });

  return server;
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const projectRoot = process.env.BANTO_PROJECT_ROOT;
  if (!projectRoot) {
    console.error("BANTO_PROJECT_ROOT が必要です");
    process.exit(1);
  }
  const hostUrl = process.env.BANTO_HOST_MCP_URL;
  const hostToken = process.env.BANTO_HOST_MCP_TOKEN;
  const { RelayingRemote, hostRelayCall, listSshIdentities, listTokenAliases, resolveSecret } = await import("./remote.js");
  // 中継が渡されていなければ Repositories にも Vault にも頼まない（リポジトリの git の設定だけで送る）
  const relay = hostUrl && hostToken ? hostRelayCall(hostUrl, hostToken) : undefined;
  // **出来事**（できた・状態が変わった）は出口の箱に書いてから host へ出す（アーキ仕様 §4.3、Backlog #347）。箱は Module の
  // 置き場の下——繋がっていない間に書いたものは、次に起きて繋がったときに古い順に出す
  const dataDir = process.env.BANTO_MODULE_DATA_DIR;
  const events =
    relay && dataDir
      ? new EventPublisher({
          outbox: new EventOutbox({ dir: join(dataDir, "outbox"), log: (m) => console.error(m) }),
          relay: (name, args) => relay(name, args),
          log: (m) => console.error(m),
        })
      : undefined;
  events?.start();
  const server = createBacklogServer({
    ...(events ? { emitEvent: (e: EmittedEvent) => events.publish(e) } : {}),
    projectRoot,
    remote: new RelayingRemote(projectRoot, relay, () => readSettings().sshIdentity),
    ...(relay ? { sshIdentities: (callId?: string) => listSshIdentities(relay, callId) } : {}),
    // Gist のトークンは Vault から（中継が無ければ Gist を選べない）
    ...(relay
      ? {
          gist: {
            tokens: (callId?: string) => listTokenAliases(relay, callId),
            resolveToken: (alias: string, callId?: string) => resolveSecret(relay, alias, callId),
          },
        }
      : {}),
  });
  await server.connect(new StdioServerTransport());
}
