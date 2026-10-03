// **履歴の項目に `content-visibility:auto` を付けない**（決定・2026-09-10、
// `mobile-transcript-height-jump`）。付けると、まだ画面に入っていない発言は
// `contain-intrinsic-size` の見込み（200px）で数えられ、**上へ辿って初めて
// 実寸に置き換わる**——つまり辿っている最中に中身の高さが伸び、指で追っている
// 位置がずれる。実測（実データ・54発言・390×844）：
//   そのまま 15,770px → 29,742px（+13,972）／無効にすると 31,589px のまま動かない。
// 代償も測った：開いて履歴が出るまで 652ms → 760ms（+108ms）。ただし**上まで辿る
// 時間は 238ms → 166ms と短くなる**（辿るたびに測り直さなくなるため）。
"use client";

import { useTouchKeyboard } from "@/hooks/use-touch-keyboard";
import {
  ComposerAddAttachment,
  ComposerAttachments,
  UserMessageAttachments,
} from "@/components/assistant-ui/elements/attachment.aui";
import { AssistantMark } from "@/components/banto/thread/assistant-mark";
import { DeliveredMessage } from "@/components/banto/thread/delivered-message";
import type { RealMessageOrigin } from "@/lib/backend/client";
import { describeAttachmentAddError } from "@/lib/backend/image-attachment";
import { ForkIcon } from "@/components/banto/thread/thread-icons";
import {
  ForkFromMessageProvider,
  seqOfMessageId,
  useForkFromMessage,
  type ForkFromMessage,
} from "@/components/banto/thread/fork-from-message";
import { File } from "@/components/assistant-ui/elements/file";
import { ThreadFollowupSuggestions } from "@/components/assistant-ui/elements/follow-up-suggestions.aui";
import { Image } from "@/components/assistant-ui/elements/image";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import {
  Reasoning,
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "@/components/assistant-ui/elements/reasoning.aui";
import { ToolFallback } from "@/components/assistant-ui/elements/tool-fallback.aui";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/components/assistant-ui/elements/tool-group.aui";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { KeepScrollPositionOnResize } from "@/components/banto/thread/keep-scroll-position-on-resize";
import { RememberScrollPosition } from "@/components/banto/thread/remember-scroll-position";
import { ShowEarlierMessages, useMessageWindow } from "@/components/banto/thread/message-window";
import { useThreadId } from "@/components/banto/thread/thread-id-context";
import { useRestoreWithdrawn } from "@/components/banto/thread/use-restore-withdrawn";
import { recalledThreadScroll } from "@/lib/thread-scroll-memory";
import { KeyboardDebugOverlay } from "@/components/banto/thread/keyboard-debug-overlay";
import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  type AssistantState,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  groupPartByType,
  MessagePrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  unstable_useThreadMessageIds,
  type FileMessagePartComponent,
  type ImageMessagePartComponent,
  type ToolCallMessagePartComponent,
  useAui,
  useAuiEvent,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  MicIcon,
  MoreHorizontalIcon,
  PencilIcon,
  RefreshCwIcon,
  SquareIcon,
} from "lucide-react";
import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type ComponentType,
  type FC,
  type PropsWithChildren,
  type ReactNode,
} from "react";

export type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart;

/**
 * Optional component overrides for the thread. `AssistantMessage` and
 * `Welcome` replace whole sections; the remaining slots override how the
 * assistant message renders tool calls and part groups. Tool UIs registered
 * by name (toolkit `render`, `useAssistantDataUI`) take precedence over
 * `ToolFallback`.
 */
export type ThreadComponents = {
  AssistantMessage?: ComponentType | undefined;
  Welcome?: ComponentType | undefined;
  ToolFallback?: ToolCallMessagePartComponent | undefined;
  ToolGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
  ReasoningGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
};

/**
 * **やり直し（分岐）を出してよいか**（`frontend-interaction-hardening`、2026-09-10）。
 * 実 Thread では host が分岐を持たないので出さない（規則13）。既定は「出す」
 * ——モックの台本はローカルの分岐で完結している。
 */
const BranchingContext = createContext(true);

export type ThreadProps = {
  components?: ThreadComponents | undefined;
  autoFocus?: boolean | undefined;
  /** composer の placeholder。「どこに向けて送るか」を文脈で示す（banto の幹／この枝） */
  placeholder?: string | undefined;
  /** composer の左下、＋ボタンの右に出す任意の内容（banto: モデル／エフォート選択） */
  composerActionSlot?: ReactNode;
  /** composer の直上に出す任意の内容（banto: モックのデモヒントに使う） */
  composerHint?: ReactNode;
  /**
   * transcript中に差し込むマーカー（banto: Clear／Compaction の横線）。
   * キーは「直後に差し込む」対象のmessage id、`null`は「最初のmessageより前」。
   * `composerHint`と違い、実際に起きた場所に出す（決定・2026-09-04——
   * composerHintは常に入力欄の直上に固定されるため、リロード後に
   * どこでClearしたか分からなくなる問題があった）。
   */
  transcriptMarkers?: ReadonlyMap<string | null, ReactNode>;
  /** やり直し（Edit・Reload・BranchPicker）を出すか。既定は出す
   *  ——実 Thread では host が分岐を持たないので false（規則13、2026-09-10） */
  allowBranching?: boolean;
  /** **そのメッセージの時点から**枝を分ける（決定・2026-09-11）。渡さなければ
   *  「ここから Fork」は出ない（記録に繋がっていない会話では分けられない） */
  onForkFrom?: ForkFromMessage;
};

const EMPTY_COMPONENTS: ThreadComponents = {};

const ThreadComponentsContext =
  createContext<ThreadComponents>(EMPTY_COMPONENTS);

// Startup exposes a loading placeholder thread; treat it as a new chat so
// the composer mounts centered. Loads after startup keep the docked layout.
const isNewChatView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  (!s.thread.isLoading || s.threads.isLoading);

// A switched thread that is still fetching its history: skeleton, not welcome.
const isHistoryLoadingView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  s.thread.isLoading &&
  !s.thread.isDisabled &&
  !s.threads.isLoading;

const ThreadHistorySkeleton: FC = () => (
  <div
    data-slot="aui_thread-history-skeleton"
    role="status"
    className="animate-in fade-in fill-mode-both flex flex-col gap-y-6 [animation-delay:150ms] [animation-duration:200ms]"
  >
    <span className="sr-only">Loading conversation</span>
    <Skeleton className="ml-auto h-9 w-2/5 rounded-xl motion-reduce:animate-none" />
    <div className="flex flex-col gap-y-2">
      <Skeleton className="h-4 w-11/12 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-4/5 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-3/5 motion-reduce:animate-none" />
    </div>
    <Skeleton className="ml-auto h-9 w-1/3 rounded-xl motion-reduce:animate-none" />
    <div className="flex flex-col gap-y-2">
      <Skeleton className="h-4 w-10/12 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-2/3 motion-reduce:animate-none" />
    </div>
  </div>
);

/** `?kbdebug=1` が付いているときだけ覗き窓を出す（普段は何も描かない）。 */
const KeyboardDebugWhenAsked: FC = () => {
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    setAsked(new URLSearchParams(window.location.search).get("kbdebug") === "1");
  }, []);
  return asked ? <KeyboardDebugOverlay /> : null;
};

export const Thread: FC<ThreadProps> = ({
  components = EMPTY_COMPONENTS,
  autoFocus = true,
  placeholder,
  composerActionSlot,
  composerHint,
  transcriptMarkers,
  allowBranching = true,
  onForkFrom,
}) => {
  const isEmpty = useAuiState(isNewChatView);

  return (
    <ThreadComponentsContext.Provider value={components}>
      <BranchingContext.Provider value={allowBranching}>
      <ForkFromMessageProvider value={onForkFrom ?? null}>
      <ThreadRoot
        isEmpty={isEmpty}
        autoFocus={autoFocus}
        placeholder={placeholder}
        composerActionSlot={composerActionSlot}
        composerHint={composerHint}
        transcriptMarkers={transcriptMarkers}
      />
      </ForkFromMessageProvider>
      </BranchingContext.Provider>
    </ThreadComponentsContext.Provider>
  );
};

const ThreadRoot: FC<{
  isEmpty: boolean;
  autoFocus: boolean;
  placeholder?: string | undefined;
  composerActionSlot?: ReactNode;
  composerHint?: ReactNode;
  transcriptMarkers?: ReadonlyMap<string | null, ReactNode>;
}> = ({ isEmpty, autoFocus, placeholder, composerActionSlot, composerHint, transcriptMarkers }) => {
  const { Welcome = ThreadWelcome } = useContext(ThreadComponentsContext);
  // **作り直された面は、読んでいた場所へ戻す**（決定・2026-09-28）。覚えた場所が「一番下」以外なら、
  // ライブラリの「最初に一番下へ」を止めて RememberScrollPosition が戻す。決まるのは作られたとき1回だけ
  const threadId = useThreadId();
  const [restoreTo] = useState(() => {
    const recalled = threadId ? recalledThreadScroll(threadId) : undefined;
    return recalled && recalled !== "bottom" ? recalled : undefined;
  });

  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root bg-background @container flex h-full flex-col"
      style={{
        ["--thread-max-width" as string]: "44rem",
        ["--composer-bg" as string]: "var(--color-card)",
        ["--composer-radius" as string]: "1.5rem",
        ["--composer-padding" as string]: "8px",
      }}
    >
      {/* **返事が伸びたら一番下を追いかける**（改訂・2026-09-28、ユーザー判断「案B」）。以前は
          turnAnchor="top"——最後の人の発言を器の上端に固定し、返事が伸びても追いかけなかったので、
          走っている Thread を開くと最新ターンの頭で止まり「上のほうに出る」と見えていた（実測：8秒で
          一番下から 1138px 上）。人が上へスクロールしたら追うのをやめる（ライブラリの既定） */}
      <ThreadPrimitive.Viewport
        turnAnchor="bottom"
        scrollToBottomOnInitialize={restoreTo === undefined}
        data-slot="aui_thread-viewport"
        className="relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll"
      >
        {/* キーボードや URL バーで高さが変わっても、見えているものを保つ
            （決定・2026-09-09、根本見直し）。実内容が入力欄の下に続いていれば
            入力欄との間隔を保つ（turnAnchor="top" のときの「最後のターンの余白」の扱いも持っているが、
            いまは bottom なので余白は出ない） */}
        <KeepScrollPositionOnResize />
        {/* 読んでいた場所を覚え、面が作り直されたらそこへ戻す（決定・2026-09-28、ユーザー要望） */}
        <RememberScrollPosition restoreTo={restoreTo} />
        {/* `?kbdebug=1` のときだけ出る覗き窓（実機で何が起きているかを測るため。
            決定・2026-09-09——エミュレータでは実機のキーボード動作を作れない） */}
        <KeyboardDebugWhenAsked />
        <div
          className={cn(
            "mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-4 pt-4",
            isEmpty && "justify-center",
          )}
        >
          <AuiIf condition={isNewChatView}>
            <Welcome />
          </AuiIf>
          <AuiIf condition={isHistoryLoadingView}>
            <ThreadHistorySkeleton />
          </AuiIf>

          <div
            data-slot="aui_message-group"
            className="mb-14 flex flex-col gap-y-6 empty:hidden"
          >
            <ThreadMessagesWithMarkers transcriptMarkers={transcriptMarkers} mustInclude={restoreTo?.messageId} />
          </div>

          <ThreadPrimitive.ViewportFooter
            className={cn(
              "aui-thread-viewport-footer bg-background flex flex-col gap-4 overflow-visible pb-4 md:pb-6",
              !isEmpty &&
                "sticky bottom-0 mt-auto rounded-t-(--composer-radius)",
            )}
          >
            <ThreadScrollToBottom />
            <ThreadFollowupSuggestions />
            {composerHint}
            <Composer autoFocus={autoFocus} placeholder={placeholder} composerActionSlot={composerActionSlot} />
            <AuiIf condition={(s) => isNewChatView(s) && s.composer.isEmpty}>
              <ThreadSuggestions />
            </AuiIf>
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

const NO_MARKERS: ReadonlyMap<string | null, ReactNode> = new Map();

/**
 * `ThreadPrimitive.Messages`（render-propで全メッセージを一括描画）の代わりに
 * message idごとに手で回す——`transcriptMarkers`で指定されたmessage idの直後に
 * マーカー（Clear等の横線）を実際に差し込むため。`unstable_useThreadMessageIds`
 * は実験的APIだが、目的（idベースの手動描画）に対して用意されている想定の使い方。
 */
const ThreadMessagesWithMarkers: FC<{
  transcriptMarkers?: ReadonlyMap<string | null, ReactNode>;
  /** 読んでいた場所へ戻すときの発言——窓をそこまで広げておく */
  mustInclude?: string | undefined;
}> = ({ transcriptMarkers = NO_MARKERS, mustInclude }) => {
  const messageIds = unstable_useThreadMessageIds();
  // **最新の 20 件だけ描く**（決定・2026-09-29、`message-window.tsx`）
  const { visible, hiddenCount, showEarlier, anchorRef } = useMessageWindow(messageIds, mustInclude);
  return (
    <>
      <ShowEarlierMessages hiddenCount={hiddenCount} onShow={showEarlier} anchorRef={anchorRef} />
      {hiddenCount === 0 ? transcriptMarkers.get(null) : null}
      {visible.map((id) => (
        <Fragment key={id}>
          <ThreadPrimitive.Unstable_MessageById messageId={id} components={{ Message: ThreadMessage }} />
          {transcriptMarkers.get(id)}
        </Fragment>
      ))}
    </>
  );
};

const ThreadMessage: FC = () => {
  const { AssistantMessage: AssistantMessageComponent = AssistantMessage } =
    useContext(ThreadComponentsContext);
  const role = useAuiState((s) => s.message.role);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);
  // **機械から届いたもの**（決定・2026-09-25）——人の吹き出しの形は使わない
  const origin = useAuiState(
    (s) => (s.message.metadata?.custom as { origin?: RealMessageOrigin } | undefined)?.origin,
  );

  if (isEditing) return <EditComposer />;
  if (role === "user" && origin) return <DeliveredMessage origin={origin} />;
  if (role === "user") return <UserMessage />;
  return <AssistantMessageComponent />;
};

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="Scroll to bottom"
        variant="outline"
        className="aui-thread-scroll-to-bottom dark:border-border dark:bg-background dark:hover:bg-accent absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible"
      >
        <ArrowDownIcon />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

const ThreadWelcome: FC = () => {
  return (
    <div className="aui-thread-welcome-root mb-6 flex flex-col items-center px-4 text-center">
      <h1 className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-2xl font-medium tracking-tight duration-200">
        How can I help you today?
      </h1>
    </div>
  );
};

const ThreadSuggestions: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestions flex w-full flex-wrap items-center justify-center gap-2 px-4">
      <ThreadPrimitive.Suggestions>
        {() => <ThreadSuggestionItem />}
      </ThreadPrimitive.Suggestions>
    </div>
  );
};

const ThreadSuggestionItem: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestion-display fade-in slide-in-from-bottom-2 animate-in fill-mode-both duration-200">
      <SuggestionPrimitive.Trigger send asChild>
        <Button
          variant="ghost"
          className="aui-thread-welcome-suggestion text-foreground hover:bg-muted border-border/60 h-auto gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-normal whitespace-nowrap transition-colors"
        >
          <SuggestionPrimitive.Title className="aui-thread-welcome-suggestion-text-1" />
          <SuggestionPrimitive.Description className="aui-thread-welcome-suggestion-text-2 empty:hidden" />
        </Button>
      </SuggestionPrimitive.Trigger>
    </div>
  );
};

/**
 * **貼り付けた画像を添える**（banto、決定・2026-09-26、ユーザー要望）。assistant-ui の既定
 * （`addAttachmentOnPaste`）は、クリップボードにファイルがあれば**文字を捨てて**添付にする。
 * Excel や Word からのコピーは文字と一緒にその絵も載るので、既定のままだと表を貼ったつもりが
 * 画像に化け、文字が消える。**文字があれば文字を貼る。文字が無いとき（スクリーンショット等）だけ
 * 画像を添える。** ファイルそのものを添えたいときは ＋ かドラッグで
 */
const usePasteImages = () => {
  const aui = useAui();
  return (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!aui.thread.getState().capabilities.attachments) return;
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    if (e.clipboardData.getData("text/plain") !== "") return;
    e.preventDefault();
    for (const file of files) {
      // 添えられなかった理由は assistant-ui が `composer.attachmentAddError` で知らせる
      // ——入力欄の中に出す（`ComposerAttachmentError`）。ここで二重に扱わない
      aui.composer.addAttachment(file).catch(() => undefined);
    }
  };
};

/** **添えられなかった理由を、入力欄の中に出す**（banto、決定・2026-09-26）——黙って何も起きない、を作らない */
const ComposerAttachmentError: FC = () => {
  const [error, setError] = useState<string>();
  useAuiEvent("composer.attachmentAddError", (e) => setError(describeAttachmentAddError(e.reason, e.message)));
  useAuiEvent("composer.attachmentAdd", () => setError(undefined));
  useAuiEvent("composer.send", () => setError(undefined));
  if (!error) return null;
  return (
    <p role="alert" data-testid="composer-attachment-error" className="text-destructive px-2.5 text-sm">
      {error}
    </p>
  );
};

const Composer: FC<{
  autoFocus: boolean;
  placeholder?: string | undefined;
  composerActionSlot?: ReactNode;
}> = ({ autoFocus, placeholder, composerActionSlot }) => {
  const pasteImages = usePasteImages();
  // **画面のキーボードが出る端末では、Enter は改行**（banto、2026-10-03、ユーザー要望）。送るのは画面の送信ボタンだけ
  // ——キーボードの Enter が送信だと改行が入れられない。見分けは自動の焦点と同じ（`useTouchKeyboard`）
  const touchKeyboard = useTouchKeyboard();
  // 止めて取り消した発言を、ここへ戻す（banto、v4-frontend.md §6.31）
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useRestoreWithdrawn(inputRef);
  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      <ComposerPrimitive.AttachmentDropzone asChild>
        <div
          data-slot="aui_composer-shell"
          className="border-border/60 data-[dragging=true]:border-ring focus-within:border-border dark:border-muted-foreground/15 dark:focus-within:border-muted-foreground/30 flex w-full cursor-text flex-col gap-2 rounded-(--composer-radius) border bg-(--composer-bg) p-(--composer-padding) transition-[border-color] data-[dragging=true]:border-dashed data-[dragging=true]:bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-background))]"
        >
          <ComposerAttachments />
          <ComposerAttachmentError />
          <ComposerPrimitive.Input
            ref={inputRef}
            placeholder={placeholder ?? "Send a message..."}
            className="aui-composer-input caret-primary placeholder:text-muted-foreground/60 max-h-48 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-base leading-6 outline-none"
            rows={1}
            autoFocus={autoFocus}
            // キーボードの Enter の表示も合わせる（携帯では「改行」、パソコンでは「送信」）
            enterKeyHint={touchKeyboard ? "enter" : "send"}
            submitMode={touchKeyboard ? "none" : "enter"}
            aria-label="Message input"
            addAttachmentOnPaste={false}
            onPaste={pasteImages}
          />
          <ComposerAction composerActionSlot={composerActionSlot} />
        </div>
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  );
};

const ComposerAction: FC<{ composerActionSlot?: ReactNode }> = ({ composerActionSlot }) => {
  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-between">
      <div className="flex items-center gap-1.5">
        {/* 添えられない会話（モックの台本）では出さない——押せるのに何も起きない、を作らない（規則13） */}
        <AuiIf condition={(s) => s.thread.capabilities.attachments}>
          <ComposerAddAttachment />
        </AuiIf>
        {composerActionSlot}
      </div>
      <div className="flex items-center gap-1.5">
        <AuiIf condition={(s) => s.thread.capabilities.dictation}>
          <AuiIf condition={(s) => s.composer.dictation == null}>
            <ComposerPrimitive.Dictate asChild>
              <TooltipIconButton
                tooltip="Voice input"
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-dictate text-muted-foreground hover:text-foreground size-7 rounded-full"
                aria-label="Start voice input"
              >
                <MicIcon className="aui-composer-dictate-icon size-4" />
              </TooltipIconButton>
            </ComposerPrimitive.Dictate>
          </AuiIf>
          <AuiIf condition={(s) => s.composer.dictation != null}>
            <ComposerPrimitive.StopDictation asChild>
              <TooltipIconButton
                tooltip="Stop dictation"
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-stop-dictation text-destructive size-7 rounded-full"
                aria-label="Stop voice input"
              >
                <SquareIcon className="aui-composer-stop-dictation-icon size-3.5 animate-pulse fill-current" />
              </TooltipIconButton>
            </ComposerPrimitive.StopDictation>
          </AuiIf>
        </AuiIf>
        <AuiIf condition={(s) => !s.thread.isRunning}>
          <ComposerPrimitive.Send asChild>
            <TooltipIconButton
              tooltip="Send message"
              side="bottom"
              type="button"
              variant="default"
              size="icon"
              className="aui-composer-send size-7 rounded-full"
              aria-label="Send message"
            >
              <ArrowUpIcon className="aui-composer-send-icon size-4" />
            </TooltipIconButton>
          </ComposerPrimitive.Send>
        </AuiIf>
        <AuiIf condition={(s) => s.thread.isRunning}>
          <ComposerPrimitive.Cancel asChild>
            <Button
              type="button"
              variant="default"
              size="icon"
              className="aui-composer-cancel size-7 rounded-full"
              aria-label="Stop generating"
            >
              <SquareIcon className="aui-composer-cancel-icon size-3.5 fill-current" />
            </Button>
          </ComposerPrimitive.Cancel>
        </AuiIf>
      </div>
    </div>
  );
};

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root border-destructive bg-destructive/10 text-destructive dark:bg-destructive/5 mt-2 rounded-md border p-3 text-sm dark:text-red-200">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

const AssistantMessage: FC = () => {
  const {
    ToolFallback: ToolFallbackComponent = ToolFallback,
    ToolGroup,
    ReasoningGroup,
  } = useContext(ThreadComponentsContext);

  const ACTION_BAR_PT = "pt-1.5";
  // Keep the action bar inside the contained root's paint box, then cancel its reserved space in flow.
  const ACTION_BAR_HEIGHT = `min-h-7.5 ${ACTION_BAR_PT}`;

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="fade-in slide-in-from-bottom-1 animate-in relative -mb-7.5 pb-7.5 duration-150"
    >
      <AssistantMark />
      <div
        data-slot="aui_assistant-message-content"
        className="text-foreground relative py-0 pr-2 pl-8 leading-relaxed wrap-break-word"
      >
        <MessagePrimitive.GroupedParts
          groupBy={groupPartByType({
            reasoning: ["group-chainOfThought", "group-reasoning"],
            "tool-call": ["group-chainOfThought", "group-tool"],
            "standalone-tool-call": [],
          })}
        >
          {({ part, children }) => {
            switch (part.type) {
              case "group-chainOfThought":
                return <div data-slot="aui_chain-of-thought">{children}</div>;
              case "group-tool":
                if (ToolGroup) {
                  return <ToolGroup group={part}>{children}</ToolGroup>;
                }
                return (
                  <ToolGroupRoot variant="ghost">
                    <ToolGroupTrigger
                      count={part.indices.length}
                      active={part.status.type === "running"}
                    />
                    <ToolGroupContent>{children}</ToolGroupContent>
                  </ToolGroupRoot>
                );
              case "group-reasoning": {
                if (ReasoningGroup) {
                  return (
                    <ReasoningGroup group={part}>{children}</ReasoningGroup>
                  );
                }
                const running = part.status.type === "running";
                return (
                  <ReasoningRoot streaming={running}>
                    <ReasoningTrigger active={running} />
                    <ReasoningContent aria-busy={running}>
                      <ReasoningText>{children}</ReasoningText>
                    </ReasoningContent>
                  </ReasoningRoot>
                );
              }
              case "text":
                return <MarkdownText />;
              case "reasoning":
                return <Reasoning {...part} />;
              case "tool-call":
                return part.toolUI ?? <ToolFallbackComponent {...part} />;
              case "data":
                return part.dataRendererUI;
              case "file":
                return (
                  <div data-slot="aui_assistant-message-file" className="py-1">
                    <File {...part} />
                  </div>
                );
              case "image":
                return (
                  <div data-slot="aui_assistant-message-image" className="py-1">
                    <Image {...part} />
                  </div>
                );
              case "indicator":
                return (
                  <span
                    data-slot="aui_assistant-message-indicator"
                    className="animate-pulse font-sans"
                    aria-label="Assistant is working"
                  >
                    {"●"}
                  </span>
                );
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        <MessageError />
      </div>

      {/* **本文の左端にそろえる**（決定・2026-09-11、ユーザー報告）。本文は
          `pl-8`（32px）から始まるので、帯もそこへ——ボタンの内側の余白ぶん
          （`-ms-1`）は下の帯が戻している */}
      <div
        data-slot="aui_assistant-message-footer"
        className={cn("ms-8 flex items-center", ACTION_BAR_HEIGHT)}
      >
        <BranchPicker />
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

/**
 * **ここから枝を分ける**（決定・2026-09-11、ユーザー要望）。
 *
 * 出すのは、**host の記録から組み直したメッセージ**だけ——分ける位置は host の
 * 物差し（seq）で表すので、それを持たない発言（モックの台本・まだ記録に
 * 落ちていない走行中の発言）からは分けられない。繋がっていないものは出さない（規則13）。
 */
const ForkFromHereButton: FC = () => {
  const forkFrom = useForkFromMessage();
  const seq = seqOfMessageId(useAuiState((s) => s.message.id));
  // **いま走り終わったばかりの発言は seq を持たない**（記録から組み直す前）。
  // それが会話の最後なら「いまの続きから」で同じ意味になるので出す——
  // 途中の発言で位置が分からないときだけ、出さない（規則13）
  const isLast = useAuiState((s) => s.message.isLast);
  if (!forkFrom) return null;
  if (seq === undefined && !isLast) return null;
  return (
    <TooltipIconButton
      tooltip="ここから Fork"
      data-testid="fork-from-message"
      onClick={() => forkFrom(seq)}
    >
      <ForkIcon />
    </TooltipIconButton>
  );
};

const AssistantActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-assistant-action-bar-root text-muted-foreground animate-in fade-in col-start-3 row-start-2 -ms-1 flex gap-1 duration-200"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="Copy">
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      {useContext(BranchingContext) ? (
        <ActionBarPrimitive.Reload asChild>
          <TooltipIconButton tooltip="Refresh">
            <RefreshCwIcon />
          </TooltipIconButton>
        </ActionBarPrimitive.Reload>
      ) : null}
      <ForkFromHereButton />
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild>
          <TooltipIconButton
            tooltip="More"
            className="data-[state=open]:bg-accent"
          >
            <MoreHorizontalIcon />
          </TooltipIconButton>
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="aui-action-bar-more-content bg-popover text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] overflow-hidden rounded-xl border p-1.5"
        >
          <ActionBarPrimitive.ExportMarkdown asChild>
            <ActionBarMorePrimitive.Item className="aui-action-bar-more-item hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none">
              <DownloadIcon className="size-4" />
              Export as Markdown
            </ActionBarMorePrimitive.Item>
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  );
};

const UserFilePart: FileMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-file" className="py-1">
    <File {...part} />
  </div>
);

const UserImagePart: ImageMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-image" className="py-1">
    <Image {...part} />
  </div>
);

const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className="fade-in slide-in-from-bottom-1 animate-in grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 [&:where(>*)]:col-start-2"
      data-role="user"
    >
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div className="aui-user-message-content peer bg-muted text-foreground rounded-xl px-4 py-2 wrap-break-word empty:hidden">
          <MessagePrimitive.Parts
            components={{ File: UserFilePart, Image: UserImagePart }}
          />
        </div>
        <div className="aui-user-action-bar-wrapper absolute start-0 top-1/2 -translate-x-full -translate-y-1/2 pe-2 peer-empty:hidden rtl:translate-x-full">
          <UserActionBar />
        </div>
      </div>

      <BranchPicker
        data-slot="aui_user-branch-picker"
        className="col-span-full col-start-1 row-start-3 -me-1 justify-end"
      />
    </MessagePrimitive.Root>
  );
};

const UserActionBar: FC = () => {
  // やり直しが繋がっていないなら、入口ごと出さない（規則13）
  if (!useContext(BranchingContext)) return null;
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-user-action-bar-root flex flex-col items-end"
    >
      <ActionBarPrimitive.Edit asChild>
        <TooltipIconButton tooltip="Edit" className="aui-user-action-edit">
          <PencilIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
  );
};

const EditComposer: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="flex flex-col px-2"
    >
      <ComposerPrimitive.Root className="aui-edit-composer-root border-border/60 dark:border-muted-foreground/15 ms-auto flex w-full max-w-[85%] cursor-text flex-col rounded-(--composer-radius) border bg-(--composer-bg)">
        <ComposerPrimitive.Input
          className="aui-edit-composer-input text-foreground min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base outline-none"
          autoFocus
        />
        <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 rounded-full px-3.5"
            >
              Cancel
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button size="sm" className="h-8 rounded-full px-3.5">
              Update
            </Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};

const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = ({
  className,
  ...rest
}) => {
  // 分岐が繋がっていないなら、枝の切替も出さない（規則13）
  if (!useContext(BranchingContext)) return null;
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn(
        "aui-branch-picker-root text-muted-foreground -ms-2 me-2 inline-flex items-center text-xs",
        className,
      )}
      {...rest}
    >
      <BranchPickerPrimitive.Previous asChild>
        <TooltipIconButton tooltip="Previous">
          <ChevronLeftIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Previous>
      <span className="aui-branch-picker-state font-medium">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <TooltipIconButton tooltip="Next">
          <ChevronRightIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};
