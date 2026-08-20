/**
 * **バックエンドが自分を名乗る**（ADR-0020 決定98a・98d・task-0102）。
 *
 * ここで守りたいのは2つ。
 *   - **「回せない」は値で返る**（`NotSupported`）。`undefined` に潰すと、画面に出せる
 *     理由が「使えません」だけになる——モデルを登録すれば直るのか、経路を替えるしか
 *     ないのかが読めない
 *   - **モデルの一覧は聞く**。聞けるまでは組み込みの別名で答え、聞けなかったら
 *     黙って空にしない（I2）
 *
 * 本物の Claude Code は起こさない（`ask` を差し替える）。実機の問い合わせは
 * 2026-08-13 に確認済み——LLM を呼ばずに約1秒、手書きの表に無い `opus[1m]` /
 * `claude-fable-5[1m]` が並んだ。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createClaudeBackend, createPiBackend, toBackendOption } from "@banto/host";
import { hostModelInfo } from "../../packages/banto-host/src/harness-backends.js";

function piBackend(options: { adopted?: Array<{ provider: string; id: string }> } = {}) {
  const adopted = options.adopted ?? [{ provider: "opencode-go", id: "deepseek-v4-flash" }];
  return createPiBackend({
    hostModels: () =>
      adopted.map((m) => ({
        providerId: m.provider,
        id: m.id,
        name: m.id,
        vision: false,
        contextWindow: 128_000,
      })),
    resolve: (provider, model) =>
      adopted.some((m) => m.provider === provider && m.id === model) ? { provider, model } : undefined,
  });
}

describe("[決定98a] 回せないことは値で返る（NotSupported）", () => {
  it("pi は「一覧にない」と言い、次にどうすればよいかまで書く", () => {
    const support = piBackend().supports({ provider: "huihui", model: "知らないもの" });
    assert.notEqual(support, true);
    assert.ok(support !== true);
    assert.equal(support.supported, false);
    assert.match(support.reason, /一覧にありません/);
    assert.match(support.reason, /採用/, "直し方（採用する）を書く");
  });

  it("Claude Code は Claude 以外を「この経路では回せない」と断る", () => {
    const support = createClaudeBackend({ ask: async () => [] }).supports({
      provider: "huihui",
      model: "deepseek-v4-flash-abliterated",
    });
    assert.ok(support !== true);
    assert.match(support.reason, /Claude 専用/);
    assert.match(support.reason, /pi/, "直し方（経路を替える）を書く——採用しても直らない");
  });

  it("採用しているものは通る", () => {
    assert.equal(
      piBackend().supports({ provider: "opencode-go", model: "deepseek-v4-flash" }),
      true
    );
    assert.equal(
      createClaudeBackend({ ask: async () => [] }).supports({ provider: "claude", model: "opus" }),
      true
    );
  });
});

describe("[決定98d] モデルの一覧はバックエンドに聞く", () => {
  it("聞く前は組み込みの別名で答える（起動を待たせない）", () => {
    const backend = createClaudeBackend({ ask: async () => [{ id: "opus[1m]" }] });
    const first = backend.providers();
    assert.deepEqual(
      first[0]!.models.map((m) => m.id),
      ["opus", "sonnet", "haiku"],
      "問い合わせの答えを待たない"
    );
  });

  it("聞けたら足される。**組み込みの別名は消えない**", async () => {
    const backend = createClaudeBackend({
      ask: async () => [
        { id: "default", name: "Default (recommended)" },
        { id: "opus[1m]", name: "Opus (1M context)" },
        { id: "sonnet", name: "Sonnet" },
      ],
    });
    backend.providers(); // 裏で聞き始める
    await new Promise((r) => setImmediate(r));
    const ids = backend.providers()[0]!.models.map((m) => m.id);
    assert.deepEqual(
      ids,
      ["default", "opus[1m]", "sonnet", "opus", "haiku"],
      "聞いた側が先、足りないぶんを組み込みから補う"
    );
    /**
     * **実測（2026-08-13）**：`supportedModels()` に素の `opus` は入っていないが、
     * `opus` は生きていて `opus[1m]` とは別のモデルへ解決する
     * （`claude-opus-5` / `claude-opus-5[1m]`）。実機の番頭は `opus` で動いており、
     * 聞いた一覧だけを出すと**いま効いている束縛が選択肢から消える**。
     */
    assert.ok(ids.includes("opus"), "聞いた一覧は「勧める一覧」であって「使える名前の全部」ではない");
    assert.equal(ids.filter((i) => i === "sonnet").length, 1, "重ねても二重に出ない");
  });

  it("聞けなかったら黙って空にしない（I2）", async () => {
    const backend = createClaudeBackend({ ask: async () => Promise.reject(new Error("落ちた")) });
    backend.providers();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.ok(backend.providers()[0]!.models.length > 0, "組み込みの別名のままにする");
  });

  it("空の答えも信じない（モデルが0本のバックエンドは選べなくなる）", async () => {
    const backend = createClaudeBackend({ ask: async () => [] });
    backend.providers();
    await new Promise((r) => setImmediate(r));
    assert.ok(backend.providers()[0]!.models.length > 0);
  });

  it("何度描いても聞き直さない（画面を開くたびに問い合わせない）", async () => {
    let asked = 0;
    const backend = createClaudeBackend({
      ask: async () => {
        asked++;
        return [{ id: "opus[1m]" }];
      },
    });
    for (let i = 0; i < 5; i++) {
      backend.providers();
      await new Promise((r) => setImmediate(r));
    }
    assert.equal(asked, 1);
  });
});

describe("[決定98d] 名乗りをそのまま画面の選択肢にする", () => {
  it("pi は採用しているモデルをプロバイダごとにまとめる", () => {
    const option = toBackendOption(
      piBackend({
        adopted: [
          { provider: "opencode-go", id: "a" },
          { provider: "opencode-go", id: "b" },
          { provider: "huihui", id: "c" },
        ],
      })
    );
    assert.equal(option.id, "pi");
    assert.deepEqual(
      option.providers.map((p) => [p.id, p.models.map((m) => m.id)]),
      [
        ["opencode-go", ["a", "b"]],
        ["huihui", ["c"]],
      ]
    );
  });
});

/**
 * **代打のモデルの値を、番頭の標準の値として名乗らない。**
 *
 * `LlmCatalog.resolveHostDefault()` は、標準を pi の登録で解けないとき pi 側の
 * 別モデルへ落ちる（Claude Code のモデルは登録に載らないので必ず落ちる）。
 * 実測 2026-08-14：番頭は `opus` で動いているのに `/api/model` が
 * `{"id":"opus","vision":false,"contextWindow":128000}` を返していた——128000 は
 * 代打（`huihui/deepseek-v4-flash-abliterated`）に pi が付けた既定値で、
 * 本物の `opus` は 1,000,000 だった。名前は標準、中身は無関係なモデル。
 */
describe("番頭の標準モデルの能力（/api/model）", () => {
  /** 代打はいつも同じ形で返る（標準が何であれ、pi 側の別モデル）。 */
  const standIn = {
    provider: "huihui",
    id: "deepseek-v4-flash-abliterated",
    vision: false,
    contextWindow: 128_000,
  };

  it("backend が claude-agent-sdk のとき、代打の文脈長（128000）を名乗らない", () => {
    const info = hostModelInfo({
      steward: { backend: "claude-agent-sdk", provider: "anthropic", model: "opus" },
      resolved: standIn,
      // Claude Code のモデルは pi の登録に載らない
      resolveExact: () => undefined,
    });
    assert.equal(info.id, "opus");
    assert.equal(info.contextWindow, undefined);
    assert.ok(!("contextWindow" in info), "分からない文脈長は欄ごと落とす（数で埋めない）");
    // vision は代打から借りる値ではなく、harness が画像を渡せるという**こちら側の事実**
    assert.equal(info.vision, true);
  });

  // opus 固有でないことの回帰確認——このバックエンドで動く3モデルすべてに等しく効く
  for (const model of ["sonnet", "haiku"]) {
    it(`backend が claude-agent-sdk のとき、${model} でも代打の文脈長（128000）を名乗らない`, () => {
      const info = hostModelInfo({
        steward: { backend: "claude-agent-sdk", provider: "anthropic", model },
        resolved: standIn,
        resolveExact: () => undefined,
      });
      assert.equal(info.id, model);
      assert.ok(!("contextWindow" in info), "分からない文脈長は欄ごと落とす（数で埋めない）");
      assert.equal(info.vision, true);
    });
  }

  /**
   * **代打の能力値を借りない。**
   *
   * もとは claude-agent-sdk で書かれていて「代打が `vision: true` でも false を返す」を
   * 見ていた。画像を実際に渡せるようになった今、そのバックエンドの答えは true になる
   * ——が、それは**代打から借りたのではなくこちら側の事実**なので、借りない性質は
   * 別の場所で見張る必要がある。pi の代打なら渡せる保証がこちらに無いので、
   * 代打が何を名乗っていようと false のまま。ここが本来の見張り所。
   */
  it("pi の代打が vision を持っていても、それを標準の能力として名乗らない", () => {
    const info = hostModelInfo({
      steward: { backend: "pi", provider: "opencode-go", model: "消えたモデル" },
      resolved: { ...standIn, vision: true },
      resolveExact: () => undefined,
    });
    assert.equal(info.vision, false, "代打の vision を標準の能力として借りてこない");
    assert.equal(info.contextWindow, undefined);
  });

  it("pi でも、標準そのものを解けていなければ代打の値を名乗らない", () => {
    const info = hostModelInfo({
      // 登録から外れた（あるいは綴りが変わった）標準
      steward: { backend: "pi", provider: "opencode-go", model: "消えたモデル" },
      resolved: standIn,
      resolveExact: () => undefined,
    });
    assert.equal(info.id, "消えたモデル");
    assert.equal(info.contextWindow, undefined);
    assert.equal(info.vision, false);
  });

  /**
   * PO報告（2026-08-15）：「Claude Code のモデルが画像非対応扱いになっている」。
   * 直したのは名乗りだけではない——harness が画像を SDK へ渡すようになったうえでの true。
   * **文脈長は相変わらず名乗らない**（そちらは今も分からない）。この2つを一度に見る。
   */
  it("claude-agent-sdk では vision を名乗り、contextWindow は名乗らない", () => {
    const info = hostModelInfo({
      steward: { backend: "claude-agent-sdk", provider: "anthropic", model: "opus" },
      resolved: { ...standIn, vision: false, contextWindow: 128_000 },
      resolveExact: () => undefined,
    });
    assert.deepEqual(info, { id: "opus", backend: "claude-agent-sdk", vision: true });
  });

  it("pi で標準そのものを解けたときは、その能力をそのまま出す", () => {
    const resolved = {
      provider: "opencode-go",
      id: "deepseek-v4-flash",
      vision: true,
      contextWindow: 200_000,
    };
    const info = hostModelInfo({
      steward: { backend: "pi", provider: "opencode-go", model: "deepseek-v4-flash" },
      resolved,
      resolveExact: (provider, model) => ({ provider, id: model }),
    });
    assert.deepEqual(info, {
      id: "deepseek-v4-flash",
      backend: "pi",
      vision: true,
      contextWindow: 200_000,
    });
  });

  it("backend 未指定は pi として扱う（既定の綴りが落ちても壊れない）", () => {
    const info = hostModelInfo({
      steward: { provider: "opencode-go", model: "deepseek-v4-flash" },
      resolved: { provider: "opencode-go", id: "deepseek-v4-flash", vision: false },
      resolveExact: (provider, model) => ({ provider, id: model }),
    });
    assert.equal(info.id, "deepseek-v4-flash");
    assert.equal(info.backend, "pi");
    assert.equal(info.contextWindow, undefined);
  });

  /**
   * **どのバックエンドの標準かも名乗る**（PO報告 2026-08-20）。
   *
   * 会話がまだ自分のモデルを持たないとき、画面はこの標準をそのまま映す
   * （`BantoHostServer.hostDefaultModel`）。バックエンドが抜けていると、Claude Code で
   * 動いている会話が画面では「どちらか分からない」ものとして出て、思考レベルの選択肢
   * （pi のレベル／Claude の config）まで取り違える。実測では 211 本のうち 3 本が
   * この経路で backend 無しになっていた。
   */
  it("標準を解けても解けなくても、バックエンドは必ず名乗る", () => {
    const unresolved = hostModelInfo({
      steward: { backend: "pi", provider: "opencode-go", model: "消えたモデル" },
      resolved: standIn,
      resolveExact: () => undefined,
    });
    assert.equal(unresolved.backend, "pi", "代打へ落ちても、どの経路の標準かは変わらない");
  });

  it("何も解決できなかったときも、名前だけは標準のまま返す", () => {
    const info = hostModelInfo({
      steward: { backend: "claude-agent-sdk", provider: "anthropic", model: "opus" },
      resolved: undefined,
      resolveExact: () => undefined,
    });
    // 名前は標準のまま、文脈長は伏せ、vision はバックエンドの事実として true
    assert.deepEqual(info, { id: "opus", backend: "claude-agent-sdk", vision: true });
  });
});
