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
import {
  CLAUDE_KNOWN_MODELS,
  claudeAgentAvailability,
  type ClaudeQuotaMonitor,
} from "@banto/worker-pool";
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
 * 番頭の標準モデルとして**名乗ってよい能力**を決める（`GET /api/model`／`model_state`）。
 *
 * `LlmCatalog.resolveHostDefault()` は、番頭の標準を pi の登録で解けないとき
 * **pi 側の別モデル（代打）へ落ちる**——Claude Code（`claude-agent-sdk`）のモデルは
 * そもそも登録に載らないので、そのバックエンドを選んでいる間は必ず代打になる。
 * 代打はセッションを組む型（pi-ai の `Model`）を埋めるためのものなので、
 * **その能力値は標準とは何の関係も無い**。
 *
 * 実測（2026-08-14）：番頭は `opus` で動いているのに `/api/model` は
 * `{"id":"opus","vision":false,"contextWindow":128000}` を返していた。128000 は
 * 代打（`huihui/deepseek-v4-flash-abliterated`）に pi が付けた既定値で、
 * 実際の `opus`（`claude-opus-5`）は 1,000,000 だった——名前は標準、中身は別モデル。
 *
 * だから**代打のときは代打の能力を名乗らない**。文脈長は欄ごと落とす（「分からない」を
 * 数で埋めない・I1）。ただし vision は代打から借りる値ではなく**こちら側の事実**なので
 * 別扱いにする（下の分岐を見よ）。正しい値をここに定数で書くこともしない——Anthropic 側の
 * 仕様・プラン・`CLAUDE_CODE_DISABLE_1M_CONTEXT` で変わるので、書いた瞬間に嘘になる。
 * 実測が要る経路（章の畳み）は `BantoHarness.contextWindow()` から本物を受け取っている。
 */
export function hostModelInfo(options: {
  /** 番頭の標準（`roles.steward`）。名乗る `id` はここの綴りのまま。 */
  steward: { backend?: string; provider: string; model: string };
  /** `resolveHostDefault()` が返したモデルと、その能力。 */
  resolved: { provider: string; id: string; vision: boolean; contextWindow?: number } | undefined;
  /** 標準そのものを pi の登録で解けるか（`LlmCatalog.resolveExact`）。 */
  resolveExact: (provider: string, model: string) => { provider: string; id: string } | undefined;
}): { id: string; backend: string; vision: boolean; contextWindow?: number } {
  const backend = options.steward.backend ?? "pi";
  // `resolveHostDefault()` と同じ条件で「標準そのものを解けたか」を判定する。
  // 解けた結果と食い違っていれば、返ってきたのは代打
  const exact =
    backend === "pi"
      ? options.resolveExact(options.steward.provider, options.steward.model)
      : undefined;
  const resolved = options.resolved;
  const isHostDefault =
    exact !== undefined &&
    resolved !== undefined &&
    exact.provider === resolved.provider &&
    exact.id === resolved.id;
  if (!isHostDefault || !resolved) {
    /**
     * 文脈長は名乗らない（上の実測のとおり、代打の数は標準と無関係）。
     *
     * vision だけは別。これは**代打の能力値ではなく、こちら側が持っている事実**
     * ——`claude-agent-sdk` バックエンドのときは harness が画像ブロックを SDK へ
     * 実際に流し込む（`claude-agent-harness.ts` の `toSdkImageBlocks`／実測 2026-08-15）。
     * 渡せるようになったから真を返すのであって、代打から借りてきた値ではない。
     * pi の代打へ落ちたときは、渡せる保証がこちらに無いので false のまま（I1）。
     *
     * `onSelectModel`（`bin.ts`）も同じ判断で揃えること——**片方だけ直すと
     * モデルを選び直した瞬間に嘘に戻る**。
     */
    return { id: options.steward.model, backend, vision: backend === "claude-agent-sdk" };
  }
  return {
    id: options.steward.model,
    /**
     * **どのバックエンドの標準かも名乗る**（PO報告 2026-08-20）。会話がまだ自分の
     * モデルを持たないとき、画面はこの標準をそのまま映す——バックエンドが抜けていると
     * 「Claude Code で動いているのに、画面ではどちらか分からない」状態になり、
     * 思考レベルの選択肢（pi のレベル／Claude の config）まで取り違える。
     */
    backend,
    vision: resolved.vision,
    ...(resolved.contextWindow ? { contextWindow: resolved.contextWindow } : {}),
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

/**
 * 組み込みの別名。**聞けるまでの答え**であり、かつ**聞いた一覧に足りないぶん**でもある。
 *
 * **実測（2026-08-13）**：`supportedModels()` が返すのは
 * `default` / `opus[1m]` / `claude-fable-5[1m]` / `sonnet` / `haiku` で、**素の `opus` は
 * 入っていない**。だが `opus` は生きていて、`opus[1m]` とは**別のモデル**へ解決する
 * （`claude-opus-5` と `claude-opus-5[1m]`）。
 *
 * **文脈長は同じ**（実測 2026-08-14：どちらも `claude-opus-5` / 1,000,000）。
 * 以前ここには「文脈長が違う」と書いてあったが、測ると違うのは名前だけだった。
 *
 * つまり**聞いた一覧は「勧める一覧」であって「使える名前の全部」ではない。**
 * 実機の番頭は `opus` で動いており、聞いた一覧だけを出すと**いま効いている束縛が
 * 選択肢から消える**（画面が実態を映せなくなる）。両方を足す。
 */
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
  options: {
    now?: () => number;
    ask?: () => Promise<Array<{ id: string; name?: string }>>;
    /**
     * 認証・可用性の判定口（既定は実環境の判定＝`claudeAgentAvailability`）。
     *
     * `unavailable()` は quota 判定より先にこれを実行する。テストではここを差し替えて
     * 認証が無い環境でも自己完結させる（task-0267）。
     */
    availability?: () => ReturnType<typeof claudeAgentAvailability>;
    /**
     * サブスクの7日枠の残量を監視する口（既定は無し＝監視しない）。
     *
     * **枠が尽きかけたら `unavailable()` を返し、Claude Agent SDK を選べなくする。**
     * 認証はあるが残量がしきい値を切った、という「いま回せるか」の判断をここで足す。
     * 残量が復帰（リセット）すれば自動でまた選べるようになる。
     */
    quota?: ClaudeQuotaMonitor;
  } = {}
): HarnessBackendDescriptor {
  const now = options.now ?? (() => Date.now());
  const quota = options.quota; // 無ければ監視しない（バックエンドとしての挙動は元のまま）
  const availability = options.availability ?? claudeAgentAvailability;
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
      const a = availability();
      if (!a.ok) return a.detail;
      // 残量がしきい値を切ったら、認証はあっても「いまは使わない」を名乗る。
      // 理由に残量を載せて、PO に復帰する目安（リセット時刻）が分かるようにする
      if (quota?.shouldStop()) {
        const s = quota.snapshot();
        const remaining =
          s.remainingPct === undefined
            ? ""
            : `（残り ${s.remainingPct.toFixed(0)}%）`;
        const reset = s.resetsAt ? ` 枠は ${s.resetsAt} に戻ります。` : "";
        return `Claude サブスクの枠が尽きかけました${remaining}。${reset}自動で pi に切り替えています`;
      }
      return undefined;
    },
    providers: () => {
      // 聞くのは裏で。**いまある答えをすぐ返す**（起動も画面も待たせない）
      refresh();
      /**
       * **聞いた一覧に、組み込みの別名を重ねる**（上の注記）。聞いた側を先に置く
       * ——そちらが「いま勧められているもの」で、組み込みは補いだから。
       */
      const asked = cached ?? [];
      const missing = BUILT_IN_CLAUDE_MODELS.filter((b) => !asked.some((a) => a.id === b.id));
      return [{ id: "claude", models: [...asked, ...missing] }];
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
