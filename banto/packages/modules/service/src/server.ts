#!/usr/bin/env node
// docs/specs/v4-modules.md §4.2 Service——動き続けるもの（開発サーバ・監視・キュー処理）を起こしておく。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CANVAS_META_KEY,
  EventOutbox,
  EventPublisher,
  FILE_RANGE_MAX_BYTES,
  MODULE_META_KEY,
  VISIBILITY_META_KEY,
  callIdOf,
} from "@banto/module-contract";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ServiceManager, type ManagerDeps } from "./manager.js";
import { ServiceError } from "./spec.js";
import { SERVICES_APP_HTML, SERVICES_APP_URI } from "./services-app.js";
import { ServiceStore } from "./store.js";
import { RealSystemctl } from "./systemd.js";
import { outboxDir } from "./unit.js";

/** Module の環境から、サービスの定義に写すもの（Claude のログインの中継——v4-security.md §2） */
export const INHERITED_ENV_NAMES = [
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  // API キーのアカウントのときの合言葉（キーそのものではない。v4-distribution.md §3）
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_SUBSCRIPTION_TYPE",
  "CLAUDE_CODE_RATE_LIMIT_TIER",
];

/** MCP Apps の画面の資源の型 */
const UI_APP_MIME = "text/html;profile=mcp-app";

/** 出口の箱を見回る間隔。起動役が落ちた出来事を書いてから host に届くまでの遅れ */
const OUTBOX_POLL_MS = 3000;

const NAME_DESC = "サービスの名前。英小文字・数字・ハイフン（例 \"web\"）。以降この名前で操作する";

/**
 * `ready` は systemd の用意（linger・写しの突き合わせ）。**待たずに口を開く**——systemd が使えないときも
 * 名乗りと一覧は返し、道具を呼ばれたら理由つきで断る（規則2。立たないと設定も理由も見えない）
 */
export function createServiceServer(manager: ServiceManager, prepare: () => Promise<void> = async () => {}) {
  // **成功だけを覚える**——失敗したら次の呼び出しでやり直す（一度の失敗で Module を起こし直すまで使えなくならない）
  let ready: Promise<void> | undefined;
  const ensureReady = () => {
    if (!ready) {
      ready = prepare();
      ready.catch(() => {
        ready = undefined;
      });
    }
    return ready;
  };
  void ensureReady();
  const server = new Server({ name: "banto-module-service", version: "0.1.0" }, { capabilities: { tools: {}, resources: {} } });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        // **入口「サービス」**（launcher、決定・2026-10-20、v4-modules.md §4.2「人の画面——サービス」）——Command Palette の
        // 「Module の入口」から、AI を介さずに開く。一覧・操作は AI と同じ tool を、ログは画面用の readServiceLog を呼ぶ
        uri: SERVICES_APP_URI,
        name: "サービス",
        description: "この Project で動かしているサービスの状態・ポート・ログを見て、起動・停止する",
        mimeType: UI_APP_MIME,
        _meta: { [VISIBILITY_META_KEY]: "admin", [CANVAS_META_KEY]: "launcher", ui: { prefersBorder: false } },
      },
      {
        uri: "service://module",
        name: "この Module の申告",
        mimeType: "application/json",
        _meta: {
          [VISIBILITY_META_KEY]: "admin",
          [MODULE_META_KEY]: {
            satisfies: ["service"],
            // envSecrets を解決するので Shell と同じく窓口と金庫の両方に繋ぐ。
            // 登録を消すときは公開の窓口に知らせる（公開が無い Project では繋がらなくてよい）
            dependsOn: [
              { role: "vault-directory", required: true },
              { role: "vault", required: true },
              { role: "publish-directory", required: false },
            ],
            isolation: "subprocess",
            scope: "project",
            confinement: { kind: "landlock", root: "project", profile: "exec" },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== SERVICES_APP_URI) throw new Error(`unknown resource: ${request.params.uri}`);
    return { contents: [{ uri: SERVICES_APP_URI, mimeType: UI_APP_MIME, text: SERVICES_APP_HTML }] };
  });

  const agent = { [VISIBILITY_META_KEY]: "agent" };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "startService",
        description:
          "**動き続けるもの（開発サーバ・ファイルの監視など）を起こしておく。** runCommand は1回で終わるので、" +
          "後ろに起動したものは頼れない——止めるまで動かしたいものはこちらで起こす。この Project のコンテナの中で、" +
          "落ちたら自動で起こし直し、コンテナを起こし直しても起きる。**初めての名前なら登録して起動（command が要る）、登録済みなら起動するだけ**——登録済みの名前は name だけで起こせる。" +
          "書いた項目が登録と違うと断る（変えるなら removeService してから）。秘密は envSecrets に Vault の alias 名で渡す" +
          "（値を command に書かない）。外から見られるようにするのは別の仕組み（Publish）で、ports に書いたものが候補になる",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: NAME_DESC },
            command: { type: "string", description: "/bin/sh に渡す文字列（例 \"npm run dev -- --port 3000\"）。`&` や nohup で背景にしない——手前で動き続けるものをそのまま書く。登録済みの名前なら省略可" },
            cwd: { type: "string", description: "Project root からの相対パス。省略時は root" },
            ports: { type: "array", items: { type: "number" }, description: "待ち受けるポート（例 [3000]）。他のサービスと重ならないこと" },
            envSecrets: {
              type: "object",
              additionalProperties: { type: "string" },
              description: '環境変数名 → Vault の alias 名。例：{"OPENAI_API_KEY": "openai"}。**値ではなく alias 名を書く。** 止めるまでプロセスの環境に残る',
            },
          },
          required: ["name"],
        },
        _meta: agent,
      },
      {
        name: "stopService",
        description: "サービスを止める。登録は残る（startService に name だけ渡せばまた起きる）。コンテナを起こし直しても起きない",
        inputSchema: { type: "object", properties: { name: { type: "string", description: NAME_DESC } }, required: ["name"] },
        _meta: agent,
      },
      {
        name: "restartService",
        description: "サービスを止めて起こし直す。envSecrets の値は Vault から引き直す（鍵を替えたときもこれ）。落ちて止まったものもこれで起きる",
        inputSchema: { type: "object", properties: { name: { type: "string", description: NAME_DESC } }, required: ["name"] },
        _meta: agent,
      },
      {
        name: "removeService",
        description:
          "サービスを止めて登録を消す。ログも消える。**公開（publishService）していたら、その公開もやめる**" +
          "（やめられなければ登録は消さずに理由を返す）。止めるだけなら stopService（公開は残る）",
        inputSchema: { type: "object", properties: { name: { type: "string", description: NAME_DESC } }, required: ["name"] },
        _meta: agent,
      },
      {
        name: "listServices",
        description:
          "登録したサービスの一覧と状態。state は running（動いている）／starting／restarting（落ちて起こし直し中）／crashed（落ちて上限に当たった）／" +
          "exited（自分で終わった）／stopped（stopService した）／stopped-externally（人やプログラムが中で止めた）／not-started。" +
          "ports のうち実際に待ち受けているものが listening、いないものが notListening",
        inputSchema: { type: "object", properties: {} },
        _meta: agent,
      },
      {
        name: "readServiceLogs",
        description: "サービスのログの末尾（標準出力と標準エラー、時刻つき）。全体は返り値の logFile にあり、runCommand の grep でも読める",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: NAME_DESC },
            tail: { type: "number", description: "末尾の行数。省略時は 100、最大 2000" },
          },
          required: ["name"],
        },
        _meta: agent,
      },
      {
        // **人の画面がログを読む口**（AI には見せない——AI は readServiceLogs）。読むだけなので操作の列に並ばない
        name: "readServiceLog",
        description:
          `サービスのログ（file: "log" か、回した前の "log.1"）の一部を読む。fromByte から maxBytes（1回 ${FILE_RANGE_MAX_BYTES} バイトまで）、` +
          "fromByte を省けば末尾。UTF-8 の文字の切れ目で切る。返り値は text・fromByte・toByte・size（全体の大きさ）・generation" +
          "（ファイルの世代——回すと変わる。変わったら頭から読み直す）",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: NAME_DESC },
            file: { type: "string", enum: ["log", "log.1"] },
            fromByte: { type: "number" },
            maxBytes: { type: "number" },
          },
          required: ["name"],
        },
        _meta: { [VISIBILITY_META_KEY]: "admin" },
      },
      {
        // **人の管理操作だけ**（AI には見せない）。host が Project を別の実行場所へ移す前に呼ぶ
        name: "disableAllServices",
        description:
          "登録した全サービスを「止めておきたい」にし、自動起動から外す（動いていれば止める）。Project を別の実行場所へ移す前に banto が呼ぶ。" +
          "返り値の disabled は、動かす設定から止める設定に変えたものの名前",
        inputSchema: { type: "object", properties: {} },
        _meta: { [VISIBILITY_META_KEY]: "admin" },
      },
      {
        // **人の管理操作だけ**（AI には見せない）。host が別のサーバの Project を閉じるときに呼ぶ
        name: "suspendAllServices",
        description:
          "登録した全サービスを止めて自動起動から外し、unit を消す。登録（動かしておきたいか）は変えない——次に Module が起きたとき" +
          "登録から unit を作り直し、動かしておきたいものは起こす。Project を閉じるときに banto が呼ぶ。返り値の suspended は止めた・自動起動から外したものの名前",
        inputSchema: { type: "object", properties: {} },
        _meta: { [VISIBILITY_META_KEY]: "admin" },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const progressToken = extra._meta?.progressToken;
    // この呼び出しの印（起こしたら登録に残し、落ちた出来事の causedBy に添える）
    const callId = callIdOf(request.params._meta as Record<string, unknown> | undefined);
    const onProgress =
      progressToken !== undefined
        ? (message: string) => {
            void extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: 0, message } });
          }
        : undefined;
    const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
    try {
      // **ログを読むだけなら systemd の用意を待たない**（用意は操作の列に並ぶ——読むのを待たせない）
      if (request.params.name === "readServiceLog") return text(await manager.readLog(args));
      try {
        await ensureReady();
      } catch (err) {
        throw new ServiceError(`Service が使えません（この Project のコンテナの systemd を用意できませんでした）: ${(err as Error).message}`);
      }
      switch (request.params.name) {
        case "startService":
          return text(await manager.start(args, onProgress, callId));
        case "stopService":
          return text(await manager.stop(args.name));
        case "restartService":
          return text(await manager.restart(args.name, onProgress, callId));
        case "removeService":
          return text(await manager.remove(args.name));
        case "listServices":
          return text({ services: await manager.list() });
        case "readServiceLogs":
          return text(await manager.logs(args.name, args.tail));
        case "disableAllServices":
          return text(await manager.disableAll());
        case "suspendAllServices":
          return text(await manager.suspendAll());
        default:
          throw new Error(`unknown tool: ${request.params.name}`);
      }
    } catch (err) {
      // 頼み方の誤り・systemd の断りは、理由ごと AI に返す（黙って空を返さない）
      if (err instanceof ServiceError) return { content: [{ type: "text", text: err.message }], isError: true };
      throw err;
    }
  });

  return server;
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const projectRoot = process.env.BANTO_PROJECT_ROOT;
  const hostUrl = process.env.BANTO_HOST_MCP_URL;
  const hostToken = process.env.BANTO_HOST_MCP_TOKEN;
  const dataDir = process.env.BANTO_MODULE_DATA_DIR;
  if (!projectRoot || !hostUrl || !hostToken || !dataDir) {
    console.error("BANTO_PROJECT_ROOT, BANTO_HOST_MCP_URL, BANTO_HOST_MCP_TOKEN, BANTO_MODULE_DATA_DIR が必要です");
    process.exit(1);
  }
  // Shell と同じ中継の口（index.js は Shell の起動部分を持つので、中の1ファイルだけ使う）
  const { HostRelayClient } = await import("@banto/module-shell/dist/host-relay-client.js");
  const relay = new HostRelayClient({ url: hostUrl, token: hostToken });
  const { hostRelayCall, withdrawPublications } = await import("./publish-notice.js");
  const relayCall = hostRelayCall(hostUrl, hostToken);
  const systemctl = new RealSystemctl();
  // **試験で本物の systemd を触らない印**（core の申告の試験は名乗りだけを読む。触ると、その機械の本物の
  // `~/.config/systemd/user` にある写しを片付けてしまう——Fable のレビュー）
  const noSystemd = process.env.BANTO_SERVICE_NO_SYSTEMD === "1";
  // **置き場はコンテナの中のローカル**——`HOME` は host のディスク（Module の置き場）を指しているので使わない。
  // systemd のユーザー単位も passwd のホームを見る
  const home = userInfo().homedir;
  const inheritedEnv: Record<string, string> = {};
  for (const n of INHERITED_ENV_NAMES) if (process.env[n]) inheritedEnv[n] = process.env[n]!;
  const deps: ManagerDeps = {
    projectRoot,
    store: new ServiceStore(dataDir),
    systemctl,
    // **置き場はホームの直下**——`~/.local` は Incus が Module の置き場をマウントするときに root の持ち物で作る
    // ので、その下には書けない（実測・2026-09-27：`mkdir ~/.local/state` が EACCES）
    paths: { unitDir: join(home, ".config/systemd/user"), stateDir: join(home, ".banto-service") },
    nodePath: process.execPath,
    wrapperPath: fileURLToPath(new URL("./log-wrapper.js", import.meta.url)),
    inheritedEnv,
    moduleName: process.env.BANTO_MODULE_NAME || "service",
    async resolveSecret(envName, alias, onProgress) {
      const note = (n: string) => onProgress?.(`envSecrets: ${envName}——${n}`);
      const place = await relay.lookupAlias("vault-directory", alias, note);
      return relay.resolveAlias(place, note);
    },
    withdrawPublications: (name) => withdrawPublications(relayCall, name),
  };
  const manager = new ServiceManager(deps);
  // **落ちた出来事を host へ出す**（アーキ仕様 §4.3、Backlog #347）。起動役が出口の箱に書いたものを、繋がったとき・見回りの
  // たびに古い順に出す——Module が寝ていた間に落ちた分も、起きたときに届く。起動役は別のプロセスなので、こちらは箱を見回る
  new EventPublisher({
    outbox: new EventOutbox({ dir: outboxDir(deps.paths), log: (m) => console.error(m) }),
    relay: relayCall,
    intervalMs: OUTBOX_POLL_MS,
    log: (m) => console.error(m),
  }).start();
  const prepare = noSystemd
    ? () => Promise.reject(new Error("BANTO_SERVICE_NO_SYSTEMD=1 のため systemd を使いません"))
    : () => systemctl.ensureUserManager().then(() => manager.prepare());
  await createServiceServer(manager, prepare).connect(new StdioServerTransport());
}
