// **チャットの題は AI が付ける**（決定・2026-10-21、ユーザー。アーキ仕様 §2.2「チャット——Project を作る前の相談」、Backlog #498）。
//
// 最初のターンを始めたら、host が書き込みから題を1回だけ小さいモデルで作り、`project.renamed` を積む（一覧の `projects.changed` は
// `renameProject` が流す）。作れなければ書き込みの最初の文を縮めた題にする。
//
// **人が名前を変えていなければだけ**——名前がまだ仮の「新しいチャット」のときだけ付ける。小さいモデルを待っている間に人が
// 変えることもあるので、積む直前にもう一度見る。「最初のターン」は名前で見分ける（題を付けたら仮の名前ではなくなる）。
// 待っている間に次のターンが始まっても重ねて呼ばないよう、作っている Project を覚える
import type { ProjectThreadStore } from "../project-thread/store.js";
import type { ProjectId } from "../project-thread/types.js";
import { NEW_CHAT_NAME } from "./chat-project.js";

/** 題の長さの上限（文字）。超えたら縮める */
export const CHAT_TITLE_MAX_CHARS = 30;

export const CHAT_TITLE_SYSTEM_PROMPT = [
  "You name chat conversations.",
  "Read the user's first message and reply with a short title for the conversation, in the same language as the message.",
  `Keep it under ${CHAT_TITLE_MAX_CHARS} characters (for Japanese, about 15 characters). No quotes, no trailing punctuation, no explanation.`,
  "Reply with the title only, on one line.",
].join("\n");

/** 長さの上限で縮める（超えたら末尾を「…」に） */
function clip(text: string): string {
  const chars = [...text];
  return chars.length <= CHAT_TITLE_MAX_CHARS ? text : `${chars.slice(0, CHAT_TITLE_MAX_CHARS - 1).join("").trimEnd()}…`;
}

/** 書き込みの最初の文を縮めた題。文が無ければ（空白だけ）`undefined` */
export function titleFromFirstSentence(prompt: string): string | undefined {
  const firstLine = prompt
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return undefined;
  // 文の終わり（。！？ と、後ろに空白が続く . ! ?）の手前まで
  const sentence = firstLine.split(/[。！？]|[.!?](?=\s|$)/)[0]!.trim() || firstLine;
  return clip(sentence.replace(/\s+/g, " "));
}

/** 小さいモデルの答えを題の形に整える（囲みの引用符・末尾の句点を落とし、縮める）。何も残らなければ `undefined` */
export function cleanModelTitle(answer: string): string | undefined {
  const stripped = answer
    .trim()
    .replace(/^(title|題)\s*[:：]\s*/i, "")
    // 句点は囲みの外にも中にも付きうる（「…」。・"…."）
    .replace(/[。.]+$/, "")
    .replace(/^["'「『“]+|["'」』”]+$/g, "")
    .replace(/[。.]+$/, "")
    .trim();
  return stripped ? clip(stripped) : undefined;
}

export class ChatTitler {
  private readonly inFlight = new Set<ProjectId>();

  constructor(
    private readonly deps: {
      projectThread: Pick<ProjectThreadStore, "getThread" | "getProject" | "renameProject">;
      /** 小さいモデルを1回呼ぶ（`runner/one-shot.ts` の `askSmallModel`。失敗は投げる） */
      ask: (input: { projectId: ProjectId; systemPrompt: string; prompt: string }) => Promise<string>;
    },
  ) {}

  /**
   * ターンを始めたときに呼ぶ（人の書き込みがあるターンだけ）。題を付けるべきなら付け始め、その終わりを返す
   * （付けないなら即座に終わる）。失敗は投げない——小さいモデルが失敗したら最初の文の題にし、積めなければ警告だけ残す
   * （ターンは止めない）
   */
  turnStarted(threadId: string, prompt: string): Promise<void> {
    const thread = this.deps.projectThread.getThread(threadId);
    if (!thread) return Promise.resolve();
    const projectId = thread.projectId;
    if (!this.needsTitle(projectId) || this.inFlight.has(projectId)) return Promise.resolve();
    const fallback = titleFromFirstSentence(prompt);
    if (!fallback) return Promise.resolve();
    this.inFlight.add(projectId);
    return this.title(projectId, prompt, fallback)
      .catch((err: unknown) => console.warn(`[host] チャット ${projectId} に題を付けられませんでした:`, err))
      .finally(() => this.inFlight.delete(projectId));
  }

  private needsTitle(projectId: ProjectId): boolean {
    const project = this.deps.projectThread.getProject(projectId);
    return project?.kind === "chat" && project.status === "active" && project.name === NEW_CHAT_NAME;
  }

  private async title(projectId: ProjectId, prompt: string, fallback: string): Promise<void> {
    let title: string;
    try {
      title = cleanModelTitle(await this.deps.ask({ projectId, systemPrompt: CHAT_TITLE_SYSTEM_PROMPT, prompt })) ?? fallback;
    } catch (err) {
      console.warn(`[host] チャット ${projectId} の題を小さいモデルで作れませんでした。最初の文から付けます:`, err);
      title = fallback;
    }
    // 待っている間に人が名前を変えた・閉じたなら積まない
    if (!this.needsTitle(projectId)) return;
    await this.deps.projectThread.renameProject(projectId, title);
  }
}
