/**
 * 章の要約器（`chapter-summarizer.ts`）が使う LLM 呼び出し口の実装（task-0151）。
 *
 * `ChapterCompleter` は差し替え可能な口。ここにあるのはその実装2つ——
 * pi 経由（既存。旧 `chapter-summarizer.ts` の `piCompleter` を独立させたもの）と
 * claude-agent-sdk 経由（task-0151 で追加）。どちらを使うかは `chapter-model.ts` の
 * 解決結果に従って呼び出し側（bin.ts）が選ぶ——ここは「呼び方」だけを知っている。
 *
 * D6: claude-agent-sdk 側は `@anthropic-ai/claude-agent-sdk` のみ
 * （banto-host が会話ハーネスで既に使っている依存）。
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { completeSimple, type Model } from "@earendil-works/pi-ai/compat";
import type { ChapterCompleter, ChapterCompletion } from "./chapter-summarizer.js";
import { requireAuth, type AuthResolver } from "./llm-auth.js";

/** pi の `completeSimple` を呼ぶ口。 */
export function createPiChapterCompleter(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi の Model は Api で
  // 型付けされており、呼ぶ側はどの Api かを知らないまま解決した実体を渡す (I4)
  model: Model<any>,
  auth: AuthResolver
): ChapterCompleter {
  return async (request) => {
    // I2: 鍵が無いまま呼びに行かない
    const resolved = await requireAuth(auth, model, "章の引き継ぎ資料");
    const response = await completeSimple(
      model,
      {
        systemPrompt: request.systemPrompt,
        messages: [
          { role: "user", content: [{ type: "text", text: request.prompt }], timestamp: Date.now() },
        ],
      },
      {
        maxTokens: request.maxTokens,
        ...(resolved.apiKey !== undefined ? { apiKey: resolved.apiKey } : {}),
        ...(resolved.headers !== undefined ? { headers: resolved.headers } : {}),
      }
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi の content は
    // ブロックの直和で、ここで見るのは type と text だけ (I4)
    return response as any as ChapterCompletion;
  };
}

/**
 * claude-agent-sdk 経由の口（task-0151）。
 *
 * **セッションを開かない単発呼び出し**（決定28：本セッションのプレフィックスに触らない）。
 * `query()` に文字列プロンプトを渡すと1ターンだけ回り、`type: "result"` に本文が乗る
 * （`harness-backends.ts` の `ask()` と同じ立て方——組み込みツールは切り、設定ファイルは
 * 読まない）。単発プロンプトなので `for await` を最後まで回せば `query()` 自身が畳まれる
 * ——ここで待ち続けるのは会話ハーネス（`ClaudeAgentHarness`）のように入力を流し込む側だけ。
 *
 * **出力の上限（`request.maxTokens`）は渡せない。** Agent SDK は完成した1コールの
 * API ではなくセッションを立てる高水準の口で、生の `max_tokens` を露出していない
 * （`maxThinkingTokens` はあるが、これは思考の予算であって本文の上限ではない）。
 * inc-0068 の本命だった「思考が出力予算を食い潰す」は pi 経由（openai 互換のサーバ既定）
 * が原因で、claude-agent-sdk では起きない——`reasoning` を渡さなければ思考は既定でオフ
 * （anthropic API の既定）。
 */
export function createClaudeChapterCompleter(
  modelId: string,
  // 試験のためだけの差し替え口（`harness-backends.ts` の `ask?` と同じ形）。本番は渡さない
  options: { query?: typeof query } = {}
): ChapterCompleter {
  const runQuery = options.query ?? query;
  return async (request): Promise<ChapterCompletion> => {
    const session = runQuery({
      prompt: request.prompt,
      options: {
        systemPrompt: request.systemPrompt,
        model: modelId,
        tools: [],
        settingSources: [],
        maxTurns: 1,
      },
    });
    for await (const message of session) {
      if (message.type !== "result") continue;
      if (message.subtype === "success") {
        return {
          stopReason: message.stop_reason ?? "stop",
          content: [{ type: "text", text: message.result }],
        };
      }
      // I2: 失敗を握りつぶさない。呼び出し側（chapter-summarizer.ts）がそのまま止まれる
      return {
        stopReason: "error",
        errorMessage: message.errors.join("; ") || message.subtype,
        content: [],
      };
    }
    // I2: result が届かないまま終わったことも「空返し」として扱う（書けたと誤認しない）
    return {
      stopReason: "error",
      errorMessage: "応答が得られませんでした（result が届きませんでした）",
      content: [],
    };
  };
}
