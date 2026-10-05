// **このサーバの画面の組み立ての印**（追加・2026-10-05）。開いているページが自分の印と比べ、違えば
// 「新しい版の画面があります」を出す（`lib/backend/frontend-build.ts`）。印は組み立てたときに埋まるので静的でよい。
// 合言葉は要らない——組み立ての印（commit の頭と時刻）だけで、秘密は入らない
export const dynamic = "force-static";

export function GET(): Response {
  return Response.json({ build: process.env.NEXT_PUBLIC_BANTO_BUILD ?? null });
}
