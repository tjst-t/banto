#!/usr/bin/env node
// docs/specs/v4-modules.md §4.2 Service——動き続けるもの（開発サーバ・監視・キュー処理）を起こしておく。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MODULE_META_KEY, VISIBILITY_META_KEY } from "@banto/module-contract";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ServiceManager, type ManagerDeps } from "./manager.js";
import { ServiceError } from "./spec.js";
import { ServiceStore } from "./store.js";
import { RealSystemctl } from "./systemd.js";

/** Module の環境から、サービスの定義に写すもの（Claude のログインの中継——v4-security.md §2） */
export const INHERITED_ENV_NAMES = [
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_SUBSCRIPTION_TYPE",
  "CLAUDE_CODE_RATE_LIMIT_TIER",
];

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
        uri: "service://module",
        name: "この Module の申告",
        mimeType: "application/json",
        _meta: {
          [VISIBILITY_META_KEY]: "admin",
          [MODULE_META_KEY]: {
            satisfies: ["service"],
            // envSecrets を解決するので Shell と同じく窓口と金庫の両方に繋ぐ
            dependsOn: [
              { role: "vault-directory", required: true },
              { role: "vault", required: true },
            ],
            isolation: "subprocess",
            scope: "project",
            confinement: { kind: "landlock", root: "project", profile: "exec" },
          },
        },
      },
    ],
  }));

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
        description: "サービスを止めて登録を消す。ログも消える",
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
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const progressToken = extra._meta?.progressToken;
    const onProgress =
      progressToken !== undefined
        ? (message: string) => {
            void extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: 0, message } });
          }
        : undefined;
    const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
    try {
      try {
        await ensureReady();
      } catch (err) {
        throw new ServiceError(`Service が使えません（この Project のコンテナの systemd を用意できませんでした）: ${(err as Error).message}`);
      }
      switch (request.params.name) {
        case "startService":
          return text(await manager.start(args, onProgress));
        case "stopService":
          return text(await manager.stop(args.name));
        case "restartService":
          return text(await manager.restart(args.name, onProgress));
        case "removeService":
          return text(await manager.remove(args.name));
        case "listServices":
          return text({ services: await manager.list() });
        case "readServiceLogs":
          return text(await manager.logs(args.name, args.tail));
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
  };
  const manager = new ServiceManager(deps);
  const prepare = noSystemd
    ? () => Promise.reject(new Error("BANTO_SERVICE_NO_SYSTEMD=1 のため systemd を使いません"))
    : () => systemctl.ensureUserManager().then(() => manager.prepare());
  await createServiceServer(manager, prepare).connect(new StdioServerTransport());
}
