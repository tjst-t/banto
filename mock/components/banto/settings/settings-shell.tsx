"use client";

// 階層1（instance level、§6.1・§6.2）のレイアウト。左メニュー＋右詳細＋上部検索
// （名前のある形——macOS System Settings・VSCode設定・Vivaldi等と同じ、規則12）。
//
// 左メニューは2段に分かれる。banto 自身のカテゴリが固定で上に並び、区切り線の
// 下に Module 自身の設定面（`ui://<id>/config`）がフラットに並ぶ——iOS の
// 設定アプリが上に固定カテゴリ、下にインストール済みアプリの一覧を持つのと
// 同じ形（§6.2 既存の例え）。役割の管理（有効/無効）と、Module 自身が持ち込む
// 設定は別物——前者は「繋ぐか繋がないか」、後者は「繋いだ後、Module 自身が
// 何を見せるか」。
//
// 検索は左メニューの項目名だけでなく、右側の各セクションが実際に持つ設定項目
// （role名・実装名・既定値の各項目・資格情報・Module設定面のフィールド）も
// 対象にする（レビュー指摘、2026-09-01）。結果は「どのメニュー項目の中にあるか」
// でグループ化し、その下に一段下げて中身を並べる——フラットな一覧だと
// 「どこに飛ぶのか」が分からなかった（レビュー指摘）。クリックすると、
// すでにそのメニューが開いていても該当箇所までスクロール＋一瞬ハイライトする
// ——「開いているから押しても何も起きないように見える」を避ける（レビュー指摘）
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Puzzle, Search, SlidersHorizontal, Sparkles } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { Input } from "@/components/ui/input";
import { useRovingFocus } from "@/hooks/use-roving-focus";
import { cn } from "@/lib/utils";
import { getConfigurableImplementations } from "@/lib/mock/settings";

export type SettingsSection = "roles" | "defaults" | "credentials" | `module:${string}`;

/** 検索対象の1件。`anchorId` があれば、飛んだ先でその要素までスクロール＋ハイライトする */
export interface SearchEntry {
  section: SettingsSection;
  label: string;
  anchorId?: string;
}

interface NavItem {
  section: SettingsSection;
  label: string;
  icon: typeof Puzzle;
}

const CATEGORIES: readonly NavItem[] = [
  { section: "roles", label: "役割と Module", icon: Puzzle },
  { section: "defaults", label: "既定値", icon: SlidersHorizontal },
  { section: "credentials", label: "資格情報", icon: Sparkles },
];

const HIGHLIGHT_CLASSES = ["ring-2", "ring-accent", "ring-offset-2", "ring-offset-background"];

export function SettingsShell({
  renderContent,
  extraSearchEntries = [],
}: {
  renderContent: (section: SettingsSection) => ReactNode;
  /** 右側の中身が持つ設定項目。検索でヒットさせたいものを呼び出し側が渡す */
  extraSearchEntries?: readonly SearchEntry[];
}) {
  const isMobile = useIsMobile();
  const [section, setSection] = useState<SettingsSection | null>(null);
  const [query, setQuery] = useState("");
  // クリックのたびに更新する——同じ anchor を2回続けて押しても再スクロール
  // ＋再ハイライトが起きるように（section が変わらない場合、state 自体は
  // 変化しないので、この nonce が effect の再発火を保証する）
  const [pendingAnchor, setPendingAnchor] = useState<{ id: string; nonce: number } | null>(null);
  const anchorNonceRef = useRef(0);
  const { containerRef: navRef, onKeyDown: onNavKeyDown } = useRovingFocus<HTMLDivElement>();

  const moduleItems: readonly NavItem[] = useMemo(
    () =>
      getConfigurableImplementations().map((impl) => ({
        section: `module:${impl.id}` as SettingsSection,
        label: impl.name,
        icon: Puzzle,
      })),
    [],
  );

  const allNavItems = useMemo(() => [...CATEGORIES, ...moduleItems], [moduleItems]);

  function goTo(target: SettingsSection, anchorId?: string) {
    setSection(target);
    anchorNonceRef.current += 1;
    setPendingAnchor(anchorId ? { id: anchorId, nonce: anchorNonceRef.current } : null);
  }

  useEffect(() => {
    if (!pendingAnchor) return;
    const timer = setTimeout(() => {
      const el = document.getElementById(pendingAnchor.id);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add(...HIGHLIGHT_CLASSES);
      setTimeout(() => el.classList.remove(...HIGHLIGHT_CLASSES), 1400);
    }, 60); // renderContent の再描画を待つ
    return () => clearTimeout(timer);
  }, [pendingAnchor]);

  const q = query.trim().toLowerCase();
  const isSearching = q.length > 0;

  // 検索結果は「どのメニュー項目に属するか」でグループ化する。
  // ヘッダー行はメニュー項目自身がヒットしたとき、または中身がヒットしたときに出す
  const searchGroups = useMemo(() => {
    if (!isSearching) return [];
    const contentMatches = extraSearchEntries.filter((e) => e.label.toLowerCase().includes(q));
    const sections = new Set<SettingsSection>([
      ...allNavItems.filter((n) => n.label.toLowerCase().includes(q)).map((n) => n.section),
      ...contentMatches.map((e) => e.section),
    ]);
    return [...sections]
      .map((section) => ({
        nav: allNavItems.find((n) => n.section === section),
        items: contentMatches.filter((e) => e.section === section),
      }))
      .filter((g): g is { nav: NavItem; items: SearchEntry[] } => g.nav !== undefined);
  }, [isSearching, q, extraSearchEntries, allNavItems]);

  // デスクトップは常に何かを選んだ状態にする（未選択の空白ペインを避ける）。
  // モバイルは選ぶまでメニューだけを見せる——2ペインが狭い画面で成立しないので、
  // 「一覧→タップで詳細」の1カラムに畳む（iOS 設定アプリと同じ）
  const activeSection = section ?? (isMobile ? null : "roles");

  const nav = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border p-3">
        <div className="relative">
          <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="検索（設定項目の中身も対象）"
            className="h-8 pl-8"
          />
        </div>
      </div>
      <div ref={navRef} onKeyDown={onNavKeyDown} className="min-h-0 flex-1 overflow-auto p-2">
        {isSearching ? (
          searchGroups.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-ink-3">見つからない</p>
          ) : (
            <div className="flex flex-col gap-3">
              {searchGroups.map((g) => (
                <div key={g.nav.section}>
                  <NavButton
                    icon={g.nav.icon}
                    label={g.nav.label}
                    active={activeSection === g.nav.section && g.items.length === 0}
                    onClick={() => goTo(g.nav.section)}
                  />
                  {g.items.length > 0 ? (
                    <div className="mt-0.5 ml-5 flex flex-col gap-0.5 border-l border-border pl-2.5">
                      {g.items.map((item, i) => (
                        <button
                          key={`${item.section}:${item.label}:${i}`}
                          type="button"
                          data-roving-item
                          onClick={() => goTo(item.section, item.anchorId)}
                          className={cn(
                            "rounded-md px-2 py-1 text-left text-xs",
                            activeSection === item.section &&
                              pendingAnchor?.id === item.anchorId &&
                              item.anchorId !== undefined
                              ? "bg-accent-soft text-accent-ink"
                              : "text-ink-2 hover:bg-accent hover:text-foreground",
                          )}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )
        ) : (
          <>
            <div className="flex flex-col gap-0.5">
              {CATEGORIES.map((c) => (
                <NavButton
                  key={c.section}
                  icon={c.icon}
                  label={c.label}
                  active={activeSection === c.section}
                  onClick={() => goTo(c.section)}
                />
              ))}
            </div>
            {moduleItems.length > 0 ? (
              <>
                <p className="mt-3 mb-1 px-2 text-xs font-medium tracking-wide text-ink-3 uppercase">
                  Module の設定
                </p>
                <div className="flex flex-col gap-0.5">
                  {moduleItems.map((m) => (
                    <NavButton
                      key={m.section}
                      icon={m.icon}
                      label={m.label}
                      active={activeSection === m.section}
                      onClick={() => goTo(m.section)}
                    />
                  ))}
                </div>
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );

  if (isMobile) {
    if (activeSection === null) {
      return <div className="h-full min-h-0">{nav}</div>;
    }
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-2">
          <button
            type="button"
            onClick={() => setSection(null)}
            aria-label="設定メニューに戻る"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-accent"
          >
            <ArrowLeft className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">{renderContent(activeSection)}</div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="w-64 shrink-0 border-r border-border">{nav}</div>
      <div className="min-h-0 flex-1 overflow-auto p-6">{renderContent(activeSection ?? "roles")}</div>
    </div>
  );
}

function NavButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: typeof Puzzle;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-roving-item
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
        active
          ? "bg-accent-soft text-accent-ink"
          : "text-ink-2 hover:bg-accent hover:text-foreground",
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}
