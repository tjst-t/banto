"use client";

// **Shell の待たない形の runCommand の「画面で見る」**（v4-modules.md §2.3「人の画面——バックグラウンドのコマンド」、Backlog #492）。
// tool のカード（折りたたみの中の一般のカード）はそのままにして、折りたたみの外に開けるカードを1枚足す——inline の画面と同じく、
// 人が見に行く入口を畳める所に入れない（§6.2）。押すと Shell の入口「バックグラウンドのコマンド」がこの1件を選んで開く
// ——サイドバーの1件と同じ開き方（`backgroundViewHref`）
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Terminal } from "lucide-react";
import { OpenableCard } from "@/components/banto/thread/openable-card";
import { useThreadId } from "@/components/banto/thread/thread-id-context";
import { backgroundViewHref } from "@/lib/backend/background-view";
import { distinctDescription } from "@/lib/card-text";
import { SHELL_COMMANDS_VIEW_URI } from "@/lib/shell-background-command";

export function ShellBackgroundViewCard({ command, args }: { command: { server: string; commandId: string }; args: unknown }) {
  const router = useRouter();
  const projectId = (useParams() as { projectId?: string }).projectId;
  const threadId = useThreadId();
  // このカードの Thread が開いている Fork なら、その Fork のまま開く（Base の会話なら Base）
  const forkId = useSearchParams().get("fork") === threadId ? threadId : null;
  const { command: text, label } = (args ?? {}) as { command?: unknown; label?: unknown };
  const commandText = typeof text === "string" ? text : "";
  // 題は呼び名、無ければコマンド（サイドバーの1件と同じ）。説明はコマンド（題と同じなら出さない）
  const title = typeof label === "string" && label ? label : commandText || "バックグラウンドのコマンド";
  return (
    <OpenableCard
      icon={Terminal}
      title={title}
      description={distinctDescription(title, commandText)}
      actionLabel="画面で見る"
      // Project の外（別タブの Canvas など）では開く先が無いので押せなくする（規則13）
      onOpen={
        projectId
          ? () =>
              router.push(
                backgroundViewHref(projectId, forkId, command.server, {
                  resourceUri: SHELL_COMMANDS_VIEW_URI,
                  select: { commandId: command.commandId },
                }),
              )
          : undefined
      }
      testId="shell-background-view-card"
      moduleName={command.server}
    />
  );
}
