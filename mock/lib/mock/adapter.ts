// Thread ごとの台本を再生するダミーの ChatModelAdapter。
// 累積スナップショットを毎回 yield する（差分ではない）——実測されたドキュメントの注意点：
// tool 呼び出しは配列の外の状態として持たなくても、累積 parts 配列を作り直す形で保てば、
// 文字だけの chunk が来たときに tool カードが消える事故は起きない（parts を毎回複製するため）。
import type { ChatModelAdapter, ThreadAssistantMessagePart, ThreadMessage } from "@assistant-ui/react";
import type { ReadonlyJSONObject } from "assistant-stream/utils";
import type { MockScript, MockStep, MockThread } from "./types";

// useLocalRuntime の unstable_humanToolNames と合わせる（thread-panel.tsx）
export const HUMAN_TOOL_NAME = "banto_ask";

// 承認ゲートの対象 tool 名。unstable_humanToolNames にも含める（thread-panel.tsx）。
// 実測で分かったこと（規則1）：assistant-ui の `approval` フィールド／
// `respondToApproval` は「承認された直後、次の run() が同じ round trip の中で
// 結果を返す」前提で shouldContinue が組まれており（承認済みでも result が
// 無ければ do-while が回り続ける）、こちらの資産（コンポーネントの副作用で
// 後から addResult する形）とは相性が悪く、二重に _runLoop が走って
// スタックする事故を実測で踏んだ。**human tool とまったく同じ枠組み**
// （unstable_humanToolNames + addResult）に統一することで、既に動作確認済みの
// 経路だけを使う（規則12——一度ハマった機構をもう一度別の形で作り直さない）
export const APPROVAL_TOOL_NAME = "banto_shell_exec";

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("aborted", "AbortError"));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function chunksOf(text: string, size = 3): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function pickReply(script: MockScript, userText: string): readonly MockStep[] {
  for (const r of script.replies) {
    if (r.match === "*") continue;
    if (r.match.test(userText)) return r.steps;
  }
  const fallback = script.replies.find((r) => r.match === "*");
  return fallback?.steps ?? [{ t: "text", text: "（ダミー応答）" }];
}

function lastUserText(messages: readonly ThreadMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === "user");
  if (!last) return "";
  return last.content
    .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

/** 累積 parts。yield のたびにこの配列のコピーを返す。 */
class PartsAccumulator {
  private parts: ThreadAssistantMessagePart[] = [];

  appendText(chunk: string) {
    const last = this.parts[this.parts.length - 1];
    if (last && last.type === "text") {
      this.parts[this.parts.length - 1] = { ...last, text: last.text + chunk };
    } else {
      this.parts.push({ type: "text", text: chunk });
    }
  }

  startTool(step: Extract<MockStep, { t: "tool" }>, toolCallId: string) {
    this.parts.push({
      type: "tool-call",
      toolCallId,
      toolName: step.name,
      args: step.args,
      argsText: JSON.stringify(step.args),
    });
    if (step.inlineView) toolInlineViews.set(toolCallId, step.inlineView);
    if (step.fullscreenView) toolFullscreenViews.set(toolCallId, step.fullscreenView);
  }

  // 人に聞く tool 呼び出し。result を付けない——unstable_humanToolNames により
  // ランタイムがこれを requires-action のまま止め、addResult が渡ってくる
  startHumanTool(step: Extract<MockStep, { t: "human" }>, toolCallId: string) {
    this.parts.push({
      type: "tool-call",
      toolCallId,
      toolName: HUMAN_TOOL_NAME,
      // MockElicitationForm/Url は string index signature を持たないプレーンな
      // interface なので、tool-call の args（ReadonlyJSONObject）としては構造的に
      // 弾かれる——中身は JSON 互換なので unknown 経由でキャストする
      args: { serverName: step.serverName, message: step.message, elicitation: step.elicitation } as unknown as ReadonlyJSONObject,
      argsText: JSON.stringify({ serverName: step.serverName, message: step.message }),
    });
  }

  finishTool(toolCallId: string, result: unknown) {
    const idx = this.parts.findIndex((p) => p.type === "tool-call" && p.toolCallId === toolCallId);
    if (idx === -1) return;
    const part = this.parts[idx];
    if (part.type !== "tool-call") return;
    this.parts[idx] = { ...part, result };
  }

  // 承認ゲート。human tool とまったく同じ形——result を付けずに置き、
  // unstable_humanToolNames が requires-action のまま止める。承認/拒否は
  // カード側（ApprovalToolCard）が addResult を直接呼ぶ（human tool の
  // ElicitationFormView と同じ経路）。§6.0 の要求（呼ぶ前に見せて拒否できる）は
  // 「result が付くまで実行されていない」という状態そのもので表現できる——
  // 見た目だけ承認ゲート用に変える
  startApprovalTool(step: Extract<MockStep, { t: "approval" }>, toolCallId: string) {
    this.parts.push({
      type: "tool-call",
      toolCallId,
      toolName: step.name,
      args: step.args,
      argsText: JSON.stringify(step.args),
    });
    approvalResults.set(toolCallId, step.result);
  }

  snapshot(): readonly ThreadAssistantMessagePart[] {
    return [...this.parts];
  }
}

/**
 * toolCallId → 承認されたときに返す結果。カード側（ApprovalToolCard）が
 * addResult に渡す値をここから読む——アダプタの外（描画側）から参照するため
 * module-level に持つ（toolCallSeq と同じ理由）。
 */
const approvalResults = new Map<string, unknown>();

export function getApprovalResult(toolCallId: string): unknown {
  return approvalResults.get(toolCallId);
}

/**
 * toolCallId → inline 表示する Module の Canvas コンテンツ（§6.2 の display mode
 * "inline"）。カード側（InlineModuleView）がここから読む。
 */
const toolInlineViews = new Map<string, { moduleId: string; viewId: string }>();

export function getInlineView(toolCallId: string): { moduleId: string; viewId: string } | undefined {
  return toolInlineViews.get(toolCallId);
}

/**
 * toolCallId → tool 呼び出し自身が fullscreen を要求した Canvas
 * （§6.2 軸2「AIのtool呼び出し」行）。結果が揃ったら banto が自動で Canvas を開く。
 */
const toolFullscreenViews = new Map<string, { moduleId: string; viewId: string }>();

export function getFullscreenView(toolCallId: string): { moduleId: string; viewId: string } | undefined {
  return toolFullscreenViews.get(toolCallId);
}

/**
 * いま進行中の assistant メッセージ（まだ requires-action のまま、messages には
 * 含まれない——`unstable_getMessage()` でしか取れない、実測で踏んだ）の中に、
 * 指定した toolName で結果が付いた tool-call があれば true。human tool・
 * 承認ゲートのどちらも同じ形（result が付いたら決着）なので共通化する。
 */
function findAnsweredTool(current: ThreadMessage, toolName: string): boolean {
  if (current.role !== "assistant") return false;
  const parts = current.content as readonly ThreadAssistantMessagePart[];
  return parts.some((p) => p.type === "tool-call" && p.toolName === toolName && p.result !== undefined);
}

let toolCallSeq = 0;

export function createMockChatModelAdapter(thread: MockThread): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal, unstable_getMessage }) {
      const steps = pickReply(thread.script, lastUserText(messages));
      const acc = new PartsAccumulator();

      // 人への問いにすでに answer が付いていれば、続きの steps だけを再開する
      // （addResult のあとにランタイムが run() を呼び直す）。
      // ランタイム側で「このメッセージの既存 content」＋「今回 yield する content」
      // を連結する（local-thread-runtime-core.ts の updateMessage、実測で踏んだ）
      // ので、ここで手前の parts を作り直して二重に返してはいけない
      // ——toolCallId が重複し React の key 衝突で落ちる。
      // 進行中のメッセージ（まだ requires-action）は messages に現れないので
      // unstable_getMessage() で取る（これも実測で踏んだ）
      const current = unstable_getMessage();
      const humanStepIndex = steps.findIndex((s) => s.t === "human");
      const approvalStepIndex = steps.findIndex((s) => s.t === "approval");
      let resumeFrom = 0;
      if (humanStepIndex !== -1 && findAnsweredTool(current, HUMAN_TOOL_NAME)) {
        resumeFrom = humanStepIndex + 1;
      } else if (approvalStepIndex !== -1 && findAnsweredTool(current, APPROVAL_TOOL_NAME)) {
        resumeFrom = approvalStepIndex + 1;
      }

      try {
        for (const step of steps.slice(resumeFrom)) {
          if (step.t === "delay") {
            await sleep(step.ms, abortSignal);
            continue;
          }
          if (step.t === "text") {
            for (const chunk of chunksOf(step.text)) {
              acc.appendText(chunk);
              yield { content: acc.snapshot() };
              await sleep(step.charMs ?? 15, abortSignal);
            }
            continue;
          }
          if (step.t === "tool") {
            const toolCallId = `tool-${++toolCallSeq}`;
            acc.startTool(step, toolCallId);
            yield { content: acc.snapshot() };
            await sleep(step.runMs ?? 500, abortSignal);
            acc.finishTool(toolCallId, step.result);
            yield { content: acc.snapshot() };
          }
          if (step.t === "human") {
            const toolCallId = `tool-${++toolCallSeq}`;
            acc.startHumanTool(step, toolCallId);
            // status を明示しないと、generator が return した時点でランタイムが
            // 「running のまま終わった」と見なし complete に確定してしまう
            // （@assistant-ui/core の local-thread-runtime-core、実測で踏んだ）。
            // requires-action・reason "tool-calls" を明示して初めて、
            // unstable_humanToolNames が「このtoolは人が結果を出すまで止める」と扱う
            yield { content: acc.snapshot(), status: { type: "requires-action", reason: "tool-calls" } };
            return;
          }
          if (step.t === "approval") {
            const toolCallId = `tool-${++toolCallSeq}`;
            acc.startApprovalTool(step, toolCallId);
            yield { content: acc.snapshot(), status: { type: "requires-action", reason: "tool-calls" } };
            return;
          }
        }
      } catch (err) {
        // interrupt() による中断（規則2：止めたターンは流れてきた分をそのまま返す。
        // §2.3 の実測どおり、そこまでの出力を握りつぶさない）。
        // run() の戻り値型は void なので、最後の yield が最終状態として扱われる
        if (err instanceof DOMException && err.name === "AbortError") {
          yield { content: acc.snapshot() };
          return;
        }
        throw err;
      }
    },
  };
}
