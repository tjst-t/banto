/**
 * 章の要約に使うモデルを選べるようにする（task-0151・inc-0068）。
 *
 * 確かめるのは受け入れ基準6件のうち a1・a2・a3・a4・a5:
 *
 * - a1: claude-agent-sdk のモデルを指定でき、実際にそのバックエンド経由で呼ばれる。
 *   pi の台帳に無いことを理由に既定へ落ちない
 * - a2: 指定が無いときの既定は claude-agent-sdk の haiku（会話のモデルではない）
 * - a3: 画面の設定から選んで保存でき、再起動をまたいで残る
 * - a4: 解決できないときは黙って既定へ落とさず、警告と断りに詳細が載る
 * - a5: BANTO_CHAPTER_MODEL は互換のため残り、画面の設定より優先される
 *
 * a6（資料への記録）と、a4 のうち「章を畳めなかったときの断り」の文言は
 * `chapters.spec.ts`（`createLlmChapterSummarizer` の試験）で確かめる。
 *
 * LLM には繋がない。`resolveChapterModel` は座標を解くだけで、呼びには行かない。
 * claude-agent-sdk の呼び口（`createClaudeChapterCompleter`）は `query` を差し替えて確かめる
 * （`harness-backends.spec.ts` の `ask?` と同じ形）。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolveSettingsFields } from "@banto/core";
import {
  DEFAULT_CHAPTER_MODEL,
  SettingsStore,
  createClaudeBackend,
  createClaudeChapterCompleter,
  createCoreSettingsSections,
  createPiBackend,
  resolveChapterModel,
  type HarnessBackendDescriptor,
} from "@banto/host";

/** 常に使える偽のバックエンド。試験ごとに `supports` / `unavailable` を差し替える。 */
function fakeBackend(
  id: string,
  opts: {
    unavailable?: string;
    supports?: (ref: {
      provider: string;
      model: string;
    }) => true | { supported: false; reason: string };
  } = {}
): HarnessBackendDescriptor {
  return {
    id,
    label: id,
    unavailable: () => opts.unavailable,
    providers: () => [],
    supports: opts.supports ?? (() => true),
  };
}

// ── a2: 既定は claude-agent-sdk の haiku ──────────────────────────────────────

describe("[task-0151 a2] 指定が無ければ既定は claude-agent-sdk の haiku", () => {
  it("環境変数も画面の設定も無ければ既定へ", () => {
    const result = resolveChapterModel({
      envRaw: undefined,
      settingsValue: undefined,
      backends: [fakeBackend("pi"), fakeBackend("claude-agent-sdk")],
    });
    assert.deepEqual(result.ref, DEFAULT_CHAPTER_MODEL);
    assert.equal(result.ref.backend, "claude-agent-sdk");
    assert.equal(result.ref.model, "haiku");
    assert.equal(result.source, "default");
    assert.equal(result.fallback, undefined);
  });
});

// ── a1: claude-agent-sdk のモデルを指定できる ─────────────────────────────────

describe("[task-0151 a1] claude-agent-sdk のモデルを指定でき、pi の台帳に無くても既定へ落ちない", () => {
  it("BANTO_CHAPTER_MODEL の backend/provider/model-id で claude を指定できる", () => {
    // 本物の createClaudeBackend / createPiBackend を使う。pi 側は何も知らない
    // （hostModels 空・resolve は常に undefined）——それでも claude の指定は解決できる
    const result = resolveChapterModel({
      envRaw: "claude-agent-sdk/claude/sonnet",
      settingsValue: undefined,
      backends: [
        createPiBackend({ hostModels: () => [], resolve: () => undefined }),
        createClaudeBackend({ ask: async () => [] }),
      ],
    });
    assert.deepEqual(result.ref, { backend: "claude-agent-sdk", provider: "claude", model: "sonnet" });
    assert.equal(result.source, "env");
    assert.equal(result.fallback, undefined, "pi の台帳に無いことを理由に既定へ落ちてはいけない");
  });

  it("provider/model-id の2分割（従来の書式）は pi とみなす（互換）", () => {
    const result = resolveChapterModel({
      envRaw: "anthropic/claude-3-5-haiku",
      settingsValue: undefined,
      backends: [fakeBackend("pi"), fakeBackend("claude-agent-sdk")],
    });
    assert.deepEqual(result.ref, { backend: "pi", provider: "anthropic", model: "claude-3-5-haiku" });
    assert.equal(result.source, "env");
  });

  it("実際に呼ばれるのは claude-agent-sdk 経由（query() にそのモデルを渡す）", async () => {
    const seen: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 偽の query()。
    // 呼び出し側が見るのは渡した引数と、返す非同期ジェネレータの形だけ（意図的な絞り込み）
    const fakeQuery = ((params: any) => {
      seen.push(params);
      return (async function* () {
        yield { type: "result", subtype: "success", stop_reason: "end_turn", result: "書けた本文" };
      })();
    }) as any;

    const complete = createClaudeChapterCompleter("sonnet", { query: fakeQuery });
    const response = await complete({ systemPrompt: "sys", prompt: "prompt", maxTokens: 8000 });

    assert.equal(seen.length, 1, "query() が呼ばれていない");
    assert.equal(seen[0]!.prompt, "prompt");
    assert.equal(seen[0]!.options["model"], "sonnet", "解決したモデルが渡っていない");
    assert.deepEqual(seen[0]!.options["tools"], [], "組み込みツールを切っていない（決定28・92）");
    assert.equal(response.stopReason, "end_turn");
    assert.equal(response.content[0]?.text, "書けた本文");
  });

  it("claude-agent-sdk が result を error で返したら stopReason: error で返す", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
    const fakeQuery = (() => {
      return (async function* () {
        yield { type: "result", subtype: "error_during_execution", errors: ["何か落ちた"] };
      })();
    }) as any;

    const complete = createClaudeChapterCompleter("haiku", { query: fakeQuery });
    const response = await complete({ systemPrompt: "sys", prompt: "p", maxTokens: 100 });

    assert.equal(response.stopReason, "error");
    assert.match(response.errorMessage ?? "", /何か落ちた/);
  });
});

// ── a4: 黙って既定へ落とさない ─────────────────────────────────────────────────

describe("[task-0151 a4] 解決できないときは黙って既定へ落とさない", () => {
  it("形式が壊れていれば、生の指定を fallback に残す", () => {
    const result = resolveChapterModel({
      envRaw: "no-slash-here",
      settingsValue: undefined,
      backends: [fakeBackend("pi"), fakeBackend("claude-agent-sdk")],
    });
    assert.deepEqual(result.ref, DEFAULT_CHAPTER_MODEL);
    assert.ok(result.fallback, "fallback が記録されていない");
    assert.equal(result.fallback!.from, "env");
    assert.deepEqual(result.fallback!.requested, { raw: "no-slash-here" });
    assert.match(result.fallback!.reason, /provider\/model-id/);
  });

  it("正しい形式でも回せないモデルなら、解決の結果（理由）付きで既定へ", () => {
    const result = resolveChapterModel({
      envRaw: "pi/unknown-model",
      settingsValue: undefined,
      backends: [
        fakeBackend("pi", {
          supports: () => ({ supported: false, reason: "使えるモデルの一覧にありません" }),
        }),
        fakeBackend("claude-agent-sdk"),
      ],
    });
    assert.deepEqual(result.ref, DEFAULT_CHAPTER_MODEL);
    assert.deepEqual(result.fallback!.requested, { backend: "pi", provider: "pi", model: "unknown-model" });
    assert.match(result.fallback!.reason, /使えるモデルの一覧にありません/);
  });

  /**
   * PO差し戻し 2026-08-14: `resolveChapterModel` は `backend.unavailable()`
   * （いま実際に呼べるか。認証の有無など）を見てはいけない。見ると、解決の結果が
   * 実行環境に左右され、同じ指定がホストでは通り、認証の無い検証環境（docker）では
   * 黙って別のモデルへ落ちる——inc-0068 そのものの形の食い違いになる
   * （実測：`createClaudeBackend()` は `unavailable()` が `~/.claude` の認証の有無を見るため、
   * 認証の無い環境で `chapter-model.spec.ts` のこの試験が落ちていた）。
   *
   * 「座標が認識される（`supports()`）」と「いま実際に呼べる（`unavailable()`）」は別のこと。
   * 後者は呼ぶときに分かればよい——呼べなければそこで例外にする（I2）。
   */
  it("バックエンドが unavailable（認証が無い等）でも、座標が認識されれば解決する", () => {
    const result = resolveChapterModel({
      envRaw: "claude-agent-sdk/claude/haiku",
      settingsValue: undefined,
      backends: [
        fakeBackend("pi"),
        fakeBackend("claude-agent-sdk", { unavailable: "~/.claude の認証がありません" }),
      ],
    });
    assert.deepEqual(
      result.ref,
      { backend: "claude-agent-sdk", provider: "claude", model: "haiku" },
      "unavailable() を理由に既定へ落ちてはいけない（実行環境に解決結果が左右される）"
    );
    assert.equal(result.source, "env");
    assert.equal(result.fallback, undefined);
  });

  it("知らないバックエンドを指定したときも理由を残す", () => {
    const result = resolveChapterModel({
      envRaw: "vertex/claude/opus",
      settingsValue: undefined,
      backends: [fakeBackend("pi"), fakeBackend("claude-agent-sdk")],
    });
    assert.deepEqual(result.ref, DEFAULT_CHAPTER_MODEL);
    assert.match(result.fallback!.reason, /登録されていません/);
  });

  it("画面の設定が解決できないときも同じように fallback に残る", () => {
    const result = resolveChapterModel({
      envRaw: undefined,
      settingsValue: "pi|huihui|does-not-exist",
      backends: [
        fakeBackend("pi", { supports: () => ({ supported: false, reason: "採用していません" }) }),
        fakeBackend("claude-agent-sdk"),
      ],
    });
    assert.deepEqual(result.ref, DEFAULT_CHAPTER_MODEL);
    assert.equal(result.fallback!.from, "settings");
    assert.match(result.fallback!.reason, /採用していません/);
  });
});

// ── a5: 環境変数が画面の設定より優先される ─────────────────────────────────────

describe("[task-0151 a5] BANTO_CHAPTER_MODEL は互換のため残り、画面の設定より優先される", () => {
  it("両方指定されていれば環境変数が勝つ", () => {
    const result = resolveChapterModel({
      envRaw: "claude-agent-sdk/claude/haiku",
      settingsValue: "pi|anthropic|claude-3-5-sonnet",
      backends: [fakeBackend("pi"), fakeBackend("claude-agent-sdk")],
    });
    assert.deepEqual(result.ref, { backend: "claude-agent-sdk", provider: "claude", model: "haiku" });
    assert.equal(result.source, "env");
  });

  it("環境変数が無ければ画面の設定が使われる", () => {
    const result = resolveChapterModel({
      envRaw: undefined,
      settingsValue: "pi|anthropic|claude-3-5-sonnet",
      backends: [fakeBackend("pi"), fakeBackend("claude-agent-sdk")],
    });
    assert.deepEqual(result.ref, { backend: "pi", provider: "anthropic", model: "claude-3-5-sonnet" });
    assert.equal(result.source, "settings");
  });

  it("環境変数が空文字なら、未設定として扱い画面の設定を使う", () => {
    const result = resolveChapterModel({
      envRaw: "",
      settingsValue: "pi|anthropic|claude-3-5-sonnet",
      backends: [fakeBackend("pi"), fakeBackend("claude-agent-sdk")],
    });
    assert.equal(result.source, "settings");
  });
});

// ── a3: 画面の設定は保存され、再起動をまたいで残る ─────────────────────────────

describe("[task-0151 a3] 画面から選んで保存でき、再起動をまたいで残る", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-chapter-model-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("SettingsStore へ保存した値は、読み直しても残る（再起動を模す）", () => {
    const file = path.join(dir, "settings.json");
    const store1 = new SettingsStore(file);
    store1.update("chapterModel", "claude-agent-sdk|claude|haiku");

    // 新しいインスタンスで同じファイルを読む＝再起動を模す
    const store2 = new SettingsStore(file);
    assert.equal(store2.all().chapterModel, "claude-agent-sdk|claude|haiku");
  });

  it("設定の区画「章の要約に使うモデル」で保存・読み出しができる", async () => {
    const store = new SettingsStore(path.join(dir, "settings.json"));
    const sections = createCoreSettingsSections(store, {
      harnessChoices: () => [
        { value: "claude-agent-sdk|claude|haiku", label: "Claude Code › claude › haiku" },
      ],
    });
    const section = sections.find((s) => s.id === "chapterModel");
    assert.ok(section, "chapterModel 区画が無い");

    assert.deepEqual(await section!.spec.read(), { chapterModel: "" }, "保存前は空");

    const result = await section!.spec.write({ chapterModel: "claude-agent-sdk|claude|haiku" });
    assert.equal(result.applied, false, "次の会話から効く旨を正しく申告していない");
    assert.deepEqual(await section!.spec.read(), { chapterModel: "claude-agent-sdk|claude|haiku" });

    // 保存先そのもの（settings.json）にも残る
    assert.equal(store.all().chapterModel, "claude-agent-sdk|claude|haiku");
  });

  it("壊れた値は黙って保存しない（I2）", async () => {
    const store = new SettingsStore(path.join(dir, "settings.json"));
    const sections = createCoreSettingsSections(store, { harnessChoices: () => [] });
    const section = sections.find((s) => s.id === "chapterModel")!;

    assert.throws(() => section.spec.write({ chapterModel: "壊れた値" }));
    assert.equal(store.all().chapterModel, undefined, "壊れた値のまま保存されてはいけない");
  });

  it("空文字を書けば指定を外せる（既定へ戻る）", async () => {
    const store = new SettingsStore(path.join(dir, "settings.json"));
    store.update("chapterModel", "claude-agent-sdk|claude|haiku");
    const sections = createCoreSettingsSections(store, { harnessChoices: () => [] });
    const section = sections.find((s) => s.id === "chapterModel")!;

    await section.spec.write({ chapterModel: "" });
    assert.equal(store.all().chapterModel, undefined);
  });

  it("画面には「いま実際に使われているもの」が出る（指定と実態の食い違いも見える）", async () => {
    const store = new SettingsStore(path.join(dir, "settings.json"));
    const sections = createCoreSettingsSections(store, {
      harnessChoices: () => [],
      effectiveChapterModel: () => ({
        ref: DEFAULT_CHAPTER_MODEL,
        source: "default",
        fallback: {
          requested: { backend: "pi", provider: "huihui", model: "does-not-exist" },
          reason: "使えるモデルの一覧にありません",
          from: "settings",
        },
      }),
    });
    const section = sections.find((s) => s.id === "chapterModel")!;
    const fields = await resolveSettingsFields(section.spec);
    const field = fields.find((f) => f.key === "chapterModel");

    assert.ok(field, "chapterModel の項目が無い");
    assert.match(field!.description ?? "", /いま実際に使われているのは/);
    assert.match(field!.description ?? "", /claude-agent-sdk/);
    assert.match(field!.description ?? "", /使えるモデルの一覧にありません/, "指定との食い違いが見えない");
  });
});
