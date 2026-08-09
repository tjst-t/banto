/**
 * LLM の目録（モデル表）の遠隔更新（inc-0047）。
 *
 * pi は起動時にプロバイダごとの目録を `https://pi.dev/api/models/…` から取り直す。
 * **この呼び出しに上限が無かった**——`fetch` が自前で諦めるのは 300 秒なので、
 * pi.dev に届かない日は「番頭が5分立ち上がらない」になった（2026-08-09、実測 300.8 秒 ×2）。
 *
 * 届かないこと自体は困らない：解決に要る表は `models.json` と組み込みの定義から
 * 既に組めている（実測 1231 件）。遠隔の目録が効くのは**新しいモデルが増えたとき**だけ。
 * だから短く待って、来なければそのまま進む。
 *
 * bin.ts から切り出してあるのは**試験から掴めるようにするため**。あちらは読み込むと
 * `main()` が走る入口なので、中の関数を試験から呼べない。
 */

/**
 * 待つ上限。届いた日の実測は 322ms なので、10 秒は「遅い回線でも届く」側に十分広い。
 * それでも 300 秒からは2桁小さい——待ち受け開始が握られない値であることが要件。
 */
export const MODEL_CATALOG_TIMEOUT_MS = 10_000;

/**
 * 目録を更新できるもの（pi の `ModelRegistry` がこれを満たす）。
 *
 * pi の型をそのまま要求しない——試験が pi を持ち込まずに「届かない目録」を作れるように、
 * 使う面だけを写す。
 */
export interface ModelCatalogRefresher {
  refresh(options?: {
    signal?: AbortSignal;
  }): Promise<{ aborted: boolean; errors: ReadonlyMap<string, unknown> }>;
}

/** どう終わったか。呼ぶ側が待たなくてよいように、投げずに返す。 */
export type ModelCatalogOutcome =
  | { kind: "ok"; tookMs: number }
  | { kind: "timeout" }
  | { kind: "partial"; providers: string[] }
  | { kind: "failed"; reason: string };

/**
 * 目録を遠隔から取り直す。**呼ぶ側は待たない**（`void` で投げる）。
 *
 * I2: 黙って諦めない——落ちた理由はログに出す。出しておかないと、「モデルの一覧が古い」の
 * 原因がここだと誰も辿れない。**投げ返さない**のは、待たない呼び出しの例外が
 * `unhandledRejection` になってプロセスごと落とすため。
 */
export async function refreshModelCatalog(
  registry: ModelCatalogRefresher,
  timeoutMs: number = MODEL_CATALOG_TIMEOUT_MS,
  log: { warn(message: string): void; info(message: string): void } = {
    warn: (m) => console.warn(m),
    info: (m) => console.log(m),
  }
): Promise<ModelCatalogOutcome> {
  const startedAt = Date.now();
  try {
    const result = await registry.refresh({ signal: AbortSignal.timeout(timeoutMs) });
    if (result.aborted) {
      log.warn(
        `[banto] モデルの目録を ${timeoutMs / 1000} 秒で諦めました` +
          "（手元の models.json で動きます。新しいモデルは出ないことがあります）"
      );
      return { kind: "timeout" };
    }
    if (result.errors.size > 0) {
      const providers = [...result.errors.keys()];
      log.warn(`[banto] モデルの目録を取れなかったプロバイダ: ${providers.join(", ")}`);
      return { kind: "partial", providers };
    }
    const tookMs = Date.now() - startedAt;
    log.info(`[banto] モデルの目録を更新しました（${tookMs}ms）`);
    return { kind: "ok", tookMs };
  } catch (err) {
    // 打ち切りを投げてくる実装もありうる（pi は返してくるが、そこに寄りかからない）
    const reason = String(err);
    log.warn(`[banto] モデルの目録を更新できませんでした: ${reason}`);
    return { kind: "failed", reason };
  }
}
