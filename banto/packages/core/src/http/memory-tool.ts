// G3「既定でAIが判断して足す」（v4-architecture.md §2.2）。C13の方針
// ——中核の機能もMCPのインターフェースで持つ——に沿い、Module中継とは
// 別枠でcore自身のin-process MCPサーバをRunnerに常時アタッチする。
// agentがこのtoolを呼んだら`appendMemory`を実行するだけ——判断（何を
// 憶えるか）はagent側、保存はcore側という分担（規則3を跨がない）。
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ProjectThreadStore } from "../project-thread/store.js";

/** systemPromptに追記する、Memory toolの使い方指示。 */
export const MEMORY_SYSTEM_PROMPT_APPEND =
  "決まったこと（設計判断・決定事項）は remember_decision tool で残してください。" +
  "会話が畳まれたり、別のThreadに分岐しても、この記録は引き継がれます。";

export function createMemoryMcpServer(store: ProjectThreadStore, threadId: string) {
  return createSdkMcpServer({
    name: "banto-memory",
    // SDKの既定はtool searchの裏に遅延ロード——1toolだけのserverだと
    // agentが自発的に検索せず見えないままになる（実測、2026-09-05）。
    // 常にプロンプトに含める
    alwaysLoad: true,
    tools: [
      tool(
        "remember_decision",
        "設計判断・決定事項をこのThreadのMemoryに残す。以降のターン・Fork Threadに引き継がれる。",
        { text: z.string().describe("決まったことの内容") },
        async ({ text }) => {
          await store.appendMemory(threadId, text);
          return { content: [{ type: "text", text: "記録した。" }] };
        },
      ),
    ],
  });
}
