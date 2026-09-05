// tool呼び出しの承認待ち（canUseTool、hold-the-lineモデル）は、Inboxの
// judgment idをキーにして「resolveされるまで待つ」状態を保つ——SSEでターンを
// 流しているリクエストと、答えを受け取る/api/inbox/:id/answerは別リクエスト
// なので、この橋渡しをプロセスメモリ上のレジストリに持つ（アーキ仕様§6.0）。

import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";

export class PendingApprovalRegistry {
  private readonly pending = new Map<string, (result: PermissionResult) => void>();

  register(judgmentId: string, resolve: (result: PermissionResult) => void): void {
    this.pending.set(judgmentId, resolve);
  }

  /** 登録が無ければfalse（Elicitationのように解決対象を持たない判断待ちもある）。 */
  resolve(judgmentId: string, result: PermissionResult): boolean {
    const resolve = this.pending.get(judgmentId);
    if (!resolve) return false;
    this.pending.delete(judgmentId);
    resolve(result);
    return true;
  }
}
