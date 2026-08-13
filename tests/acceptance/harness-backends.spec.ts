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

  it("聞けたら、その答えに入れ替わる", async () => {
    const backend = createClaudeBackend({
      ask: async () => [
        { id: "default", name: "Default (recommended)" },
        { id: "opus[1m]", name: "Opus (1M context)" },
      ],
    });
    backend.providers(); // 裏で聞き始める
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(
      backend.providers()[0]!.models.map((m) => m.id),
      ["default", "opus[1m]"],
      "手書きの表は既に古かった（実機で確認）"
    );
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
