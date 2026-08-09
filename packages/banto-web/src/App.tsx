/**
 * Banto の画面：**幹1本と枝、そして作業する面**（ADR-0017 決定77・79・80）。
 *
 * ## 骨格
 *
 * ```
 * .rail   横断の通知 ／ 抱えているものの点 ／ 履歴・設定・明暗   （狭いと上端の帯）
 * .rooms  [背表紙] 幹（地）→ 枝（その上の紙）→ 作業する面（さらに上）
 * ```
 *
 * **幹・枝・面は重なりで表す**（決定79）。広い画面で横に並んでいても関係は重なりのままで、
 * 狭い画面の重ねと同じ模型になる。狭いとき（760px 以下）は幹が地、枝と面が下から上がる紙で、
 * 上端に幹が覗く。
 *
 * **作業する面が開くと、いま居た会話は細い帯として残る**（決定79）——面を見ながら
 * 「これ何？」と訊けないのは、番頭が主体の店として本末転倒。帯の幅はつまんで変えられる。
 *
 * **面はどこから開いたかを覚える**（決定79・a12）。キャンバスは会話ごと（決定2）なので、
 * 面が載っているキャンバスがそのまま「どこから開いたか」になる——幹から開けば枝は視界から
 * 外れ、枝から開けば枝が細い帯として左に残る。畳んだ面を開き直すと、その組み合わせが戻る。
 *
 * **会話のタブは無い**（決定77）。幹は畳めず、枝はレールの点と幹の札から開く。
 *
 * D3/D5: 会話も面の状態もホストが持つ真実をそのまま描く。
 *
 * **いま見ている場所（面・会話・キャンバスのタブ・設定の区画）は URL が持つ**
 * （`viewLocation.ts`）。だから戻る／進むが効き、リロードしても同じ画面に戻る。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBantoSession } from "./useBantoSession.js";
import { resolveCanvasView } from "./views/registry.js";
import { ThreadHistory } from "./ThreadHistory.js";
import { SettingsPanel } from "./views/SettingsPanel.js";
import { Modal, SearchField } from "./views/ui.js";
import { useViewLocation } from "./viewLocation.js";
import { useTabOverflow } from "./useTabOverflow.js";
import { Icon, iconOfKind } from "./icons.js";
import { InboxFace } from "./Inbox.js";
import { CommandPalette, useCommandPalette } from "./CommandPalette.js";
import { useKeyHints } from "./keyHints.js";
import { useListNav } from "./listNav.js";
import { useThemeState } from "./theme/ThemeProvider.js";
import { Room } from "./Room.js";
import { NewBranchForm } from "./Branch.js";

/**
 * 既定は**同一オリジンの `/ws`**。開発サーバがそれを番頭ホストへ中継するので、
 * リバースプロキシ（Caddy等）のサブドメイン経由でもそのまま繋がる。
 * 別ホストの番頭に繋ぎたいときは `?host=ws://...` で上書きする。
 *
 * **中継 URL（`{baseUrl}/env/<envId>/`）で開かれたときは、WS も同じ中継パスへ繋ぐ**。
 */
function defaultWsUrl(): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const relay = location.pathname.match(/(\/env\/[^/]+)(?:\/|$)/);
  if (relay) {
    const prefix = location.pathname.slice(0, relay.index! + relay[1]!.length);
    return `${scheme}//${location.host}${prefix}/ws`;
  }
  return `${scheme}//${location.host}/ws`;
}

const WS_URL = new URLSearchParams(location.search).get("host") ?? defaultWsUrl();

/**
 * 細い帯の幅（決定79）。
 *
 * **そこで読むのではなく、話しかけるための幅**。主役がその時の作業で変わるので
 * 決め打ちにせず、つまんで変えられる（上下限だけ決める）。
 */
const SLIM_WIDTH_KEY = "banto.slimWidth";
const SLIM_WIDTH_DEFAULT = 344;
const SLIM_WIDTH_MIN = 260;
const SLIM_WIDTH_MAX = 620;

/** 狭い画面の境（決定79）。ここから下は幹が地で、枝と面が重なる紙になる。 */
const NARROW_PX = 760;

function clampSlimWidth(width: number): number {
  return Math.min(Math.max(width, SLIM_WIDTH_MIN), SLIM_WIDTH_MAX);
}

function readStoredSlimWidth(): number {
  try {
    const stored = Number(localStorage.getItem(SLIM_WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0 ? clampSlimWidth(stored) : SLIM_WIDTH_DEFAULT;
  } catch {
    return SLIM_WIDTH_DEFAULT;
  }
}

/** 狭いかどうか。**器の幅ではなくビューポート**——重ねるかどうかは画面全体の話。 */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.innerWidth <= NARROW_PX
  );
  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${NARROW_PX}px)`);
    const update = (): void => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}

export function App(): React.ReactElement {
  const theme = useThemeState();
  // ⌘K：既にある場所への近道。ここから新しい状態は生まれない
  const palette = useCommandPalette();
  // 符牒：⌥ を押している間だけ、押せるものにキーが浮く
  useKeyHints();
  const [view, navigate] = useViewLocation();
  const narrow = useNarrow();

  /**
   * ホストの都合で見る先が決まったとき（幹へ落ちる・自分が開いた枝）。
   * **面は保ったまま**会話だけ動かす。
   */
  const onActiveThread = useCallback(
    (threadId: string | undefined, { push }: { push: boolean }) => {
      navigate(
        (prev) => {
          const face = push ? "chat" : prev.face;
          return {
            face,
            ...(threadId ? { threadId } : {}),
            ...(face === "settings" && prev.section ? { section: prev.section } : {}),
            ...(face === "history" && prev.readThreadId
              ? { readThreadId: prev.readThreadId }
              : {}),
          };
        },
        { replace: !push }
      );
    },
    [navigate]
  );
  const session = useBantoSession(WS_URL, {
    activeThreadId: view.threadId,
    onActiveThread,
  });

  const [dragTabId, setDragTabId] = useState<string>();
  const [dropIndex, setDropIndex] = useState<number>();
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogQuery, setCatalogQuery] = useState("");
  /** 収まらないタブをまとめる ▾ の開閉。 */
  const [tabMenuOpen, setTabMenuOpen] = useState(false);
  /** 抱えているものの一覧（レールの「+N」から開く被さる面）。 */
  const [holdOpen, setHoldOpen] = useState(false);
  /** 枝を開くときの入力（還す条件と理由を書かせる）。 */
  const [newBranch, setNewBranch] = useState(false);
  /** 細い帯の幅（決定79）。 */
  const [slimWidth, setSlimWidth] = useState(readStoredSlimWidth);
  /**
   * 番頭への入力へ移る合図（PO要望 2026-08-06）。
   *
   * キーで会話へ飛んだのに、話しかけるのにマウスへ持ち替えるのでは近道にならない。
   * **面を見に行くときは移さない**——見に行ったのであって、話しかけに行ったのではない。
   */
  const [focusReq, setFocusReq] = useState<{ threadId: string; seq: number }>();
  /**
   * 狭い画面で、上がっていた紙を下ろしたか（決定79）。
   *
   * **面は畳まない**——覗きを押したら「幹へ戻る」であって「面を閉じる」ではない。
   * 閉じてしまうと、戻ったときに開き直す手間が増える（面は抱えたまま残る）。
   */
  const [lowered, setLowered] = useState(false);

  const historyOpen = view.face === "history";
  const settingsOpen = view.face === "settings";
  const inboxOpen = view.face === "inbox";
  const faceOpen = historyOpen || settingsOpen || inboxOpen;

  /** 被さっている面を閉じて会話へ戻る。 */
  const backToChat = useCallback(() => {
    navigate((prev) => ({
      face: "chat",
      ...(prev.threadId ? { threadId: prev.threadId } : {}),
      ...(prev.tabId ? { tabId: prev.tabId } : {}),
    }));
  }, [navigate]);
  const showFace = useCallback(
    (face: "chat" | "history" | "settings" | "inbox") => {
      navigate((prev) => {
        const next = prev.face === face ? "chat" : face;
        return {
          face: next,
          ...(prev.threadId ? { threadId: prev.threadId } : {}),
          ...(prev.tabId ? { tabId: prev.tabId } : {}),
          ...(next === "settings" && prev.section ? { section: prev.section } : {}),
          ...(next === "history" && prev.readThreadId ? { readThreadId: prev.readThreadId } : {}),
        };
      });
    },
    [navigate]
  );

  /**
   * いま見ている会話（幹または枝）。**既定は幹**——会話のタブは無いので、
   * どこにも居ないという状態は作らない（決定77）。
   */
  const focused = useMemo(
    () => (view.threadId ? session.threadOf(view.threadId) : undefined) ?? session.trunk,
    [view.threadId, session]
  );
  /** 枝を見ているか。幹は畳めないので、枝のときだけ2枚重なる。 */
  const branch = focused?.kind === "branch" ? focused : undefined;
  const trunk = session.trunk;

  /** 会話を移る（枝の札・レールの点・取次から）。 */
  const openThread = useCallback(
    (threadId: string, options: { focus?: boolean } = {}) => {
      setHoldOpen(false);
      backToChat();
      session.switchThread(threadId);
      if (options.focus) {
        setFocusReq((prev) => ({ threadId, seq: (prev?.seq ?? 0) + 1 }));
      }
    },
    [session, backToChat]
  );
  /** その列へ入力の合図が出ているか。 */
  const focusSeqOf = useCallback(
    (threadId: string): number => (focusReq?.threadId === threadId ? focusReq.seq : 0),
    [focusReq]
  );

  /**
   * 取次の一通を開く（決定73・75）。
   * **会話と面はホストが動かす**。画面が受け持つのは「どの面を出すか」だけ。
   */
  const openInboxItem = useCallback(
    (itemId: string) => {
      const item = session.inbox.find((i) => i.id === itemId);
      session.openInbox(itemId);
      if (item?.opens?.settings) {
        const section = item.opens.settings.section;
        navigate((prev) => ({
          face: "settings",
          ...(prev.threadId ? { threadId: prev.threadId } : {}),
          ...(prev.tabId ? { tabId: prev.tabId } : {}),
          ...(section ? { section } : {}),
        }));
        return;
      }
      backToChat();
    },
    [session, navigate, backToChat]
  );

  useEffect(() => {
    try {
      localStorage.setItem(SLIM_WIDTH_KEY, String(slimWidth));
    } catch {
      // ストレージが使えない環境でも幅の変更自体は効く
    }
  }, [slimWidth]);

  /** 細い帯をつまんで広げる（決定79）。会話は左にあるので、右へ動かすほど広くなる。 */
  const startResize = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = slimWidth;
    const onMove = (move: PointerEvent): void => {
      setSlimWidth(clampSlimWidth(startWidth + (move.clientX - startX)));
    };
    const onUp = (): void => {
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  };

  /**
   * **この画面で描ける面だけを「開けるもの」として扱う**（決定12・17）。
   * カタログを配るのはホスト、描けるかを知っているのはUI。
   */
  const openableCatalog = useMemo(
    () => session.catalog.filter((entry) => resolveCanvasView(entry.component) !== undefined),
    [session.catalog]
  );
  const unresolvedCatalog = useMemo(
    () => session.catalog.filter((entry) => resolveCanvasView(entry.component) === undefined),
    [session.catalog]
  );

  const catalogGroups = useMemo(() => {
    const q = catalogQuery.trim().toLowerCase();
    const matched = openableCatalog.filter((entry) =>
      q.length === 0
        ? true
        : `${entry.title} ${entry.description} ${entry.kind} ${entry.module}`.toLowerCase().includes(q)
    );
    return Object.entries(
      matched.reduce<Record<string, typeof session.catalog>>((groups, entry) => {
        const key = entry.category ?? "その他";
        (groups[key] ??= []).push(entry);
        return groups;
      }, {})
    );
  }, [openableCatalog, catalogQuery]);
  const catalogOrdered = useMemo(
    () => catalogGroups.flatMap(([, entries]) => entries),
    [catalogGroups]
  );

  // 収納メニューは外側を押したら閉じる
  useEffect(() => {
    if (!tabMenuOpen) return;
    const close = (e: MouseEvent): void => {
      if (!(e.target as Element | null)?.closest(".canvas-more-wrap")) setTabMenuOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [tabMenuOpen]);


  /**
   * キャンバスのタブ：URL とホストを合わせる。
   *
   * 真実はホスト（`canvas_state`）。URL は「どのタブを見たいか」の意図で、**動いた側に
   * 合わせて片方を直す**。
   */
  const syncedTabRef = useRef<string>(undefined);
  /** POがカタログから開いた1回だけ履歴に積む（番頭が開いた分は積まない）。 */
  const followOpenedTab = useRef(false);

  const openFromCatalog = (kind: string): void => {
    followOpenedTab.current = true;
    session.openView(kind);
    setCatalogOpen(false);
    setCatalogQuery("");
  };
  const catalogNav = useListNav(catalogOrdered, {
    onChoose: (entry) => openFromCatalog(entry.kind),
    resetKey: catalogQuery,
  });

  const { activeThreadId, activeTabId, tabs: canvasTabs, canvasKnown, switchTab } = session;
  useEffect(() => {
    if (!activeThreadId) return;
    const urlTab = view.tabId;
    if (urlTab === activeTabId) {
      syncedTabRef.current = activeTabId;
      followOpenedTab.current = false;
      return;
    }
    if (urlTab !== undefined && urlTab !== syncedTabRef.current) {
      if (canvasTabs.some((t) => t.id === urlTab)) {
        syncedTabRef.current = urlTab;
        switchTab(urlTab);
        return;
      }
      // まだこの会話の canvas_state が届いていないなら、消さずに待つ
      if (!canvasKnown) return;
    }
    const push = followOpenedTab.current;
    followOpenedTab.current = false;
    syncedTabRef.current = activeTabId;
    navigate((prev) => ({ ...prev, tabId: activeTabId }), { replace: !push });
  }, [activeThreadId, activeTabId, canvasTabs, canvasKnown, switchTab, view.tabId, navigate]);

  const activeTab = session.tabs.find((t) => t.id === session.activeTabId);
  const activeSpec = activeTab
    ? session.catalog.find((c) => c.kind === activeTab.kind)
    : undefined;
  const ActiveView = activeSpec ? resolveCanvasView(activeSpec.component) : undefined;
  const settingsEndpoint = session.modules.find((m) => m.name === "settings")?.baseUrl;

  /** モジュール名 → 到達先。カタログが持っている情報をそのまま引く（決定25）。 */
  const endpointOf = useCallback(
    (moduleName: string): string | undefined =>
      session.modules.find((m) => m.name === moduleName)?.baseUrl ??
      session.catalog.find((entry) => entry.module === moduleName)?.endpoint,
    [session.modules, session.catalog]
  );

  const tabOverflow = useTabOverflow(
    session.tabs.map((t) => t.id),
    { reservePx: 52, gapPx: 3, ...(session.activeTabId ? { pinnedId: session.activeTabId } : {}) }
  );
  const hiddenTabIds = tabOverflow.hiddenIds;
  const hiddenTabs = session.tabs.filter((t) => hiddenTabIds.has(t.id));

  /** その会話に関わる判断待ち（決定80：会話の流れの中に立つ）。 */
  const pendingFor = useCallback(
    (threadId: string | undefined) =>
      session.inbox.filter(
        (i) =>
          !i.resolvedAt &&
          (i.opens?.threadId === undefined
            ? threadId === session.trunk?.threadId
            : i.opens.threadId === threadId)
      ),
    [session.inbox, session.trunk]
  );

  /**
   * 抱えているもの（決定77 の不変条件③「レールの点」）。
   *
   * **開いている枝は全部ここに出る。** 押さなくても本数と状態が点で分かる——
   * どこにも出ていない枝は作れない、を画面の側でも成り立たせる。
   */
  const held = useMemo(() => {
    const order = { turn: 0, stop: 1, run: 2 } as const;
    const items = session.branches.map((b) => {
      const turn = session.inbox.some((i) => !i.resolvedAt && i.opens?.threadId === b.threadId);
      return {
        threadId: b.threadId,
        title: b.title,
        state: (turn ? "turn" : "run") as "turn" | "stop" | "run",
        meta: b.returnCondition ?? "",
      };
    });
    return items.sort((a, b) => order[a.state] - order[b.state]);
  }, [session.branches, session.inbox]);
  /** レールに点で出すのは先頭 6 本。溢れた分は「+N」から被さる面で見る。 */
  const heldShown = held.slice(0, 6);
  const heldRest = held.length - heldShown.length;

  // 面を開いた／移ったら紙は上がり直す（番頭が開いたのに何も見えないのが一番困る）
  useEffect(() => {
    if (activeTabId) setLowered(false);
  }, [activeTabId]);

  const workOpen = activeTab !== undefined && ActiveView !== undefined;
  /** 狭い画面では、下ろした紙は出さない（幹が地として残る）。 */
  const showWork = activeTab !== undefined && !(narrow && lowered);

  /**
   * Esc で1枚ずつ剥がす（重なりの順に：面 → 枝 → 被さる面）。
   * **入力中の Esc は IME の変換取り消しに使われる**ので、変換中は何もしない。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.isComposing) return;
      if (holdOpen) return setHoldOpen(false);
      if (newBranch) return setNewBranch(false);
      if (faceOpen) return backToChat();
      // **面は畳まない。** Esc は「1枚剥がす」であって「閉じる」ではない——閉じてしまうと、
      // 戻ったときに開き直す手間が増える（面は抱えたまま残る・決定79）。
      // 広い画面では面と会話が並んでいるので、剥がすものは枝だけ
      if (narrow && showWork) return setLowered(true);
      if (branch && trunk) return openThread(trunk.threadId);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [holdOpen, newBranch, faceOpen, backToChat, narrow, showWork, branch, trunk, openThread]);
  /** 作業する面が開いたら、いま居た会話が細い帯になる（決定79）。 */
  const slim = workOpen && !narrow;

  const canvasTab = (
    tab: (typeof session.tabs)[number],
    index: number,
    inMenu: boolean
  ): React.ReactElement => (
    <span
      key={tab.id}
      data-tab-id={tab.id}
      className={[
        inMenu ? "canvas-menu-row" : "canvas-tab",
        tab.id === session.activeTabId ? "is-active" : "",
        !inMenu && dropIndex === index ? "is-drop-target" : "",
        !inMenu && hiddenTabIds.has(tab.id) ? "is-hidden" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      draggable={!inMenu}
      onDragStart={() => setDragTabId(tab.id)}
      onDragEnd={() => {
        setDragTabId(undefined);
        setDropIndex(undefined);
      }}
      onDragOver={(e) => {
        if (inMenu || !dragTabId) return;
        e.preventDefault();
        setDropIndex(index);
      }}
      onDrop={(e) => {
        if (inMenu) return;
        e.preventDefault();
        if (dragTabId) session.reorderTab(dragTabId, index);
        setDragTabId(undefined);
        setDropIndex(undefined);
      }}
    >
      <button
        className="canvas-tab-label"
        {...(inMenu ? {} : { "data-key": "qweryupa"[index] })}
        onClick={() => {
          navigate((prev) => ({ ...prev, tabId: tab.id }));
          setTabMenuOpen(false);
        }}
        title={inMenu ? tab.kind : `${tab.kind}（ドラッグで並べ替え）`}
      >
        <Icon name={iconOfKind(tab.kind)} size={14} className="canvas-tab-icon" />
        <span className="canvas-tab-text">{tab.title}</span>
      </button>
      <button
        className="canvas-tab-close"
        onClick={() => session.closeTab(tab.id)}
        aria-label={`${tab.title} を閉じる`}
      >
        <Icon name="close" size={13} />
      </button>
    </span>
  );

  /** 背表紙。**消さない——押せば戻る**（モーダルより良いのはここ）。 */
  const spine = (label: string, mark: string, onClick: () => void): React.ReactElement => (
    <button className="spine" type="button" onClick={onClick} title={`${label} へ戻る`}>
      <Icon name="chevron-left" size={15} />
      <span className="spine-mark">{mark}</span>
    </button>
  );

  return (
    <div className={`shell ${narrow ? "is-narrow" : ""} ${workOpen ? "has-work" : ""}`}>
      <CommandPalette
        open={palette.open}
        onClose={() => palette.setOpen(false)}
        threads={trunk ? [trunk, ...session.branches] : session.branches}
        closedThreads={session.mergedBranches}
        catalog={openableCatalog}
        inbox={session.inbox}
        onOpenThread={(id) => openThread(id, { focus: true })}
        onReopenThread={(id) => session.reopenThread(id)}
        onOpenView={(kind) => {
          followOpenedTab.current = true;
          backToChat();
          session.openView(kind);
        }}
        onOpenInbox={openInboxItem}
        onFace={showFace}
        onNewThread={() => {
          backToChat();
          setNewBranch(true);
        }}
        onToggleTheme={theme.toggle}
      />

      {/* ── レール：行き先の帯（決定77 の不変条件③）───────────────────────
          プロジェクトも枝も面も同じ種類のもの＝どこへ行くか。会話の列には触れないので、
          読み物が無傷のまま残る。狭いときは上端の帯になる */}
      <nav className="rail">
        <div className="brand">
          <span className="brand-name">番頭</span>
          <span className="brand-sub">banto</span>
        </div>
        <button
          className={`rail-btn ${inboxOpen ? "is-active" : ""} ${session.inboxPending === 0 ? "is-empty" : ""}`}
          type="button"
          onClick={() => showFace("inbox")}
          title="横断の通知（番頭に用があるもの）"
          data-key="i"
        >
          <Icon name="inbox" size={17} />
          <span className="rail-label">取次</span>
          <span className="inbox-n">{session.inboxPending}</span>
        </button>

        <div className="rail-sep" />

        {/* 幹。**畳めないので閉じる口は無い**（決定77） */}
        {trunk && (
          <button
            className={`rail-trunk ${!branch ? "is-active" : ""}`}
            type="button"
            onClick={() => openThread(trunk.threadId, { focus: true })}
            title={`${trunk.title}（プロジェクトの幹）`}
            data-key="1"
          >
            <Icon name="home" size={16} />
            <span className="rail-label">幹</span>
          </button>
        )}

        {/* 抱えているもの。**点で並ぶので、押さなくても本数と状態が分かる** */}
        <div className="rail-hold">
          {heldShown.map((h, i) => (
            <button
              key={h.threadId}
              className={`hold ${branch?.threadId === h.threadId ? "is-active" : ""}`}
              type="button"
              /* 符牒。会話のタブが無くなったので、幹は 1、枝は 2 から振る */
              data-key={String(i + 2)}
              onClick={() => openThread(h.threadId, { focus: true })}
              title={`${h.title}${h.meta ? ` — 還す条件：${h.meta}` : ""}`}
              aria-label={h.title}
            >
              <span className={`u-dot is-${h.state}`} />
              <span className="rail-label hold-label">{h.title}</span>
            </button>
          ))}
          {heldRest > 0 && (
            <button className="hold-more" type="button" onClick={() => setHoldOpen(true)}>
              +{heldRest}
            </button>
          )}
          <button
            className="hold-new"
            type="button"
            onClick={() => {
              backToChat();
              setNewBranch(true);
            }}
            title="枝を開く（還す条件が要ります）"
            data-key="n"
          >
            <Icon name="plus" size={15} />
            <span className="rail-label">枝を開く</span>
          </button>
        </div>

        <span className="rail-sp" />

        <button
          className={`rail-btn ${historyOpen ? "is-active" : ""}`}
          type="button"
          onClick={() => showFace("history")}
          title="履歴（畳んだ枝）"
          aria-label="履歴"
          data-key="h"
        >
          <Icon name="history" size={17} />
          <span className="rail-label">履歴</span>
        </button>
        <button
          className={`rail-btn ${settingsOpen ? "is-active" : ""}`}
          type="button"
          onClick={() => showFace("settings")}
          title="設定"
          aria-label="設定"
          data-key="s"
        >
          <Icon name="settings" size={17} />
          <span className="rail-label">設定</span>
        </button>
        <button
          className="rail-btn cmdk-tab"
          type="button"
          onClick={() => palette.setOpen(true)}
          title="横断して引く（⌘K）"
          aria-label="横断して引く"
          data-key="k"
        >
          <Icon name="search" size={16} />
          <span className="rail-label">横断して引く</span>
          <kbd className="cmdk-key">⌘K</kbd>
        </button>
        <button
          className="rail-btn"
          type="button"
          onClick={theme.toggle}
          title={`${theme.family.name}：${theme.mode === "dark" ? "明かりを点ける" : "明かりを落とす"}`}
          aria-label="明るさを切り替える"
          data-key="t"
        >
          <Icon name={theme.mode === "dark" ? "sun" : "moon"} size={17} />
          <span className="rail-label">明暗</span>
        </button>
        <span className={`conn conn--${session.status}`}>
          {session.status === "open"
            ? "接続中"
            : session.status === "connecting"
              ? "接続しています…"
              : session.status === "reconnecting"
                ? "繋ぎ直しています…"
                : "切断"}
        </span>
      </nav>

      {settingsOpen ? (
        settingsEndpoint ? (
          <SettingsPanel
            params={{}}
            tabId="settings"
            kind="settings"
            module="settings"
            endpoint={settingsEndpoint}
            endpointOf={endpointOf}
            openCanvas={session.openView}
            section={view.section}
            onSection={(id) => navigate((prev) => ({ ...prev, section: id }))}
          />
        ) : (
          <div className="threads-empty">
            <p className="threads-empty-title">設定を開けません</p>
            <p className="threads-empty-sub">
              設定モジュールが登録されていません（ホストの構成を確認してください）
            </p>
          </div>
        )
      ) : inboxOpen ? (
        <InboxFace
          items={session.inbox}
          onAnswer={session.answerInbox}
          onOpen={openInboxItem}
          onBack={backToChat}
        />
      ) : historyOpen ? (
        <ThreadHistory
          closedThreads={session.mergedBranches}
          chatOf={session.chatOf}
          ensureHistory={session.ensureHistory}
          historyLoaded={session.historyLoaded}
          selectedId={view.readThreadId}
          onSelect={(id) => navigate((prev) => ({ ...prev, readThreadId: id }))}
          onReopen={(id) => session.reopenThread(id)}
          onBack={backToChat}
        />
      ) : !trunk ? (
        /* 幹が届くまで。**空状態を隠さない**（I1） */
        <div className="threads-empty">
          <p className="threads-empty-title">幹をひらいています…</p>
          <p className="threads-empty-sub">
            会話はプロジェクトごとに幹が1本。番頭ホストからの応答を待っています。
          </p>
        </div>
      ) : (
        /* ── 続き間：幹（地）→ 枝（紙）→ 作業する面（さらに上）── */
        <div
          className={`rooms ${branch ? "has-branch" : ""}`}
          style={{ ["--slim-w" as string]: `${slimWidth}px` }}
        >
          {/* 面が開いていて枝も開いているとき、幹は背表紙になる。**押せば戻る** */}
          {slim && branch &&
            spine(trunk.title, trunk.title.slice(0, 1), () => openThread(trunk.threadId))}

          {/* 幹。面が開いていて枝を見ているときは背表紙に譲る */}
          {(!slim || !branch) && (
            <Room
              session={session}
              thread={trunk}
              slim={slim && !branch}
              pending={pendingFor(trunk.threadId)}
              onAnswerInbox={session.answerInbox}
              onOpenInbox={openInboxItem}
              onOpenBranch={openThread}
              onOpenView={(kind, params) => {
                followOpenedTab.current = true;
                session.openView(kind, params);
              }}
              {...(slim && !branch ? { onGrip: startResize } : {})}
              {...(branch ? { activeBranchId: branch.threadId } : {})}
              focusSeq={focusSeqOf(trunk.threadId)}
            />
          )}

          {/* 枝。**幹の上に置いた紙**（決定79） */}
          {branch && (
            <Room
              session={session}
              thread={branch}
              slim={slim}
              raised={narrow}
              pending={pendingFor(branch.threadId)}
              onAnswerInbox={session.answerInbox}
              onOpenInbox={openInboxItem}
              onOpenBranch={openThread}
              onOpenView={(kind, params) => {
                followOpenedTab.current = true;
                session.openView(kind, params);
              }}
              onCloseBranch={() => openThread(trunk.threadId)}
              onMergeBranch={(conclusion) => {
                session.mergeBranch(branch.threadId, conclusion);
                openThread(trunk.threadId);
              }}
              {...(slim ? { onGrip: startResize } : {})}
              activeBranchId={branch.threadId}
              focusSeq={focusSeqOf(branch.threadId)}
            />
          )}

          {/* ── 作業する面：**手前を背表紙に畳んで全幅を使う**（決定79）───────
              400px の列に押し込まない。探す・移動する・比べるには幅が要る */}
          {showWork && activeTab && (
            <section className={`work canvas-pane ${narrow ? "is-raised" : ""}`}>
              <div className="canvas-tabbar">
                <div className="canvas-tabstrip" ref={tabOverflow.stripRef}>
                  {session.tabs.map((tab, index) => canvasTab(tab, index, false))}
                </div>

                {hiddenTabs.length > 0 && (
                  <div className="canvas-more-wrap">
                    <button
                      className="canvas-more-btn"
                      type="button"
                      aria-expanded={tabMenuOpen}
                      title={`表示しきれないタブ（${hiddenTabs.length}）`}
                      onClick={() => setTabMenuOpen((v) => !v)}
                    >
                      <span className="canvas-more-count">{hiddenTabs.length}</span>
                      <Icon name="chevron-down" size={14} />
                    </button>
                    {tabMenuOpen && (
                      <div className="canvas-more-menu">
                        {hiddenTabs.map((tab) => canvasTab(tab, session.tabs.indexOf(tab), true))}
                      </div>
                    )}
                  </div>
                )}

                {openableCatalog.length > 0 && (
                  <button
                    className="canvas-catalog-btn"
                    onClick={() => setCatalogOpen(true)}
                    aria-label="開くものを選ぶ"
                    aria-expanded={catalogOpen}
                    title="開くものを選ぶ"
                    data-key="o"
                  >
                    <Icon name="plus" size={16} />
                  </button>
                )}
                {/* いま居た会話が細い帯として残っていることを言う（決定79） */}
                {slim && <span className="work-note">会話は左に残しています</span>}
              </div>

              <div className="canvas-body">
                {ActiveView ? (
                  <ActiveView
                    key={`${activeTab.id}:${activeTab.rev}`}
                    params={activeTab.params}
                    tabId={activeTab.id}
                    kind={activeTab.kind}
                    module={activeSpec!.module}
                    endpoint={activeSpec!.endpoint}
                    endpointOf={endpointOf}
                    openCanvas={session.openView}
                  />
                ) : (
                  // I2: カタログにあるのにUIが解決できない＝配線漏れ。黙って空にせず理由を出す
                  <div className="canvas-empty">
                    <div className="canvas-empty-inner">
                      <Icon name="warn" size={30} stroke={1.2} className="canvas-empty-mark" />
                      <p className="canvas-empty-title">この面を描けません</p>
                      <p className="canvas-empty-sub">
                        コンポーネント <code>{activeSpec?.component ?? "(不明)"}</code>{" "}
                        がUI側の解決表にありません（配線漏れです）。
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* 狭いときに上端へ覗く幹。**戻り道が常に見えている**（決定79） */}
          {narrow && (branch || showWork) && (
            <button
              className="peek"
              type="button"
              onClick={() => {
                // 重なりの順に1枚ずつ下ろす。**面は畳まない**（抱えたまま残る）
                if (showWork) setLowered(true);
                else if (trunk) openThread(trunk.threadId);
              }}
            >
              <span>▲ {trunk.title} に戻る</span>
              <span className="peek-sp" />
              <span className="peek-now">{showWork && activeTab ? activeTab.title : branch?.title}</span>
            </button>
          )}
        </div>
      )}

      {/* 枝を開く（決定77：還す条件が要る）。**被さる面**で出す——脇に開くものは狭い画面で
          必ず端からはみ出す（`spec-canvas-ui` §5） */}
      {newBranch && (
        <Modal title="枝を開く" onClose={() => setNewBranch(false)}>
          <NewBranchForm
            onOpen={(spec) => {
              session.openBranch(spec);
              setNewBranch(false);
            }}
            onCancel={() => setNewBranch(false)}
          />
        </Modal>
      )}

      {/* 抱えているものの一覧。**ドロップダウンではなく被さる面**（`spec-canvas-ui` §5） */}
      {holdOpen && (
        <Modal
          title="抱えているもの"
          onClose={() => setHoldOpen(false)}
          footer={
            <span className="picker-hint">
              開いている枝は、必ず<b>幹の札・横断の通知・レールの点</b>のどれかに出ています。
              どこにも出ていない枝は作れません。
            </span>
          }
        >
          {held.map((h) => (
            <button
              key={h.threadId}
              className="held-row"
              type="button"
              onClick={() => openThread(h.threadId)}
            >
              <span className={`u-dot is-${h.state}`} />
              <span className="held-row-t">{h.title}</span>
              <span className="held-row-m">{h.meta}</span>
            </button>
          ))}
        </Modal>
      )}

      {catalogOpen && (
        <Modal
          title="キャンバスに開く"
          onClose={() => setCatalogOpen(false)}
          footer={
            <>
              <span className="picker-hint">↑↓ で選ぶ · Enter で開く · Esc で閉じる</span>
              {/* I2: 描けない面があることを黙らない。出所（kind）まで出す */}
              {unresolvedCatalog.length > 0 && (
                <span className="catalog-unresolved">
                  この画面で描けない面が {unresolvedCatalog.length} 件あります（配線漏れ）:{" "}
                  {unresolvedCatalog.map((e) => e.kind).join(", ")}
                </span>
              )}
            </>
          }
        >
          <div className="catalog-search">
            <SearchField
              value={catalogQuery}
              onChange={setCatalogQuery}
              onKeyDown={catalogNav.onKeyDown}
              placeholder="名前・説明で絞る"
              autoFocus
            />
          </div>
          <div ref={catalogNav.listRef}>
            {catalogGroups.length === 0 ? (
              <p className="catalog-empty">「{catalogQuery}」に当てはまる面はありません。</p>
            ) : (
              catalogGroups.map(([category, entries]) => (
                <div key={category}>
                  <div className="catalog-group-label">{category}</div>
                  {entries.map((entry) => {
                    const opened = session.tabs.some((t) => t.kind === entry.kind);
                    const index = catalogOrdered.indexOf(entry);
                    return (
                      <button
                        key={entry.kind}
                        className={`catalog-item ${catalogNav.isOn(index) ? "is-on" : ""}`}
                        onClick={() => openFromCatalog(entry.kind)}
                        title={`${entry.kind} · ${entry.module}`}
                        {...catalogNav.rowProps(index)}
                      >
                        <Icon name={iconOfKind(entry.kind)} size={17} className="ci-ico" />
                        <span className="ci-body">
                          <span className="ci-name">{entry.title}</span>
                          <span className="ci-desc">{entry.description}</span>
                        </span>
                        {opened && <span className="ci-open">開いています</span>}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </Modal>
      )}

      {/* 何も開いていないときに、そのまま押せる札を並べる（決定25の人側の経路）。
          **タブ列とは別の器**——面が1枚も無いときは作業する間そのものが無い */}
      {!faceOpen && trunk && !showWork && openableCatalog.length > 0 && (
        <button
          className="open-work"
          type="button"
          onClick={() => (activeTab ? setLowered(false) : setCatalogOpen(true))}
          title={activeTab ? "作業する面へ戻る" : "作業する面を開く"}
          data-key="o"
        >
          <Icon name="canvas" size={15} />
          {activeTab ? "面へ戻る" : "面を開く"}
        </button>
      )}
    </div>
  );
}
