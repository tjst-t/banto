import { type ComponentPropsWithoutRef, type ElementRef, forwardRef } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

import { cn } from '../../lib/cn';

/**
 * 受信箱・履歴・設定の被さるダイアログ（要件 A5・A6・C4・C12）。
 *
 * **Radix の上に薄く重ねるだけ**（規則10）。フォーカストラップ・Escape での閉じ・
 * スクロールロック・背景クリックでの閉じは Radix が持っている——ここで手組みしない。
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;

export const DialogOverlay = forwardRef<
  ElementRef<typeof DialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn('fixed inset-0 z-40 bg-ink/35 data-[state=open]:animate-fade-in', className)}
    {...props}
  />
));
DialogOverlay.displayName = 'DialogOverlay';

export const DialogContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { widthClassName?: string }
>(({ className, widthClassName = 'max-w-2xl', children, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed left-1/2 top-0 z-50 flex h-full w-full -translate-x-1/2 flex-col bg-paper shadow-overlay outline-none data-[state=open]:animate-rise-in',
        widthClassName,
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close
        className="absolute right-4 top-4 grid h-8 w-8 place-items-center rounded-sm text-ink-muted hover:bg-paper-sunken hover:text-ink"
        aria-label="閉じる"
      >
        <X className="h-4 w-4" />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
DialogContent.displayName = 'DialogContent';

export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;
export const DialogClose = DialogPrimitive.Close;
