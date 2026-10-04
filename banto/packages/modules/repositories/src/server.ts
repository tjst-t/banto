#!/usr/bin/env node
// docs/specs/v4-modules.md §2.4「Repositories——手元のリポジトリの台帳」の同梱 Module（段階1・2）。
//
// **既定で入っていて消せない**（`DEFAULT_MODULE_DECLARATIONS`）・banto 全体に1本・banto 本体で動く。
// 段階1で持つもの：台帳（Import・一覧から外す・元に戻す・origin との突き合わせ）、既定の置き場の設定、
// 一覧の画面（launcher）と設定の面。段階2：GitHub のアカウント（PAT・ブラウザでログイン）の登録・一覧・削除と、
// 台帳の「扱うアカウント」。段階3：clone・新しいリポジトリ。段階4：アカウントを後から選ぶ・このマシンから削除・
// 新しい Project の画面のタブ。段階5：GitHub に公開（`publish.ts`）。
//
// **AI 向けの道具は持たない**（段階1、判断・2026-10-01）。台帳はこのマシンのフォルダの場所で、Project の
// コンテナの中の AI からは届かない場所を指す——渡しても AI が次の一手に使えない。道具の説明で文脈を取られる
// だけになる（§2.4 が GitHub 公式の MCP を繋がないのと同じ理由）。AI が「新しい開発を始めて」と頼む道具は
// §2.4 の「まだ決めていないこと」にある。
//
// 道具はどれも**人の画面からだけ**（可視性 `admin`、呼び出しの刻印 `{admin: true}` でも確かめる）。例外は
// **ブランチを送る・取ってくる口**（`push_branch`・`fetch_branch`、可視性 `module`、追加・2026-10-04）——Backlog が
// 中継で呼ぶ。リポジトリは呼び出し元の Project の根で決まり（host に聞く）、引数で選べるのはブランチ名だけ。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { AUDIT_ARGS_META_KEY, CANVAS_META_KEY, MODULE_META_KEY, VISIBILITY_META_KEY, callIdOf, callerOf } from "@banto/module-contract";
import { GithubAccounts, parsePlaceArg } from "./accounts.js";
import { LIST_APP_URI, PREPARE_CLONE_URI, PREPARE_CREATE_URI, PUBLISH_APP_URI, SETTINGS_APP_URI, UI_APP_MIME, repositoriesAppHtml } from "./app.js";
import { setRepositoryAccount } from "./assign.js";
import { BranchSync } from "./branch-sync.js";
import { deleteRepository, inspectDelete } from "./delete.js";
import { Cloner } from "./clone.js";
import { Publisher } from "./publish.js";
import { GITHUB_COM, type GithubApi, type GithubEndpoints } from "./github.js";
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
  /** GitHub の行き先（clone の URL を作るのに使う。既定は本物） */
  githubEndpoints?: GithubEndpoints;
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

function branchTool(name: string, description: string) {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: { branch: { type: "string" } }, required: ["branch"] },
    _meta: { [VISIBILITY_META_KEY]: "module", [AUDIT_ARGS_META_KEY]: ["branch"] },
  };
}

function json(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
}

function str(v: unknown, name: string): string {
  if (typeof v !== "string" || v === "") throw new Error(`${name} が要ります`);
  return v;
}

/** 始め方のタブのアイコン（lucide の cloud-download・folder-plus の線。core は画像として描くだけ） */
const CLONE_ICON =
  '<path d="M12 13v8l-4-4"/><path d="m12 21 4-4"/><path d="M4.393 15.269A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.436 8.284"/>';
const CREATE_ICON =
  '<path d="M12 10v6"/><path d="M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>';
function iconDataUri(paths: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#666" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
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
  const cloner = new Cloner({
    store,
    dataDir: deps.dataDir,
    accounts,
    vault: deps.vault,
    github: deps.github,
    endpoints: deps.githubEndpoints ?? GITHUB_COM,
    ...(home ? { home } : {}),
  });
  const publisher = new Publisher({
    store,
    dataDir: deps.dataDir,
    accounts,
    vault: deps.vault,
    github: deps.github,
    endpoints: deps.githubEndpoints ?? GITHUB_COM,
    ...(home ? { home } : {}),
  });
  const branchSync = new BranchSync({
    store,
    accounts,
    vault: deps.vault,
    dataDir: deps.dataDir,
    endpoints: deps.githubEndpoints ?? GITHUB_COM,
  });
  const lookupProjects = async (meta: Record<string, unknown> | undefined): Promise<ProjectsLookup> => {
    try {
      return { ok: true, projects: await deps.projects.listProjects(callIdOf(meta)) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  };
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
      adminTool("set_github_app_slug", "GitHub App のページ（https://github.com/apps/<名前>、Install のページを開くため。null で消す）", {
        slug: { type: ["string", "null"] },
      }, ["slug"]),
      adminTool("github_app_installations", "ブラウザでログインのアカウントの、GitHub App が Install されている先・権限・Install のページ", {
        login: { type: "string" },
      }, ["login"]),
      adminTool("start_github_login", "ブラウザでログイン（デバイスフロー）を始める。コードと開く URL を返す", { ssh: PLACE_SCHEMA }),
      adminTool("poll_github_login", "ブラウザでログインの結果を1回聞く（間隔より早ければ待ってから）", { flowId: { type: "string" } }, ["flowId"]),
      adminTool("cancel_github_login", "ブラウザでログインをやめる", { flowId: { type: "string" } }, ["flowId"]),
      adminTool("verify_github_account", "今使えるトークンで GitHub に login を確かめる（期限が近ければ更新する）", { login: { type: "string" } }, [
        "login",
      ]),
      // ── 始める手（段階3）：URL から clone・新しいリポジトリ。clone は背景の仕事で、画面が進み具合を聞きに来る ──
      adminTool("inspect_clone", "その URL を clone すると何が起きるか（もう手元にある・clone し直す・置く場所とそこにあるもの）", {
        source: { type: "string" },
        folder: { type: "string" },
      }, ["source"]),
      adminTool("start_clone", "clone を始める（account は GitHub の login、null でアカウントを使わない）", {
        source: { type: "string" },
        folder: { type: "string" },
        account: { type: ["string", "null"] },
      }, ["source"]),
      adminTool("clone_status", "clone の進み具合と結果", { jobId: { type: "string" } }, ["jobId"]),
      adminTool("cancel_clone", "clone をやめる（途中まで作ったフォルダは消す）", { jobId: { type: "string" } }, ["jobId"]),
      adminTool("inspect_new_repository", "その名前で新しいリポジトリを作ると何が起きるか（checkGithub で GitHub に同じ名前があるかも聞く）", {
        name: { type: "string" },
        checkGithub: { type: "boolean" },
      }, ["name"]),
      adminTool("create_repository", "置き場に空のリポジトリを作り（git init）、一覧に足す", { name: { type: "string" } }, ["name"]),
      // ── 段階4：アカウントを後から指定・このマシンから削除 ──
      adminTool("set_repository_account", "その行を扱うアカウントを指定する（null で読むだけに戻す）。見えないアカウントは断る", {
        path: { type: "string" },
        login: { type: ["string", "null"] },
      }, ["path", "login"]),
      adminTool("inspect_delete", "このマシンから削除すると失われるもの（と、消せない理由）", { path: { type: "string" } }, ["path"]),
      adminTool("delete_repository", "このマシンから削除する（フォルダごと。直前にもう一度調べ、要る確かめが無ければ断る）", {
        path: { type: "string" },
        confirmed: { type: "boolean" },
        typedName: { type: "string" },
      }, ["path", "confirmed"]),
      // ── 段階5：GitHub に公開。path を省くと、押した画面の Project（host の刻印）の Root を含む行 ──
      adminTool("inspect_publish", "そのフォルダを GitHub に公開できるか（いまのブランチ・origin・断る理由）", { path: { type: "string" } }),
      adminTool("publish_targets", "公開に使えるアカウントと、その持ち主（自分・Organization）にリポジトリを作れそうか", { path: { type: "string" } }),
      adminTool("check_publish_name", "GitHub にその名前が空いているか（あれば空いている名前を出す）", {
        login: { type: "string" },
        owner: { type: "string" },
        name: { type: "string" },
      }, ["login", "owner", "name"]),
      adminTool("start_publish", "GitHub に空のリポジトリを作り、origin を足して、いまのブランチを push する", {
        path: { type: "string" },
        login: { type: "string" },
        owner: { type: "string" },
        name: { type: "string" },
        private: { type: "boolean" },
        description: { type: "string" },
      }, ["path", "login", "owner", "name", "private"]),
      adminTool("publish_status", "公開の進み具合と結果", { jobId: { type: "string" } }, ["jobId"]),
      adminTool("cancel_publish", "push をやめる（GitHub に作ったリポジトリは消さない）", { jobId: { type: "string" } }, ["jobId"]),
      adminTool("retry_push", "push だけやり直す（GitHub の origin はあるが、いまのブランチが GitHub にまだ無い）", { path: { type: "string" } }, ["path"]),
      // ── Backlog のブランチ（§2.4「ブランチを送る口」）。**中継からだけ**（可視性 module）。ブランチ名を識別子として
      // 名乗る——中継のゲートは、コンテナからの呼び出しをブランチごとに初回だけ人に聞く ──
      branchTool("push_branch", "呼び出し元の Project のリポジトリの、そのブランチだけを origin へ送る（force しない）"),
      branchTool("fetch_branch", "呼び出し元の Project のリポジトリの origin から、そのブランチだけを refs/remotes/origin/<branch> に取ってくる"),
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
      if (name === "push_branch" || name === "fetch_branch") {
        // **Project のための呼び出しだけ**（AI のターンでも人の画面でも）。どの Project かは host に聞き、刻印と照らす
        const stamped = caller && "project" in caller ? caller.project : caller && "admin" in caller ? caller.forProject : undefined;
        if (!stamped) throw new Error(`${name} は Project のための呼び出しからだけ呼べます`);
        if (!deps.projects.callerProject) throw new Error("この Repositories は呼び出し元の Project を引く口を持っていません");
        const project = await deps.projects.callerProject(callIdOf(meta));
        if (project.id !== stamped) throw new Error(`呼び出しの刻印の Project（${stamped}）と、host の台帳の Project（${project.id}）が違います`);
        return json(await branchSync.sync(name === "push_branch" ? "push" : "fetch", str(args.branch, "branch"), project, callIdOf(meta)));
      }
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
        case "inspect_clone":
          return json(
            await cloner.inspect(
              { source: str(args.source, "source"), ...(typeof args.folder === "string" ? { folder: args.folder } : {}) },
              await lookupProjects(meta),
            ),
          );
        case "start_clone":
          return json(
            await cloner.start(
              {
                source: str(args.source, "source"),
                ...(typeof args.folder === "string" ? { folder: args.folder } : {}),
                ...(args.account === null ? { account: null } : typeof args.account === "string" ? { account: args.account } : {}),
              },
              callIdOf(meta),
            ),
          );
        case "clone_status":
          return json(cloner.status(str(args.jobId, "jobId")));
        case "cancel_clone":
          return json(cloner.cancel(str(args.jobId, "jobId")));
        case "inspect_new_repository":
          return json(
            await cloner.inspectNew({ name: typeof args.name === "string" ? args.name : "", checkGithub: args.checkGithub === true }, callIdOf(meta)),
          );
        case "create_repository":
          return json(await cloner.create({ name: str(args.name, "name") }));
        case "set_repository_account":
          return json(
            await setRepositoryAccount(
              { store, accounts, github: deps.github },
              { path: str(args.path, "path"), login: args.login === null ? null : str(args.login, "login") },
              callIdOf(meta),
            ),
          );
        case "inspect_delete":
          return json(await inspectDelete(store, str(args.path, "path"), await lookupProjects(meta), home));
        case "delete_repository":
          return json(
            await deleteRepository(
              store,
              {
                path: str(args.path, "path"),
                confirmed: args.confirmed === true,
                ...(typeof args.typedName === "string" ? { typedName: args.typedName } : {}),
              },
              await lookupProjects(meta),
              home,
            ),
          );
        case "inspect_publish":
        case "publish_targets": {
          // 行き先のフォルダ：画面が言ったもの、無ければ刻印の Project の Root（画面は別の Project を名乗れない）
          const forProject = "forProject" in caller ? caller.forProject : undefined;
          const path = await publisher.resolveFolder(
            { ...(typeof args.path === "string" && args.path ? { path: args.path } : {}), ...(forProject ? { forProject } : {}) },
            typeof args.path === "string" && args.path ? { ok: true, projects: [] } : await lookupProjects(meta),
          );
          return json(name === "inspect_publish" ? await publisher.inspect(path) : await publisher.targets(path, callIdOf(meta)));
        }
        case "check_publish_name":
          return json(await publisher.checkName({ login: str(args.login, "login"), owner: str(args.owner, "owner"), name: str(args.name, "name") }, callIdOf(meta)));
        case "start_publish":
          if (typeof args.private !== "boolean") throw new Error("private（公開か非公開か）が要ります");
          return json(
            await publisher.start(
              {
                path: str(args.path, "path"),
                login: str(args.login, "login"),
                owner: str(args.owner, "owner"),
                name: str(args.name, "name"),
                private: args.private,
                ...(typeof args.description === "string" ? { description: args.description } : {}),
              },
              callIdOf(meta),
            ),
          );
        case "publish_status":
          return json(publisher.status(str(args.jobId, "jobId")));
        case "cancel_publish":
          return json(publisher.cancel(str(args.jobId, "jobId")));
        case "retry_push":
          return json(await publisher.retryPush({ path: str(args.path, "path") }, callIdOf(meta)));
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
        case "set_github_app_slug":
          return json(await accounts.setAppSlug(args.slug === null ? null : str(args.slug, "slug")));
        case "github_app_installations":
          return json(await accounts.installations(str(args.login, "login"), callIdOf(meta)));
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
        // **Project の画面の入口**（段階5）——その Project の Root を GitHub に公開する。どの Project かは、押した画面の
        // 呼び出しに host が刻む Project で決める（画面の申告ではない）
        uri: PUBLISH_APP_URI,
        name: "この Project を GitHub に公開",
        description: "この Project の Root のリポジトリを、GitHub に作って push します",
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
      // **core の新しい Project の画面に差し出す始め方**（段階4、§2.4「core との境目」）。名前・説明・アイコンは
      // ここで名乗る——core は「clone」という言葉を持たない。用意できたら画面が `dev.banto/folder-prepared` で返す
      {
        uri: PREPARE_CLONE_URI,
        name: "clone",
        description: "GitHub などのリポジトリを、リポジトリの置き場に clone します。",
        mimeType: UI_APP_MIME,
        icons: [{ src: iconDataUri(CLONE_ICON), mimeType: "image/svg+xml" }],
        _meta: { [VISIBILITY_META_KEY]: "admin", [CANVAS_META_KEY]: "folder-provider", ui: { prefersBorder: false } },
      },
      {
        uri: PREPARE_CREATE_URI,
        name: "新しいリポジトリ",
        description: "リポジトリの置き場に作って git init します。GitHub へは、あとで公開できます。",
        mimeType: UI_APP_MIME,
        icons: [{ src: iconDataUri(CREATE_ICON), mimeType: "image/svg+xml" }],
        _meta: { [VISIBILITY_META_KEY]: "admin", [CANVAS_META_KEY]: "folder-provider", ui: { prefersBorder: false } },
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
    if (uri === PUBLISH_APP_URI) return { contents: [{ uri, mimeType: UI_APP_MIME, text: repositoriesAppHtml("publish") }] };
    if (uri === PREPARE_CLONE_URI) return { contents: [{ uri, mimeType: UI_APP_MIME, text: repositoriesAppHtml("prepare-clone") }] };
    if (uri === PREPARE_CREATE_URI) return { contents: [{ uri, mimeType: UI_APP_MIME, text: repositoriesAppHtml("prepare-create") }] };
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
  const { httpGithub } = await import("./github.js");
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
  if (web && api) {
    // 偽の GitHub から clone したものも GitHub のものと読む
    const { registerGithubHost } = await import("./remote.js");
    registerGithubHost(new URL(web).host);
  }
  const relay = new HostRelay(hostUrl, hostToken);
  const server = createRepositoriesServer({
    dataDir,
    projects: relay,
    vault: new RelayVault(relay),
    github: httpGithub(web && api ? { web, api } : GITHUB_COM),
    githubEndpoints: web && api ? { web, api } : GITHUB_COM,
    notices: relay,
  });
  await server.connect(new StdioServerTransport());
}
