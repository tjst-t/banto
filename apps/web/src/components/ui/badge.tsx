import type { HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../lib/cn';

/**
 * 状態バッジ。**色だけに頼らない**——アイコン・文言と対にして使う
 * （dataviz スキルの status 色の規則。色弱の読み手も文言で判別できる）。
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
  {
    variants: {
      tone: {
        neutral: 'bg-surface-sunken text-ink-secondary',
        accent: 'bg-accent-soft text-accent',
        waiting: 'bg-waiting-soft text-waiting',
        good: 'bg-good-soft text-good',
        critical: 'bg-critical-soft text-critical',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
