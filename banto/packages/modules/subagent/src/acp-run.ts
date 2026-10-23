// サブエージェントを1回走らせる（アーキ仕様 §4.1「Subagent Module の形」）。
//
// **1回の呼び出し＝エージェントのプロセス1つ**：起動→`initialize`→`session/new` か
// `session/load`→設定→`session/prompt`→終了。続きは `session/load` で拾う
// （§2.3 のモデルB と同じ考え方。別プロセスでの再開は Claude Code・OpenCode とも実測済み）。
//
// ACP の口は `@agentclientprotocol/sdk` の `client()`（旧 `ClientSideConnection` は非推奨）。

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute, relative } from "node:path";
import { Readable, Writable } from "node:stream";
import { startTicksOf } from "./process-group.js";
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
import { inWorkScope, stopWorkScope, workScopeOwner } from "@banto/module-contract";
import { clipLine, STEP_TITLE_MAX, type PlanEntry, type StepStatus, type ToolCallView } from "./runs.js";

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
  /** エージェントが tool を呼んだ（`tool_call`）。仕事の記録（`runs.ts`）が途中の様子を持つのに使う。題は仮のことがある */
  onToolCall?: (call: ToolCallView) => void;
  /**
   * tool の呼び出しが書き換わった（`tool_call_update`。届いた欄だけ）。claude-agent-acp は呼び始めに仮の題（「Terminal」）で
   * `tool_call` を送り、本当の題・種類・触るファイル・引数はこちらで送る（追加・2026-10-21、アーキ仕様 §4.1）
   */
  onToolUpdate?: (toolCallId: string, changes: Partial<Omit<ToolCallView, "toolCallId">>) => void;
  /** 途中の発言の一片（`agent_message_chunk`）。経過に発言として入れる——返答の全文（`onText`）とは別 */
  onMessage?: (chunk: string) => void;
  /** やること一覧（`plan`。届くたびに丸ごと） */
  onPlan?: (entries: PlanEntry[]) => void;
  /**
   * tool が終わった（`tool_call_update` の completed・failed）。走っている仕事の記録が「切れたとき実行中だった tool」を
   * 持つのに使う（追加・2026-10-05、アーキ仕様 §2.5「2.」）
   */
  onToolDone?: (toolCallId: string) => void;
  /**
   * 会話の id が決まった（`session/new` の返事・`session/load` した id）。走っている仕事の記録に、prompt を送る前に
   * 残す（追加・2026-10-05）——起こし直したあと `session/load` で続ける
   */
  onSession?: (sessionId: string) => void;
  /**
   * エージェントを起こした（pid＝自分のプロセスグループの id と、開始時刻と、仕事の組に入れたならその単位の名前）。走っている
   * 仕事の記録に残し、起こし直したあと続ける前に残ったものをグループごと・組ごと止める（追加・2026-10-05、`process-group.ts`）
   */
  onSpawn?: (agent: { pid: number; startTicks?: number; unit?: string }) => void;
  /** 返答を書き進めた（ここまでの全文）。走っている間の画面に、書きかけを見せるのに使う */
  onText?: (textSoFar: string) => void;
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
  /** 実際に使ったモデル（設定項目 `model` の現在値——指定しなければエージェントの既定） */
  model?: string;
  permissions: { title: string; answer: string }[];
  /** 黙って落とさずに伝えること（例：モードを掛けられなかった） */
  notes: string[];
}

/**
 * **`tool_call`・`tool_call_update` から、経過に持つ欄を取り出す**（届いた欄だけ）。エージェントに依らない読み方だけ：説明は
 * `rawInput.description` が文字列のとき、触ったファイルは `locations` のパス（作業場所の中は相対、外は絶対パスのまま）
 */
export function toolFieldsOf(
  update: { title?: string | null; kind?: string | null; status?: string | null; rawInput?: unknown; locations?: { path: string }[] | null },
  cwd: string,
): Partial<Omit<ToolCallView, "toolCallId">> {
  const description = (update.rawInput as { description?: unknown } | undefined)?.description;
  return {
    ...(typeof update.title === "string" ? { title: update.title } : {}),
    ...(typeof update.kind === "string" ? { kind: update.kind } : {}),
    ...(typeof update.status === "string" ? { status: update.status as StepStatus } : {}),
    ...(typeof description === "string" && description.trim() !== "" ? { description } : {}),
    ...(Array.isArray(update.locations) && update.locations.length > 0
      ? { files: update.locations.filter((l) => typeof l?.path === "string").map((l) => displayPath(l.path, cwd)) }
      : {}),
  };
}

function displayPath(path: string, cwd: string): string {
  if (!isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  if (rel === "") return ".";
  return rel.startsWith("..") || isAbsolute(rel) ? path : rel;
}

const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_CANCEL_GRACE_MS = 10_000;
const STDERR_TAIL = 4000;
/** 接続が閉じてから、プロセスの終了を待つ上限 */
const EXIT_WAIT_MS = 1000;

function optionalTicks(pid: number): { startTicks?: number } {
  const startTicks = startTicksOf(pid);
  return startTicks === undefined ? {} : { startTicks };
}

/** エージェントのグループごと信号を送る（もう誰も居なければ何もしない） */
function killGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // もう誰も居ない
  }
}

export class SubagentError extends Error {
  override name = "SubagentError";
}

/**
 * **続きから開けなかった**（`session/load` が断られた。追加・2026-10-05）。claude-agent-acp は最初の prompt が記録される
 * 前に切れた会話を load できない（実測 B「Resource not found」）——起こし直しのあと続けるとき、まだ何も進んでいなければ
 * 同じ頼みで最初からやり直す（`server.ts`）
 */
export class SessionLoadError extends SubagentError {
  override name = "SessionLoadError";
}

/**
 * **ログインが切れて、頼みが断られた**（追加・2026-10-13、Backlog #284）。会話の id を持つ——同じ会話を `session/load` して
 * 続けられる（`server.ts`）。claude-agent-acp は上流の 401 で `session/prompt` を `errorKind: authentication_failed`（ACP の
 * `authRequired` のこともある）で断る（実測：本物の claude-agent-acp を 401 を返す偽の上流に向けた）
 */
export class LoginExpiredError extends SubagentError {
  override name = "LoginExpiredError";
  constructor(
    message: string,
    readonly sessionId: string,
  ) {
    super(message);
  }
}

function isLoginExpired(err: unknown): boolean {
  if (!(err instanceof RequestError)) return false;
  if (err.code === RequestError.authRequired().code) return true;
  const data = err.data as { errorKind?: unknown } | undefined;
  // `oauth_org_not_allowed` は入れない——待っても直らない
  return typeof data === "object" && data !== null && data.errorKind === "authentication_failed";
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
  /** 仕事の組に入れたなら、その単位の名前 */
  unit?: string;
  /** エージェントと子を止める。組に入れたなら組ごと止め、止まるまで待つ */
  stop: () => Promise<void>;
}

/**
 * この Module（このプロセス）が起こして、まだ止めていない組。起きたときの片づけ（`server.ts` の
 * `sweepLeftoverAgentScopes`）が、片づけている間に起こした仕事の組を止めないように
 */
const liveUnits = new Set<string>();

export function agentScopesOfThisProcess(): ReadonlySet<string> {
  return liveUnits;
}

/**
 * この1本の印（host が渡す `BANTO_MODULE_NAME` から）。組の名前に入れ、起きたときの片づけはこの印の組だけを止める——同じ
 * Project に Subagent を2本立てても、互いの仕事を止めない（Backlog #294）
 */
export function agentScopeOwner(): string {
  return workScopeOwner("subagent");
}

function spawnAgent(launch: AgentLaunch, cwd: string): SpawnedAgent {
  // **自分のプロセスグループで起こす**（追加・2026-10-05）——エージェントが起こす子（claude-agent-acp の CLI など）ごと
  // 止められるように。Module が止まっても（banto の起こし直し）エージェントと子は残るので、続ける前にグループで止める
  // **仕事の組に入れて起こす**（段2a、`docs/specs/v4-security.md` §1）——エージェントと子（Claude Code・ブラウザ等）が
  // メモリを食い尽くしても組の中だけで止まり、Module は巻き込まれない。`systemd-run --scope` はその場で exec するので、
  // 標準入出力（ACP）とプロセスグループはそのまま
  const scoped = inWorkScope(launch.command, launch.args, { kind: "subagent", owner: agentScopeOwner(), env: launch.env });
  if (scoped.unit) liveUnits.add(scoped.unit);
  const child = spawn(scoped.command, scoped.args, { cwd, env: scoped.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
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
      // **エージェントが理由を添えて断った**なら、それを伝える——終了を待たない（訂正・2026-10-13、Backlog #284）。
      // 断られると接続を閉じる（こちらの読み口も閉じる）ので、claude-agent-acp はそのあと書いた1行で EPIPE を投げて落ちる。
      // 終了を待つと、その「終了しました（EPIPE）」が本当の理由（ログイン切れ）を上書きしていた
      if (err instanceof RequestError) {
        return new SubagentError(`${describeError(err)}${stderr.trim() ? `\nstderr: ${stderr.trim().slice(-1500)}` : ""}`);
      }
      if (!exitError) await Promise.race([exited.catch(() => undefined), new Promise((r) => setTimeout(r, EXIT_WAIT_MS))]);
      if (exitError) return exitError;
      return new SubagentError(`${describeError(err)}${stderr.trim() ? `\nstderr: ${stderr.trim().slice(-1500)}` : ""}`);
    },
    ...(scoped.unit ? { unit: scoped.unit } : {}),
    stop: async () => {
      child.removeAllListeners("exit");
      // グループごと（エージェントが起こした子も）。エージェントがもう終わっていても、子が残っていれば止める
      killGroup(child, "SIGTERM");
      // **組ごと止める**（Backlog #294）——グループを抜けた子（setsid・ssh-agent -D・E2E が後ろに回したもの）はグループで
      // 止めても残り、組（banto-subagent-*.scope）が終わらない。止められなければログに残す（結果はもう出ているので投げない）
      if (scoped.unit) {
        await stopWorkScope(scoped.unit, { env: scoped.env }).then(
          () => liveUnits.delete(scoped.unit!),
          (err: unknown) => console.error(`[subagent] エージェントの仕事の組 ${scoped.unit} を止められませんでした:`, err),
        );
      }
    },
  };
}

const INITIALIZE: InitializeRequest = {
  protocolVersion: PROTOCOL_VERSION,
  // ファイル・端末の操作は引き受けない——エージェント自身の tool を閉じ込め（Project のコンテナ）の中で使わせる（§4.1）
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
    await spawned.stop();
  }
}

export async function runSubagent(input: RunInput, deps: RunDeps): Promise<RunResult> {
  const spawned = spawnAgent(deps.launch, deps.cwd);
  const { child } = spawned;
  if (child.pid !== undefined) deps.onSpawn?.({ pid: child.pid, ...optionalTicks(child.pid), ...(spawned.unit ? { unit: spawned.unit } : {}) });

  const result: Omit<RunResult, "agent" | "sessionId" | "stopReason"> = {
    text: "",
    toolCalls: [],
    permissions: [],
    notes: [],
  };
  // `session/load` は履歴を `session/update` で再生してから返る——**このターンの分だけ**を拾う
  let collecting = false;
  /** toolCallId → `result.toolCalls` の何番目か（本当の題が後から届いたら書き換える） */
  const toolCallIndex = new Map<string, number>();
  let lastProgress = Date.now();
  const progress = (message: string) => {
    lastProgress = Date.now();
    deps.onProgress?.(message);
  };

  const onUpdate = (update: SessionUpdate) => {
    if (!collecting) return;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") {
          result.text += update.content.text;
          deps.onMessage?.(update.content.text);
          deps.onText?.(result.text);
        }
        break;
      case "tool_call": {
        const fields = toolFieldsOf(update, deps.cwd);
        const call: ToolCallView = { toolCallId: update.toolCallId, ...fields, title: fields.title ?? "" };
        toolCallIndex.set(update.toolCallId, result.toolCalls.length);
        result.toolCalls.push(clipLine(call.title, STEP_TITLE_MAX));
        deps.onToolCall?.(call);
        progress(`ツール：${clipLine(call.title, STEP_TITLE_MAX)}`);
        break;
      }
      case "tool_call_update": {
        const changes = toolFieldsOf(update, deps.cwd);
        // AI に返る一覧と進み具合の知らせも本当の題に（「Terminal」は AI にも役に立たない）
        const index = toolCallIndex.get(update.toolCallId);
        if (changes.title !== undefined && index !== undefined) {
          const title = clipLine(changes.title, STEP_TITLE_MAX);
          if (result.toolCalls[index] !== title) {
            result.toolCalls[index] = title;
            progress(`ツール：${title}`);
          }
        }
        if (Object.keys(changes).length > 0) deps.onToolUpdate?.(update.toolCallId, changes);
        if (update.status === "completed" || update.status === "failed") deps.onToolDone?.(update.toolCallId);
        break;
      }
      case "plan":
        deps.onPlan?.(update.entries.map((e) => ({ content: e.content, status: e.status })));
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
          let loaded;
          try {
            loaded = await ctx.request(methods.agent.session.load, {
              sessionId: input.sessionId,
              cwd: deps.cwd,
              mcpServers: [],
            });
          } catch (err) {
            throw new SessionLoadError(`会話 ${input.sessionId} を続きから開けませんでした: ${describeError(err)}`);
          }
          sessionId = input.sessionId;
          options = loaded.configOptions ?? [];
        } else {
          const created = await ctx.request(methods.agent.session.new, { cwd: deps.cwd, mcpServers: [] });
          sessionId = created.sessionId;
          options = created.configOptions ?? [];
        }
        deps.onSession?.(sessionId);

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
          setTimeout(() => killGroup(child, "SIGKILL"), deps.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS).unref();
        };
        if (deps.signal?.aborted) onAbort();
        else deps.signal?.addEventListener("abort", onAbort, { once: true });
        try {
          let res;
          try {
            res = await ctx.request(methods.agent.session.prompt, {
              sessionId,
              prompt: [{ type: "text", text: input.prompt }],
            });
          } catch (err) {
            if (isLoginExpired(err)) {
              throw new LoginExpiredError(`ログインが切れて、会話 ${sessionId} の途中で断られました: ${describeError(err)}`, sessionId);
            }
            throw err;
          }
          const model = findOption(options, "model");
          return {
            agent,
            sessionId,
            stopReason: res.stopReason,
            ...result,
            ...(model?.type === "select" ? { model: model.currentValue } : {}),
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
    await spawned.stop();
  }
}
