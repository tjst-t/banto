import { type ComponentPropsWithoutRef, type ElementRef, forwardRef } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';

import { cn } from '../../lib/cn';

/**
 * サイドバーの「開いているもの」一覧など、押して出す小さな面。
 * **外側クリックで閉じる・Escape で閉じる**は Radix が持っている（規則10）。
 */
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;

export const PopoverContent = forwardRef<
  ElementRef<typeof PopoverPrimitive.Content>,
  ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, sideOffset = 8, align = 'start', ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      align={align}
      className={cn(
        'z-50 max-h-[70vh] w-80 overflow-y-auto rounded-md bg-paper-raised p-2 shadow-pop data-[state=open]:animate-fade-in',
        className,
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = 'PopoverContent';
