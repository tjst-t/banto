/**
 * 単発のLLM呼び出しに要る認証の解決（提案§3.2 / §3.4 の裏方）。
 *
 * 章の引き継ぎ資料も記憶の抽出も、**本セッションとは別の呼び出し**で走る（決定28）。
 * どちらも `ModelRegistry.getApiKeyAndHeaders` の結果をそのまま使うが、あれは
 * 成功と失敗の直和なので、そのまま渡すと**鍵が無いまま呼びに行く**形が書けてしまう。
 *
 * I2: 解決できなかったら黙って空の鍵で呼ばずエラーにする。
 */

/** `ModelRegistry.getApiKeyAndHeaders` が返す形（成功・失敗の直和）。 */
export interface ResolvedAuthLike {
  ok?: boolean;
  error?: string;
  apiKey?: string;
  /**
   * pi 0.84 から**値に `null` を取りうる**（`ProviderHeaders`）。null は「既定で付く
   * ヘッダを外す」の意味で、こちらは単発呼び出しのヘッダを毎回組み立てるので
   * **落として渡す**（外すべきものは、そもそも付けていない）。
   */
  headers?: Record<string, string | null>;
}

/** 単発呼び出しに渡す認証を解決する関数。 */
export type AuthResolver = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi の Model は Api で
  // 型付けされており、呼ぶ側はどの Api かを知らないまま解決した実体を渡す (I4)
  model: any
) => Promise<ResolvedAuthLike>;

/** 認証を解決し、失敗していれば止める。 */
export async function requireAuth(
  auth: AuthResolver,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上 (I4)
  model: any,
  what: string
): Promise<{ apiKey?: string; headers?: Record<string, string> }> {
  const resolved = await auth(model);
  if (resolved.ok === false) {
    throw new Error(`${what}: モデルの認証を解決できません（${resolved.error ?? "理由不明"}）`);
  }
  const headers =
    resolved.headers === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(resolved.headers).filter(
            (entry): entry is [string, string] => entry[1] !== null
          )
        );
  return {
    ...(resolved.apiKey !== undefined ? { apiKey: resolved.apiKey } : {}),
    ...(headers !== undefined ? { headers } : {}),
  };
}
