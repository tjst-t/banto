/**
 * LLM Registry の受け入れ検証（ADR-0004 / spec §3.5）。
 *
 * 番頭は具体モデルを持ち、職人は tier で指定する。tier は難度の軸、制約
 * （vision / local / free）は候補を絞る条件で、互いに直交する。
 *
 * ここで守りたい性質は3つ。
 *   - **制約は決して緩めない**。満たせないなら解決せずに返す（I2）
 *   - 並び順と役割の許可は設定、キーの上限は実行時状態（D3）
 *   - 解決先を失う操作は止める（既定・第一候補を使用不可にできない）
 *
 * pi には接続しない。models.json / auth.json は一時ディレクトリに書いて読ませる。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { LlmCatalog, type LlmModelResolver, type ResolvedModel } from "@banto/core";

/** models.json の1モデル分。input に "image" があると vision 扱いになる。 */
interface SeedModel {
  id: string;
  input?: string[];
}

interface SeedProvider {
  baseUrl?: string;
  models?: SeedModel[];
  /** auth.json にこのプロバイダの鍵を書くか。無い＝無料扱いの既定になる */
  auth?: boolean;
}

let dir: string;

function seed(providers: Record<string, SeedProvider>): LlmCatalog {
  const modelsJson = {
    providers: Object.fromEntries(
      Object.entries(providers).map(([id, p]) => [
        id,
        { name: id, baseUrl: p.baseUrl ?? "", models: p.models ?? [] },
      ])
    ),
  };
  const authJson = Object.fromEntries(
    Object.entries(providers)
      .filter(([, p]) => p.auth)
      .map(([id]) => [id, { type: "api", key: "dummy" }])
  );
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify(modelsJson));
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify(authJson));

  // 実物の pi を呼ばずに、models.json に載っているものはそのまま解決できることにする
  const resolver: LlmModelResolver = {
    find(provider, modelId): ResolvedModel | undefined {
      const p = providers[provider];
      const m = p?.models?.find((x) => x.id === modelId);
      return m ? { provider, id: m.id, name: m.id, input: m.input ?? [] } : undefined;
    },
    getKnownModels(provider) {
      return providers[provider]?.models;
    },
  };

  return new LlmCatalog({
    authJsonPath: path.join(dir, "auth.json"),
    modelsJsonPath: path.join(dir, "models.json"),
    overlayPath: path.join(dir, "llm-registry.json"),
    resolver,
  });
}

/** 高精度/通常/高速に1つずつ、ローカルと無料も用意した標準の並び。 */
function standardSeed(): LlmCatalog {
  const c = seed({
    cloud: {
      baseUrl: "https://example.invalid",
      auth: true,
      models: [
        { id: "big", input: ["text", "image"] },
        { id: "mid", input: ["text", "image"] },
        { id: "small", input: ["text"] },
      ],
    },
    local: {
      baseUrl: "http://localhost:11434",
      models: [{ id: "tiny", input: ["text"] }],
    },
  });
  c.setTier("cloud", "big", "reasoning");
  c.setTier("cloud", "mid", "standard");
  c.setTier("cloud", "small", "fast");
  c.setTier("local", "tiny", "fast");
  c.setProviderLocal("local", true);
  return c;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-llm-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("LLM Registry — 職人への解決は (tier, 制約) で決まる", () => {
  it("tier だけ指定すれば、その tier の第一候補が返る", () => {
    const c = standardSeed();
    c.setPick("cloud", "mid");

    const r = c.resolveForWorker("standard");
    assert.equal(r?.model.id, "mid");
    assert.equal(r?.tier, "standard");
    assert.equal(r?.usedFallbackTier, false);
    assert.equal(r?.droppedPick, false);
  });

  it("第一候補が制約で落ちたら、同じ tier の次の候補に降りる", () => {
    const c = standardSeed();
    // 高速の第一候補はクラウドの small。ローカル限定を付けると local/tiny に降りるはず
    c.setPick("cloud", "small");

    const r = c.resolveForWorker("fast", { local: true });
    assert.equal(r?.model.provider, "local");
    assert.equal(r?.model.id, "tiny");
    assert.equal(r?.tier, "fast");
    assert.equal(r?.droppedPick, true, "第一候補が落ちたことが呼び出し側に分かる");
  });

  it("制約を満たせるモデルがどの tier にも無ければ、解決しない", () => {
    const c = standardSeed();
    // vision を持つローカルモデルはどの tier にも無い。tier を落としても満たせない
    assert.equal(c.resolveForWorker("fast", { local: true, vision: true }), undefined);
    assert.equal(c.resolveForWorker("reasoning", { local: true, vision: true }), undefined);
  });

  it("tier を落としてでも制約は守る。緩めるのは tier だけ", () => {
    const c = standardSeed();
    // 通常にローカルのモデルは無い。tier は高速へ落ちるが、ローカル限定は守られる
    const r = c.resolveForWorker("standard", { local: true });
    assert.equal(r?.model.provider, "local", "外に出るモデルを返してはいけない");
    assert.equal(r?.tier, "fast");
    assert.equal(r?.usedFallbackTier, true, "tier が落ちたことは呼び出し側に分かる");
  });

  it("tier は候補が無ければ隣に落ちるが、落ちたことを隠さない", () => {
    const c = seed({
      cloud: { auth: true, models: [{ id: "only", input: ["text"] }] },
    });
    c.setTier("cloud", "only", "fast");

    const r = c.resolveForWorker("reasoning");
    assert.equal(r?.model.id, "only");
    assert.equal(r?.requestedTier, "reasoning");
    assert.equal(r?.tier, "fast");
    assert.equal(r?.usedFallbackTier, true);
  });

  it("職人が使えないモデルは候補に入らない", () => {
    const c = standardSeed();
    // 第一候補を決めていないので、高速では cloud/small が先に来る
    assert.equal(c.resolveForWorker("fast")?.model.id, "small");

    c.setUsable("cloud", "small", "worker", false);
    assert.equal(c.resolveForWorker("fast")?.model.id, "tiny");
  });

  it("鍵が要らないプロバイダのモデルは、既定で無料として扱う", () => {
    const c = standardSeed();
    const r = c.resolveForWorker("fast", { free: true });
    assert.equal(r?.model.provider, "local", "auth.json に鍵が無いので無料扱い");
  });

  it("番頭は tier を通らず、自分の既定モデルを使う", () => {
    const c = standardSeed();
    c.setHostDefault("cloud", "big");
    assert.equal(c.resolveHostDefault()?.id, "big");
  });
});

describe("LLM Registry — 解決先を失う操作は止める", () => {
  it("番頭の既定モデルを番頭の使用可から外せない", () => {
    const c = standardSeed();
    c.setHostDefault("cloud", "big");
    assert.throws(() => c.setUsable("cloud", "big", "host", false), /既定モデル/);
  });

  it("tier の第一候補を職人の使用可から外せない", () => {
    const c = standardSeed();
    c.setPick("cloud", "mid");
    assert.throws(() => c.setUsable("cloud", "mid", "worker", false), /第一候補/);
  });

  it("第一候補のまま tier を移せない（元の tier の第一候補が居なくなるため）", () => {
    const c = standardSeed();
    c.setPick("cloud", "mid");
    assert.throws(() => c.setTier("cloud", "mid", "fast"), /第一候補/);

    // 空けるには「同じ tier の」別のモデルを第一候補にする必要がある
    c.setTier("cloud", "small", "standard");
    c.setPick("cloud", "small");
    c.setTier("cloud", "mid", "fast");
    assert.equal(c.getTier("cloud", "mid"), "fast");
    assert.deepEqual(
      c.tiers().find((t) => t.tier === "standard")?.pick,
      { provider: "cloud", model: "small" }
    );
  });
});

describe("LLM Registry — キーは上から順に消費する", () => {
  it("役割が許されていて上限に来ていない最初のキーを使う", () => {
    const c = seed({ cloud: { auth: true, models: [{ id: "m" }] } });

    const first = c.resolveKey("cloud", "worker");
    assert.equal(first?.name, "cloud");

    // 上限に当たったキーは、待ち時間のあいだ候補から外れる
    c.markKeyLimited("cloud", "cloud", new Date(Date.now() + 60_000));
    assert.equal(c.resolveKey("cloud", "worker"), undefined);

    // 復帰させれば戻る
    c.markKeyOk("cloud", "cloud");
    assert.equal(c.resolveKey("cloud", "worker")?.name, "cloud");
  });

  it("待ち時間が過ぎたキーは自動で候補に戻る", () => {
    const c = seed({ cloud: { auth: true, models: [{ id: "m" }] } });
    c.markKeyLimited("cloud", "cloud", new Date(Date.now() - 1_000));
    assert.equal(c.resolveKey("cloud", "worker")?.name, "cloud");
  });

  it("役割の許可を外したキーは、その役割からは見えない", () => {
    const c = seed({ cloud: { auth: true, models: [{ id: "m" }] } });
    // 最後の1本なので外せない
    assert.throws(() => c.setKeyScope("cloud", "cloud", "worker", false), /無くなります/);
  });

  it("キーの上限は設定に書き出さない（実行時状態なので）", () => {
    const c = seed({ cloud: { auth: true, models: [{ id: "m" }] } });
    c.markKeyLimited("cloud", "cloud", new Date(Date.now() + 60_000));
    const saved = fs.existsSync(path.join(dir, "llm-registry.json"))
      ? fs.readFileSync(path.join(dir, "llm-registry.json"), "utf-8")
      : "";
    assert.equal(saved.includes("limited"), false, "上限はファイルに残らない");
  });
});

describe("LLM Registry — pi の設定ファイル", () => {
  it("外部で書き換えられたら検知でき、読み直せば解消する", () => {
    const c = standardSeed();
    assert.equal(c.fileState().changed, false);

    // banto の外で models.json を書き換える
    const p = path.join(dir, "models.json");
    const json = JSON.parse(fs.readFileSync(p, "utf-8"));
    json.providers["cloud"].models.push({ id: "added", input: ["text"] });
    fs.writeFileSync(p, JSON.stringify(json));

    assert.equal(c.fileState().changed, true, "読み込み時のハッシュと違えば検知する");

    c.reload();
    assert.equal(c.fileState().changed, false);
    assert.ok(c.models().some((m) => m.id === "added"), "読み直した内容が反映される");
  });

  it("旧形式（職人の既定が具体モデル）は、既定 tier と第一候補へ移る", () => {
    // 先に旧形式のオーバーレイを置いてから読ませる
    fs.writeFileSync(
      path.join(dir, "llm-registry.json"),
      JSON.stringify({
        tiers: { cloud: { mid: "standard" } },
        defaults: { worker: { provider: "cloud", model: "mid" } },
      })
    );
    const c = seed({ cloud: { auth: true, models: [{ id: "mid" }] } });

    assert.equal(c.defaults().workerTier, "standard");
    assert.deepEqual(
      c.tiers().find((t) => t.tier === "standard")?.pick,
      { provider: "cloud", model: "mid" }
    );

    const saved = JSON.parse(fs.readFileSync(path.join(dir, "llm-registry.json"), "utf-8"));
    assert.equal(saved.defaults.worker, undefined, "旧形式は残さない");
  });
});
