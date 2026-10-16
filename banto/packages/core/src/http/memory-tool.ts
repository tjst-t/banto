// G3「既定でAIが判断して足す」（v4-architecture.md §2.2）。C13の方針
// ——中核の機能もMCPのインターフェースで持つ——に沿い、Module中継とは
// 別枠でcore自身のin-process MCPサーバをRunnerに常時アタッチする。
// agentがこのtoolを呼んだら`appendMemory`を実行するだけ——判断（何を
// 憶えるか）はagent側、保存はcore側という分担（規則3を跨がない）。
//
// **取り消す・改める**（`revise_memory`、追加・2026-10-15、§2.2「取り消した行は AI に渡さない・AI が取り消しと『改める』を
// 頼める」）。承認モードにも自動許可にも依らず、会話のカードで必ず人に聞く。
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { MEMORY_ENTRY_MAX_CHARS, type ProjectThreadStore } from "../project-thread/store.js";
import { askInThread, type AskInThreadDeps } from "../inbox/ask-in-thread.js";

// 使い方の指示は`runner/system-prompt.ts`の骨格が持つ（決定・2026-09-05）
// ——プリセットへの追記ではなくなったので、ここに別置きする理由が無くなった。

export const REVISE_MEMORY_TOOL_NAME = "revise_memory";
/** 確認のカードの選択肢。許す側の「変える」は画面が「許可」に写す（`apps/frontend/lib/backend/adapter.ts`） */
export const MEMORY_REVISE_CHOICES = ["変える", "変えない"] as const;
/** 1回で頼める変更の数・取り消す行の数の上限（カードが読める大きさに抑える） */
export const MEMORY_REVISE_MAX_CHANGES = 100;
export const MEMORY_REVISE_MAX_RETRACT = 300;

export interface MemoryChangeRequest {
  retract: number[];
  text?: string;
}

/**
 * **頼まれた変更を確かめる**。誤りがあれば AI が読んで直せる文を返す（人に聞く前に断る——許されたあとで断らない）
 */
export function checkMemoryRevision(
  memory: readonly { seq: number; text: string; invalidatedAtSeq?: number }[],
  reason: string,
  changes: readonly MemoryChangeRequest[],
): string | undefined {
  if (reason.trim() === "") return "reason（なぜ変えるか）を書いてください。";
  if (changes.length === 0) return "changes が空です。取り消す行を1つ以上指してください（足すだけなら remember_decision）。";
  if (changes.length > MEMORY_REVISE_MAX_CHANGES) return `changes は1回に ${MEMORY_REVISE_MAX_CHANGES} 件までです。分けて頼んでください。`;
  const seen = new Set<number>();
  for (const [i, c] of changes.entries()) {
    const where = `changes[${i}]`;
    if (c.retract.length === 0) return `${where}：retract が空です。足すだけなら remember_decision を使ってください。`;
    for (const seq of c.retract) {
      if (seen.has(seq)) return `${where}：#${seq} を2回指しています。1つの行は1回だけ指してください。`;
      seen.add(seq);
      const entry = memory.find((m) => m.seq === seq);
      if (!entry) return `${where}：この Project の Memory に #${seq} はありません（番号は Memory の [#番号]）。`;
      if (entry.invalidatedAtSeq !== undefined) return `${where}：#${seq} はもう取り消してあります。`;
    }
    if (c.text !== undefined) {
      if (c.text.trim() === "") return `${where}：text が空です。取り消すだけなら text を省いてください。`;
      if (c.text.length > MEMORY_ENTRY_MAX_CHARS) return `${where}：text が長すぎます（${c.text.length} 字、上限 ${MEMORY_ENTRY_MAX_CHARS} 字）。`;
    }
  }
  if (seen.size > MEMORY_REVISE_MAX_RETRACT) return `取り消す行は1回に ${MEMORY_REVISE_MAX_RETRACT} 件までです。分けて頼んでください。`;
  return undefined;
}

/** カードに出す中身（理由・変更ごとの取り消す行と足す行） */
export function describeMemoryRevision(
  memory: readonly { seq: number; text: string }[],
  reason: string,
  changes: readonly MemoryChangeRequest[],
): Record<string, string> {
  const rows: Record<string, string> = { 理由: reason.trim() };
  changes.forEach((c, i) => {
    // 取り消す行は**全文**を出す（2026-10-16、ユーザー「削除するメモリの内容がわからない」——頭60字では判断できない）
    const retracted = c.retract.map((seq) => `#${seq}「${(memory.find((m) => m.seq === seq)?.text ?? "").trim()}」`).join("\n\n");
    rows[`変更 ${i + 1}`] = c.text !== undefined ? `取り消す：\n${retracted}\n\n足す：\n${c.text.trim()}` : `取り消す：\n${retracted}`;
  });
  return rows;
}

/**
 * **頼まれた変更を、人に聞いてから行う**。許されたら変更ごとに「先に新しい行を足してから、元の行を取り消す」。
 * その間に人が取り消していた行は飛ばして結果に書く
 */
export async function reviseMemory(
  deps: { store: ProjectThreadStore; ask: AskInThreadDeps },
  input: { projectId: string; threadId: string; reason: string; changes: MemoryChangeRequest[]; signal?: AbortSignal },
): Promise<{ ok: boolean; text: string }> {
  const memory = deps.store.getProject(input.projectId)?.memory ?? [];
  const problem = checkMemoryRevision(memory, input.reason, input.changes);
  if (problem) return { ok: false, text: problem };
  const retractCount = input.changes.reduce((n, c) => n + c.retract.length, 0);
  const addCount = input.changes.filter((c) => c.text !== undefined).length;
  const message =
    addCount > 0
      ? `Memory の ${retractCount} 行を取り消し、${addCount} 行を足してよいですか`
      : `Memory の ${retractCount} 行を取り消してよいですか`;
  const answer = await askInThread(deps.ask, {
    threadId: input.threadId,
    source: "memory",
    message,
    toolInput: describeMemoryRevision(memory, input.reason, input.changes),
    choices: MEMORY_REVISE_CHOICES,
    signal: input.signal,
    logTag: "memory",
  });
  if (!answer.allowed) return { ok: false, text: `人が変えないと答えたので、Memory は変えていません。${answer.note}` };

  const reason = input.reason.trim();
  const lines: string[] = [];
  let skipped = 0;
  for (const c of input.changes) {
    // 先に足す——取り消してから落ちると決まりが消える
    const added = c.text !== undefined ? await deps.store.appendMemory(input.projectId, c.text.trim(), input.threadId) : undefined;
    const done: number[] = [];
    for (const seq of c.retract) {
      const changed = await deps.store.invalidateMemory(input.projectId, seq, { reason, ...(added !== undefined ? { replacedBy: added } : {}) });
      if (changed) done.push(seq);
      else skipped++;
    }
    const retracted = done.length > 0 ? done.map((s) => `#${s}`).join("・") : "なし";
    lines.push(added !== undefined ? `- #${added} を足し、${retracted} を取り消した` : `- ${retracted} を取り消した`);
  }
  if (skipped > 0) lines.push(`（${skipped} 行は聞いている間にもう取り消されていたので飛ばした）`);
  return { ok: true, text: `人が許したので、Memory を変えた。\n${lines.join("\n")}` };
}

export function createMemoryMcpServer(
  store: ProjectThreadStore,
  projectId: string,
  threadId: string,
  /** 人に聞く口。無ければ revise_memory は断る（試験の構成） */
  ask?: AskInThreadDeps,
) {
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
      tool(
        REVISE_MEMORY_TOOL_NAME,
        "この Project の Memory の行を取り消す・改める（置き換える）。行は Memory の [#番号] で指す。1回の呼び出しに複数の変更を" +
          "まとめられる：changes の1件ごとに retract の行々を取り消し、text があればその代わりに新しい行を1つ足す（複数の行を" +
          "まとめて1行に改めることもできる）。足すだけなら remember_decision。会話のカードで人に必ず聞き、許されたときだけ変わる" +
          "（全部か何もしないか）。",
        {
          reason: z.string().describe("なぜ変えるか（人がカードで読む。取り消しの記録にも残る）"),
          changes: z
            .array(
              z.object({
                retract: z.array(z.number().int()).describe("取り消す行の番号（Memory の [#番号] の数字）"),
                text: z.string().optional().describe("代わりに足す新しい行の全文。取り消すだけなら省く"),
              }),
            )
            .describe("変更の一覧"),
        },
        async ({ reason, changes }, extra) => {
          if (!ask) return { content: [{ type: "text", text: "この banto では Memory を取り消す口がつながっていません。" }], isError: true };
          const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
          const result = await reviseMemory(
            { store, ask },
            { projectId, threadId, reason, changes: changes.map((c) => ({ retract: c.retract, ...(c.text !== undefined ? { text: c.text } : {}) })), ...(signal ? { signal } : {}) },
          );
          return { content: [{ type: "text", text: result.text }], ...(result.ok ? {} : { isError: true }) };
        },
      ),
    ],
  });
}
