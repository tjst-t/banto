import { useState, type ReactNode } from 'react';
import { History, Inbox, Moon, Settings, Sun } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { useTheme } from '../hooks/useTheme';
import { displayStatus, statusOrder, type DisplayStatus } from '../lib/threadOrder';
import type { ThreadStatus } from '../lib/types';

/**
 * **`idle` は塗らない、灰の点。** 動いてもいないのに `working` の青（動いている色）を
 * 塗ると、開いた直後のフォークが「もう動き出した」ように見える（PO指摘）。
 */
const STATUS_DOT: Record<DisplayStatus, string> = {
  'waiting-on-human': 'bg-attention shadow-[0_0_0_3px_var(--attention-soft)]',
  blocked: 'bg-transparent shadow-[inset_0_0_0_2px_var(--stopped)] rounded-sm rotate-45',
  working: 'bg-accent shadow-[0_0_0_3px_var(--accent-soft)]',
  done: 'bg-transparent shadow-[inset_0_0_0_2px_var(--done)]',
  idle: 'bg-transparent shadow-[inset_0_0_0_2px_var(--ink-muted)]',
};

export interface OpenItem {
  readonly key: string;
  readonly title: string;
  readonly meta: string;
  readonly status: ThreadStatus;
  readonly turnCount: number;
  readonly active: boolean;
  /** 親を持つか（`thread.forkedFrom !== null`）。スレッドと見分けるのに使う（PO裁定 2026-08-22）。 */
  readonly isFork: boolean;
  readonly onOpen: () => void;
}

/**
 * サイドバー。**行き先の帯**——受信箱・開いているもの・履歴・設定・明暗、
 * どれも「押すとどこかへ行く」という同じ種類のもの。
 *
 * **絵と点だけを並べ、名前は帯の外（ホバー札）に出す**——帯の中に字を入れると
 * 幅を食い、押せるものの数だけ列が伸びる。
 *
 * 狭い画面では横並びの帯になる（同じコンポーネント、CSS だけ切り替える）。
 *
 * **プロジェクト分けは持たない**（決定23）。実開発では banto のインスタンス自体を
 * 作業範囲ごとに分けるので（`BANTO_FS_ROOT`／`BANTO_REPO_ROOT` が1インスタンス=1範囲）、
 * アプリの中でさらにプロジェクトを分ける実体が無かった——v2の意匠見本にあった
 * 「プロジェクト」行は、実装（`banto-web`）には一度も無かった提案止まりの要素だった。
 */
export function Sidebar({
  openItems,
  queueCount,
  onOpenInbox,
  onOpenHistory,
  onOpenSettings,
}: {
  /** いま開いているもの（会話パネル・作業パネル）。押すと開き直せる。 */
  openItems: readonly OpenItem[];
  queueCount: number;
  onOpenInbox: () => void;
  onOpenHistory: () => void;
  onOpenSettings: () => void;
}) {
  const { theme, toggle } = useTheme();
  const [heldOpen, setHeldOpen] = useState(false);

  const shown = openItems.slice(0, 6);
  const rest = openItems.length - shown.length;

  return (
    <nav
      data-sidebar
      className="flex w-[58px] shrink-0 flex-col items-center gap-2 bg-paper-sunken py-3 max-md:h-[54px] max-md:w-full max-md:flex-row max-md:gap-2 max-md:border-b max-md:border-rule max-md:px-3 max-md:py-0"
    >
      <RailButton
        onClick={onOpenInbox}
        label="受信箱"
        icon={<Inbox className="h-[18px] w-[18px]" strokeWidth={1.7} />}
        badge={queueCount > 0 ? queueCount : undefined}
      />

      <Separator />

      {/* **開いているもの。** 押さなくても本数と状態が点で分かる（要件 A2） */}
      <div className="flex flex-col items-center gap-1.5 max-md:flex-row">
        {shown.map((item) => (
          <OpenDot key={item.key} item={item} />
        ))}
        {rest > 0 && (
          <Popover open={heldOpen} onOpenChange={setHeldOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="grid h-[30px] w-[30px] place-items-center rounded-sm bg-paper-sunken-2 font-mono text-xs text-ink-muted hover:text-ink"
              >
                +{rest}
              </button>
            </PopoverTrigger>
            <PopoverContent side="right" align="start">
              <OpenList items={openItems} onPick={() => setHeldOpen(false)} />
            </PopoverContent>
          </Popover>
        )}
      </div>

      <div className="flex-1 max-md:hidden" />

      <RailButton
        onClick={onOpenHistory}
        label="履歴"
        icon={<History className="h-[17px] w-[17px]" strokeWidth={1.6} />}
      />
      <RailButton
        onClick={onOpenSettings}
        label="設定"
        icon={<Settings className="h-[17px] w-[17px]" strokeWidth={1.6} />}
      />
      <RailButton
        onClick={toggle}
        label={theme === 'dark' ? '明るくする' : '暗くする'}
        icon={
          theme === 'dark' ? (
            <Sun className="h-[17px] w-[17px]" strokeWidth={1.6} />
          ) : (
            <Moon className="h-[17px] w-[17px]" strokeWidth={1.6} />
          )
        }
      />
    </nav>
  );
}

function Separator() {
  return <div className="h-px w-[22px] shrink-0 bg-rule max-md:h-[22px] max-md:w-px" />;
}

function RailButton({
  onClick,
  label,
  icon,
  badge,
}: {
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
  badge?: number | undefined;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          className="relative grid h-[38px] w-[38px] shrink-0 place-items-center rounded-md text-ink-secondary hover:bg-paper-raised hover:text-ink"
        >
          {icon}
          {badge !== undefined && (
            <span className="absolute -right-1 -top-1 grid h-[17px] min-w-[17px] place-items-center rounded-full bg-attention px-[3px] font-mono text-xs font-semibold leading-none text-on-attention">
              {badge}
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * **スレッドは四角＋頭文字、フォークは丸い点**（PO裁定 2026-08-22）。
 * v2 の意匠見本にあった「プロジェクトは四角＋頭文字」の見た目を、
 * プロジェクトが無くなった今はスレッドに持ってきた——形そのものが
 * スレッドかフォークかを言うので、状態の色は小さい角バッジに退く。
 */
function OpenDot({ item }: { item: OpenItem }) {
  const statusDot = (
    <span
      className={`h-[9px] w-[9px] rounded-full ${STATUS_DOT[displayStatus(item.status, item.turnCount)]}`}
    />
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {item.isFork ? (
          <button
            type="button"
            onClick={item.onOpen}
            data-open-item={item.key}
            data-fork-item="true"
            aria-current={item.active}
            className={`grid h-[30px] w-[30px] shrink-0 place-items-center rounded-sm ring-1 ring-inset ring-accent/50 ${
              item.active ? 'bg-accent-soft' : 'hover:bg-paper-sunken-2'
            }`}
          >
            {statusDot}
          </button>
        ) : (
          <button
            type="button"
            onClick={item.onOpen}
            data-open-item={item.key}
            data-fork-item="false"
            aria-current={item.active}
            className={`relative grid h-[30px] w-[30px] shrink-0 place-items-center rounded-md text-md font-semibold transition-colors ${
              item.active
                ? 'bg-paper-raised text-accent shadow-rest'
                : 'text-ink-muted hover:bg-paper-raised hover:text-ink'
            }`}
          >
            {item.title.slice(0, 1).toUpperCase()}
            <span className="absolute -right-1 -top-1 rounded-full ring-2 ring-paper-sunken">
              {statusDot}
            </span>
          </button>
        )}
      </TooltipTrigger>
      <TooltipContent side="right">
        {item.isFork ? 'フォーク' : 'スレッド'} ・ {item.title} — {item.meta}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * **スレッドとフォークを別の見出しの下に分ける**（PO裁定 2026-08-22）。
 * プロトタイプの `heldPanel()` が「あなたの番／止まっている／動いている」を
 * 見出しつきで分けていたのと同じ考え——1本の列に並べず、種類ごとに束ねる。
 */
function OpenList({
  items,
  onPick,
}: {
  items: readonly OpenItem[];
  onPick: () => void;
}) {
  const byStatus = (a: OpenItem, b: OpenItem): number => statusOrder(a.status) - statusOrder(b.status);
  const threadsList = items.filter((i) => !i.isFork).sort(byStatus);
  const forksList = items.filter((i) => i.isFork).sort(byStatus);

  const section = (label: string, rows: readonly OpenItem[]): ReactNode =>
    rows.length > 0 && (
      <div key={label}>
        <div className="px-2 py-1 text-xs text-ink-muted">
          {label} {rows.length}
        </div>
        {rows.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => {
              item.onOpen();
              onPick();
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-paper-sunken"
          >
            <span
              className={`h-[9px] w-[9px] shrink-0 rounded-full ${STATUS_DOT[displayStatus(item.status, item.turnCount)]}`}
            />
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
            <span className="shrink-0 font-mono text-xs text-ink-muted">{item.meta}</span>
          </button>
        ))}
      </div>
    );

  return (
    <div className="flex flex-col gap-0.5">
      {section('スレッド', threadsList)}
      {section('フォーク', forksList)}
    </div>
  );
}
