// サブエージェントを1回走らせる（アーキ仕様 §4.1「Subagent Module の形」）。
//
// **1回の呼び出し＝エージェントのプロセス1つ**：起動→`initialize`→`session/new` か
// `session/load`→設定→`session/prompt`→終了。続きは `session/load` で拾う
// （§2.3 のモデルB と同じ考え方。別プロセスでの再開は Claude Code・OpenCode とも実測済み）。
//
// ACP の口は `@agentclientprotocol/sdk` の `client()`（旧 `ClientSideConnection` は非推奨）。

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type ClientContext,
  type InitializeRequest,
  type PermissionOption,
  type SessionConfigOption,
  type SessionUpdate,
  type StopReason,
  type ToolCallUpdate,
  type Stream,
  type Usage,
} from "@agentclientprotocol/sdk";

export interface AgentLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** 人への確認の答え。`cancelled` は「答えられなかった／取り消した」 */
export type PermissionAnswer = { optionId: string } | "cancelled";

export interface PermissionQuestion {
  title: string;
  options: PermissionOption[];
  toolCall: ToolCallUpdate;
}

export interface RunInput {
  prompt: string;
  /** `session/new` の設定項目のうち category `model` に渡す値 */
  model?: string;
  /** category `thought_level` に渡す値 */
  effort?: string;
  /** 続きから走らせる session id（`loadSession` を名乗るエージェントだけ） */
  sessionId?: string;
}

export interface RunDeps {
  launch: AgentLaunch;
  /** 作業場所（Project の根）。ACP は絶対パスを求める */
  cwd: string;
  /** そのエージェントに既定で掛けるモード（Claude は `auto`——main の Runner と揃える） */
  mode?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /** エージェントが tool を呼んだ（題）。仕事の記録（`runs.ts`）が途中の様子を持つのに使う */
  onToolCall?: (title: string) => void;
  askPermission: (question: PermissionQuestion) => Promise<PermissionAnswer>;
  /** 進捗を送る間隔（Shell と同じ10秒。テストで縮める） */
  heartbeatMs?: number;
  /** 取り消しを送ってから、止まるのを待つ上限。過ぎたらプロセスを殺す */
  cancelGraceMs?: number;
}

export interface RunResult {
  agent: { name: string; version?: string };
  sessionId: string;
  stopReason: StopReason;
  /** このターンの返答（再開したときの履歴の再生は含まない） */
  text: string;
  usage?: Usage;
  cost?: { amount: number; currency: string };
  context?: { used: number; size: number };
  toolCalls: string[];
  permissions: { title: string; answer: string }[];
  /** 黙って落とさずに伝えること（例：モードを掛けられなかった） */
  notes: string[];
}

const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_CANCEL_GRACE_MS = 10_000;
const STDERR_TAIL = 4000;
/** 接続が閉じてから、プロセスの終了を待つ上限 */
const EXIT_WAIT_MS = 1000;

export class SubagentError extends Error {
  override name = "SubagentError";
}

function selectValues(option: SessionConfigOption): string[] {
  if (option.type !== "select") return [];
  return option.options.flatMap((o) => ("options" in o ? o.options.map((x) => x.value) : [o.value]));
}

function findOption(options: SessionConfigOption[], category: string): SessionConfigOption | undefined {
  return options.find((o) => o.category === category) ?? options.find((o) => o.id === category);
}

/**
 * 設定項目に値を掛ける。**候補に無い値は、候補を添えて断る**——候補の一覧は
 * `configOptions` が唯一の真実で（規則3）、渡した資格情報で変わる。
 */
async function applyOption(
  ctx: ClientContext,
  sessionId: string,
  options: SessionConfigOption[],
  category: string,
  value: string,
): Promise<SessionConfigOption[]> {
  const option = findOption(options, category);
  if (!option) throw new SubagentError(`このエージェントには ${category} の設定がありません`);
  const values = selectValues(option);
  if (!values.includes(value)) {
    const shown = values.slice(0, 40).join(", ");
    throw new SubagentError(
      `${category} に "${value}" はありません。候補（${values.length}件）: ${shown}${values.length > 40 ? " …" : ""}`,
    );
  }
  const res = await ctx.request(methods.agent.session.setConfigOption, { sessionId, configId: option.id, value });
  return res.configOptions;
}

function describeError(err: unknown): string {
  if (err instanceof RequestError) {
    const data = err.data === undefined ? "" : ` ${JSON.stringify(err.data).slice(0, 600)}`;
    return `${err.message}${data}`;
  }
  return err instanceof Error ? err.message : String(err);
}

interface SpawnedAgent {
  child: ChildProcessWithoutNullStreams;
  stream: Stream;
  /** 落ちたら reject する（`Promise.race` に入れる） */
  exited: Promise<never>;
  /** 接続が閉じたとき、終了コードと stderr を待ってから伝えるための変換 */
  toError: (err: unknown) => Promise<SubagentError>;
  stop: () => void;
}

function spawnAgent(launch: AgentLaunch, cwd: string): SpawnedAgent {
  const child = spawn(launch.command, launch.args, { cwd, env: launch.env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString("utf8")).slice(-STDERR_TAIL);
  });
  // **エージェントが途中で落ちたら、そこで止まる**（規則2）——返事を待ち続けない。
  // 落ちると ACP の接続が先に閉じる（「ACP connection closed」）ので、終了コードと stderr を
  // 待ってからそちらを伝える——「接続が閉じた」だけでは、探す場所を間違える
  let exitError: SubagentError | undefined;
  const exited = new Promise<never>((_, reject) => {
    child.once("error", (err) => reject((exitError = new SubagentError(`エージェントを起動できません: ${err.message}`))));
    child.once("exit", (code, sig) =>
      reject(
        (exitError = new SubagentError(
          `エージェントが終了しました（code=${code} signal=${sig}）。stderr: ${stderr.trim().slice(-1500)}`,
        )),
      ),
    );
  });
  exited.catch(() => {});
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  return {
    child,
    stream,
    exited,
    toError: async (err) => {
      if (err instanceof SubagentError) return err;
      if (!exitError) await Promise.race([exited.catch(() => undefined), new Promise((r) => setTimeout(r, EXIT_WAIT_MS))]);
      if (exitError) return exitError;
      return new SubagentError(`${describeError(err)}${stderr.trim() ? `\nstderr: ${stderr.trim().slice(-1500)}` : ""}`);
    },
    stop: () => {
      child.removeAllListeners("exit");
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    },
  };
}

const INITIALIZE: InitializeRequest = {
  protocolVersion: PROTOCOL_VERSION,
  // ファイル・端末の操作は引き受けない——エージェント自身の tool を Landlock の中で使わせる（§4.1）
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
};

export interface AgentDescription {
  agent: { name: string; version?: string };
  loadSession: boolean;
  /** 設定項目ごとの候補（model・thought_level・mode など）。**唯一の真実は `session/new` の応答** */
  options: { id: string; category?: string; current: string | boolean; values: string[] }[];
}

/**
 * エージェントを起こして、名乗る能力と設定項目の候補を聞く。候補は渡した資格情報で変わる
 * ——**一覧を banto 側に写して持たない**（規則3）。聞くたびに `session/new` を1つ作る
 */
export async function describeAgent(launch: AgentLaunch, cwd: string): Promise<AgentDescription> {
  const spawned = spawnAgent(launch, cwd);
  try {
    return await Promise.race([
      spawned.exited,
      client({ name: "banto-subagent" }).connectWith(spawned.stream, async (ctx) => {
        const init = await ctx.request(methods.agent.initialize, INITIALIZE);
        const created = await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] });
        return {
          agent: { name: init.agentInfo?.name ?? "（名乗らない）", version: init.agentInfo?.version },
          loadSession: init.agentCapabilities?.loadSession === true,
          options: (created.configOptions ?? []).map((o) => ({
            id: o.id,
            ...(o.category ? { category: o.category } : {}),
            current: o.currentValue,
            values: selectValues(o),
          })),
        };
      }),
    ]);
  } catch (err) {
    throw await spawned.toError(err);
  } finally {
    spawned.stop();
  }
}

export async function runSubagent(input: RunInput, deps: RunDeps): Promise<RunResult> {
  const spawned = spawnAgent(deps.launch, deps.cwd);
  const { child } = spawned;

  const result: Omit<RunResult, "agent" | "sessionId" | "stopReason"> = {
    text: "",
    toolCalls: [],
    permissions: [],
    notes: [],
  };
  // `session/load` は履歴を `session/update` で再生してから返る——**このターンの分だけ**を拾う
  let collecting = false;
  let lastProgress = Date.now();
  const progress = (message: string) => {
    lastProgress = Date.now();
    deps.onProgress?.(message);
  };

  const onUpdate = (update: SessionUpdate) => {
    if (!collecting) return;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") result.text += update.content.text;
        break;
      case "tool_call":
        result.toolCalls.push(update.title);
        deps.onToolCall?.(update.title);
        progress(`ツール：${update.title}`);
        break;
      case "usage_update":
        result.context = { used: update.used, size: update.size };
        if (update.cost) result.cost = { amount: update.cost.amount, currency: update.cost.currency };
        break;
      default:
        break;
    }
  };

  const started = Date.now();
  const heartbeat = setInterval(() => {
    if (Date.now() - lastProgress < (deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS)) return;
    const sec = Math.round((Date.now() - started) / 1000);
    progress(`作業中（${sec}秒・ツール ${result.toolCalls.length}回）`);
  }, Math.min(deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS, 1000));

  const app = client({ name: "banto-subagent" })
    .onNotification(methods.client.session.update, (ctx) => onUpdate(ctx.params.update))
    .onRequest(methods.client.session.requestPermission, async (ctx) => {
      const question: PermissionQuestion = {
        title: ctx.params.toolCall.title ?? "（題の無い操作）",
        options: ctx.params.options,
        toolCall: ctx.params.toolCall,
      };
      progress(`確認待ち：${question.title}`);
      const answer = deps.signal?.aborted ? "cancelled" : await deps.askPermission(question);
      const chosen = answer === "cancelled" ? undefined : ctx.params.options.find((o) => o.optionId === answer.optionId);
      result.permissions.push({ title: question.title, answer: chosen?.kind ?? "cancelled" });
      return answer === "cancelled" || !chosen
        ? { outcome: { outcome: "cancelled" as const } }
        : { outcome: { outcome: "selected" as const, optionId: chosen.optionId } };
    });

  try {
    return await Promise.race([
      spawned.exited,
      app.connectWith(spawned.stream, async (ctx) => {
        const init = await ctx.request(methods.agent.initialize, INITIALIZE);
        const agent = { name: init.agentInfo?.name ?? "（名乗らない）", version: init.agentInfo?.version };

        let sessionId: string;
        let options: SessionConfigOption[];
        if (input.sessionId) {
          if (!init.agentCapabilities?.loadSession) {
            throw new SubagentError(`${agent.name} は続きからの再開（loadSession）を名乗っていません`);
          }
          const loaded = await ctx.request(methods.agent.session.load, {
            sessionId: input.sessionId,
            cwd: deps.cwd,
            mcpServers: [],
          });
          sessionId = input.sessionId;
          options = loaded.configOptions ?? [];
        } else {
          const created = await ctx.request(methods.agent.session.new, { cwd: deps.cwd, mcpServers: [] });
          sessionId = created.sessionId;
          options = created.configOptions ?? [];
        }

        if (input.model) options = await applyOption(ctx, sessionId, options, "model", input.model);
        if (input.effort) options = await applyOption(ctx, sessionId, options, "thought_level", input.effort);
        if (deps.mode) {
          // **掛けられなくても止めない、ただし黙らない**——モードはエージェントとモデルで
          // 使えるものが違う（例：Claude の auto は Haiku に無い）。掛からなければ確認が人に来るだけ
          try {
            options = await applyOption(ctx, sessionId, options, "mode", deps.mode);
          } catch (err) {
            result.notes.push(`モード ${deps.mode} を掛けられませんでした: ${describeError(err)}`);
          }
        }

        collecting = true;
        const onAbort = () => {
          void ctx.notify(methods.agent.session.cancel, { sessionId });
          // 取り消しを送っても止まらないエージェントは、待ちすぎずに殺す
          setTimeout(() => child.kill("SIGKILL"), deps.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS).unref();
        };
        if (deps.signal?.aborted) onAbort();
        else deps.signal?.addEventListener("abort", onAbort, { once: true });
        try {
          const res = await ctx.request(methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: "text", text: input.prompt }],
          });
          return {
            agent,
            sessionId,
            stopReason: res.stopReason,
            ...result,
            ...(res.usage ? { usage: res.usage } : {}),
          };
        } finally {
          deps.signal?.removeEventListener("abort", onAbort);
        }
      }),
    ]);
  } catch (err) {
    throw await spawned.toError(err);
  } finally {
    clearInterval(heartbeat);
    spawned.stop();
  }
}
