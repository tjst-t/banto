// G3「既定でAIが判断して足す」（v4-architecture.md §2.2）。C13の方針
// ——中核の機能もMCPのインターフェースで持つ——に沿い、Module中継とは
// 別枠でcore自身のin-process MCPサーバをRunnerに常時アタッチする。
// agentがこのtoolを呼んだら`appendMemory`を実行するだけ——判断（何を
// 憶えるか）はagent側、保存はcore側という分担（規則3を跨がない）。
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ProjectThreadStore } from "../project-thread/store.js";

// 使い方の指示は`runner/system-prompt.ts`の骨格が持つ（決定・2026-09-05）
// ——プリセットへの追記ではなくなったので、ここに別置きする理由が無くなった。

export function createMemoryMcpServer(store: ProjectThreadStore, projectId: string, threadId: string) {
  return createSdkMcpServer({
    name: "banto-memory",
    // SDKの既定はtool searchの裏に遅延ロード——1toolだけのserverだと
    // agentが自発的に検索せず見えないままになる（実測、2026-09-05）。
    // 常にプロンプトに含める
    alwaysLoad: true,
    tools: [
      tool(
        "remember_decision",
        "設計判断・決定事項をこのProjectのMemoryに残す。以降のターン・Fork Threadに引き継がれる。",
        { text: z.string().describe("決まったことの内容") },
        async ({ text }) => {
          // 出所（どのThreadで決まったか）を残す——走行中の別Threadへ
          // 差分を届けるときに使う（アーキ仕様§2.3、決定・2026-09-05）。
          await store.appendMemory(projectId, text, threadId);
          return { content: [{ type: "text", text: "記録した。" }] };
        },
      ),
    ],
  });
}
