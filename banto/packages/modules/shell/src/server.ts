#!/usr/bin/env node
// docs/specs/v4-modules.md §2.3 Shell のインターフェース。AI の tool は `runCommand` と、待たずに流したコマンドの
// 一覧・止める口（`listCommands`・`cancelCommand`、追加・2026-10-07）。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  CARD_META_KEY,
  DELIVERS_LATER_META_KEY,
  MODULE_META_KEY,
  PENDING_REPLY_META_KEY,
  RESUME_AFTER_RESTART_TOOL,
  VISIBILITY_META_KEY,
  callerModuleOf,
  isHostResumeCall,
  parseResumeQuestion,
  replyToOf,
  threadOf,
} from "@banto/module-contract";
import { runCommand, runCommandInBackground } from "./run-command.js";
import { HostRelayClient } from "./host-relay-client.js";
import { BackgroundCommandError, BackgroundCommands } from "./background.js";
import { SystemdLauncher } from "./background-launcher.js";

export interface ShellServerDeps {
  projectRoot: string;
  relayClient: HostRelayClient;
  homeDir?: string;
  inContainer?: boolean;
  /**
   * **待たずに流したコマンド**（追加・2026-10-07、v4-modules.md §2.3「待たない形」）。無ければ待たない形は断る
   * （`backgroundUnavailable` の理由で）——黙って待つ形に落とさない
   */
  background?: BackgroundCommands;
  backgroundUnavailable?: string;
}

/** 頼み方の誤りは AI に理由ごと返す（黙って空を返さない） */
class ShellRefusal extends Error {}

export function createShellServer(deps: ShellServerDeps) {
  const server = new Server(
    { name: "banto-module-shell", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  // **自分が何者かを名乗る**（決定・2026-09-06）。host は宣言（Config）と
  // 突き合わせ、より厳しい方向の申告だけを採る。AI には見せない（admin）。
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: "shell://module",
        name: "この Module の申告",
        mimeType: "application/json",
        _meta: {
          [VISIBILITY_META_KEY]: "admin",
          [MODULE_META_KEY]: {
            satisfies: ["shell"],
            // **窓口と金庫の両方に繋ぐ**（改訂・2026-09-12）。在りかは
            // `vault-directory` に聞き、値はその金庫から直接受け取る
            // ——どちらが欠けても秘密は渡せないので、両方 required
            dependsOn: [
              { role: "vault-directory", required: true },
              { role: "vault", required: true },
            ],
            isolation: "subprocess",
            scope: "project",
            confinement: { kind: "landlock", root: "project", profile: "exec" },
            // 待たずに流したコマンドは、banto を起こし直しても続けられる（追加・2026-10-07、アーキ仕様 §2.5「2.」）
            // ——コマンドは systemd が持ち、終わりは必ず札で届ける
            resumesAfterRestart: true,
          },
        },
      },
    ],
  }));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "runCommand",
        // **引数の説明は、AI がこの Module を使えるかどうかそのもの**
        // （追加・2026-09-12、ユーザー指摘「AI が Vault の使い方を分かっていない」）。
        // 以前は `envSecrets: { type: "object" }` としか書いていなかったので、
        // 「何を鍵にして何を値にするのか」も「値を書いてはいけない」ことも
        // 伝わりようがなかった。**秘密の使い方の説明はここにある**
        // ——system prompt は個々の tool を語らない（決定・2026-09-05、規則3）。
        description:
          "コマンドを実行する。**この Project 専用のコンテナの中で動く**（Ubuntu。見えるのはこの Project のフォルダと、" +
          "コンテナに入れた道具だけ——人の機械のほかのファイルは無い）。要る道具は sudo apt-get install などで入れてよい" +
          "（入れたものはこの Project のコンテナに残る）。" +
          "**秘密（トークン・鍵）が要るときは、値を command に書かず、Vault の alias 名を " +
          "envSecrets / secretFiles / sshIdentity に渡す**——値は Vault から直接この子プロセスへ渡り、" +
          "あなたの文脈には出ない。使える alias の一覧は resource `vault://aliases`。" +
          "必要な alias が無ければ requestAlias で人に登録を頼む。" +
          "**出力が長いとき**（stdout と stderr の合計が 3万文字超）は、長いほうの頭と末尾だけを返し、" +
          "全体は stdoutFile / stderrFile のファイルに残す——grep や sed -n で読む（同じコマンドを打ち直さない）。" +
          "**長いコマンド（数分〜数時間のビルド・試験の繰り返しなど）は runInBackground: true で待たずに流せる**——" +
          "すぐ commandId と outputFile が返り、終わったら終了コードと出力の末尾 50 行がこの会話に届いて、あなたが起こされる" +
          "（届くまで他の仕事を続けてよい。結果を待つために同じコマンドを流し直さない。`&` で後ろに回さない）。" +
          "途中の様子は outputFile を tail・grep で読む。流したものの一覧は listCommands、止めるのは cancelCommand。",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "/bin/sh -c に渡す文字列" },
            cwd: { type: "string", description: "Project root からの相対パス。省略時は root そのもの" },
            timeout: {
              type: "number",
              description: "秒。超えると SIGTERM で止める。省略時は 120（runInBackground のときは上限なし）",
            },
            envSecrets: {
              type: "object",
              description:
                '環境変数名 → Vault の alias 名。例：{"GITHUB_TOKEN": "github-token"}。' +
                "**値ではなく alias 名を書く。** その環境変数だけがこのコマンドに渡り、結果には現れない",
              additionalProperties: { type: "string" },
            },
            secretFiles: {
              type: "object",
              description:
                'Project root からの相対パス → Vault の alias 名。例：{".npmrc": "npm-token"}。' +
                "その alias の中身をファイル（0600）として書き出し、**コマンドが終わったら消す**",
              additionalProperties: { type: "string" },
            },
            sshIdentity: {
              type: "string",
              description:
                "kind が ssh-identity の alias 名。ssh-agent を立てて SSH_AUTH_SOCK を渡す" +
                "（git push 等に使う）。**秘密鍵はファイルにもあなたの文脈にも出ない**",
            },
            runInBackground: {
              type: "boolean",
              description:
                "true なら待たない。すぐ commandId と outputFile（stdout と stderr を出た順に書くファイル）を返し、" +
                "終わったら終了コードと出力の末尾がこの会話に届く（既定 false：終わるまで待つ）",
            },
          },
          required: ["command"],
        },
        // **待たない形の終わりは、host が渡す返信用の札で届ける**（追加・2026-10-07、アーキ仕様 §4.2）。札は呼び出しの
        // たびに渡るが、「あとで届ける」と返すのは runInBackground のときだけ（runSubagent と同じ名乗り方）。
        // カードの題はサイドバーのバックグラウンドの印に出る（v4-frontend.md §6.33）——Shell は画面を持たないので、
        // 会話の表示は変わらない
        _meta: {
          [VISIBILITY_META_KEY]: "agent",
          [DELIVERS_LATER_META_KEY]: true,
          [CARD_META_KEY]: { title: "{command}" },
        },
      },
      {
        name: "listCommands",
        description:
          "runCommand の runInBackground で待たずに流したコマンドの一覧（この会話（Thread）で流したものだけ、新しい順に 20 件まで）。" +
          "commandId・command・cwd・startedAt・status（running：動いている／exited：終わった（exitCode）／timedOut：時間切れ／" +
          "cancelled：cancelCommand で止めた／stopped：外から止められた／lost：終わり方の記録が無い）・outputFile",
        inputSchema: { type: "object", properties: {} },
        _meta: { [VISIBILITY_META_KEY]: "agent" },
      },
      {
        // **止められるのは流した Thread からだけ**——同じ Project の別の Thread（Fork）が、id を知っただけで止められない
        // ように（cancelSubagent と同じ形）。どの Thread からの呼び出しかは host が刻む印（`dev.banto/thread`）で見る
        name: "cancelCommand",
        description:
          "runCommand の runInBackground で待たずに流したコマンドを止める（cgroup ごと SIGTERM、10 秒で SIGKILL）。" +
          "**止められるのは、この会話（Thread）で流したものだけ**。止めると「止めました」と出力の末尾がこの会話に届く",
        inputSchema: {
          type: "object",
          properties: { commandId: { type: "string", description: "止めるコマンドの id（runCommand の返り値の commandId）" } },
          required: ["commandId"],
        },
        _meta: { [VISIBILITY_META_KEY]: "agent" },
      },
      // ---- host が起き直したときに呼ぶ（admin——AI には見せない） ----------------------------
      {
        // **起こし直しても続けられる**（追加・2026-10-07、アーキ仕様 §2.5「2.」、`@banto/module-contract` の `resume.ts`）。
        // host が、待たずに流して届けると約束したまま終わっていないコマンドを渡す
        name: RESUME_AFTER_RESTART_TOOL,
        description: "banto を起こし直したあと、待たずに流したコマンドの結果を届け続けるかを答える（host だけが呼ぶ）",
        inputSchema: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  replyTo: { type: "string" },
                  toolName: { type: "string" },
                  toolCallId: { type: "string" },
                  thread: { type: "object", properties: { projectId: { type: "string" }, threadId: { type: "string" } } },
                },
                required: ["replyTo"],
              },
            },
          },
          required: ["items"],
        },
        _meta: { [VISIBILITY_META_KEY]: "admin" },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const meta = request.params._meta as Record<string, unknown> | undefined;
    try {
      if (request.params.name === "listCommands") {
        const background = requireBackground();
        // **一覧も流した Thread の分だけ**（決定・2026-10-07）——止められるのも同じ範囲。Thread の印が無い呼び出しは全部
        const owner = threadOf(meta);
        return text({ commands: background.list(owner) });
      }
      if (request.params.name === "cancelCommand") {
        const background = requireBackground();
        const id = String((request.params.arguments ?? {}).commandId ?? "");
        const found = background.get(id);
        if (!found) throw new ShellRefusal(`コマンド "${id}" はありません`);
        const callerModule = callerModuleOf(meta);
        if (callerModule) {
          // 中継で流したものは、流した Module（接続名）からだけ
          if (found.record.requestedByModule?.conn !== callerModule.conn) {
            throw new ShellRefusal("このコマンドは、この Module が流したものではないので止められません");
          }
        } else {
          // **流した Thread と呼び出し元の Thread が同じときだけ**。どちらかの印が無ければ確かめられないので断る（fail closed）
          const caller = threadOf(meta);
          if (!caller) {
            throw new ShellRefusal("どの会話からの呼び出しか分からないため止められません（banto がこの呼び出しに Thread の印を付けていない）");
          }
          const owner = found.record.requestedBy;
          if (!owner || owner.projectId !== caller.projectId || owner.threadId !== caller.threadId) {
            throw new ShellRefusal(
              "このコマンドは別の会話（Thread）が流したものなので、ここからは止められません。止められるのは、この会話で流したものだけです",
            );
          }
        }
        const after = await background.cancel(id);
        return text({ ok: true, ...after, note: "止めました。「止めました」と出力の末尾がこの会話に届きます" });
      }
      if (request.params.name === RESUME_AFTER_RESTART_TOOL) {
        // **host だけが問う**——人の画面・中継・AI のターンからの呼び出しには呼び元の印が付く。付いていたら断る
        if (!isHostResumeCall(meta)) throw new ShellRefusal(`${RESUME_AFTER_RESTART_TOOL} は banto 本体だけが呼べます`);
        const question = parseResumeQuestion(request.params.arguments);
        if (!deps.background) {
          return text({
            answers: question.items.map((item) => ({
              replyTo: item.replyTo,
              resume: false,
              reason: `この Shell では待たない形が使えません（${deps.backgroundUnavailable ?? "理由不明"}）`,
            })),
          });
        }
        return text({ answers: deps.background.answerResume(question.items, () => extra.signal.aborted) });
      }
      if (request.params.name === "runCommand") return await callRunCommand();
    } catch (err) {
      if (err instanceof ShellRefusal || err instanceof BackgroundCommandError) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
      throw err;
    }
    throw new Error(`unknown tool: ${request.params.name}`);

    function requireBackground(): BackgroundCommands {
      if (!deps.background) throw new ShellRefusal(`この Shell では待たない形が使えません（${deps.backgroundUnavailable ?? "理由不明"}）`);
      return deps.background;
    }

    async function callRunCommand() {
      const args = request.params.arguments as Record<string, unknown>;
      const progressToken = extra._meta?.progressToken;

      if (args.runInBackground === true) {
        // **届ける先（host が渡した返信用の札）が無ければ断る**——黙って待つ形に落とさない（規則2。AI は「届く」と
        // 思って待ち続けることになる）
        const replyTo = replyToOf(meta);
        if (!replyTo) {
          throw new ShellRefusal(
            "待たない形（runInBackground）では流せません——終わったことを届ける先がありません" +
              "（banto がこの呼び出しに返信用の札を渡していない）。runInBackground を外して、待つ形で流してください",
          );
        }
        const background = requireBackground();
        const requestedBy = threadOf(meta);
        const requestedByModule = callerModuleOf(meta);
        const started = await runCommandInBackground(
          {
            command: String(args.command),
            cwd: args.cwd as string | undefined,
            timeout: args.timeout as number | undefined,
            envSecrets: args.envSecrets as Record<string, string> | undefined,
            secretFiles: args.secretFiles as Record<string, string> | undefined,
            sshIdentity: args.sshIdentity as string | undefined,
            signal: extra.signal,
          },
          {
            projectRoot: deps.projectRoot,
            homeDir: deps.homeDir,
            inContainer: deps.inContainer,
            relayClient: deps.relayClient,
            background,
            replyTo,
            ...(requestedBy ? { requestedBy } : {}),
            ...(requestedByModule ? { requestedByModule } : {}),
            onProgress:
              progressToken !== undefined
                ? (note) => {
                    void extra.sendNotification({
                      method: "notifications/progress",
                      params: { progressToken, progress: 0, message: note },
                    });
                  }
                : undefined,
          },
        );
        return {
          ...text(started),
          // **あとで届けると約束した**——host は札を返事待ちにし、この Module が止まったら代わりに知らせる
          _meta: { [PENDING_REPLY_META_KEY]: true },
        };
      }

      const result = await runCommand(
        {
          command: String(args.command),
          cwd: args.cwd as string | undefined,
          timeout: args.timeout as number | undefined,
          envSecrets: args.envSecrets as Record<string, string> | undefined,
          secretFiles: args.secretFiles as Record<string, string> | undefined,
          sshIdentity: args.sshIdentity as string | undefined,
          signal: extra.signal,
        },
        {
          projectRoot: deps.projectRoot,
          homeDir: deps.homeDir,
          inContainer: deps.inContainer,
          relayClient: deps.relayClient,
          onProgress:
            progressToken !== undefined
              ? (note) => {
                  void extra.sendNotification({
                    method: "notifications/progress",
                    params: { progressToken, progress: 0, message: note },
                  });
                }
              : undefined,
        },
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
        isError: result.exitCode !== 0,
      };
    }
  });

  return server;
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const projectRoot = process.env.BANTO_PROJECT_ROOT;
  const hostUrl = process.env.BANTO_HOST_MCP_URL;
  const hostToken = process.env.BANTO_HOST_MCP_TOKEN;
  if (!projectRoot || !hostUrl || !hostToken) {
    console.error("BANTO_PROJECT_ROOT, BANTO_HOST_MCP_URL, BANTO_HOST_MCP_TOKEN が必要です");
    process.exit(1);
  }
  const relayClient = new HostRelayClient({ url: hostUrl, token: hostToken });
  // **Shell 専用のホーム**（決定・2026-09-23）。host が用意して写してある
  const homeDir = process.env.BANTO_SHELL_HOME || undefined;
  const inContainer = process.env.BANTO_IN_CONTAINER === "1";
  const moduleDataDir = process.env.BANTO_MODULE_DATA_DIR || undefined;
  // **待たない形はコンテナの中だけ**（決定・2026-10-07、v4-security.md「Shell の待たない形のコマンド」）——人の機械の
  // systemd にコマンドを残さない。置き場は host のディスク（起こし直しても残る）、秘密はコンテナの中の tmpfs
  const backgroundUnavailable = !inContainer
    ? "コンテナの外で動いている Shell です"
    : !moduleDataDir
      ? "BANTO_MODULE_DATA_DIR がありません"
      : undefined;
  const background =
    backgroundUnavailable === undefined
      ? new BackgroundCommands({
          dir: join(moduleDataDir!, "commands"),
          secretsDir: join(SystemdLauncher.runtimeDir(), "banto-shell"),
          projectRoot,
          launcher: new SystemdLauncher(process.execPath, fileURLToPath(new URL("./background-wrapper.js", import.meta.url))),
          deliver: (input) => relayClient.deliverToThread(input),
        })
      : undefined;
  const server = createShellServer({
    projectRoot,
    relayClient,
    homeDir,
    inContainer,
    ...(background ? { background } : {}),
    ...(backgroundUnavailable ? { backgroundUnavailable } : {}),
  });
  await server.connect(new StdioServerTransport());
}
