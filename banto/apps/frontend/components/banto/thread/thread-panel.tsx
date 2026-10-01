"use client";

// 1つの Thread（Base か Fork）を表示する。各パネルが独立した useLocalRuntime を持つ
// ——banto は複数の Thread を同時に画面へ並べる（Base Thread・Fork Thread・Canvas）ので、
// 「1つの RuntimeProvider が1つのアクティブスレッドを持つ」という assistant-ui の
// RemoteThreadListRuntime の前提とは相性が悪い。Thread ごとに Runtime を分けることで、
// 複数パネルの同時表示をそのまま実現する（Command Palette 等での Thread 一覧操作は
// 別の場所で Event Store 相当のストアから作る——ここでは会話の表示・送信だけを担う）。
import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { AssistantRuntimeProvider, ExportedMessageRepository, useLocalRuntime } from "@assistant-ui/react";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { ThreadIdProvider } from "@/components/banto/thread/thread-id-context";
import { ForkIcon } from "@/components/banto/thread/thread-icons";
import type { ForkFromMessage } from "@/components/banto/thread/fork-from-message";
import { CanvasAutoOpen } from "@/components/banto/thread/canvas-auto-open";
import { ComposerModelMenu } from "@/components/banto/thread/composer-model-menu";
import { ComposerPermissionModeMenu } from "@/components/banto/thread/composer-permission-mode-menu";
import { HumanAwareToolGroup, HumanToolCard } from "@/components/banto/thread/human-tool-card";
import { OpenableCard } from "@/components/banto/thread/openable-card";
import { APPROVAL_TOOL_NAMES, createMockChatModelAdapter, HUMAN_TOOL_NAME } from "@/lib/mock/adapter";
import {
  cancelRunQuietly,
  followVersion,
  registerRuntimeBusy,
  releaseRealRun,
  reportRuntimeIdle,
  realMessagesToInitial,
  restoredSyncVersion,
  subscribeFollow,
  takeFollowToStart,
} from "@/lib/backend/adapter";
import { registerOpenThread } from "@/lib/backend/latest-state";
import { ImageAttachmentAdapter } from "@/lib/backend/image-attachment";
import { CanvasOpenerProvider, type CanvasOpener } from "@/components/banto/canvas/canvas-opener";
import { getProject } from "@/lib/mock/projects";
import { seedToInitialMessages } from "@/lib/mock/seed";
import { getThread, getThreadsForProject } from "@/lib/mock/threads";
import type { MockThread } from "@/lib/mock/types";
import { CONNECTED_FEATURES } from "@/lib/feature-flags";
import { markThreadViewing } from "@/lib/backend/real-inbox";
import { keepComposerDraft } from "@/lib/composer-drafts";

export interface ThreadMarker {
  id: string;
  kind: "clear" | "compact";
}

/** Clear／Compaction が起きたことを示す横線。実際に起きた場所（transcript中）に
 *  差し込む——composerHintに置くと常に入力欄の直上に固定され、リロード後に
 *  どこでClearしたか分からなくなる（指摘・2026-09-04で訂正）。 */
function MarkerDivider({ kind }: { kind: ThreadMarker["kind"] }) {
  return (
    // 印そのものを指せるようにしておく（`data-testid`）——「Clear」という文字は
    // メニュー項目にもあるので、文字だけで探すと**押したメニューの文字**に当たって
    // しまい、横線が出ていなくても通ってしまう（規則14、2026-09-10）
    <div data-testid="thread-marker" data-kind={kind} className="flex items-center gap-2 text-xs text-ink-3">
      <div className="h-px flex-1 bg-border" />
      <span>{kind === "clear" ? "Clear" : "Compaction"}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

/** 未永続化（compact等、ローカルのみ）のマーカーをComposer直上にまとめて出す
 *  ——「起きた場所」が分かる情報（seq）を持たないものだけがここに残る。 */
function ThreadMarkers({ markers }: { markers: readonly ThreadMarker[] }) {
  if (markers.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {markers.map((m) => (
        <MarkerDivider key={m.id} kind={m.kind} />
      ))}
    </div>
  );
}

/**
 * **Fork の画面では、分ける前の親の会話は最後の1件だけ出す**（決定・2026-09-29、ユーザー）。
 * host は Fork に親の記録を分けた所まで写して持たせている（`project-thread/fold.ts`、それは変えない）。
 * 長い会話から分けると Fork も親と同じ量を描くことになり、重さの元だった。親の会話は親を開けば読める。
 * 分けた場所は `realCreatedSeq`（過去から分けたならその発言の seq）——そこまでが親の分
 */
function forkOwnPart<T extends { seq: number }>(thread: MockThread, items: readonly T[]): readonly T[] {
  const cut = thread.kind === "fork" ? thread.realCreatedSeq : undefined;
  if (cut === undefined) return items;
  return items.filter((m) => m.seq > cut);
}

function visibleRealMessages(thread: MockThread): MockThread["realMessages"] {
  const all = thread.realMessages;
  if (!all || thread.kind !== "fork" || thread.realCreatedSeq === undefined) return all;
  const cut = thread.realCreatedSeq;
  const lastParent = all.filter((m) => m.seq <= cut).at(-1);
  const own = forkOwnPart(thread, all);
  return lastParent ? [lastParent, ...own] : [...own];
}

export function ThreadPanel({
  threadId,
  onOpenCanvas,
  onOpenFork,
  onForkFrom,
  markers,
}: {
  threadId: string;
  /** MCP Apps の display mode "fullscreen"——tool 呼び出し自身が要求したら呼ばれる（§6.2） */
  onOpenCanvas?: CanvasOpener;
  /** 分岐した場所に残る「この Fork を開く」（決定・2026-09-07） */
  onOpenFork?: (threadId: string) => void;
  /** **そのメッセージの時点から**枝を分ける（決定・2026-09-11、ユーザー要望）。
   *  引数は host の物差し（seq） */
  onForkFrom?: ForkFromMessage;
  markers?: readonly ThreadMarker[];
}) {
  const thread = getThread(threadId);

  const adapter = useMemo(() => (thread ? createMockChatModelAdapter(thread) : null), [thread]);
  // **判断待ちは、走っているターンの流れで出る**（改訂・2026-09-26）。以前はリロード後に受信箱から
  // 判断待ちを拾って会話の末尾に描き足していた（2026-09-06）が、いまは開き直すと host がそのターンを
  // 最初から流し直す（`latest-state.ts`）——判断待ちのカードもその中にある。受信箱から描き足す道は、
  // **受信箱が変わるたびに会話を作り直し**、人が送った直後に当たると送信ごと消していた
  // （実測・2026-09-26、`turn-lifecycle-abandoned` が10回に3回）。同じものを描く道を1つにした（規則3）
  const initialMessages = useMemo(() => {
    if (!thread) return [];
    if (!thread.real) return seedToInitialMessages(thread.script.seed);
    return realMessagesToInitial(visibleRealMessages(thread), thread.id);
  }, [thread]);
  // リロード時のマーカー表示復元（決定・2026-09-04）——永続化済みのClearマーカーを、
  // 実際に起きた場所（直前のmessageのid）に紐づけて transcript 中へ差し込む。
  // messageのidは realMessagesToInitial が振る `real-${seq}` と同じ規則を使うので、
  // seq比較だけで「どのmessageの直後か」が求まる（真実は一箇所——handleClear側で
  // 別途ローカルにも記録したりしない、サーバから返るmarkers/messagesだけを見る）。
  // パネルが解体されたら「このブラウザはもう読んでいない」を伝える
  // （決定・2026-09-06）。伝えないと、判断待ちで中断しているジェネレータが
  // 掃除されず、その Thread は復元も新しいターンもできなくなる
  // ——docs/notes/2026-09-06-tool-approval-review.md
  const realThreadId = thread?.real ? thread.id : null;
  useEffect(() => {
    if (!realThreadId) return;
    return () => releaseRealRun(realThreadId);
  }, [realThreadId]);
  // **開いて見ている Thread のターンの終わりは、受信箱に積まない**（決定・2026-09-27）——見ている人に知らせは要らない
  useEffect(() => {
    if (!realThreadId) return;
    return markThreadViewing(realThreadId);
  }, [realThreadId]);
  // **開いている間、最新の状況を出し続ける**（決定・2026-09-26、ユーザー要望）——開いたとき・他所でターンが
  // 始まった／終わったとき・流れが切れたとき・画面に戻ってきたとき、記録から組み直し、走っていれば本文に流す
  useEffect(() => {
    if (!realThreadId) return;
    return registerOpenThread(realThreadId);
  }, [realThreadId]);
  // 記録から組み直した（乗った流れを描き始める）——会話を作り直す合図
  useSyncExternalStore(subscribeFollow, followVersion, () => 0);

  const transcriptMarkers = useMemo(() => {
    if (!thread?.real) return undefined;
    const msgs = visibleRealMessages(thread) ?? [];
    const map = new Map<string | null, ReactNode>();
    // 起きた場所（直前の message）に紐づける。Clear の横線も Fork の入口も
    // 物差しは同じ seq——**別の仕組みを増やさない**（規則3）
    const anchorOf = (seq: number): string | null => {
      let anchor: string | null = null;
      for (const m of msgs) {
        if (m.seq < seq) anchor = `real-${m.seq}`;
        else break;
      }
      return anchor;
    };
    const put = (anchor: string | null, node: ReactNode) => {
      const existing = map.get(anchor);
      map.set(anchor, existing ? <>{existing}{node}</> : node);
    };
    // Fork では親の分の横線（Clear 等）は出さない——その発言を描いていない
    for (const marker of forkOwnPart(thread, thread.realMarkers ?? [])) {
      put(anchorOf(marker.seq), <MarkerDivider key={`marker-${marker.seq}`} kind={marker.kind} />);
    }
    // **分岐した場所に「この Fork を開く」を置く**（決定・2026-09-07、ユーザー要望）。
    // Fork は横のレールからも開けるが、**会話のどこで分けたのか**はそこからは
    // 分からない——分けた場所に残っているのが、あとで辿るときの手がかりになる
    for (const fork of getThreadsForProject(thread.projectId)) {
      if (fork.kind !== "fork" || fork.parentThreadId !== thread.id) continue;
      if (fork.realCreatedSeq === undefined) continue;
      // 数えるのは Fork 自身のやり取りだけ（親から写した分を数えると、分けたばかりでも「180 件」になる）
      const count = forkOwnPart(fork, fork.realMessages ?? []).length;
      put(
        anchorOf(fork.realCreatedSeq),
        <OpenableCard
          key={`fork-${fork.id}`}
          icon={ForkIcon}
          title={fork.title}
          description={count > 0 ? `${count} 件のやり取り` : "まだやり取りはありません"}
          onOpen={onOpenFork ? () => onOpenFork(fork.id) : undefined}
          testId="fork-open-card"
        />,
      );
    }
    return map;
  }, [thread, onOpenFork]);

  if (!thread || !adapter) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-ink-3">
        Thread が見つかりません（{threadId}）
      </div>
    );
  }

  // **中身が揃うまで会話を組み立てない**（改訂・2026-09-07、実測）。
  // 一覧は要約だけになったので、会話の中身は Project を開いてから届く
  // ——先に空で組み立ててしまうと、**後から届いても入らない**
  // （useLocalRuntime は initialMessages を作るときにしか読まない）。
  // 中身が0件の Thread は `[]` を持つので、「まだ来ていない」と区別がつく。
  if (thread.real && thread.realMessages === undefined) {
    return (
      <div
        className="flex h-full items-center justify-center text-sm text-ink-3"
        data-testid="thread-loading"
      >
        会話を読み込んでいます…
      </div>
    );
  }

  const placeholder =
    thread.kind === "fork"
      ? "この Fork Thread に送る"
      : `${getProject(thread.projectId).name} の Base Thread に送る`;

  return (
    <ThreadRuntime
      // **ランタイムは Thread ごとに1つ、作り直さない**（改訂・2026-09-28、Fable のレビュー→ユーザー判断）。
      // 以前は記録から組み直すたびに key を変えてランタイムごと捨てていたので、そのたびに入力欄・
      // スクロール・カードの開閉・流れていた run の後片づけまで失っていた。いまは組み直した版
      // （`restoredSyncVersion`）が進んだら、**同じランタイムに記録を流し込む**（ThreadRuntime の中）。
      // **会話が送っている・流している間は組み直さない**（`registerRuntimeBusy`）のは前と同じ
      key={thread.id}
      build={restoredSyncVersion(thread.id)}
      adapter={adapter}
      initialMessages={initialMessages}
      placeholder={placeholder}
      threadId={thread.id}
      projectId={thread.projectId}
      onOpenCanvas={onOpenCanvas}
      markers={markers ?? []}
      transcriptMarkers={transcriptMarkers}
      allowBranching={!thread.real || CONNECTED_FEATURES.threadBranching}
      onForkFrom={thread.real ? onForkFrom : undefined}
      // 画像を添えられるのは host に届く Thread だけ（モックの台本は画像を読まない・規則13）
      imageAttachments={!!thread.real && CONNECTED_FEATURES.composerImages}
    />
  );
}

function ThreadRuntime({
  adapter,
  initialMessages,
  placeholder,
  threadId,
  projectId,
  onOpenCanvas,
  markers,
  transcriptMarkers,
  allowBranching,
  onForkFrom,
  imageAttachments,
  build,
}: {
  adapter: ReturnType<typeof createMockChatModelAdapter>;
  initialMessages: ReturnType<typeof seedToInitialMessages>;
  placeholder: string;
  threadId: string;
  projectId: string;
  onOpenCanvas?: CanvasOpener;
  markers: readonly ThreadMarker[];
  transcriptMarkers?: ReadonlyMap<string | null, ReactNode>;
  allowBranching: boolean;
  onForkFrom?: ForkFromMessage;
  imageAttachments: boolean;
  /** この会話を記録から組み立てた版（`restoredSyncVersion`）。進んだら記録を流し込み直す。乗った流れを描き始めてよいかの照合にも使う */
  build: number;
}) {
  const attachments = useMemo(
    () => (imageAttachments ? new ImageAttachmentAdapter() : undefined),
    [imageAttachments],
  );
  const runtime = useLocalRuntime(adapter, {
    initialMessages,
    ...(attachments ? { adapters: { attachments } } : {}),
    unstable_humanToolNames: [HUMAN_TOOL_NAME, ...APPROVAL_TOOL_NAMES],
  });

  // **書きかけは面が作り直されても残す**（決定・2026-09-28、ユーザー要望）——ランタイムは組み直しでは
  // 作り直さなくなったが、別のページへ行く・Fork と Canvas を両方開く等で面ごと消えることはある。
  // 入力欄の中身は外に写しておき、作られたら戻す。描く前に戻す（空の入力欄を一瞬見せない）
  useLayoutEffect(() => keepComposerDraft(threadId, runtime.thread.composer), [runtime, threadId]);

  // **記録から組み直したら、同じランタイムに流し込む**（決定・2026-09-28）。作ったときの版（最初の
  // `initialMessages` がそれ）から版が進んだら、そのときの写しで会話を入れ替える。描く前に入れ替える
  // （古い会話を一瞬見せない）。走っている run が残っていれば先に止める——前は作り直しで捨てていたもの
  // （呼ぶ側は走っている間は組み直さないので、ふつうは何も走っていない）
  const importedBuild = useRef(build);
  useLayoutEffect(() => {
    if (importedBuild.current === build) return;
    importedBuild.current = build;
    // 人の停止ではない——host のターンは止めない（§6.31）
    cancelRunQuietly(threadId, () => runtime.thread.cancelRun());
    runtime.thread.import(ExportedMessageRepository.fromArray(initialMessages));
    // 流し込む版は build が進んだときの写し——initialMessages はその都度写しから作り直されている
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, build]);

  // **host が走らせているターンに乗ったら、自分で送ったときと同じく本文に流す**（決定・2026-09-26）。
  // 乗るたびに会話は記録から組み直される（上で流し込む）。**描き始めるのは、乗ったあとに組み直した版の
  // 会話だけ**（`build`）。流れを読むのは adapter の run——自分で送ったターンと同じ道（規則3）
  useEffect(() => {
    if (!takeFollowToStart(threadId, build)) return;
    const messages = runtime.thread.getState().messages;
    runtime.thread.startRun({ parentId: messages.at(-1)?.id ?? null });
  }, [runtime, threadId, build]);
  // **送っている・流している間は、会話を組み直させない**（決定・2026-09-26）——人が Enter を押してから host に
  // 送り出すまでの間に組み直すと、送った発言ごと会話が作り直されて送信が消える
  useEffect(
    () => registerRuntimeBusy(threadId, () => runtime.thread.getState().isRunning),
    [runtime, threadId],
  );
  // 走り終えたら知らせる——走っている間に引き返した「最新を出す」を、ここでやり直す
  useEffect(() => {
    let wasRunning = runtime.thread.getState().isRunning;
    return runtime.thread.subscribe(() => {
      const running = runtime.thread.getState().isRunning;
      if (wasRunning && !running) reportRuntimeIdle(threadId);
      wasRunning = running;
    });
  }, [runtime, threadId]);

  const hint: ReactNode = <ThreadMarkers markers={markers} />;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {/* 会話の奥（inline の Canvas）から「大きく出して」を伝える通り道（§6.2） */}
      <CanvasOpenerProvider value={onOpenCanvas ?? null}>
      {/* 奥で描かれるカードに「どの Thread か」を伝える——Fork は親と同じ
          toolCallId を持つので、これが無いと画面の持ち主を取り違える */}
      <ThreadIdProvider value={threadId}>
      {CONNECTED_FEATURES.mockCanvasSurfaces && onOpenCanvas ? <CanvasAutoOpen onOpenCanvas={onOpenCanvas} /> : null}
      <Thread
        placeholder={placeholder}
        composerActionSlot={
          <>
            {/* 選んだ値は host が持つ——host に無い Thread（モックの固定データ）では出さない（規則13） */}
            {CONNECTED_FEATURES.composerModelEffort && getThread(threadId)?.real ? (
              <ComposerModelMenu threadId={threadId} />
            ) : null}
            <ComposerPermissionModeMenu threadId={threadId} projectId={projectId} />
          </>
        }
        components={{ ToolFallback: HumanToolCard, ToolGroup: HumanAwareToolGroup }}
        composerHint={hint}
        transcriptMarkers={transcriptMarkers}
        // やり直し（Edit・Reload・BranchPicker）——実 Thread では host が分岐を
        // 持たないので出さない（規則13、`CONNECTED_FEATURES.threadBranching`）
        allowBranching={allowBranching}
        // 「ここから Fork」——分ける位置（seq）だけを渡す。どのセッションへ
        // 戻すかは host が決める（アーキ仕様 §2.2）
        onForkFrom={onForkFrom}
      />
      </ThreadIdProvider>
      </CanvasOpenerProvider>
    </AssistantRuntimeProvider>
  );
}
