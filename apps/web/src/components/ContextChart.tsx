import { useMemo, useState } from 'react';

import { contextSize, type TurnUsage } from '../lib/types';

export interface ContextPoint {
  readonly turnIndex: number;
  readonly queryId: string;
  readonly usage: TurnUsage;
}

const WIDTH = 520;
const HEIGHT = 108;
const PAD_TOP = 10;
const PAD_BOTTOM = 18;
const PAD_X = 4;

const fmt = (n: number): string => n.toLocaleString('ja-JP');

/**
 * 1スレッドの、ターンごとの文脈サイズの系列。
 *
 * 文脈サイズは `contextSize()`（input + cacheCreation + cacheRead）だけで作る——
 * ここで別の式に寄せない（Phase 0 の観測を画面に出す、という要件そのもの）。
 *
 * x 軸は受け取った順の連番。サーバの `turnIndex` は `/api/prompt` の呼び出し
 * （＝1回の送信）ごとに 0 から振り直されるので、複数回送信した後の並びには
 * 使えない——ここでは表示上の通し番号として別に振り直す。
 */
export function ContextChart({ points }: { points: readonly ContextPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);

  const sizes = useMemo(() => points.map((p) => contextSize(p.usage)), [points]);
  const max = Math.max(1, ...sizes);

  if (points.length === 0) {
    return (
      <div className="flex h-[108px] items-center justify-center rounded-md border border-dashed border-border text-xs text-ink-muted">
        まだターンが記録されていません
      </div>
    );
  }

  const xAt = (i: number): number =>
    points.length === 1
      ? WIDTH / 2
      : PAD_X + (i / (points.length - 1)) * (WIDTH - PAD_X * 2);
  const yAt = (v: number): number =>
    PAD_TOP + (1 - v / max) * (HEIGHT - PAD_TOP - PAD_BOTTOM);

  const linePath = sizes.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)} ${yAt(v)}`).join(' ');
  const areaPath =
    `M ${xAt(0)} ${HEIGHT - PAD_BOTTOM} ` +
    sizes.map((v, i) => `L ${xAt(i)} ${yAt(v)}`).join(' ') +
    ` L ${xAt(sizes.length - 1)} ${HEIGHT - PAD_BOTTOM} Z`;

  const active = hover ?? points.length - 1;
  const activeUsage = points[active]?.usage;
  const activeSize = activeUsage ? contextSize(activeUsage) : 0;

  const onMove: React.MouseEventHandler<SVGSVGElement> = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * WIDTH;
    let nearest = 0;
    let best = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(xAt(i) - relX);
      if (d < best) {
        best = d;
        nearest = i;
      }
    }
    setHover(nearest);
  };

  return (
    <div className="rounded-md border border-border bg-surface p-3">
      <div className="mb-1 flex items-baseline justify-between">
        <div>
          <div className="font-mono text-xl font-medium tabular-nums text-ink">{fmt(activeSize)}</div>
          <div className="text-[11px] text-ink-muted">
            トークン ・ 第 {active + 1} ターン
            {hover === null ? '（最新）' : ''}
          </div>
        </div>
        <div className="text-right text-[11px] leading-tight text-ink-muted">
          <div>入力 {fmt(activeUsage?.inputTokens ?? 0)}</div>
          <div>キャッシュ作成 {fmt(activeUsage?.cacheCreationInputTokens ?? 0)}</div>
          <div>キャッシュ読み {fmt(activeUsage?.cacheReadInputTokens ?? 0)}</div>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="h-[72px] w-full cursor-crosshair"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`文脈サイズの推移。最新は ${fmt(sizes[sizes.length - 1] ?? 0)} トークン`}
      >
        <line x1={PAD_X} y1={yAt(max)} x2={WIDTH - PAD_X} y2={yAt(max)} stroke="var(--color-border)" strokeWidth={1} />
        <line
          x1={PAD_X}
          y1={HEIGHT - PAD_BOTTOM}
          x2={WIDTH - PAD_X}
          y2={HEIGHT - PAD_BOTTOM}
          stroke="var(--color-border)"
          strokeWidth={1}
        />
        <path d={areaPath} fill="var(--color-accent-soft)" stroke="none" />
        <path d={linePath} fill="none" stroke="var(--color-accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {hover !== null && (
          <line
            x1={xAt(hover)}
            y1={PAD_TOP}
            x2={xAt(hover)}
            y2={HEIGHT - PAD_BOTTOM}
            stroke="var(--color-ink-muted)"
            strokeWidth={1}
            strokeDasharray="2 2"
          />
        )}
        <circle cx={xAt(active)} cy={yAt(sizes[active] ?? 0)} r={3.5} fill="var(--color-accent)" stroke="var(--color-surface)" strokeWidth={1.5} />
      </svg>
      <div className="flex justify-between text-[10px] text-ink-muted">
        <span>第 1 ターン</span>
        <span>ピーク {fmt(max)}</span>
      </div>
    </div>
  );
}
