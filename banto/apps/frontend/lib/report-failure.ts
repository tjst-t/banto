// **失敗したら見せる。そして巻き戻す**（決定・2026-09-10、`frontend-error-surfacing`）。
//
// 画面側には「console.error だけ」「catch すら無い」が点在していた——host に
// 届かなかったのに、人には**成功したように見える**（あるいは何も起きない）。
// 規則2 は「エラーを握りつぶさない」で、画面でも同じ。
//
// **形を1つに揃える**（規則3）：起きたことを1行で言い、詳細を添える。
// toast は既に Clear・Fork を畳む等で使っているので、それに合わせる
// ——人が「どこを見れば失敗が分かるか」を覚え直さなくて済む。

import { toast } from "sonner";

export function describeFailure(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * 人に見せる。`what` は「何ができなかったか」を人の言葉で
 *（例：「Project を終了できませんでした」）。
 */
export function reportFailure(what: string, err: unknown): void {
  // 追える形でログにも残す（画面の toast は消える）
  console.error(`[banto] ${what}`, err);
  toast(`${what}: ${describeFailure(err)}`);
}
