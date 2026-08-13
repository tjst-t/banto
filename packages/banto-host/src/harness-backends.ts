/**
 * **バックエンドが自分を名乗る**（ADR-0020 決定98・task-0102）。
 *
 * どのモデルを回せるか・その参照を回せるか、を**バックエンド自身に聞く**。以前は
 * bin.ts が `CLAUDE_KNOWN_MODELS`（手書きの3行）を直に読み、`onSelectModel` が
 * `if (backend === "claude-agent-sdk")` で分岐していた——バックエンドが1つ増えるたびに
 * bin.ts の2箇所を直して回ることになり、**片方だけ直すと画面と実態が食い違う**。
 *
 * ## 問い合わせにする（決定98d）
 *
 * Agent SDK は `query().supportedModels()` を持っている。**実測（2026-08-13）**：
 * LLM を1回も呼ばずに約1秒で返り、手書きの表には無かった `default` / `opus[1m]` /
 * `claude-fable-5[1m]` が並んだ——**手書きの表は既に古かった**。
 *
 * **待たない。** 起動を1秒遅らせないため、聞いた結果は写しに置き、聞けるまでは
 * 組み込みの別名（`opus` / `sonnet` / `haiku`）で答える。**答えを持っていないことと、
 * 答えが「無い」ことは違う**（I2：聞けなかったら黙って空にしない）。
 *
 * D5: 判断は無い。名乗りの形と、聞いた結果の写しだけ。
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { NotSupported } from "@banto/core";
import { CLAUDE_KNOWN_MODELS, claudeAgentAvailability } from "@banto/worker-pool";
import type { HarnessBackendOption } from "./settings-module.js";

/** モデルの座標（バックエンドは呼び出し側が知っている）。 */
export interface BackendModelRef {
  provider: string;
  model: string;
}

/**
 * バックエンドの名乗り。
 *
 * `supports` が **`NotSupported` を値で返す**のが要点（決定98a）——
 * 「解決できなかった（undefined）」と「このバックエンドでは原理的に回せない」は
 * 直し方が違う。前者はモデルを登録すれば直り、後者は経路を替えるしかない。
 */
export interface HarnessBackendDescriptor {
  id: string;
  label: string;
  /** 使えない理由（認証が無い等）。あるなら選ばせない（I2）。 */
  unavailable(): string | undefined;
  /** このバックエンドが回せるモデル。 */
  providers(): HarnessBackendOption["providers"];
  /** この参照をこのバックエンドで回せるか。 */
  supports(ref: BackendModelRef): true | NotSupported;
}

/** 名乗りを画面へ出す形にする。 */
export function toBackendOption(backend: HarnessBackendDescriptor): HarnessBackendOption {
  const unavailable = backend.unavailable();
  return {
    id: backend.id,
    label: backend.label,
    ...(unavailable ? { unavailable } : {}),
    providers: backend.providers(),
  };
}

/**
 * pi バックエンド。**モデルは LLM 登録が持つ**——採用（`policy`）に `host` が
 * 立っているものだけが番頭の選択肢になる。
 *
 * @param hostModels 番頭に許しているモデル（`LlmCatalog.models()` を絞ったもの）
 * @param resolve    その組み合わせを pi が解決できるか（登録に載っているか）
 */
export function createPiBackend(options: {
  hostModels: () => Array<{
    providerId: string;
    id: string;
    name: string;
    vision: boolean;
    contextWindow?: number;
  }>;
  resolve: (provider: string, model: string) => unknown;
}): HarnessBackendDescriptor {
  return {
    id: "pi",
    label: "pi（登録したプロバイダ・ローカルLLMも可）",
    unavailable: () => undefined,
    providers: () => {
      const byProvider = new Map<string, HarnessBackendOption["providers"][number]["models"]>();
      for (const m of options.hostModels()) {
        const list = byProvider.get(m.providerId) ?? [];
        list.push({
          id: m.id,
          ...(m.name ? { name: m.name } : {}),
          vision: m.vision,
          ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
        });
        byProvider.set(m.providerId, list);
      }
      return [...byProvider.entries()].map(([id, models]) => ({ id, models }));
    },
    supports: (ref) =>
      options.resolve(ref.provider, ref.model) !== undefined
        ? true
        : {
            supported: false,
            reason:
              `${ref.provider}/${ref.model} は使えるモデルの一覧にありません` +
              "（設定の「LLM・モデル」で採用してください）",
          },
  };
}

/** 組み込みの別名。**聞けるまでの答え**であって、正典ではない。 */
const BUILT_IN_CLAUDE_MODELS = CLAUDE_KNOWN_MODELS.map((m) => ({
  id: m.value,
  name: m.label,
  vision: true,
}));

/** 聞き直す間隔。モデルの増減はそう頻繁ではないので、画面を開くたびには聞かない。 */
const ASK_TTL_MS = 10 * 60 * 1000;
/** 問い合わせの上限。応答が無い構成でホストごと待たせない（I2）。 */
const ASK_TIMEOUT_MS = 20_000;

/**
 * Claude Code（Agent SDK）バックエンド。
 *
 * **Claude 以外には繋げない**——公式が明文で非対応（ADR-0020）。だから
 * `supports` は provider を見て `NotSupported` を返す。「モデルが見つからない」ではなく
 * 「この経路では回せない」と言えることが、決定98a の狙いそのもの。
 */
export function createClaudeBackend(
  options: { now?: () => number; ask?: () => Promise<Array<{ id: string; name?: string }>> } = {}
): HarnessBackendDescriptor {
  const now = options.now ?? (() => Date.now());
  let cached: Array<{ id: string; name?: string; vision: boolean }> | undefined;
  let askedAt = 0;
  let inFlight = false;
  let warned = false;

  const ask =
    options.ask ??
    (async () => {
      // 入力を返し切らない生成器で立てる（この問い合わせは LLM を呼ばない・実測 約1秒）
      const session = query({
        prompt: (async function* () {
          await new Promise(() => {});
        })(),
        options: { tools: [], settingSources: [] },
      });
      try {
        const models = await Promise.race([
          session.supportedModels(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), ASK_TIMEOUT_MS)
          ),
        ]);
        return models.map((m) => ({ id: m.value, name: m.displayName }));
      } finally {
        // 聞くためだけに立てたセッションを畳む（放すと子プロセスが残る・task-0104）
        await session.interrupt?.().catch(() => {});
        session.return?.(undefined as never);
      }
    });

  const refresh = (): void => {
    if (inFlight || now() - askedAt < ASK_TTL_MS) return;
    inFlight = true;
    void ask()
      .then((models) => {
        askedAt = now();
        // I2: 空が返ったら「モデルが無い」と信じない。組み込みの別名のままにする
        if (models.length > 0) cached = models.map((m) => ({ ...m, vision: true }));
      })
      .catch((err: unknown) => {
        askedAt = now();
        if (!warned) {
          warned = true;
          console.warn(
            `[banto] Claude Code にモデル一覧を聞けませんでした（組み込みの別名で続けます）: ${String(err)}`
          );
        }
      })
      .finally(() => {
        inFlight = false;
      });
  };

  return {
    id: "claude-agent-sdk",
    label: "Claude Code（手元のサブスクリプション・Claude 専用）",
    unavailable: () => {
      const availability = claudeAgentAvailability();
      return availability.ok ? undefined : availability.detail;
    },
    providers: () => {
      // 聞くのは裏で。**いまある答えをすぐ返す**（起動も画面も待たせない）
      refresh();
      return [{ id: "claude", models: cached ?? BUILT_IN_CLAUDE_MODELS }];
    },
    supports: (ref) =>
      ref.provider === "claude"
        ? true
        : {
            supported: false,
            reason:
              `Claude Code は ${ref.provider} のモデルを回せません（Claude 専用）。` +
              "このモデルで話すなら、バックエンドを pi に替えてください",
          },
  };
}
