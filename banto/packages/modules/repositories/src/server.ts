#!/usr/bin/env node
// docs/specs/v4-modules.md §2.4「Repositories——手元のリポジトリの台帳」の同梱 Module（段階1・2）。
//
// **既定で入っていて消せない**（`DEFAULT_MODULE_DECLARATIONS`）・banto 全体に1本・banto 本体で動く。
// 段階1で持つもの：台帳（Import・一覧から外す・元に戻す・origin との突き合わせ）、既定の置き場の設定、
// 一覧の画面（launcher）と設定の面。段階2：GitHub のアカウント（PAT・ブラウザでログイン）の登録・一覧・削除と、
// 台帳の「扱うアカウント」。clone・新しいリポジトリ・GitHub に公開はまだ無い。
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
import { GithubAccounts, parsePlaceArg } from "./accounts.js";
import { LIST_APP_URI, SETTINGS_APP_URI, UI_APP_MIME, repositoriesAppHtml } from "./app.js";
import type { GithubApi } from "./github.js";
import { LedgerStore } from "./ledger.js";
import type { NoticeSink, ProjectsSource } from "./relay-client.js";
import type { VaultAccess } from "./vault.js";
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
  /** アカウントの秘密の置き場（host の中継で Vault へ） */
  vault: VaultAccess;
  /** GitHub（試験では偽物の HTTP に向ける） */
  github: GithubApi;
  /** 受信箱（ログインの更新に失敗したとき） */
  notices: NoticeSink;
  /** home（試験で差し替える）。既定は `os.homedir()` */
  home?: string;
  /** 時計と待ち（試験で差し替える） */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
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

function optionalPlace(v: unknown, what: string) {
  return v === undefined || v === null ? undefined : parsePlaceArg(v, what);
}

const PLACE_SCHEMA = {
  type: "object",
  properties: { implementation: { type: "string" }, name: { type: "string" }, group: { type: "string" } },
  required: ["implementation", "name"],
};

export function createRepositoriesServer(deps: RepositoriesServerDeps) {
  const store = new LedgerStore(deps.dataDir);
  const home = deps.home;
  const accounts = new GithubAccounts({
    store,
    vault: deps.vault,
    github: deps.github,
    notices: deps.notices,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
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
      // ── GitHub のアカウント（段階2）。秘密の値は返さない——返すのは login と alias の在りかだけ ──
      adminTool("list_github_accounts", "登録した GitHub のアカウントと、GitHub App の client ID"),
      adminTool("list_credential_aliases", "PAT・SSH 鍵に選べる Vault の alias（値は返さない）"),
      adminTool("set_github_app_client_id", "ブラウザでログインに使う GitHub App の client ID（null で消す）", {
        clientId: { type: ["string", "null"] },
      }, ["clientId"]),
      adminTool(
        "add_github_account_with_pat",
        "PAT でアカウントを登録する（貼った値は Vault に預ける。GitHub で login を確かめてから）",
        { pat: { type: "string" }, patAlias: PLACE_SCHEMA, ssh: PLACE_SCHEMA },
      ),
      adminTool("start_github_login", "ブラウザでログイン（デバイスフロー）を始める。コードと開く URL を返す", { ssh: PLACE_SCHEMA }),
      adminTool("poll_github_login", "ブラウザでログインの結果を1回聞く（間隔より早ければ待ってから）", { flowId: { type: "string" } }, ["flowId"]),
      adminTool("cancel_github_login", "ブラウザでログインをやめる", { flowId: { type: "string" } }, ["flowId"]),
      adminTool("verify_github_account", "今使えるトークンで GitHub に login を確かめる（期限が近ければ更新する）", { login: { type: "string" } }, [
        "login",
      ]),
      adminTool("remove_github_account", "アカウントの登録を外す（ブラウザでログインしたものは Vault のログイン情報も消す）", {
        login: { type: "string" },
      }, ["login"]),
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
        case "list_github_accounts":
          return json(await accounts.list());
        case "list_credential_aliases":
          return json(await accounts.credentialChoices(callIdOf(meta)));
        case "set_github_app_client_id":
          return json(await accounts.setAppClientId(args.clientId === null ? null : str(args.clientId, "clientId")));
        case "add_github_account_with_pat": {
          const patAlias = optionalPlace(args.patAlias, "PAT の alias ");
          const ssh = optionalPlace(args.ssh, "SSH 鍵");
          return json(
            await accounts.addWithPat(
              { ...(typeof args.pat === "string" ? { pat: args.pat } : {}), ...(patAlias ? { patAlias } : {}), ...(ssh ? { ssh } : {}) },
              callIdOf(meta),
            ),
          );
        }
        case "start_github_login": {
          const ssh = optionalPlace(args.ssh, "SSH 鍵");
          return json(await accounts.startLogin(ssh ? { ssh } : {}, callIdOf(meta)));
        }
        case "poll_github_login":
          return json(await accounts.pollLogin(str(args.flowId, "flowId"), callIdOf(meta)));
        case "cancel_github_login":
          accounts.cancelLogin(str(args.flowId, "flowId"));
          return json({ ok: true });
        case "verify_github_account":
          return json(await accounts.verify(str(args.login, "login"), callIdOf(meta)));
        case "remove_github_account":
          return json(await accounts.remove(str(args.login, "login"), callIdOf(meta)));
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
        description: "リポジトリの一覧・clone や新しく作るときの既定の置き場・GitHub のアカウント",
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
            // アカウントの秘密（PAT・ログインのトークン・SSH 鍵）は Vault に置く。台帳だけなら Vault 無しでも動く
            dependsOn: [
              { role: "vault-directory", required: false },
              { role: "vault", required: false },
            ],
            isolation: "subprocess",
            scope: "instance",
            // 人が設定画面で貼った PAT がこの Module を通って Vault へ行く（要件 C8c）
            handlesSecrets: true,
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
  const { HostRelay } = await import("./relay-client.js");
  const { RelayVault } = await import("./vault.js");
  const { GITHUB_COM, httpGithub } = await import("./github.js");
  // **行き先を替える穴は試験のためだけ**（E2E が偽の GitHub に向ける。skills の `BANTO_SKILLS_GITHUB_API_URL` と同じ形）。
  // 片方だけ指すと、ログインは偽物・API は本物のように混ざる——両方か、どちらも無しか
  const web = process.env.BANTO_REPOSITORIES_GITHUB_URL;
  const api = process.env.BANTO_REPOSITORIES_GITHUB_API_URL;
  if ((web === undefined) !== (api === undefined)) {
    console.error("BANTO_REPOSITORIES_GITHUB_URL と BANTO_REPOSITORIES_GITHUB_API_URL は両方指してください");
    process.exit(1);
  }
  // 行き先を替えているなら、それを起動の記録に1行残す（本番で誤って効いていても気づけるように。宛先は秘密ではない）
  if (web && api && (web !== GITHUB_COM.web || api !== GITHUB_COM.api)) {
    console.error(`[repositories] GitHub の行き先を替えています：ログイン ${web}・API ${api}（BANTO_REPOSITORIES_GITHUB_URL・BANTO_REPOSITORIES_GITHUB_API_URL）`);
  }
  const relay = new HostRelay(hostUrl, hostToken);
  const server = createRepositoriesServer({
    dataDir,
    projects: relay,
    vault: new RelayVault(relay),
    github: httpGithub(web && api ? { web, api } : GITHUB_COM),
    notices: relay,
  });
  await server.connect(new StdioServerTransport());
}
