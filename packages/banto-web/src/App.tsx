/**
 * Banto の画面：**続き間**（ADR-0017 決定77・79・80。見本 `prototype/redesign/13-tsuzukima-kai.html`）。
 *
 * ## 骨格
 *
 * ```
 * .rail    横断の通知 ／ プロジェクト（＝幹） ／ 抱えているもの ／ 履歴・設定・明暗
 * .rooms   [背表紙] 幹（地）→ 枝（その上の紙）→ 作業する面（さらに上）
 * ```
 *
 * **レールは行き先の帯。** プロジェクトも枝も面も同じ種類のもの＝どこへ行くか。
 * 会話の列には一切触れないので、読み物が無傷のまま残る。**押さなくても、何本あって
 * どれがあなたの番かが点で分かる**——名前は帯の外（ホバー）に出す。
 *
 * **幹・枝・面は重なりで表す**（決定79）。広い画面で横に並んでいても関係は重なりのままで、
 * 狭い画面（760px 以下）の重ねと同じ模型になる。
 *
 * **作業する面が開くと、いま居た会話は細い帯として残る**——そこで読むのではなく、
 * **話しかけるための幅**。手前の会話は背表紙に畳んで、面は全幅を使う。
 *
 * **枝を開く口も、面を開く口も、レールには無い**（PO裁定 2026-08-10）。枝は会話の中で
 * 番頭が自分で開くか、POが会話で指示して開く。面は会話に残る「面への口」（`open` の器）
 * から開き直す——開いた面は必ず会話に1行残るので、レールに口を作る必要がない。
 *
 * D3/D5: 会話も面の状態もホストが持つ真実をそのまま描く。
 * 場所（面・会話・タブ・設定の区画）は URL が持つ（`viewLocation.ts`）。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBantoSession } from "./useBantoSession.js";
import { resolveCanvasView } from "./views/registry.js";
import { ThreadHistory } from "./ThreadHistory.js";
import { SettingsPanel } from "./views/SettingsPanel.js";
import { useViewLocation } from "./viewLocation.js";
import { Icon, iconOfKind } from "./icons.js";
import { InboxFace } from "./Inbox.js";
import { CommandPalette, useCommandPalette } from "./CommandPalette.js";
import { useKeyHints } from "./keyHints.js";
import { useThemeState } from "./theme/ThemeProvider.js";
import { Room } from "./Room.js";

/**
 * 既定は**同一オリジンの `/ws`**。開発サーバがそれを番頭ホストへ中継するので、
 * リバースプロキシ（Caddy等）のサブドメイン経由でもそのまま繋がる。
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
 * 細い帯の幅（決定79）。**そこで読むのではなく、話しかけるための幅**。
 * 主役がその時の作業で変わるので決め打ちにせず、つまんで変えられる。
 */
const SLIM_WIDTH_KEY = "banto.slimWidth";
const SLIM_WIDTH_DEFAULT = 344;
const SLIM_WIDTH_MIN = 260;
const SLIM_WIDTH_MAX = 620;

/** 狭い画面の境（決定79）。ここから下は幹が地で、枝と面が重なる紙になる。 */
const NARROW_PX = 760;

/** レールに点で並べる上限。溢れた分は「+N」から被さる面で見る（見本と同じ）。 */
const HOLD_SHOWN = 6;

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

/** 抱えているもの1件（枝か、開いた面）。**どちらも「行き先」**なので同じ点で出す。 */
interface Held {
  kind: "branch" | "face";
  id: string;
  title: string;
  state: "turn" | "stop" | "run";
  meta: string;
}

/**
 * レールの押しもの。**絵だけ。名前は帯の外（ホバー）に出す**——見本のとおり、
 * 帯の中に字を入れると幅を食い、押せるものの数だけ列が伸びる。
 */
function RailBtn({
  icon,
  tip,
  active,
  onClick,
  count,
  dataKey,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  tip: string;
  active?: boolean;
  onClick(): void;
  count?: number;
  dataKey?: string;
}): React.ReactElement {
  return (
    <button
      className={`rail-btn ${active ? "is-active" : ""} ${count === 0 ? "is-empty" : ""}`}
      type="button"
      onClick={onClick}
      aria-label={tip}
      {...(dataKey ? { "data-key": dataKey } : {})}
    >
      <Icon name={icon} size={17} />
      {count !== undefined && <span className="inbox-n">{count}</span>}
      <span className="tip">{tip}</span>
    </button>
  );
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
   * ホストの都合で見る先が決まったとき（幹へ落ちる・番頭が開いた枝）。
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

  /** 抱えているものの一覧（レールの「+N」から開く被さる面）。 */
  const [holdOpen, setHoldOpen] = useState(false);
  /** 細い帯の幅（決定79）。 */
  const [slimWidth, setSlimWidth] = useState(readStoredSlimWidth);
  /**
   * 狭い画面で、上がっていた紙を下ろしたか（決定79）。
   * **面は畳まない**——覗きを押すのは「幹へ戻る」であって「面を閉じる」ではない。
   */
  const [lowered, setLowered] = useState(false);
  /** 番頭への入力へ移る合図（キーで会話へ飛んだときだけ）。 */
  const [focusReq, setFocusReq] = useState<{ threadId: string; seq: number }>();

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

  /** いま見ている会話（幹または枝）。**既定は開いている先頭の幹**。 */
  const focused = useMemo(
    () => (view.threadId ? session.threadOf(view.threadId) : undefined) ?? session.trunks[0],
    [view.threadId, session]
  );
  const branch = focused?.kind === "branch" ? focused : undefined;
  /** いま居るプロジェクトの幹。枝を見ているなら**その枝の親**。 */
  const trunk = useMemo(
    () =>
      (branch?.parentId ? session.threadOf(branch.parentId) : undefined) ??
      (focused?.kind === "trunk" ? focused : undefined) ??
      session.trunks[0],
    [branch, focused, session]
  );

  /** 会話を移る（枝の札・レールの点・取次から）。 */
  const openThread = useCallback(
    (threadId: string, options: { focus?: boolean } = {}) => {
      setHoldOpen(false);
      backToChat();
      session.switchThread(threadId);
      if (options.focus) setFocusReq((prev) => ({ threadId, seq: (prev?.seq ?? 0) + 1 }));
    },
    [session, backToChat]
  );
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

  /** 細い帯をつまんで広げる。会話は左にあるので、右へ動かすほど広くなる。 */
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

  /** **この画面で描ける面だけ**を開けるものとして扱う（決定12・17）。 */
  const openableCatalog = useMemo(
    () => session.catalog.filter((entry) => resolveCanvasView(entry.component) !== undefined),
    [session.catalog]
  );

  /**
   * キャンバスの面：URL とホストを合わせる。真実はホスト（`canvas_state`）。
   * URL は「どの面を見たいか」の意図で、**動いた側に合わせて片方を直す**。
   */
  const syncedTabRef = useRef<string>(undefined);
  const followOpenedTab = useRef(false);

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

  /** 面を開く（会話に残る「面への口」・⌘K・取次から）。 */
  const openView = useCallback(
    (kind: string, params?: Record<string, unknown>) => {
      followOpenedTab.current = true;
      setLowered(false);
      session.openView(kind, params);
    },
    [session]
  );

  /**
   * その会話に関わる判断待ち（決定80：会話の流れの中に立つ）。
   * **どの会話でもない件は、いま居る幹に出す**——文脈の無い札を隣の幹へ配らない。
   */
  const pendingFor = useCallback(
    (threadId: string | undefined) =>
      session.inbox.filter(
        (i) =>
          !i.resolvedAt &&
          (i.opens?.threadId === undefined
            ? threadId === trunk?.threadId
            : i.opens.threadId === threadId)
      ),
    [session.inbox, trunk]
  );

  /**
   * 抱えているもの（決定77 の不変条件③「レールの点」）。
   *
   * **開いている枝と、開いた面**。どちらも「行き先」なので同じ点で並べる（見本と同じ）。
   * 押さなくても本数と状態が分かる——どこにも出ていない枝は作れない、を画面でも成り立たせる。
   */
  const held = useMemo<Held[]>(() => {
    const order = { turn: 0, stop: 1, run: 2 } as const;
    /**
     * I2: **親を引けない枝は消さない**——消すとレールの点から外れ、埋没しない不変条件
     * （決定77）が画面の側で破れる。行き場の無い枝は既定の幹の下に出す。
     */
    const known = new Set(session.trunks.map((t) => t.threadId));
    const fallback = trunk?.threadId === session.trunks[0]?.threadId;
    const branches: Held[] = session.branches
      .filter((b) =>
        b.parentId !== undefined && known.has(b.parentId)
          ? b.parentId === trunk?.threadId
          : fallback
      )
      .map((b) => ({
        kind: "branch" as const,
        id: b.threadId,
        title: b.title,
        state: session.inbox.some((i) => !i.resolvedAt && i.opens?.threadId === b.threadId)
          ? ("turn" as const)
          : ("run" as const),
        meta: b.returnCondition ?? (b.openReason ?? ""),
      }));
    // 開いた面も抱えているもの。**畳んでも抱えたまま**（決定79）
    const faces: Held[] = session.tabs.map((t) => ({
      kind: "face" as const,
      id: t.id,
      title: t.title,
      state: "run" as const,
      meta: t.kind,
    }));
    return [...branches, ...faces].sort((a, b) => order[a.state] - order[b.state]);
  }, [session.branches, session.inbox, session.tabs, session.trunks, trunk]);
  const heldShown = held.slice(0, HOLD_SHOWN);
  const heldRest = held.length - heldShown.length;

  const openHeld = useCallback(
    (item: Held) => {
      setHoldOpen(false);
      // 会話へ行くなら**入力へも移る**（キーで飛んだのに持ち替えでは近道にならない）
      if (item.kind === "branch") {
        openThread(item.id, { focus: true });
        return;
      }
      setLowered(false);
      // **ホストへ直接投げず URL を動かす**（押した経路と戻るの経路を1本にする）。
      // URL に合わせて `canvas_switch` を投げるのは下の効果
      navigate((prev) => ({ ...prev, tabId: item.id }));
    },
    [openThread, navigate]
  );

  // 面を開いた／移ったら紙は上がり直す（番頭が開いたのに何も見えないのが一番困る）
  useEffect(() => {
    if (activeTabId) setLowered(false);
  }, [activeTabId]);

  const workOpen = activeTab !== undefined && ActiveView !== undefined;
  /** 狭い画面では、下ろした紙は出さない（幹が地として残る）。 */
  const showWork = activeTab !== undefined && !(narrow && lowered);
  /** 作業する面が開いたら、いま居た会話が細い帯になる（決定79）。 */
  const slim = workOpen && !narrow;

  /**
   * Esc で1枚ずつ剥がす（重なりの順に：被さる面 → 面 → 枝）。
   * **入力中の Esc は IME の変換取り消し**に使われるので、変換中は何もしない。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.isComposing) return;
      if (holdOpen) return setHoldOpen(false);
      if (faceOpen) return backToChat();
      // **面は畳まない。** Esc は「1枚剥がす」であって「閉じる」ではない
      if (narrow && showWork) return setLowered(true);
      if (branch && trunk) return openThread(trunk.threadId);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [holdOpen, faceOpen, backToChat, narrow, showWork, branch, trunk, openThread]);

  /** 背表紙。**消さない——押せば戻る**（モーダルより良いのはここ）。 */
  const spine = (label: string, mark: string, onClick: () => void): React.ReactElement => (
    <button className="spine" type="button" onClick={onClick} aria-label={`${label} へ戻る`}>
      <Icon name="chevron-left" size={15} />
      <span className="spine-mark">{mark}</span>
      <span className="tip">{label} へ戻る</span>
    </button>
  );

  return (
    <div className={`shell ${narrow ? "is-narrow" : ""} ${workOpen ? "has-work" : ""}`}>
      <CommandPalette
        open={palette.open}
        onClose={() => palette.setOpen(false)}
        threads={[...session.trunks, ...session.branches]}
        closedThreads={session.closedThreads}
        catalog={openableCatalog}
        inbox={session.inbox}
        onOpenThread={(id) => openThread(id, { focus: true })}
        onReopenThread={(id) => session.reopenThread(id)}
        onOpenView={(kind) => {
          backToChat();
          openView(kind);
        }}
        onOpenInbox={openInboxItem}
        onFace={showFace}
        /* 枝は会話の中で開く（PO裁定 2026-08-10）。⌘K からは幹へ飛んで話しかけるだけ */
        onNewThread={() => {
          backToChat();
          if (trunk) openThread(trunk.threadId, { focus: true });
        }}
        onToggleTheme={theme.toggle}
      />

      {/* ── レール：行き先の帯（決定77 の不変条件③）──────────────────────── */}
      <nav className="rail">
        <RailBtn
          icon="inbox"
          tip="横断の通知"
          active={inboxOpen}
          count={session.inboxPending}
          onClick={() => showFace("inbox")}
          dataKey="i"
        />

        <div className="rail-sep" />

        {/*
          プロジェクト＝幹（PO裁定 2026-08-09）。**頭文字の印**で並べ、名前は帯の外へ。
          用のある幹には朱の点を添える——押さなくても、どこに用があるか分かる。
          幹は畳めない（終うのは番頭の口・`thread.close_trunk`）ので閉じる×は無い
        */}
        {session.trunks.map((t, i) => {
          const turn = session.inbox.some(
            (item) =>
              !item.resolvedAt &&
              (item.opens?.threadId === t.threadId ||
                session.branches.some(
                  (b) => b.parentId === t.threadId && b.threadId === item.opens?.threadId
                ))
          );
          return (
            <button
              key={t.threadId}
              className={`pj ${trunk?.threadId === t.threadId ? "is-active" : ""}`}
              type="button"
              onClick={() => openThread(t.threadId, { focus: true })}
              aria-label={t.title}
              {...(i < 9 ? { "data-key": String(i + 1) } : {})}
            >
              {[...t.title][0] ?? "幹"}
              {turn && <span className="bell" />}
              <span className="tip">{t.title}</span>
            </button>
          );
        })}

        <div className="rail-sep" />

        {/* 抱えているもの＝枝と開いた面。**点で並ぶので、押さなくても本数と状態が分かる** */}
        {heldShown.map((h, i) => (
          <button
            key={`${h.kind}:${h.id}`}
            /* 符牒は**行き先の並び**に1本で振る（幹のあと、抱えているものが続く） */
            {...(session.trunks.length + i < 9
              ? { "data-key": String(session.trunks.length + i + 1) }
              : {})}
            /* 枝と面は**同じ点**で並べる（どちらも行き先）。種別は class で言うだけ
               ——見た目は変えない。変えると「点で本数が分かる」が崩れる */
            className={`hold hold--${h.kind} ${
              (h.kind === "branch" ? branch?.threadId : session.activeTabId) === h.id
                ? "is-active"
                : ""
            }`}
            type="button"
            onClick={() => openHeld(h)}
            aria-label={h.title}
          >
            <span className={`u-dot is-${h.state}`} />
            <span className="tip">
              {h.title}
              {h.meta ? ` — ${h.meta}` : ""}
            </span>
          </button>
        ))}
        {heldRest > 0 && (
          <button className="hold-more" type="button" onClick={() => setHoldOpen(true)}>
            +{heldRest}
          </button>
        )}

        <span className="rail-sp" />

        {/* 畳んだものと設定は「行き先ではあるが、いまではない」ので下端に置く（見本と同じ） */}
        <RailBtn
          icon="history"
          tip="履歴（終えた幹）"
          active={historyOpen}
          onClick={() => showFace("history")}
          dataKey="h"
        />
        <RailBtn
          icon="settings"
          tip="設定"
          active={settingsOpen}
          onClick={() => showFace("settings")}
          dataKey="s"
        />
        <RailBtn
          icon="search"
          tip="横断して引く（⌘K）"
          onClick={() => palette.setOpen(true)}
          dataKey="k"
        />
        <RailBtn
          icon={theme.mode === "dark" ? "sun" : "moon"}
          tip={`${theme.family.name}：${theme.mode === "dark" ? "明かりを点ける" : "明かりを落とす"}`}
          onClick={theme.toggle}
          dataKey="t"
        />
        <span className={`conn conn--${session.status}`} title={connLabel(session.status)}>
          <span className="tip">{connLabel(session.status)}</span>
        </span>
      </nav>

      {/* ── 設定：一級の面。**中身が広いので被せずに置き換える** ──────────── */}
      {settingsOpen ? (
        settingsEndpoint ? (
          <SettingsPanel
            params={{}}
            tabId="settings"
            kind="settings"
            module="settings"
            endpoint={settingsEndpoint}
            endpointOf={endpointOf}
            openCanvas={openView}
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
            spine(trunk.title, [...trunk.title][0] ?? "幹", () => openThread(trunk.threadId))}

          {(!slim || !branch) && (
            <Room
              session={session}
              thread={trunk}
              slim={slim && !branch}
              pending={pendingFor(trunk.threadId)}
              onAnswerInbox={session.answerInbox}
              onOpenInbox={openInboxItem}
              onOpenBranch={openThread}
              onOpenView={openView}
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
              onOpenView={openView}
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
              タブ列は持たない。開いた面はレールの点に並び、そこから移る */}
          {showWork && activeTab && (
            <section className={`work canvas-pane ${narrow ? "is-raised" : ""}`}>
              <div className="work-head">
                <button
                  className="room-back"
                  type="button"
                  onClick={() => session.closeTab(activeTab.id)}
                  aria-label="この面を畳む"
                  title="この面を畳む"
                >
                  <Icon name="close" size={15} />
                </button>
                <div className="work-head-t">
                  <h1 className="work-title">{activeTab.title}</h1>
                  <div className="work-sub">
                    作業する面 ・ {activeSpec?.description ?? activeTab.kind}
                  </div>
                </div>
                {slim && <span className="work-note">会話は左に残しています</span>}
              </div>
              <div className="work-body canvas-body">
                {ActiveView ? (
                  <ActiveView
                    key={`${activeTab.id}:${activeTab.rev}`}
                    params={activeTab.params}
                    tabId={activeTab.id}
                    kind={activeTab.kind}
                    module={activeSpec!.module}
                    endpoint={activeSpec!.endpoint}
                    endpointOf={endpointOf}
                    openCanvas={openView}
                  />
                ) : (
                  // I2: カタログにあるのにUIが解決できない＝配線漏れ。理由を出す
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
                else openThread(trunk.threadId);
              }}
            >
              <span>▲ {trunk.title} に戻る</span>
              <span className="peek-sp" />
              <span className="peek-now">
                {showWork && activeTab ? activeTab.title : branch?.title}
              </span>
            </button>
          )}
        </div>
      )}

      {/* ── 被さる面（見本の `.veil`）。横断の通知と履歴はここに出す ────────
          脇に開くものは狭い画面で必ず端からはみ出す（`spec-canvas-ui` §5） */}
      {(inboxOpen || historyOpen || holdOpen) && (
        <div
          className="veil"
          onClick={(e) => {
            if (e.target !== e.currentTarget) return;
            if (holdOpen) setHoldOpen(false);
            else backToChat();
          }}
        >
          <div className={`veil-panel ${historyOpen ? "is-wide" : ""}`}>
            {inboxOpen && (
              <InboxFace
                items={session.inbox}
                onAnswer={session.answerInbox}
                onOpen={openInboxItem}
                onBack={backToChat}
              />
            )}
            {historyOpen && (
              <ThreadHistory
                /* 履歴は**終えた幹の一覧**（PO裁定 2026-08-10）。畳んだ枝は幹の記録に
                   結論1行として残るので、ここへは並べない */
                closedThreads={session.closedThreads.filter((t) => t.kind === "trunk")}
                chatOf={session.chatOf}
                ensureHistory={session.ensureHistory}
                historyLoaded={session.historyLoaded}
                selectedId={view.readThreadId}
                onSelect={(id) => navigate((prev) => ({ ...prev, readThreadId: id }))}
                onReopen={(id) => session.reopenThread(id)}
                onBack={backToChat}
              />
            )}
            {holdOpen && (
              <div className="held-face">
                <h2 className="held-face-h">抱えているもの</h2>
                {held.map((h) => (
                  <button
                    key={`${h.kind}:${h.id}`}
                    className="held-row"
                    type="button"
                    onClick={() => openHeld(h)}
                  >
                    <span className={`u-dot is-${h.state}`} />
                    <span className="held-row-t">{h.title}</span>
                    <span className="held-row-m">{h.meta}</span>
                  </button>
                ))}
                <p className="held-foot">
                  開いている枝は、必ず<b>幹の札・横断の通知・レールの点</b>のどれかに出ています。
                  <br />
                  どこにも出ていない枝は作れません。
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** 接続の状態を1語で。**切れたことは分かる必要がある**（点は残す）。 */
function connLabel(status: string): string {
  return status === "open"
    ? "接続中"
    : status === "connecting"
      ? "接続しています…"
      : status === "reconnecting"
        ? "繋ぎ直しています…"
        : "切断";
}
