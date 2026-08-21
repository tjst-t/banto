import { type ButtonHTMLAttributes, forwardRef } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../lib/cn';

/**
 * 押しもの。**背丈も字の段もトークンから引く**（要件 E9）。
 *
 * `attention` は**面を塗ってよい唯一の役**（＝あなたの番）。他の役は塗らない
 * ——塗りを許すと、いちばん強い色が「あなたの番」を指さなくなる。
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-ctl font-medium transition-colors disabled:pointer-events-none disabled:opacity-40 whitespace-nowrap',
  {
    variants: {
      variant: {
        /** ふつうの主ボタン。**塗らずに、枠と字で立てる** */
        primary: 'border border-accent bg-accent-soft text-accent hover:bg-accent/10',
        /** **あなたの番**。塗ってよいのはここだけ */
        attention: 'bg-attention text-on-attention hover:opacity-90',
        secondary: 'border border-rule bg-paper-raised text-ink hover:border-rule-strong',
        ghost: 'text-ink-secondary hover:bg-paper-sunken hover:text-ink',
      },
      size: {
        sm: 'h-[var(--h-ctl-sm)] px-2.5 text-meta',
        md: 'h-[var(--h-ctl)] px-3 text-body',
        icon: 'h-[var(--h-ctl)] w-[var(--h-ctl)]',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = 'Button';
