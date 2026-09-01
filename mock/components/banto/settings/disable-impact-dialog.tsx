"use client";

// 「押す前に何が壊れるかの提示」（§6.1 共通で持ち越すもの）。役割・実装の
// 有効/無効はライブ切替でよいが、黙って切り替えない——切る前に壊れるものを
// 見せ、押した後は依存していた tool が次に呼ばれた瞬間はっきり断る（§6.1）。
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export function DisableImpactDialog({
  open,
  onOpenChange,
  targetName,
  breaks,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetName: string;
  breaks: readonly string[];
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{targetName} を無効化しますか</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>切り替えは今すぐ効きます。次の tool は、次に呼ばれた瞬間はっきり断ります：</p>
              <ul className="list-disc space-y-0.5 pl-5 text-sm text-foreground">
                {breaks.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>やめる</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>無効化する</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
