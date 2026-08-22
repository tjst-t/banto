import { useMemo, useState, type MouseEventHandler } from 'react';

import { contextSize, type TurnUsage } from '../lib/types';

export interface ContextPoint {
  readonly turnIndex: number;
  readonly queryId: string;
  readonly usage: TurnUsage;
}

const WIDTH = 520;
const HEIGHT = 40;
const PAD_Y = 4;
const PAD_X = 2;

const fmt = (n: number): string => n.toLocaleString('ja-JP');

/**
 * 1スレッドの、ターンごとの文脈サイズ（要件 F1・F3）。
 *
 * ## 帯にしてある
 *
 * ここは**箱**だった——数字を大きく出し、108px の図を持ち、会話の上に居座っていた。
 * 読みたいのは会話なのに、**画面の上から 180px を観測が占めていた**（撮って気づいた）。
 * 文脈サイズは「増え続けていないか」を横目で見るものなので、**細く、常にある**ほうがよい。
 * 詳しく知りたいときは撫でれば各ターンが読める。
 *
 * 文脈サイズは `contextSize()`（input + cacheCreation + cacheRead）だけで作る——
 * ここで別の式に寄せない（規則3：導出できる値を別に持たない）。
 *
 * x 軸は受け取った順の連番。サーバの `turnIndex` は `/api/prompt` の呼び出し
 * （＝1回の送信）ごとに 0 から振り直されるので、複数回送信した後の並びには使えない。
 */
export function ContextChart({ points }: { points: readonly ContextPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);

  const sizes = useMemo(() => points.map((p) => contextSize(p.usage)), [points]);
  const max = Math.max(1, ...sizes);

  if (points.length === 0) {
    // **無いことは言う。** 黙って消えると「壊れている」と見分けが付かない（規則2）。
    return (
      <div className="flex h-7 items-center px-1 text-xs text-ink-muted">
        まだターンが記録されていません
      </div>
    );
  }

  const xAt = (i: number): number =>
    points.length === 1 ? WIDTH / 2 : PAD_X + (i / (points.length - 1)) * (WIDTH - PAD_X * 2);
  const yAt = (v: number): number => PAD_Y + (1 - v / max) * (HEIGHT - PAD_Y * 2);

  const linePath = sizes.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)} ${yAt(v)}`).join(' ');
  const areaPath =
    `M ${xAt(0)} ${HEIGHT} ` +
    sizes.map((v, i) => `L ${xAt(i)} ${yAt(v)}`).join(' ') +
    ` L ${xAt(sizes.length - 1)} ${HEIGHT} Z`;

  const active = hover ?? points.length - 1;
  const usage = points[active]?.usage;
  const size = usage ? contextSize(usage) : 0;

  const onMove: MouseEventHandler<SVGSVGElement> = (e) => {
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
    <div
      className="flex items-center gap-3 text-xs text-ink-muted"
      title={`入力 ${fmt(usage?.inputTokens ?? 0)} ・ キャッシュ作成 ${fmt(
        usage?.cacheCreationInputTokens ?? 0,
      )} ・ キャッシュ読み ${fmt(usage?.cacheReadInputTokens ?? 0)}`}
    >
      <span className="shrink-0 whitespace-nowrap">
        文脈{' '}
        <span className="font-mono tabular-nums text-ink-secondary">{fmt(size)}</span> トークン ・ 第{' '}
        {active + 1} ターン{hover === null ? '（最新）' : ''}
      </span>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="h-6 min-w-0 flex-1 cursor-crosshair"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`文脈サイズの推移。最新は ${fmt(sizes[sizes.length - 1] ?? 0)} トークン`}
      >
        <line x1={0} y1={HEIGHT} x2={WIDTH} y2={HEIGHT} stroke="var(--rule)" strokeWidth={1} />
        <path d={areaPath} fill="var(--accent-soft)" stroke="none" />
        <path
          d={linePath}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {hover !== null && (
          <line
            x1={xAt(hover)}
            y1={0}
            x2={xAt(hover)}
            y2={HEIGHT}
            stroke="var(--ink-muted)"
            strokeWidth={1}
            strokeDasharray="2 2"
          />
        )}
        <circle
          cx={xAt(active)}
          cy={yAt(sizes[active] ?? 0)}
          r={3}
          fill="var(--accent)"
          stroke="var(--paper-raised)"
          strokeWidth={1.5}
        />
      </svg>
      <span className="shrink-0 whitespace-nowrap">ピーク {fmt(max)}</span>
    </div>
  );
}
