import type { HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../lib/cn';

/**
 * 状態の札。**色だけに頼らない**——文言と必ず対で使う（色弱の読み手も判別できる）。
 *
 * **丸くしない**（角は3段だけ・要件 E9）。丸い札は数を入れる器のときだけ。
 * 塗るのは `attention`（あなたの番）だけで、他は淡い地に字を置く。
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-seal px-1.5 py-0.5 text-note font-medium',
  {
    variants: {
      tone: {
        neutral: 'bg-paper-sunken text-ink-secondary',
        accent: 'bg-accent-soft text-accent',
        attention: 'bg-attention text-on-attention',
        caution: 'bg-caution-soft text-caution',
        done: 'bg-done-soft text-done',
        stopped: 'bg-stopped-soft text-stopped',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>['tone']>;

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
