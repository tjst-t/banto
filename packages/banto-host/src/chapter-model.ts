/**
 * 章の要約に使うモデルを解決する（task-0151・inc-0068）。
 *
 * 要約器（`chapter-summarizer.ts`）は pi の `completeSimple` しか呼べなかったため、
 * `BANTO_CHAPTER_MODEL` に claude-agent-sdk のモデル（haiku 等）を指定しても解決できず、
 * **会話のモデルへ黙って落ちていた**（inc-0068）。会話のモデルが Claude Agent SDK
 * のときは pi の台帳にも無いため、さらに番頭の標準（無関係なローカルモデル）へ落ち、
 * 誰も選んでいないモデルが要約を書いていた。
 *
 * ここでの直し方は2つ:
 *
 * 1. **会話と同じモデルへは頼らない。** 既定は固定で claude-agent-sdk の haiku
 *    （`DEFAULT_CHAPTER_MODEL`）——安く、pi の台帳の有無に左右されない。
 * 2. **指定があるのに使えないときは黙って既定へ落とさない**（I2）。`resolveChapterModel`
 *    は解決できなかった理由と、実際に使うことになったものの両方を返す。呼び出し側
 *    （bin.ts）がこれで警告を出し、章を畳めなかったときの断りにも載せる（a4）。
 *
 * 優先順位（前提と注意・a5）: 環境変数 `BANTO_CHAPTER_MODEL` > 画面の設定（保存された値）
 * > 既定。環境変数は運用に出ているので互換のため残し、最優先のままにする。
 *
 * **解決は実行環境に左右されない**（PO差し戻し 2026-08-14）。「この座標は認識される形か」
 * （`HarnessBackendDescriptor.supports()`）だけを見て、「いま実際に呼べるか」
 * （`unavailable()`。認証の有無など）は見ない——見ると、同じ指定がホストでは通り、
 * 認証の無い検証環境では黙って別のモデルへ落ちる。それは inc-0068 そのものの形
 * （実測で確認済み：`CLAUDE_CONFIG_DIR` を空にすると、ホストでもこの食い違いが再現した）。
 * 実際に呼べるかは呼ぶときに分かる——呼べなければ、そこで例外にする（I2。
 * `chapter-completers.ts` の各口が担う）。
 *
 * D5: 判断は「どちらを勝たせるか」「座標を認識できるかをバックエンドに聞く」だけ。
 * D6: 追加の依存は無い。
 */

import type { HarnessBackendDescriptor } from "./harness-backends.js";

/** モデルの座標（バックエンド込み・決定103と同じ3成分）。 */
export interface ChapterModelRef {
  backend: string;
  provider: string;
  model: string;
}

/**
 * 既定：claude-agent-sdk の haiku（task-0151）。
 *
 * 会話のモデルへ寄せていた以前の既定はやめる。理由は3つ（task-0151 §2）:
 * ①要約は安いモデルで足りる ②会話のモデルは思考を出す等級が選ばれがちで、
 * 出力予算を思考で食い潰す（inc-0068） ③「会話と同じ」は解決に失敗したとき
 * 静かに別物へ落ちる。
 */
export const DEFAULT_CHAPTER_MODEL: ChapterModelRef = {
  backend: "claude-agent-sdk",
  provider: "claude",
  model: "haiku",
};

/** モデルの座標を人が読める形にする（ログ・断りの文言に使う）。 */
export function chapterModelLabel(ref: ChapterModelRef): string {
  return `${ref.backend}/${ref.provider}/${ref.model}`;
}

/** パースに失敗したときの生の指定（形が壊れていて座標に組めない）。 */
export interface UnparsedChapterModel {
  raw: string;
}

/**
 * `BANTO_CHAPTER_MODEL` をパースする。
 *
 * 2つの形を受け付ける:
 * - `provider/model-id`（**従来の2分割・互換のため残す**。backend は pi とみなす）
 * - `backend/provider/model-id`（3分割。claude-agent-sdk 等、pi 以外を明示するとき）
 *
 * 空・未設定なら `undefined`。壊れた形は `{ error }` で返し、値を作らない
 * （I2：読めない指定を黙って無視しない）。
 */
export function parseChapterModelEnv(
  raw: string | undefined
): { ref: ChapterModelRef } | { error: string; raw: string } | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const parts = raw.split("/");
  const formatError = {
    error: `BANTO_CHAPTER_MODEL は "provider/model-id" または "backend/provider/model-id" の形です（${raw}）`,
    raw,
  };
  if (parts.length === 2) {
    const [provider, model] = parts;
    if (!provider || !model) return formatError;
    return { ref: { backend: "pi", provider, model } };
  }
  if (parts.length === 3) {
    const [backend, provider, model] = parts;
    if (!backend || !provider || !model) return formatError;
    return { ref: { backend, provider, model } };
  }
  return formatError;
}

/**
 * 画面の設定に保存された値（`backend|provider|model` の形）をパースする。
 *
 * 会話のモデル選択・「役ごとのモデル」の区画（`core-settings.ts`）と同じ符号化
 * ——選択肢を2箇所で組まない（D3）ので、値の形も揃える。
 */
export function parseChapterModelSetting(raw: unknown): ChapterModelRef | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const [backend, provider, model] = raw.split("|");
  if (!backend || !provider || !model) return undefined;
  return { backend, provider, model };
}

/** 解決の結果。実際に使うものと、指定があったのに使えなかった記録（あれば）。 */
export interface ChapterModelResolution {
  ref: ChapterModelRef;
  source: "env" | "settings" | "default";
  /**
   * 指定はあったが使えず、既定へ落ちたときの記録（a4）。
   *
   * `requested` はパースできていれば座標、パースできなければ生の文字列
   * ——どちらでも「指定された名前」が断りの文言に載せられる。
   */
  fallback?: {
    requested: ChapterModelRef | UnparsedChapterModel;
    reason: string;
    from: "env" | "settings";
  };
}

/**
 * 章の要約に使うモデルを解決する。
 *
 * **黙って既定へ落とさない**（I2・a4）。指定（環境変数・画面の設定）があるのに
 * 解決できないときは `fallback` に理由を残す——呼び出し側が警告を出し、
 * 断りの文言にも載せられるようにするため。
 */
export function resolveChapterModel(options: {
  envRaw: string | undefined;
  settingsValue: unknown;
  backends: readonly HarnessBackendDescriptor[];
}): ChapterModelResolution {
  const backendById = new Map(options.backends.map((b) => [b.id, b] as const));

  /**
   * この座標がこのバックエンドで**認識される形か**。理由があれば返す。
   *
   * **`backend.unavailable()`（いま実際に呼べるか）はここでは見ない**——見ると、
   * 解決の結果が実行環境（認証の有無・SDK が使える状態か）に左右される。同じ指定が
   * ホストでは通り、認証の無い環境（検証コンテナ等）では黙って別のモデルへ落ちる、
   * という**まさに inc-0068 の形**の食い違いになる（実測で確認済み：
   * `CLAUDE_CONFIG_DIR` を空にすると、ホストでもこの食い違いが再現する）。
   *
   * 「解決できる（座標として認識される）」と「いま実際に呼べる」は別のこと。
   * 後者は呼ぶときに分かる——呼べなければ、その場で例外にする（I2）。
   * ここで確かめるのは `supports()`（この参照をこのバックエンドで回せる形か）だけ。
   */
  const unusable = (ref: ChapterModelRef): string | undefined => {
    const backend = backendById.get(ref.backend);
    if (!backend) {
      const known = [...backendById.keys()].join(", ");
      return `バックエンド "${ref.backend}" は登録されていません（あるのは ${known}）`;
    }
    const support = backend.supports({ provider: ref.provider, model: ref.model });
    return support === true ? undefined : support.reason;
  };

  const env = parseChapterModelEnv(options.envRaw);
  if (env) {
    if ("error" in env) {
      return {
        ref: DEFAULT_CHAPTER_MODEL,
        source: "default",
        fallback: { requested: { raw: env.raw }, reason: env.error, from: "env" },
      };
    }
    const reason = unusable(env.ref);
    if (reason) {
      return {
        ref: DEFAULT_CHAPTER_MODEL,
        source: "default",
        fallback: { requested: env.ref, reason, from: "env" },
      };
    }
    return { ref: env.ref, source: "env" };
  }

  const settingsRef = parseChapterModelSetting(options.settingsValue);
  if (settingsRef) {
    const reason = unusable(settingsRef);
    if (reason) {
      return {
        ref: DEFAULT_CHAPTER_MODEL,
        source: "default",
        fallback: { requested: settingsRef, reason, from: "settings" },
      };
    }
    return { ref: settingsRef, source: "settings" };
  }

  return { ref: DEFAULT_CHAPTER_MODEL, source: "default" };
}
