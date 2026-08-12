/**
 * Claude Code の会話を、**職人のセッションJSONL** に写す（純関数）。
 *
 * なぜ写すのか：`worker.attach` とセッションビューア（決定18）は、セッションファイルの
 * 各行を読んで会話として描く。既にその形（pi のセッションJSONL）で描く側が動いているので、
 * ランタイムが変わっても**同じ形で書く**——ここを別形式にすると、職人の覗き窓が
 * ランタイムごとに割れる（D5：Surface に判断を持たせない）。
 *
 * 書き出す行（`packages/banto-web/src/views/WorkerViewer.tsx` の `parseSession` が読む形）:
 *   {"type":"session", ...}
 *   {"type":"model_change","provider":...,"modelId":...}
 *   {"type":"message","message":{"role":"user"|"assistant","content":[{type:"text"|"thinking"|"toolCall"}]}}
 *   {"type":"message","message":{"role":"toolResult","toolCallId":...,"toolName":...,"content":[...],"isError":bool}}
 *
 * D6: SDK の型を import しない。実行時に渡ってくる形だけを見る（拡張と同じ判断）。
 */

/** セッションJSONL の1行。 */
export type SessionLine = Record<string, unknown>;

/** 中身を見る最小限の形（SDK の型そのものではなく、読む部分だけ）。 */
interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface SdkLikeMessage {
  type?: string;
  message?: { role?: string; content?: unknown };
}

/** content から読める文字を集める（tool_result の中身は文字列にも配列にもなる）。 */
function collectText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined ? "" : JSON.stringify(content);
  return (content as ContentBlock[])
    .map((block) => (typeof block.text === "string" ? block.text : JSON.stringify(block)))
    .join("\n");
}

/**
 * 会話を行に写す係。`toolCall` の名前は後から来る `tool_result` に足すため覚えておく
 * ——ビューアは呼び出しの行に結果を差し込むので、名前が落ちると「結果」とだけ出る。
 */
export class SessionTranscript {
  private readonly toolNames = new Map<string, string>();

  /** 冒頭の2行（セッション開始・どのモデルで動いているか）。 */
  start(sessionId: string, model: string, at: string): SessionLine[] {
    return [
      { type: "session", sessionId, at },
      { type: "model_change", provider: "claude-code", modelId: model },
    ];
  }

  /** 番頭から届いた指示。 */
  user(text: string): SessionLine[] {
    return [{ type: "message", message: { role: "user", content: text } }];
  }

  /**
   * SDK から流れてきた1件を行に写す。写すもののない種類（system・result など）は空を返す。
   *
   * I2: 知らない種類を無理に描かない。空で返して、記録は残さない
   *     ——中途半端に描くと、読む側が「何か起きたのに中身が無い」と誤読する。
   */
  fromSdkMessage(message: SdkLikeMessage): SessionLine[] {
    if (message.type === "assistant") return this.assistant(message);
    if (message.type === "user") return this.toolResults(message);
    return [];
  }

  private assistant(message: SdkLikeMessage): SessionLine[] {
    const blocks = Array.isArray(message.message?.content)
      ? (message.message?.content as ContentBlock[])
      : [];
    const content: Record<string, unknown>[] = [];
    for (const block of blocks) {
      if (block.type === "text" && typeof block.text === "string") {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        content.push({ type: "thinking", thinking: block.thinking });
      } else if (block.type === "tool_use") {
        const id = typeof block.id === "string" ? block.id : "";
        const name = typeof block.name === "string" ? block.name : "?";
        if (id) this.toolNames.set(id, name);
        content.push({ type: "toolCall", id, name, arguments: block.input ?? {} });
      }
    }
    if (content.length === 0) return [];
    return [{ type: "message", message: { role: "assistant", content } }];
  }

  /**
   * 道具の結果。SDK では「user ロールの tool_result ブロック」として返ってくるが、
   * ビューアは `toolResult` ロールで受けるので、そちらへ寄せる。
   */
  private toolResults(message: SdkLikeMessage): SessionLine[] {
    const blocks = Array.isArray(message.message?.content)
      ? (message.message?.content as ContentBlock[])
      : [];
    const lines: SessionLine[] = [];
    for (const block of blocks) {
      if (block.type !== "tool_result") continue;
      const toolCallId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      lines.push({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId,
          toolName: this.toolNames.get(toolCallId) ?? "?",
          isError: block.is_error === true,
          content: [{ type: "text", text: collectText(block.content) }],
        },
      });
    }
    return lines;
  }
}

/**
 * 書き出したセッションから、Claude 側のセッションIDを読み戻す（起こし直しの手がかり）。
 *
 * 決定30d の「起こし直しは同じセッションの再開」を Claude Code でも成り立たせるために要る。
 * 番頭は `worker.wake` に**前のセッションファイルの場所**しか渡さないので、
 * Claude の session id はそのファイルから拾えないといけない。
 */
export function readSessionIdFromLines(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    if (!line.includes("\"session\"")) continue;
    try {
      const parsed = JSON.parse(line) as { type?: string; sessionId?: string };
      if (parsed.type === "session" && typeof parsed.sessionId === "string") return parsed.sessionId;
    } catch {
      // 壊れた行は飛ばす。読めた行から拾えれば足りる
    }
  }
  return undefined;
}
