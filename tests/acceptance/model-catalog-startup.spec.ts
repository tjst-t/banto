/**
 * 起動時のモデル目録の更新（inc-0047）。
 *
 * PO報告 2026-08-09：再始動したら**番頭が5分立ち上がらなかった**。
 * 待たされていたのは pi の目録取得（`https://pi.dev/api/models/…`）で、**上限が無い**まま
 * `fetch` の既定の 300 秒を使い切っていた（実測 300.8 秒 ×2 → 待ち受け開始まで 5分01秒）。
 *
 * ここで押さえるのは3つ。**どれが欠けても「外が遅い日は番頭が立たない」に戻る**：
 *
 * 1. 上限つきで打ち切る（外の応答に上限が無いなら、こちらで持つ）
 * 2. 打ち切っても**投げない**——待たない呼び出しの例外は `unhandledRejection` で
 *    プロセスごと落とす。落ちてよい失敗ではない（目録が古いだけ）
 * 3. 落ちたことを**黙らせない**（I2）。「モデルの一覧が古い」の原因がここだと辿れるように
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_CATALOG_TIMEOUT_MS,
  refreshModelCatalog,
  type ModelCatalogRefresher,
} from "../../packages/banto-host/src/model-catalog.js";

/** 何を言ったかを控えるログ（I2 の「黙らせない」を見るため）。 */
function recorder(): { warn(m: string): void; info(m: string): void; lines: string[] } {
  const lines: string[] = [];
  return { lines, warn: (m) => lines.push(m), info: (m) => lines.push(m) };
}

describe("[inc-0047] 起動時のモデル目録", () => {
  it("**返ってこない目録は打ち切る**（待ち受け開始を外に握らせない）", async () => {
    // 応答しないプロバイダの再現。打ち切りが無ければ永遠に解決しない
    const stuck: ModelCatalogRefresher = {
      refresh: (options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(new Error("The operation was aborted due to timeout"))
          );
        }),
    };

    const log = recorder();
    const startedAt = Date.now();
    const outcome = await refreshModelCatalog(stuck, 200, log);
    const took = Date.now() - startedAt;

    assert.equal(outcome.kind, "failed", "打ち切ったのに終わっていない");
    assert.ok(took < 2000, `${took}ms 待っている（上限 200ms のはず）`);
    assert.match(log.lines.join("\n"), /更新できませんでした/);
  });

  it("打ち切りを**返してくる**実装でも、時間切れとして扱う", async () => {
    // pi は投げずに `{aborted:true}` を返す。どちらでも同じ扱いにする
    const aborts: ModelCatalogRefresher = {
      refresh: async (options) => {
        await new Promise((resolve) => {
          options?.signal?.addEventListener("abort", resolve);
        });
        return { aborted: true, errors: new Map() };
      },
    };

    const log = recorder();
    const outcome = await refreshModelCatalog(aborts, 150, log);
    assert.equal(outcome.kind, "timeout");
    assert.match(log.lines.join("\n"), /諦めました/);
    // 何が起きるかを言う：手元の表で動く／新しいモデルは出ないことがある
    assert.match(log.lines.join("\n"), /models\.json/);
  });

  it("**投げ返さない**（待たない呼び出しなので、例外はプロセスごと落とす）", async () => {
    const broken: ModelCatalogRefresher = {
      refresh: () => Promise.reject(new Error("boom")),
    };
    const log = recorder();
    // ここで throw されたら、bin.ts の `void refreshModelCatalog(...)` は
    // unhandledRejection になる
    const outcome = await refreshModelCatalog(broken, 1000, log);
    assert.equal(outcome.kind, "failed");
    assert.match(log.lines.join("\n"), /boom/);
  });

  it("一部のプロバイダだけ取れなかったら、その名前を出す", async () => {
    const partial: ModelCatalogRefresher = {
      refresh: async () => ({
        aborted: false,
        errors: new Map<string, unknown>([["opencode-go", new Error("503")]]),
      }),
    };
    const log = recorder();
    const outcome = await refreshModelCatalog(partial, 1000, log);
    assert.deepEqual(outcome, { kind: "partial", providers: ["opencode-go"] });
    assert.match(log.lines.join("\n"), /opencode-go/);
  });

  it("届いたときは、かかった時間を出す（次に遅くなったら気づける）", async () => {
    const ok: ModelCatalogRefresher = {
      refresh: async () => ({ aborted: false, errors: new Map() }),
    };
    const log = recorder();
    const outcome = await refreshModelCatalog(ok, 1000, log);
    assert.equal(outcome.kind, "ok");
    assert.match(log.lines.join("\n"), /更新しました/);
  });

  it("上限は 300 秒（fetch の既定）から桁で離れている", () => {
    // 「上限を持つ」だけでは足りない。**待ち受け開始が握られない**値であることが要件
    assert.ok(
      MODEL_CATALOG_TIMEOUT_MS <= 30_000,
      `${MODEL_CATALOG_TIMEOUT_MS}ms は起動を待たせる長さ`
    );
  });
});
