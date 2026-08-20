/**
 * [task-0303] 記憶の抽出も、抽出が走る直前にモデルを引き直す。
 *
 * `model-settings-live.spec.ts` の a1（章の要約は畳む直前にモデルを引き直す）と
 * 同じ取り違えが、記憶の抽出器（`createLlmMemoryExtractor`）の側にも残っていた。
 * 以前は `model` を組み立て時に一度だけ受け取っていたので、会話の器はそのモデル
 * 実体を掴んだまま使い続け、設定画面でモデルを変えても走っている会話の抽出には
 * 最後まで効かなかった。ここで固定するのは、抽出器が章の要約と同じ形
 * （`resolve` を、抽出が走るたびに呼ぶ）になったこと。
 *
 * LLM には繋がない。認証解決の口（`auth`）を偽物に差し替え、`requireAuth` の
 * 手前で意図して止める——実際の `completeSimple`（ネットワーク呼び出し）までは
 * 進ませず、渡された model の座標と呼ばれた回数だけを見る。
 * `model-settings-live.spec.ts` の a1 と同じ「偽の呼び口を渡して呼ばれた回数と
 * 使われた座標だけを見る」書き方に倣う。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Model } from "@earendil-works/pi-ai/compat";
import { createLlmMemoryExtractor } from "@banto/host";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi の Model は Api で
// 型付けされているが、試験では実体を組まず座標（id）だけ持つ偽物で足りる (I4)
type FakeModel = Model<any>;

/** `Model` を装う、座標（id）だけ持つ偽物。ネットワークには繋がない。 */
function fakeModel(id: string): FakeModel {
  return { id } as FakeModel;
}

/**
 * `requireAuth` の手前で必ず断る偽の認証解決。渡された model の座標（id）を記録する。
 *
 * `ok: false` を返すと `requireAuth` が投げるので、抽出器はここで止まり
 * `completeSimple`（実際の LLM 呼び出し）へは進まない。
 */
function authRecorder(): {
  auth: (model: FakeModel) => Promise<{ ok: boolean; error: string }>;
  markers: () => string[];
} {
  const markers: string[] = [];
  return {
    markers: () => markers,
    auth: async (model: FakeModel) => {
      markers.push((model as { id: string }).id);
      return { ok: false, error: "test-stop" };
    },
  };
}

// ── [a1] 抽出に使うモデルは、抽出が走る直前に引き直す ──────────────────────────

describe("[task-0303 a1] 記憶の抽出に使うモデルは、抽出が走る直前に引き直す", () => {
  it("設定を変えたら、走っている会話の次の抽出から新しいモデルが使われる", async () => {
    const rec = authRecorder();
    /** 画面の設定にあたるもの。試験の途中で書き換える。 */
    let saved = fakeModel("1回目");

    const extract = createLlmMemoryExtractor({
      resolve: () => ({ model: saved }),
      auth: rec.auth,
    });

    await assert.rejects(extract({ transcript: "PO: こんにちは", existing: [] }));
    assert.deepEqual(rec.markers(), ["1回目"], "1回目は保存されていたモデルで呼ぶ");

    // ここで PO が設定画面から「記憶の抽出」に使うモデルを変えた（会話はそのまま走っている）
    saved = fakeModel("2回目");

    await assert.rejects(extract({ transcript: "PO: つづき", existing: [] }));
    assert.deepEqual(
      rec.markers(),
      ["1回目", "2回目"],
      "**器を組み直さずに**新しい指定で呼ぶ（以前は会話の生涯そのままだった）"
    );
  });

  it("固定で渡す形も残る（引き直す相手が無い呼び出し側を巻き込まない）", async () => {
    const rec = authRecorder();
    const extract = createLlmMemoryExtractor({
      model: fakeModel("固定"),
      auth: rec.auth,
    });

    await assert.rejects(extract({ transcript: "PO: こんにちは", existing: [] }));
    await assert.rejects(extract({ transcript: "PO: つづき", existing: [] }));
    assert.deepEqual(rec.markers(), ["固定", "固定"], "resolve が無ければ毎回同じモデルを使う");
  });
});

// ── 解決できないときの振る舞い ─────────────────────────────────────────────────

describe("[task-0303] 解決できないときは、黙って握り潰さない（I2）", () => {
  it("resolve が投げたら、抽出の呼び出しが理由を持って失敗する", async () => {
    const extract = createLlmMemoryExtractor({
      resolve: () => {
        throw new Error("記憶の抽出に使えるモデルがありません（テスト用の断り）");
      },
      auth: async () => ({ ok: true, error: "" }),
    });

    await assert.rejects(
      extract({ transcript: "PO: こんにちは", existing: [] }),
      /記憶の抽出に使えるモデルがありません/u,
      "理由の無い失敗にしない"
    );
  });
});
