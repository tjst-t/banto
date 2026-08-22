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
  'inline-flex items-center justify-center gap-1.5 rounded-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-40 whitespace-nowrap',
  {
    variants: {
      variant: {
        /** ふつうのボタン。既定 */
        secondary: 'bg-paper-sunken text-ink-secondary hover:bg-paper-sunken-2 hover:text-ink',
        /** banto を選ぶ・進める主ボタン */
        accent: 'bg-accent text-paper-raised hover:bg-accent-strong',
        /** **あなたの番**。塗ってよいのはここだけ */
        attention: 'bg-attention text-on-attention hover:brightness-105',
        ghost: 'text-ink-muted hover:bg-paper-sunken hover:text-ink',
      },
      size: {
        sm: 'h-[var(--h-ctl-sm)] px-2.5 text-sm',
        md: 'h-[var(--h-ctl)] px-3 text-md',
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
