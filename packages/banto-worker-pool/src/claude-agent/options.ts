/**
 * Claude Agent SDK の `query()` に渡す `Options` の組み立て（純関数）。
 *
 * ホスト（`host.ts`）から分けてあるのは、**繋ぎ目を試験から叩けるようにするため**。
 * host.ts は読み込むと `main()` が走る入口なので、試験から import できない——
 * 中で組み立てていると「フックを載せ忘れた」「作法を足し忘れた」が誰にも見えない。
 *
 * それが実際に起きたのが task-0102 だった（task-0090 の退避は pi の `extensionPaths` に
 * しか載っておらず、claude-agent 経路では1行も効いていなかった。器の試験は全部通っていた）。
 * **繋ぎ目こそが対策の本体**なので、ここは純関数として切り出して押さえる。
 *
 * D5: 判断は無い。起動時の指定を SDK の言葉へ写すだけ。
 * D6: SDK からは**型だけ**を取る（実行時に読み込ませない——ドライバ側の約束と同じ）。
 */

import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_WEB_TOOL_NAMES } from "./naming.js";
import { CLAUDE_REPORT_PROMPT } from "./report.js";
import type { ClaudeHookMatcher, ClaudeToolOffload } from "./tool-offload.js";
import type { ClaudeWorkKeep } from "./work-keep.js";
// 型だけ（`import type` は実行時に消えるので、ホストの `main()` を巻き込まない）
import type { HostConfig } from "./host.js";

export interface BuildHostOptionsParams {
  /** 起動引数から読んだ指定。 */
  config: HostConfig;
  /** 職人の作業場所。 */
  cwd: string;
  /** 起こし直しでないときに名乗るセッションID。 */
  sessionId: string;
  /** 報告経路（`worker.report` / `worker.ask`）を載せたか。載せたときだけ作法も足す。 */
  reported: boolean;
  /** 長いツール結果の退避。切ってあるときは `undefined`。 */
  offload?: ClaudeToolOffload | undefined;
  /** 作業の取り置き（機構が定期的にコミットする）。切ってあるときは `undefined`。 */
  workKeep?: ClaudeWorkKeep | undefined;
  /** 職人に生やす MCP サーバ（報告・工場の口）。 */
  mcpServers?: Options["mcpServers"] | undefined;
}

/** ここで組み合わせるフックの種類（増えたらここに足す）。 */
type ClaudeHookEvent = "PostToolUse" | "Stop";

type ClaudeHookMap = Readonly<Partial<Record<ClaudeHookEvent, readonly ClaudeHookMatcher[]>>>;

/**
 * 複数の器のフックを1つにまとめる。
 *
 * 退避（task-0102）も取り置き（work-keep）も `PostToolUse` を使うので、
 * **片方で上書きしない**ことがここの唯一の仕事。`hooks` は1つしか渡せないのだから、
 * 後から器を足す人が黙って前の器を消せてしまう——それを構造で塞ぐ。
 */
function mergeHooks(...sources: Array<ClaudeHookMap | undefined>): Options["hooks"] | undefined {
  const merged: Partial<Record<ClaudeHookEvent, ClaudeHookMatcher[]>> = {};
  for (const source of sources) {
    if (!source) continue;
    for (const [event, matchers] of Object.entries(source) as Array<
      [ClaudeHookEvent, readonly ClaudeHookMatcher[] | undefined]
    >) {
      if (!matchers || matchers.length === 0) continue;
      (merged[event] ??= []).push(...matchers);
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * 職人に足すシステムプロンプト（既定のプロンプトへの**追記**）。
 *
 * 順番は「立場 → 報告の作法 → 退避の作法」。空のものは足さない。
 */
export function buildAppendedPrompt(params: {
  systemPrompt: string;
  reported: boolean;
  offloadPrompt?: string | undefined;
}): string {
  return [
    params.systemPrompt,
    params.reported ? CLAUDE_REPORT_PROMPT : "",
    params.offloadPrompt ?? "",
  ]
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
}

/** `query()` へ渡すものを組み立てる。 */
export function buildHostOptions(params: BuildHostOptionsParams): Options {
  const { config } = params;
  const hooks = mergeHooks(params.offload?.hooks, params.workKeep?.hooks);
  const appended = buildAppendedPrompt({
    systemPrompt: config.systemPrompt,
    reported: params.reported,
    offloadPrompt: params.offload?.prompt,
  });

  return {
    model: config.model,
    cwd: params.cwd,
    // imp-0004: 立場は**追記**する。既定のプロンプト（道具の作法）を奪わない
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      ...(appended.length > 0 ? { append: appended } : {}),
    },
    // imp-0004: 空なら既定の道具立てのまま。空の許可リストを渡すと道具が1つも無い職人になる
    tools: config.tools.length > 0 ? config.tools : { type: "preset", preset: "claude_code" },
    // imp-0005: 外を読む口は許したときだけ。Claude Code の既定には入っているので明示的に外す
    ...(config.network ? {} : { disallowedTools: [...CLAUDE_WEB_TOOL_NAMES] }),
    ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
    // task-0102: 長いツール結果はモデルへ渡る前に栞へ差し替える（切ってあれば載せない）
    // work-keep: 道具を使うたびに、間隔が過ぎていれば作業を取り置く。**同じ `PostToolUse` を
    // 分け合う**ので、どちらか片方だけを載せて上書きしない（mergePostToolUse）
    ...(hooks ? { hooks } : {}),
    // 職人の前に人は居ない。**可否を尋ねる相手が居ない**ので通す。危険の境目は
    // 「渡した道具（tools）」と「作業させる worktree」であって、対話の確認ではない（pi と同じ）
    canUseTool: async (_toolName, input) => ({ behavior: "allow" as const, updatedInput: input }),
    settingSources: config.settingSources,
    ...(config.resume ? { resume: config.resume } : { sessionId: params.sessionId }),
  };
}
