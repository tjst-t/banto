// Thread を開いたときに最初から表示する既存ログ（MockStep[]）を、
// useLocalRuntime の initialMessages（ThreadMessageLike[]）に変換する。
import type { ThreadMessageLike } from "@assistant-ui/react";
import type { MockStep } from "./types";

export function seedToInitialMessages(seed: readonly MockStep[]): ThreadMessageLike[] {
  const messages: ThreadMessageLike[] = [];
  let seq = 0;

  for (const step of seed) {
    if (step.t === "delay") continue;
    if (step.t === "text") {
      messages.push({
        id: `seed-${seq++}`,
        role: "assistant",
        content: [{ type: "text", text: step.text }],
      });
      continue;
    }
    if (step.t === "tool") {
      messages.push({
        id: `seed-${seq++}`,
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: `seed-tool-${seq}`,
            toolName: step.name,
            args: step.args,
            result: step.result,
          },
        ],
      });
    }
  }

  return messages;
}
