"use client";

// Shell Module の launcher（v4-modules.md §2.3・§4「作りたい Module」比較表とは
// 別物——ここは人が AI を介さず直接触る簡易パネル）。「コマンドを1つ打つ→
// 結果を見る」を繰り返すだけに留める——対話的な（PTY の）ターミナルは作らない
// （`docs/notes/2026-09-02-shell-module-design.md` §5）。`cd` は永続化しない
// ——毎回 Project の根からの相対で実行される、という制約を画面上にも出す。
// 内部で呼んでいるのは AI 向けと同じ runCommand tool 1本（FileSystem の
// ファイルブラウザが自分の readFile/writeFile を内部的に呼ぶのと同じ形、
// v4-modules.md §2.2 末尾）——新しい tool は増やさない。
import { useState } from "react";
import { AlertTriangle, Loader2, Terminal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface HistoryEntry {
  id: number;
  command: string;
  status: "running" | "done";
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

/** 実バックエンドが無いモックなので、よく使う数コマンドだけ既知の出力を返す */
function fakeRun(command: string): { stdout: string; stderr: string; exitCode: number } {
  const trimmed = command.trim();
  if (trimmed === "") return { stdout: "", stderr: "", exitCode: 0 };
  if (/^ls\b/.test(trimmed)) {
    return { stdout: "lib\ndocs\npublic\npackage.json", stderr: "", exitCode: 0 };
  }
  if (/^pwd$/.test(trimmed)) {
    return { stdout: "（Project の根）", stderr: "", exitCode: 0 };
  }
  const echo = /^echo\s+(.*)$/.exec(trimmed);
  if (echo) return { stdout: echo[1], stderr: "", exitCode: 0 };
  if (/^cd\b/.test(trimmed)) {
    return {
      stdout: "",
      stderr: "cd はこのパネルでは持続しません（次のコマンドも Project の根から実行されます）",
      exitCode: 0,
    };
  }
  return { stdout: "", stderr: `${trimmed}: モックのため実行していません`, exitCode: 127 };
}

let seq = 0;

export function ShellTerminalView() {
  const [history, setHistory] = useState<readonly HistoryEntry[]>([]);
  const [input, setInput] = useState("");

  function submit() {
    const command = input.trim();
    if (!command) return;
    const id = ++seq;
    setHistory((prev) => [...prev, { id, command, status: "running" }]);
    setInput("");
    setTimeout(() => {
      const { stdout, stderr, exitCode } = fakeRun(command);
      setHistory((prev) =>
        prev.map((e) => (e.id === id ? { ...e, status: "done", stdout, stderr, exitCode } : e)),
      );
    }, 350);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-start gap-2 border-b border-border bg-warn-soft/40 px-4 py-2 text-xs text-ink-2">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warn" />
        <p>
          コマンドを1つ打つ→結果を見る、を繰り返すだけの簡易パネルです。<code>cd</code>
          は次のコマンドに引き継がれません。vim・ssh ログインのような対話的なプログラムは実行できません。
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs">
        {history.length === 0 ? (
          <p className="text-ink-3">まだコマンドを実行していません。下の入力欄からどうぞ。</p>
        ) : (
          <div className="flex flex-col gap-3">
            {history.map((e) => (
              <div key={e.id} className="flex flex-col gap-1">
                <div className="flex items-center gap-1.5 text-foreground">
                  <span className="text-ink-3">$</span>
                  <span>{e.command}</span>
                  {e.status === "running" ? (
                    <Loader2 className="size-3 shrink-0 animate-spin text-ink-3" />
                  ) : null}
                </div>
                {e.status === "done" ? (
                  <div className="flex flex-col gap-1 pl-3">
                    {e.stdout ? <pre className="whitespace-pre-wrap text-ink-2">{e.stdout}</pre> : null}
                    {e.stderr ? <pre className="whitespace-pre-wrap text-stop">{e.stderr}</pre> : null}
                    <Badge
                      className={cn(
                        "w-fit",
                        e.exitCode === 0 ? "bg-ok-soft text-ok" : "bg-stop-soft text-stop",
                      )}
                    >
                      exit {e.exitCode}
                    </Badge>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-border p-3">
        <Terminal className="size-4 shrink-0 text-ink-3" />
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="コマンドを入力（例：ls）"
          className="font-mono text-sm"
        />
        <Button size="sm" onClick={submit} disabled={input.trim() === ""}>
          実行
        </Button>
      </div>
    </div>
  );
}
