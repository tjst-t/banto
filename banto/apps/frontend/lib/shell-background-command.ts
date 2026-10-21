// **会話のカードの「画面で見る」**（v4-modules.md §2.3「人の画面——バックグラウンドのコマンド」、Backlog #492）。Shell の待たない形の
// runCommand は、返事の本文に commandId を書く。そのカードから、Shell の入口「バックグラウンドのコマンド」をその1件を選んで開く
// ——サイドバーの1件と同じ形（入口を `canvasView`＝`{ commandId }`）。結果の `_meta`（`dev.banto/backgroundView`）は host が外した
// あとなので、カードは本文から読む。待つ形（runInBackground が無い）のカードには何も足さない

/** Shell の入口の資源（`packages/modules/shell/src/commands-app.ts` の `COMMANDS_APP_URI`） */
export const SHELL_COMMANDS_VIEW_URI = "ui://banto-shell/commands";

/** Runner から見える tool 名は `mcp__<Module名>__<tool名>`（Agent SDK の付け方） */
const RUN_COMMAND = /^mcp__(.+)__runCommand$/;

function textOf(result: unknown): string | undefined {
  if (typeof result === "string") return result;
  if (!Array.isArray(result)) return undefined;
  const texts = result.flatMap((b) =>
    typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string"
      ? [(b as { text: string }).text]
      : [],
  );
  return texts.length ? texts.join("") : undefined;
}

/** 待たない形で流せた runCommand の呼び出しなら、どの Module のどのコマンドか。それ以外（待つ形・断られた・まだ結果が無い）は undefined */
export function shellBackgroundCommandOf(toolName: string, args: unknown, result: unknown): { server: string; commandId: string } | undefined {
  const server = RUN_COMMAND.exec(toolName)?.[1];
  if (!server) return undefined;
  if ((args as { runInBackground?: unknown } | null | undefined)?.runInBackground !== true) return undefined;
  const text = textOf(result);
  if (text === undefined) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  const commandId = (body as { commandId?: unknown } | null)?.commandId;
  return typeof commandId === "string" && commandId ? { server, commandId } : undefined;
}
