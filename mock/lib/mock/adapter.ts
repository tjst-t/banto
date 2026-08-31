// Thread ごとの台本を再生するダミーの ChatModelAdapter。
// 累積スナップショットを毎回 yield する（差分ではない）——実測されたドキュメントの注意点：
// tool 呼び出しは配列の外の状態として持たなくても、累積 parts 配列を作り直す形で保てば、
// 文字だけの chunk が来たときに tool カードが消える事故は起きない（parts を毎回複製するため）。
import type { ChatModelAdapter, ThreadAssistantMessagePart, ThreadMessage } from "@assistant-ui/react";
import type { MockScript, MockStep, MockThread } from "./types";

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
  }

  finishTool(toolCallId: string, result: unknown) {
    const idx = this.parts.findIndex((p) => p.type === "tool-call" && p.toolCallId === toolCallId);
    if (idx === -1) return;
    const part = this.parts[idx];
    if (part.type !== "tool-call") return;
    this.parts[idx] = { ...part, result };
  }

  snapshot(): readonly ThreadAssistantMessagePart[] {
    return [...this.parts];
  }
}

let toolCallSeq = 0;

export function createMockChatModelAdapter(thread: MockThread): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal }) {
      const steps = pickReply(thread.script, lastUserText(messages));
      const acc = new PartsAccumulator();

      try {
        for (const step of steps) {
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
