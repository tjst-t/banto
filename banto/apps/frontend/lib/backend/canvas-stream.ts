// **Canvas から「流れを開きたい」と頼む口**（banto の拡張、決定・2026-10-08、アーキ仕様 §5.8「札」）。
//
// - 画面 → banto：request `dev.banto/stream/open`（`params.name`・`params.params?`）。仕様に無い request なので
//   「知らない request」の受け口で受ける（`dev.banto/open-new-project` と同じ）
// - banto → host：その面の持ち主の `…/ui-stream` に、画面の Module・資源と **iframe ごとの印**（`frame`）を添えて札を頼む
//   ——上限（1つの画面で 8 本）は描いた iframe ごとに数える。パソコンと携帯で同じ画面を開けば別々に数える
// - 返すのは host の `{ url, ticket, expiresAt }` をそのまま。画面はそれで WebSocket を開く（`@banto/stream-client`）
// - どの面の画面からでも受ける（人が押した直後かは見ない）——開いたままの端末が、裏で切れたあと自分で繋ぎ直すため

export const STREAM_OPEN_METHOD = "dev.banto/stream/open";

/** 画面から来た params を読む。読めなければ理由 */
export function parseStreamOpenParams(
  params: unknown,
): { name: string; params: Record<string, unknown> } | { error: string } {
  const p = (params ?? {}) as { name?: unknown; params?: unknown };
  if (typeof p.name !== "string" || p.name === "" || p.name.length > 100) return { error: "流れの名前（name）を渡してください" };
  const inner = p.params ?? {};
  if (typeof inner !== "object" || inner === null || Array.isArray(inner)) return { error: "params は JSON のオブジェクトで渡してください" };
  return { name: p.name, params: inner as Record<string, unknown> };
}

/** iframe ごとの印（描いた枠1つに1つ） */
export function newFrameId(): string {
  return crypto.randomUUID();
}
