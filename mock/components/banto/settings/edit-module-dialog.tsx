"use client";

// インストール済み Module の設定を変える（§6.1）。banto は自分の構造化編集
// フォームを発明しない——「Module を追加」の mcpServers タブとまったく同じ
// フォーム（McpServersEditor）を、今の mcpServersJson で埋めて開くだけ
// （§5.1「mcpServersが唯一の真実」）。command/args/env は本来これで渡すもの
// なので、専用の構造化UIを別に作る理由が無い。
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { updateImplementationMcpServersJson } from "@/lib/mock/settings";
import type { MockModuleImplementation } from "@/lib/mock/types";
import { McpServersEditor } from "./add-module-dialog";

export function EditModuleDialog({
  implementation,
  onOpenChange,
}: {
  /** null のとき閉じる（開閉は表示対象の有無で駆動、他のダイアログと同じ形） */
  implementation: MockModuleImplementation | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={implementation !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{implementation?.name} の設定を変える</DialogTitle>
          <DialogDescription>
            command・引数・環境変数（env）は mcpServers エントリで決まるので、この JSON を
            直接書き換える——banto 独自の入力欄は作らない（§5.1）。
          </DialogDescription>
        </DialogHeader>

        {implementation ? (
          <McpServersEditor
            key={implementation.id}
            initialJson={implementation.mcpServersJson}
            submitLabel="保存する"
            onSubmit={(json) => {
              updateImplementationMcpServersJson(implementation.id, json);
              onOpenChange(false);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
