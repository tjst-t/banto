"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, Bell, Clock, ExternalLink, Maximize2, Minimize2, Settings, X } from "lucide-react";
import { CloseIcon, ForkIcon, type IconComponent } from "@/components/banto/thread/thread-icons";
import {
  RenameOnRightClick,
  type RenameTarget,
} from "@/components/banto/thread/rename-on-right-click";
import { toast } from "sonner";
import { useIsMobile } from "@/hooks/use-mobile";
import { useMounted } from "@/hooks/use-mounted";
import { CanvasContent } from "@/components/banto/canvas/canvas-content";
import { ModuleCanvas } from "@/components/banto/canvas/module-canvas";
import {
  getRealInlineView,
  hasLiveRealRun,
  rebuildThreadFromRecord,
} from "@/lib/backend/adapter";
import { refreshRealInbox } from "@/lib/backend/real-inbox";
import { MobileNavDrawer } from "@/components/banto/shell/mobile-nav-drawer";
import { useJudgmentCount } from "@/components/banto/shell/nav-panel";
import { PanelStack } from "@/components/banto/shell/panel-stack";
import { usePanelStack } from "@/components/banto/shell/use-panel-stack";
import { ProjectSettingsOverlay } from "@/components/banto/settings/project-settings-overlay";
import { ContextUsageMeter } from "@/components/banto/thread/context-usage-meter";
import { ThreadActionsMenu } from "@/components/banto/thread/thread-actions-menu";
import { ThreadPanel, type ThreadMarker } from "@/components/banto/thread/thread-panel";
import {
  clearRealThread,
  createRealFork,
  getRealThread,
  loadRealProjectThreads,
  prepareRealProjectModules,
} from "@/lib/backend/client";
import { reportFailure } from "@/lib/report-failure";
import { getProject, hydrateRealProjects, renameProject } from "@/lib/mock/projects";
import {
  foldForkThread,
  getThread,
  registerRealFork,
  renameForkThread,
  updateRealThreadData,
} from "@/lib/mock/threads";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import { CONNECTED_FEATURES } from "@/lib/feature-flags";

const SHOW_ARCHIVE = CONNECTED_FEATURES.threadCloseReopen || CONNECTED_FEATURES.projectCloseReopen;

function PanelHeader({
  leading,
  title,
  onRename,
  children,
}: {
  /** ヘッダの左端に置くもの（モバイルのナビの入口） */
  leading?: ReactNode;
  title: string;
  /** 題を右クリックしたら名前を変えられる（決定・2026-09-11、ユーザー要望）
   *  ——サイドバーまで戻らなくても、いま見ている面から直せる */
  onRename?: RenameTarget;
  children?: ReactNode;
}) {
  return (
    // モバイルでは専用の上部バーを廃したので、**これが画面の上段そのもの**
    // ——`<header>` にして、位置の回帰試験（mobile-layout.spec.ts）が
    // 見ている「上段」と実物を一致させる
    <header className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border px-2 md:h-11 md:px-3">
      {leading}
      {/* 実Projectのhydration完了前後でtitleがサーバー/クライアントで食い違いうる
          （real-projects-bootstrap.tsx）。suppressHydrationWarningが無いと、
          Reactはミスマッチ検出時にこのテキストだけでなく祖先ツリー全体を
          クライアント側で作り直す——その巻き添えでThreadPanel（会話中の
          ストリーミング購読）ごと再マウントされ、応答が届かなくなる実害を
          実測で確認した。ここでは意図的な差分なので警告を抑止する */}
      <RenameOnRightClick target={onRename}>
        <p
          className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
          suppressHydrationWarning
        >
          {title}
        </p>
      </RenameOnRightClick>
      <div className="flex shrink-0 items-center gap-1.5">{children}</div>
    </header>
  );
}

// Fork Thread・Canvas 用。閉じる操作のアイコンを左端に置く
// （Escape での同じ操作は panel-stack.tsx に1箇所だけ持つ——前面の層だけを閉じる）
function ClosablePanelHeader({
  icon: Icon,
  onClose,
  closeLabel,
  titleIcon: TitleIcon,
  title,
  onRename,
  trailing,
}: {
  icon: IconComponent;
  onClose: () => void;
  closeLabel: string;
  /** 何の面か（Fork Thread・Canvas）はアイコンで示す——狭い幅では文字の接頭辞が
      題そのものを押し出してしまう（3層のときフォーク名が途中で切れていた） */
  titleIcon?: IconComponent;
  title: string;
  /** 題を右クリックしたら名前を変えられる（決定・2026-09-11、ユーザー要望） */
  onRename?: RenameTarget;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-2 md:h-11">
      <button
        type="button"
        onClick={onClose}
        aria-label={closeLabel}
        className="flex size-9 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-accent md:size-7"
      >
        <Icon className="size-4" />
      </button>
      {TitleIcon ? <TitleIcon className="size-4 shrink-0 text-ink-3" /> : null}
      <RenameOnRightClick target={onRename}>
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground" title={title}>
          {title}
        </p>
      </RenameOnRightClick>
      {trailing}
    </div>
  );
}

function IconHeaderButton({
  onClick,
  label,
  icon: Icon,
}: {
  onClick: () => void;
  label: string;
  icon: IconComponent;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex size-9 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-accent md:size-7"
    >
      <Icon className="size-4" />
    </button>
  );
}

/** 受信箱の入口（モバイルのヘッダ用）。判断待ち・お知らせの件数をバッジで出す */
function InboxHeaderButton({ onClick }: { onClick: () => void }) {
  const judgmentCount = useJudgmentCount();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={judgmentCount > 0 ? `受信箱（${judgmentCount}件）` : "受信箱"}
      className="relative flex size-9 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-accent md:size-7"
    >
      <Bell className="size-4" />
      {judgmentCount > 0 ? (
        <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-turn text-xs leading-none font-semibold text-on-color">
          {judgmentCount}
        </span>
      ) : null}
    </button>
  );
}

export function ProjectPanels({ projectId }: { projectId: string }) {
  // 実Projectのhydration（アプリ起動時の非同期読み込み、
  // components/banto/real-projects-bootstrap.tsx）が終わったら再描画する
  // ——直接そのProjectのURLへ来たとき、最初のレンダーではまだ実データが
  // 無い可能性があるため。
  useMockStoreVersion();
  const stack = usePanelStack(projectId);
  const project = getProject(projectId);
  const searchParams = useSearchParams();
  // モバイルの Canvas はすでにヘッダ以外の全画面を使っているので、
  // 全画面トグルは無意味（押しても見た目が変わらない）——desktop だけに出す
  const isMobile = useIsMobile();
  const [markersByThread, setMarkersByThread] = useState<Record<string, ThreadMarker[]>>({});
  // 実Projectの場合、SSR側はhydrateRealProjects()未実行のためデモの初期値
  // （banto Project・"banto-base" Thread）にフォールバックしたまま描画される。
  // クライアント初回hydrateも同じ内容なら一致するが、そのあとuseMockStoreVersion
  // 経由で実データに切り替わる時、ThreadPanel配下のThread種別・DemoHints表示
  // 等が丸ごと入れ替わり、Reactの通常のhydration mismatch対処（テキストの
  // suppressHydrationWarning）では吸収しきれない規模の差分になる——ページ
  // 遷移から戻ってきた際に実際に会話ツリーごと壊れることを実測で確認した。
  // クライアント側の初回マウントが済むまでは何も描画せず、SSR出力と
  // 完全に一致させることでmismatch自体を起こさない
  const mounted = useMounted();

  // **Project を開いたら、その Project の Module を先に用意する**
  // （決定・2026-09-07、ユーザー）。最初のターンで待たされず、繋がらないことにも
  // 人が何か打つ前に気づける（繋がらなかったら受信箱にお知らせが出る）。
  // 返事は待たない——用意できていなくても会話は始められる
  // **開いた Project の会話の中身は、ここで取りに行く**（改訂・2026-09-07、実測）。
  // 一覧は要約だけになったので、開いていない Project の全会話まで受け取ることは
  // もう無い（起動時の API 転送 2.88MB のうち 2.875MB がそれだった）。
  //
  // **Project がまだ手元に無い瞬間に諦めない**——直接この URL へ来たときは
  // 一覧の読み込み（hydrate）がまだ終わっていない。先に待ってから確かめる
  // （実測・2026-09-07：早々に return して二度と取りに行かず、会話が
  //  「読み込んでいます…」のまま止まった）。hydrate は進行中のものを
  // 使い回すので、二重には取りに行かない
  useEffect(() => {
    let cancelled = false;
    void hydrateRealProjects()
      .then(async () => {
        if (cancelled || !getProject(projectId)?.real) return;
        const threads = await loadRealProjectThreads(projectId);
        if (cancelled) return;
        for (const t of threads) updateRealThreadData(t.id, t.messages, t.markers, t.usage);
        // その Project の Module を用意する（決定・2026-09-07）。返事は待たない
        // ——用意できなければ受信箱にお知らせが出る
        await prepareRealProjectModules(projectId).then(() => refreshRealInbox());
      })
      .catch((err: unknown) => {
        // 取れなければ会話は出ない。**黙って古いものを見せない**
        // ——開き直せば取り直す。**ただし黙りもしない**（改訂・2026-09-10）：
        // 以前はここで握りつぶしていたので、会話は「読み込んでいます…」の
        // ままで、なぜ出ないのかが誰にも分からなかった
        if (!cancelled) reportFailure("この Project の会話を読み込めませんでした", err);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  function addMarker(threadId: string, kind: ThreadMarker["kind"]) {
    setMarkersByThread((prev) => ({
      ...prev,
      [threadId]: [...(prev[threadId] ?? []), { id: `${kind}-${(prev[threadId]?.length ?? 0) + 1}`, kind }],
    }));
  }

  // 「Clear」——実Threadなら実際にresume-pointを捨てる（v4-architecture.md §2.2
  // 「会話を畳む」）。マーカーはbanto host側に永続化される（真実は一箇所、規則3）
  // ——ローカルに楽観的なコピーを足すのではなく、host側の最新状態を取り直して
  // thread-panel.tsx側のseqベースの位置合わせ（transcript中への差し込み）に任せる。
  async function handleClear(threadId: string) {
    const thread = getThread(threadId);
    if (!thread?.real) {
      addMarker(threadId, "clear");
      return;
    }
    try {
      await clearRealThread(threadId);
      const updated = await getRealThread(threadId);
      // **畳んだら、記録から会話を組み直す**（決定・2026-09-11）。組み直すと
      // 各発言が host の物差し（seq）を持つ——横線が**起きた場所**に出るのも
      // （§6.4 transcriptMarkers）、そこから枝を分けられるのも、これがあってこそ。
      // **走行中は組み直さない**——流れている表示を壊す
      if (!hasLiveRealRun(threadId)) rebuildThreadFromRecord(threadId);
      updateRealThreadData(threadId, updated.messages, updated.markers, updated.usage);
    } catch (err) {
      toast(`Clear に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Fork Threadを畳む（削除ではない、archive-dialog.tsxから読み返して再度開ける）。
  // ローカルのrealMessagesはFork作成時以降更新されていない（真実は一箇所、規則3
  // ——会話中はassistant-ui側のruntimeが状態を持ち、mockThreadsへは書き戻さない）
  // ——畳む直前にhost側の最新状態を取り直してから畳む。取り直さないと、
  // 履歴（Archive）の概要が「0件のやり取り」のまま古くなる（指摘・2026-09-04）。
  async function handleCloseFork(threadId: string) {
    try {
      // 畳む手順そのものは lib/mock/threads.ts に1つだけ持つ——サイドバーの
      // 目次からも同じ経路を通る（規則3）
      await foldForkThread(threadId);
      stack.close("fork");
    } catch (err) {
      toast(`Fork を Close できませんでした: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Fork Threadを立てる（決定・2026-09-04——旧実装はデモ用の固定id"ui"を
  // 開くだけで、実データには一切繋がっていなかった）。実際にhost側へ
  // forkThreadを叩き、その場で登録してから開く。
  /**
   * 枝を分けて開く。**過去のメッセージからも分けられる**（決定・2026-09-11、
   * ユーザー要望）——`fromSeq` はそのメッセージの seq。どのセッションへ戻すかは
   * host が決める（アーキ仕様 §2.2）。口は1つ（規則3）——ヘッダの「Fork を開く」も
   * 会話の中の「ここから Fork」も、ここを通る。
   */
  async function handleOpenFork(baseThreadId: string, fromSeq?: number) {
    const base = getThread(baseThreadId);
    if (!base?.real) {
      toast("この Thread は実 Project ではないため、Fork を作れません");
      return;
    }
    try {
      const fork = await createRealFork(baseThreadId, fromSeq);
      registerRealFork(
        fork.id,
        fork.projectId,
        baseThreadId,
        fork.messages,
        fork.markers,
        "open",
        fork.usage,
        // **入口は「分けた場所」に置く**——過去から分けたならその位置
        fork.forkedFromSeq ?? fork.createdSeq,
      );
      stack.open({ fork: fork.id });
    } catch (err) {
      toast(`Fork の作成に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 「別タブで開く」——banto のクロム（ProjectRail・ヘッダ等）を持たない
  // /canvas-window へ、その Canvas に要る状態（canvas・fsFile 等）だけを運ぶ。
  // fork/overlay/fullscreen は banto 側のパネル状態なので運ばない
  function openCanvasInNewTab() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("fork");
    params.delete("overlay");
    params.delete("fullscreen");
    // **別タブは手元の記憶を持たない**（決定・2026-09-07、ユーザー報告）
    // ——どの Thread の記録から引き直せばよいかを一緒に運ぶ。
    // 以前はこれが無く、別タブではモックの固定データが描かれていた
    const realView = stack.canvas?.toolCallId ? getRealInlineView(stack.canvas.toolCallId) : undefined;
    if (realView) params.set("thread", realView.threadId);
    // **入口（launcher）から開いた面は Thread を持たない**——どの Project の
    // Module かだけが要る（決定・2026-09-07、ユーザー要望で別タブ対応を広げた）
    else params.set("project", projectId);
    window.open(`/canvas-window?${params.toString()}`, "_blank", "noopener,noreferrer");
    // 別タブへ切り出したら、元の banto 側では畳む——同じものが2箇所に開いた
    // ままだと紛らわしい
    stack.close("canvas");
  }

  if (!mounted) return null;

  return (
    <>
    <PanelStack
      projectId={projectId}
      renderBase={() => (
        <div className="flex h-full min-h-0 flex-col">
          <PanelHeader
            // モバイルはここが唯一のナビの入口（上部バーを廃した分、段が1つ減る）
            leading={isMobile ? <MobileNavDrawer projectId={projectId} /> : undefined}
            // **題は Project 名だけ**（改訂・2026-09-11、ユーザー要望）。
            // 「Base Thread —」の接頭辞はやめた——その面が何かは、いま開いて
            // いるもので分かる（Fork なら Fork の名前とアイコンが出る）
            title={project.name}
            onRename={{
              what: "Project",
              name: project.name,
              onRename: (name) => renameProject(project.id, name),
            }}
          >
            {CONNECTED_FEATURES.contextUsage ? <ContextUsageMeter threadId={project.baseThreadId} /> : null}
            <IconHeaderButton icon={ForkIcon} label="Fork を開く" onClick={() => handleOpenFork(project.baseThreadId)} />
            {isMobile ? (
              // 判断待ちは「止まっている」ので、目次を開かなくても件数が見える
              // 位置に置く。履歴は急がないので Drawer に譲る（段を1つに保つ）
              CONNECTED_FEATURES.inbox ? (
                <InboxHeaderButton onClick={() => stack.open({ overlay: "inbox" })} />
              ) : null
            ) : SHOW_ARCHIVE ? (
              <IconHeaderButton
                icon={Clock}
                label="履歴"
                onClick={() => stack.open({ overlay: "archive" })}
              />
            ) : null}
            {CONNECTED_FEATURES.projectSettings ? (
              <IconHeaderButton
                icon={Settings}
                label="Project 設定"
                onClick={() => stack.open({ overlay: "settings-project" })}
              />
            ) : null}
            <ThreadActionsMenu
              onClear={() => handleClear(project.baseThreadId)}
              onCompact={CONNECTED_FEATURES.compaction ? () => addMarker(project.baseThreadId, "compact") : undefined}
            />
          </PanelHeader>
          <div className="min-h-0 flex-1">
            <ThreadPanel
              threadId={project.baseThreadId}
              onOpenCanvas={
                // **実 Module の面はいつでも開ける**（決定・2026-09-07）。
                // `CONNECTED_FEATURES.mockCanvasSurfaces` はモックの固定データの面を出すかの旗で、
                // 本物の Canvas はそれとは別（規則13：繋がっているものは見せてよい）
                (moduleId, viewId, toolCallId) => stack.open({ canvas: { moduleId, viewId, toolCallId } })
              }
              onOpenFork={(id) => stack.open({ fork: id })}
              onForkFrom={(seq) => void handleOpenFork(project.baseThreadId, seq)}
              markers={markersByThread[project.baseThreadId]}
            />
          </div>
        </div>
      )}
      renderFork={(threadId) => {
        const thread = getThread(threadId);
        return (
          <div className="flex h-full min-h-0 flex-col">
            <ClosablePanelHeader
              icon={ArrowLeft}
              onClose={() => stack.close("fork")}
              closeLabel={`${project.name} の Base Thread に戻る`}
              titleIcon={ForkIcon}
              title={thread?.title ?? threadId}
              onRename={
                thread
                  ? {
                      what: "Fork Thread",
                      name: thread.title,
                      onRename: (title) => renameForkThread(threadId, title),
                    }
                  : undefined
              }
              trailing={
                <div className="flex items-center gap-1.5">
                  {CONNECTED_FEATURES.contextUsage ? <ContextUsageMeter threadId={threadId} /> : null}
                  <ThreadActionsMenu
                    onClear={() => handleClear(threadId)}
                    onCompact={CONNECTED_FEATURES.compaction ? () => addMarker(threadId, "compact") : undefined}
                  />
                  {CONNECTED_FEATURES.threadCloseReopen ? (
                    <IconHeaderButton
                      icon={CloseIcon}
                      label="この Fork Thread を Close"
                      onClick={() => handleCloseFork(threadId)}
                    />
                  ) : null}
                </div>
              }
            />
            <div className="min-h-0 flex-1">
              <ThreadPanel
                threadId={threadId}
                onForkFrom={(seq) => void handleOpenFork(threadId, seq)}
                markers={markersByThread[threadId]}
              />
            </div>
          </div>
        );
      }}
      renderCanvas={(moduleId, viewId) => {
        // 実 Module の面（会話の記録から引ける）か、モックの面か。
        // **入口（launcher）から開いた面は tool 呼び出しを持たない**
        // ——`ui://` を指しているかで見分ける（決定・2026-09-07、§6.2）
        const realView = stack.canvas?.toolCallId ? getRealInlineView(stack.canvas.toolCallId) : undefined;
        const launcherUri = !realView && viewId.startsWith("ui://") ? viewId : undefined;
        return (
        <div className="flex h-full min-h-0 flex-col">
          <ClosablePanelHeader
            icon={X}
            onClose={() => stack.close("canvas")}
            closeLabel="Canvas を閉じる"
            title={realView || launcherUri ? `Canvas — ${moduleId}` : `Canvas — ${moduleId}:${viewId}`}
            trailing={
              <div className="flex items-center gap-1.5">
                {/* **どの開き方でも別タブに出せる**（改訂・2026-09-07、ユーザー要望）。
                    以前は全画面のときだけ出していたが、会話の隣で見ているときこそ
                    「これは別の窓で見たい」が起きる。別タブへ切り出したら
                    **元のタブ側は畳む**——同じものが2箇所に開いたままだと紛らわしい */}
                <IconHeaderButton icon={ExternalLink} label="別タブで開く" onClick={openCanvasInNewTab} />
                {isMobile ? null : (
                  <IconHeaderButton
                    icon={stack.canvasFullscreen ? Minimize2 : Maximize2}
                    label={stack.canvasFullscreen ? "全画面を解除" : "全画面で表示"}
                    onClick={() => stack.open({ canvasFullscreen: !stack.canvasFullscreen })}
                  />
                )}
              </div>
            }
          />
          <div className="min-h-0 flex-1">
            {launcherUri ? (
              // 人が入口から開いた面——tool の結果は無い。Canvas が自分で
              // 必要なものを取りに行く（§6.2「launcher も同じ形」）
              <ModuleCanvas
                owner={{ kind: "project", id: projectId }}
                server={moduleId}
                resourceUri={launcherUri}
                displayMode="fullscreen"
              />
            ) : realView ? (
              <ModuleCanvas
                owner={{ kind: "thread", id: realView.threadId }}
                server={realView.server}
                resourceUri={realView.resourceUri}
                toolName={realView.toolName}
                toolArgs={realView.toolArgs}
                toolResult={realView.toolResult}
                displayMode="fullscreen"
              />
            ) : (
              <CanvasContent moduleId={moduleId} viewId={viewId} />
            )}
          </div>
        </div>
        );
      }}
    />
    {CONNECTED_FEATURES.projectSettings ? (
      <ProjectSettingsOverlay
        projectId={projectId}
        open={stack.overlay === "settings-project"}
        onOpenChange={(open) => (open ? stack.open({ overlay: "settings-project" }) : stack.close("overlay"))}
      />
    ) : null}
    </>
  );
}
