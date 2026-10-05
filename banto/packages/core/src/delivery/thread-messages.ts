// **Thread 間・Project 間のメッセージ**（決定・2026-10-01、ユーザー。アーキ仕様 §4.2「Thread 間・Project 間の送り方」）。
//
// 届け方は「Thread に届ける」口（`ThreadDeliveries`）にそのまま乗る。ここが足すのは、AI が宛先を選んで送る口と、
// Project をまたぐときの許し方だけ：
//
// - **宛先は Project と Thread**。Thread を指さず Project だけなら、その Project に**会話を引き継がない新しい Fork**を
//   立てて届ける（Base の会話を Clear した状態。Memory は Project のものなので効く）
// - 届いたものには**送り元（Project・Thread）**が付き、受け取った AI はそこへ送り返せる
// - **同じ Project の中は自由**。**Project をまたぐ送信は人が承認する**——承認モードが「全部許す」でも聞く（Project の
//   内部配線の承認と同じ考え方：緩めるのは AI への信用であって、別の Project を起こしてよいかではない）。
//   「以後聞かない」を選ぶと宛先の Project の「受け取ってよい Project」に足し、次からは聞かない
// - **送り元の Project の「承認をすべて自動で許可する」がオンなら聞かない**（追加・2026-10-05、ユーザー。v4-frontend.md §6.4）
//   ——答え済みの承認カードだけ残し、「受け取ってよい Project」には足さない（覚えない。スイッチを切れば、また聞く）
// - **返事は承認なし**——受け取ったメッセージの送り元の Thread へ、受け取ってから 24 時間以内に送るもの
// - ループ防止（ホップ・速度）と受信箱のお知らせは、届ける口がそのまま持っている

import type { InboxStore } from "../inbox/store.js";
import type { PendingApprovalRegistry } from "../inbox/pending-approvals.js";
import { AUTO_APPROVED_ANSWER_TEXT, raiseAutoApprovedJudgment } from "../inbox/auto-approve.js";
import type { ProjectThreadStore } from "../project-thread/store.js";
import type { MessageSender, ProjectState, ThreadState } from "../project-thread/types.js";
import type { ThreadDeliveries } from "./thread-deliveries.js";
import type { ThreadTurns } from "./thread-turns.js";

/** 承認画面の選択肢。「許可する」「拒否する」は他の判断待ちと同じ言葉 */
export const MESSAGE_ALLOW = "許可する";
export const MESSAGE_ALLOW_REMEMBER = "許可し、以後この Project からは聞かない";
export const MESSAGE_DENY = "拒否する";

/** 受け取ってからこの間は、送り元への返事を承認なしで通す（決定・2026-10-01、ユーザー） */
export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

export type ThreadActivity = "idle" | "running" | "waitingOnHuman" | "closed";

export interface ThreadDirectoryEntry {
  projectId: string;
  projectName: string;
  threadId: string;
  /** 人が付けた名前。無ければ「Base Thread」／「Fork Thread（名前なし）」 */
  label: string;
  kind: "base" | "fork";
  state: ThreadActivity;
  /** 呼んだ本人 */
  self?: boolean;
}

export interface SendMessageRequest {
  /** 宛先の Project。Thread だけ指すなら省いてよい */
  projectId?: string;
  /** 宛先の Thread。省くと、その Project に会話を引き継がない新しい Fork を立てて届ける */
  threadId?: string;
  title: string;
  text: string;
}

export type SendMessageResult =
  | { ok: true; text: string; threadId: string; createdFork: boolean }
  | { ok: false; text: string };

export interface ThreadMessagingDeps {
  projectThread: ProjectThreadStore;
  inbox: InboxStore;
  pendingApprovals: PendingApprovalRegistry;
  deliveries?: ThreadDeliveries;
  threadTurns?: ThreadTurns;
  /** 走っているターンの画面へ、判断待ちが出たことを流す（会話の中の承認カード） */
  publishJudgment?(
    threadId: string,
    judgment: { id: string; message: string; serverName: string; toolInput: unknown; choices: string[] },
  ): void;
  /** 走っているターンの画面へ、判断待ちに答えがついたことを流す（自動で許可したカードを答え済みにする、追加・2026-10-05） */
  publishAnswered?(threadId: string, answered: { id: string; answer: string }): void;
  /**
   * **その Project で「承認をすべて自動で許可する」がオンか**（追加・2026-10-05）。送るたびに引く。渡されなければ今までどおり聞く
   */
  autoApproveAll?(projectId: string): boolean;
  now?: () => number;
}

export function threadLabel(thread: ThreadState): string {
  return thread.title ?? (thread.kind === "base" ? "Base Thread" : "Fork Thread（名前なし）");
}

export class ThreadMessaging {
  constructor(private readonly deps: ThreadMessagingDeps) {}

  /** 宛先の一覧。**中身は読まない**——id・名前・状態だけ */
  listThreads(fromThreadId: string, allProjects: boolean): ThreadDirectoryEntry[] {
    const from = this.deps.projectThread.getThread(fromThreadId);
    if (!from) return [];
    const projects = allProjects
      ? this.deps.projectThread.listProjects().filter((p) => p.status === "active")
      : [this.deps.projectThread.getProject(from.projectId)].filter((p): p is ProjectState => p !== undefined);
    const waiting = new Set(
      this.deps.inbox
        .listOpen()
        // 生きている判断待ちだけ（期限切れは誰も答えを待っていない。訂正・2026-10-04）
        .filter((i) => i.kind === "judgment" && i.liveness === "live")
        .map((i) => (i as { threadId: string }).threadId),
    );
    const entries: ThreadDirectoryEntry[] = [];
    for (const p of projects) {
      for (const t of this.deps.projectThread.listThreadsForProject(p.id)) {
        if (t.status === "closed") continue;
        entries.push({
          projectId: p.id,
          projectName: p.name,
          threadId: t.id,
          label: threadLabel(t),
          kind: t.kind,
          state: waiting.has(t.id)
            ? "waitingOnHuman"
            : this.deps.threadTurns?.isRunning(t.id)
              ? "running"
              : "idle",
          ...(t.id === fromThreadId ? { self: true } : {}),
        });
      }
    }
    return entries;
  }

  /**
   * 送る。Project をまたぐときは、要るなら人の承認を待つ（`signal` が立ったら待つのをやめて断る）。
   * **断る理由は文で返す**——AI が読んで直せるように
   */
  async send(fromThreadId: string, req: SendMessageRequest, signal?: AbortSignal): Promise<SendMessageResult> {
    const store = this.deps.projectThread;
    const from = store.getThread(fromThreadId);
    const fromProject = from && store.getProject(from.projectId);
    if (!from || !fromProject) return { ok: false, text: "送り元の Thread が見つかりません。" };
    if (!this.deps.deliveries) return { ok: false, text: "この banto には届ける口がありません。" };
    const title = req.title.trim();
    const text = req.text.trim();
    if (title === "") return { ok: false, text: "題（title）が空です。" };
    if (text === "") return { ok: false, text: "本文（text）が空です。" };

    // ——宛先を決める
    let target: ThreadState | undefined;
    let targetProject: ProjectState | undefined;
    if (req.threadId) {
      target = store.getThread(req.threadId);
      if (!target) return { ok: false, text: `宛先の Thread ${req.threadId} が見つかりません。list_threads で確かめてください。` };
      if (req.projectId && req.projectId !== target.projectId) {
        return { ok: false, text: `Thread ${req.threadId} は Project ${req.projectId} のものではありません。` };
      }
      if (target.id === from.id) return { ok: false, text: "自分自身には送れません。" };
      if (target.status === "closed") return { ok: false, text: "宛先の Thread は閉じられています。" };
      targetProject = store.getProject(target.projectId);
    } else {
      if (!req.projectId) return { ok: false, text: "宛先（projectId か threadId）を指してください。" };
      targetProject = store.getProject(req.projectId);
      if (!targetProject) return { ok: false, text: `宛先の Project ${req.projectId} が見つかりません。list_threads で確かめてください。` };
    }
    if (!targetProject) return { ok: false, text: "宛先の Project が見つかりません。" };
    if (targetProject.status === "closed") return { ok: false, text: "宛先の Project は閉じられています。" };
    const base = target ? undefined : store.listThreadsForProject(targetProject.id).find((t) => t.kind === "base");
    if (!target && !base) return { ok: false, text: "宛先の Project に Base Thread がありません。" };

    // ——Project をまたぐなら、許されているかを見る
    const crossProject = targetProject.id !== fromProject.id;
    if (crossProject && !this.mayPassWithoutAsking(from, fromProject, targetProject, target)) {
      // **送り元の Project のスイッチで決める**（追加・2026-10-05）——頼んだのは送り元の AI で、聞かれるのも送り元の会話
      const decision =
        this.deps.autoApproveAll?.(fromProject.id) === true
          ? await this.autoApprove(from, fromProject, targetProject, target, { title, text })
          : await this.ask(from, fromProject, targetProject, target, { title, text }, signal);
      if (decision === "deny") {
        return { ok: false, text: "人が Project をまたぐ送信を許しませんでした。送っていません。" };
      }
      if (decision === "remember") {
        await store.setMessageSenders(targetProject.id, [...(targetProject.acceptMessagesFrom ?? []), fromProject.id]);
      }
    }

    // ——届ける（Project だけなら、会話を引き継がない Fork を立ててから）
    const createdFork = !target;
    if (!target) target = await store.forkThread(base!.id, { title, fresh: true });
    const sender: MessageSender = {
      projectId: fromProject.id,
      projectName: fromProject.name,
      threadId: from.id,
      threadLabel: threadLabel(from),
    };
    const hop = (this.deps.threadTurns?.hopOf(from.id) ?? 0) + 1;
    const delivered = await this.deps.deliveries.deliver({
      threadId: target.id,
      from: `${fromProject.name} の ${sender.threadLabel}`,
      title,
      text,
      hop,
      sender,
    });
    const where = `「${targetProject.name}」の${createdFork ? `新しい Fork「${title}」` : `「${threadLabel(target)}」`}`;
    const wake =
      delivered.wake === "held"
        ? `ただし相手の AI は自動では起こしていません（${delivered.reason}）。`
        : "相手の AI が起きて続きをやります。";
    return {
      ok: true,
      threadId: target.id,
      createdFork,
      text: `${where}（threadId: ${target.id}）に届けた。${wake}返事はこの Thread に届く。`,
    };
  }

  /** 承認なしで通せるか：宛先の一覧に載っている／送り元への 24 時間以内の返事 */
  private mayPassWithoutAsking(
    from: ThreadState,
    fromProject: ProjectState,
    targetProject: ProjectState,
    target: ThreadState | undefined,
  ): boolean {
    if ((targetProject.acceptMessagesFrom ?? []).includes(fromProject.id)) return true;
    if (!target) return false;
    const received = from.receivedFrom?.[target.id];
    if (!received) return false;
    const now = (this.deps.now ?? Date.now)();
    return now - Date.parse(received) <= REPLY_WINDOW_MS;
  }

  /** 確認の画面に出す文と中身 */
  private describe(
    from: ThreadState,
    fromProject: ProjectState,
    targetProject: ProjectState,
    target: ThreadState | undefined,
    message: { title: string; text: string },
    auto: boolean,
  ): { judgmentMessage: string; toolInput: Record<string, unknown> } {
    const toLabel = target ? `「${threadLabel(target)}」` : "新しい Fork";
    const judgmentMessage =
      `Project をまたぐメッセージの確認：「${fromProject.name}」の「${threadLabel(from)}」の AI が、` +
      `「${targetProject.name}」の${toLabel}へメッセージを送ろうとしています`;
    const toolInput = {
      送り元: `${fromProject.name} / ${threadLabel(from)}`,
      宛先: `${targetProject.name} / ${target ? threadLabel(target) : "新しい Fork（会話を引き継がない）"}`,
      題: message.title,
      本文: message.text,
      注記: auto
        ? `「${fromProject.name}」は「承認をすべて自動で許可する」がオンなので、聞かずに送りました（「受け取ってよい Project」には足していません）`
        : `「${MESSAGE_ALLOW_REMEMBER}」を選ぶと、「${targetProject.name}」は「${fromProject.name}」からのメッセージを次から聞かずに受け取ります（${targetProject.name} の Project の設定で外せます）`,
    };
    return { judgmentMessage, toolInput };
  }

  /** 聞かずに許可する（「承認をすべて自動で許可する」）。答え済みのカードだけを送り元の会話に残す。覚えない */
  private async autoApprove(
    from: ThreadState,
    fromProject: ProjectState,
    targetProject: ProjectState,
    target: ThreadState | undefined,
    message: { title: string; text: string },
  ): Promise<"allow"> {
    const { judgmentMessage, toolInput } = this.describe(from, fromProject, targetProject, target, message, true);
    const choices = [MESSAGE_ALLOW, MESSAGE_ALLOW_REMEMBER, MESSAGE_DENY];
    const judgment = await raiseAutoApprovedJudgment(this.deps.inbox, {
      threadId: from.id,
      source: "message",
      message: judgmentMessage,
      serverName: "banto",
      toolInput,
      choices,
    });
    this.deps.publishJudgment?.(from.id, { id: judgment.id, message: judgmentMessage, serverName: "banto", toolInput, choices });
    this.deps.publishAnswered?.(from.id, { id: judgment.id, answer: AUTO_APPROVED_ANSWER_TEXT });
    return "allow";
  }

  private async ask(
    from: ThreadState,
    fromProject: ProjectState,
    targetProject: ProjectState,
    target: ThreadState | undefined,
    message: { title: string; text: string },
    signal: AbortSignal | undefined,
  ): Promise<"allow" | "remember" | "deny"> {
    if (signal?.aborted) return "deny";
    const { judgmentMessage, toolInput } = this.describe(from, fromProject, targetProject, target, message, false);
    const choices = [MESSAGE_ALLOW, MESSAGE_ALLOW_REMEMBER, MESSAGE_DENY];
    const judgment = await this.deps.inbox.raiseJudgment({
      threadId: from.id,
      source: "message",
      message: judgmentMessage,
      serverName: "banto",
      toolInput,
      choices,
    });
    this.deps.publishJudgment?.(from.id, { id: judgment.id, message: judgmentMessage, serverName: "banto", toolInput, choices });

    const answer = await new Promise<{ behavior: string; remember?: unknown }>((resolve) => {
      this.deps.pendingApprovals.register(judgment.id, (result) => resolve(result as { behavior: string }));
      // ターンが止められた（tool の呼び出しが取り消された）——待つのをやめ、判断待ちも畳む
      signal?.addEventListener(
        "abort",
        () => {
          const denied = { behavior: "deny" as const, message: "ターンが止まりました" };
          if (this.deps.pendingApprovals.resolve(judgment.id, denied)) {
            void this.deps.inbox.answerJudgment(judgment.id, denied).catch(() => undefined);
          }
        },
        { once: true },
      );
    });
    if (answer.behavior !== "allow") return "deny";
    return answer.remember === true ? "remember" : "allow";
  }
}
