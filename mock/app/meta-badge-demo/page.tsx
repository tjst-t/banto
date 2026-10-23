"use client";

import type { ReactNode } from "react";
import { Network } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * サイドバーの「メタ Project の目印」代替案を並べて見比べるための、確認専用ページ。
 * 本物のサイドバー(nav-panel.tsx / project-list.tsx)には配線しない——
 * ここで選んだ案だけをあとで本物に反映する想定(決定・2026-10-23 のやり取り中)。
 */

const PROJECT_NAME = "全体統括";
const INITIAL = "統";

function Row({ badge }: { badge: ReactNode }) {
  return (
    <div className="flex h-8 items-center gap-2 rounded-md px-2 text-sm text-foreground">
      {badge}
      <span className="truncate">{PROJECT_NAME}</span>
    </div>
  );
}

function PlainBadge({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <span
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md bg-surface-3 text-xs font-semibold text-ink-2",
        className,
      )}
    >
      {children ?? INITIAL}
    </span>
  );
}

// 0: 今の実装(比較の基準) — 丸形 + 右下に小さい Network バッジ
function Badge0() {
  return (
    <span className="relative flex size-6 shrink-0">
      <span className="flex size-6 items-center justify-center rounded-full bg-surface-3 text-xs font-semibold text-ink-2">
        {INITIAL}
      </span>
      <span
        className="absolute -right-0.5 -bottom-0.5 flex size-3 items-center justify-center rounded-full border border-background bg-surface-3 text-ink-2"
        aria-label="メタ Project"
      >
        <Network className="size-2" />
      </span>
    </span>
  );
}

// 1: 二重リング
function Badge1() {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-xs font-semibold text-ink-2 ring-2 ring-border ring-offset-2 ring-offset-background">
      {INITIAL}
    </span>
  );
}

// 2: アイコン置き換え(頭文字をやめて Network アイコンだけにする)
function Badge2() {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-ink-2">
      <Network className="size-3.5" />
    </span>
  );
}

// 3: カードの重なり(奥にもう1枚あるように見せる)
function Badge3() {
  return (
    <span className="relative flex size-6 shrink-0">
      <span className="absolute inset-0 translate-x-1 translate-y-1 rounded-md bg-surface-2" aria-hidden />
      <span className="relative flex size-6 items-center justify-center rounded-md bg-surface-3 text-xs font-semibold text-ink-2">
        {INITIAL}
      </span>
    </span>
  );
}

// 4: 点線の枠
function Badge4() {
  return <PlainBadge className="border border-dashed border-ink-3" />;
}

// 5: 六角形
function Badge5() {
  return (
    <span
      className="flex size-6 shrink-0 items-center justify-center bg-surface-3 text-xs font-semibold text-ink-2"
      style={{ clipPath: "polygon(25% 2%, 75% 2%, 100% 50%, 75% 98%, 25% 98%, 0% 50%)" }}
    >
      {INITIAL}
    </span>
  );
}

// 6: 3点のノード(小さいネットワーク図)
function Badge6() {
  return (
    <span className="relative flex size-6 shrink-0">
      <PlainBadge />
      <svg
        className="absolute -top-1 -right-1 size-3 text-ink-3"
        viewBox="0 0 12 12"
        fill="none"
        aria-label="メタ Project"
      >
        <path d="M2 9L6 2M6 2L9 9M2 9L9 9" stroke="currentColor" strokeWidth="0.8" />
        <circle cx="2" cy="9" r="1.3" fill="currentColor" />
        <circle cx="9" cy="9" r="1.3" fill="currentColor" />
        <circle cx="6" cy="2" r="1.3" fill="currentColor" />
      </svg>
    </span>
  );
}

// 7: 名前の隣にラベルチップ
function Badge7Row() {
  return (
    <div className="flex h-8 items-center gap-2 rounded-md px-2 text-sm text-foreground">
      <PlainBadge />
      <span className="truncate">{PROJECT_NAME}</span>
      <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-xs text-ink-3">meta</span>
    </div>
  );
}

// 8: 薄いドット柄の背景
function Badge8() {
  return (
    <span
      className="flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-semibold text-ink-2"
      style={{
        backgroundColor: "var(--color-surface-3)",
        backgroundImage: "radial-gradient(var(--color-ink-3) 0.6px, transparent 0.6px)",
        backgroundSize: "4px 4px",
      }}
    >
      {INITIAL}
    </span>
  );
}

// 9: 行の左端に縦バー
function Badge9Row() {
  return (
    <div className="relative flex h-8 items-center gap-2 rounded-md pr-2 pl-3 text-sm text-foreground">
      <span className="absolute inset-y-1.5 left-1 w-0.5 rounded-full bg-ink-3" aria-hidden />
      <PlainBadge />
      <span className="truncate">{PROJECT_NAME}</span>
    </div>
  );
}

// 10: 二重の頭文字(外側に薄い枠をもう1つ)
function Badge10() {
  return (
    <span className="relative flex size-7 shrink-0 items-center justify-center">
      <span className="absolute inset-0 rounded-lg border border-border" aria-hidden />
      <span className="relative flex size-6 items-center justify-center rounded-md bg-surface-3 text-xs font-semibold text-ink-2">
        {INITIAL}
      </span>
    </span>
  );
}

// 11: 角だけ切り欠く(非対称の角丸)
function Badge11() {
  return <PlainBadge className="rounded-tr-2xl" />;
}

const CASES: { id: number; title: string; note: string; render: () => ReactNode }[] = [
  {
    id: 0,
    title: "(現状)丸形 + 右下に Network バッジ",
    note: "いま実装済み。頭文字は丸形、右下に小さい重なりバッジ。",
    render: () => <Row badge={<Badge0 />} />,
  },
  {
    id: 1,
    title: "二重リング",
    note: "頭文字の周りに薄い輪を1本足す。形は変えない。",
    render: () => <Row badge={<Badge1 />} />,
  },
  {
    id: 2,
    title: "アイコン置き換え",
    note: "頭文字をやめて Network アイコンだけにする。文字情報は無くなる。",
    render: () => <Row badge={<Badge2 />} />,
  },
  {
    id: 3,
    title: "カードの重なり",
    note: "奥にもう1枚あるように見せ、「複数を束ねている」感を出す。",
    render: () => <Row badge={<Badge3 />} />,
  },
  {
    id: 4,
    title: "点線の枠",
    note: "枠線を実線でなく点線にするだけ。地味だが他の行とすぐ見分く。",
    render: () => <Row badge={<Badge4 />} />,
  },
  {
    id: 5,
    title: "六角形",
    note: "角丸四角でも丸でもない形にする。かなり目立つ。",
    render: () => <Row badge={<Badge5 />} />,
  },
  {
    id: 6,
    title: "3点のノード",
    note: "小さいネットワーク図(点3つ+線)を右上に乗せる。",
    render: () => <Row badge={<Badge6 />} />,
  },
  {
    id: 7,
    title: "名前の隣にラベルチップ",
    note: "バッジ自体は変えず、Project名の右に小さい「meta」チップを置く。",
    render: () => <Badge7Row />,
  },
  {
    id: 8,
    title: "薄いドット柄の背景",
    note: "バッジの塗りを単色でなく、細かいドット柄にする。",
    render: () => <Row badge={<Badge8 />} />,
  },
  {
    id: 9,
    title: "行の左端に縦バー",
    note: "バッジでなく行自体に印を付ける。一覧で縦に並んだときに目が止まりやすい。",
    render: () => <Badge9Row />,
  },
  {
    id: 10,
    title: "二重の頭文字(入れ子の枠)",
    note: "頭文字の外側にもう一回り大きい薄い枠を足す(リングと似るがやや角張る)。",
    render: () => <Row badge={<Badge10 />} />,
  },
  {
    id: 11,
    title: "角だけ切り欠く",
    note: "右上の角だけ丸みを強くして、非対称な形にする。",
    render: () => <Row badge={<Badge11 />} />,
  },
];

export default function MetaBadgeDemoPage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-xl font-semibold text-foreground">サイドバーのメタ Project 目印・代替案</h1>
      <p className="mt-1 text-sm text-ink-3">
        色の塗りは使わず(塗ってよいのは turn だけ)、形・アイコン・線で見分ける案を並べている。
        それぞれ、サイドバーの Project 行の文脈(頭文字バッジ + Project 名)で見せている。
      </p>

      <div className="mt-8 flex flex-col gap-3">
        {CASES.map((c) => (
          <div key={c.id} className="rounded-lg border border-border bg-card p-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-foreground">
                案{c.id === 0 ? "0" : c.id}: {c.title}
              </p>
            </div>
            <p className="mt-0.5 text-xs text-ink-3">{c.note}</p>
            <div className="mt-2 rounded-md bg-surface-1 p-1">{c.render()}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
