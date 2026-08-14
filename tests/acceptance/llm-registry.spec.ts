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

import {
  LlmCatalog,
  workerRoleOf,
  type LlmModelResolver,
  type ResolvedModel,
} from "@banto/core";
import { contextWindowFromCatalog } from "@banto/host";

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
  /**
   * ハーネスが組み込みで知っている定義（models.json には出さない）。
   * 鍵だけがあるプロバイダ（opencode 等）の再現に使う。
   */
  builtin?: Array<{ id: string; input?: string[]; baseUrl?: string; api?: string }>;
}

let dir: string;

function seed(providers: Record<string, SeedProvider>): LlmCatalog {
  const modelsJson = {
    providers: Object.fromEntries(
      Object.entries(providers)
        // 組み込み定義しか無いプロバイダは models.json に載っていない
        .filter(([, p]) => !p.builtin)
        .map(([id, p]) => [id, { name: id, baseUrl: p.baseUrl ?? "", models: p.models ?? [] }])
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
      // pi は主要プロバイダの到達先とモデルを内蔵している。その再現
      const builtin = providers[provider]?.builtin;
      if (builtin) return builtin;
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
    c.setRole(workerRoleOf(c.getTier("cloud", "mid")), "cloud", "mid");

    const r = c.resolveForWorker("standard");
    assert.equal(r?.model.id, "mid");
    assert.equal(r?.tier, "standard");
    assert.equal(r?.usedFallbackTier, false);
    assert.equal(r?.droppedPick, false);
  });

  it("第一候補が制約で落ちたら、同じ tier の次の候補に降りる", () => {
    const c = standardSeed();
    // 高速の第一候補はクラウドの small。ローカル限定を付けると local/tiny に降りるはず
    c.setRole(workerRoleOf(c.getTier("cloud", "small")), "cloud", "small");

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

  /**
   * **等級は落ちない**（ADR-0021 決定104・PO裁定 2026-08-13）。
   *
   * 以前は隣の等級へ落ちていた。並びが `["reasoning","standard","fast"]` なので、
   * **`fast` を要求して候補が無いと次に `reasoning`**——安いつもりが一番高いモデルに
   * 落ちる。記録（`usedFallbackTier`）は残るが誰も見ていない。**知らせて人に設定させる。**
   */
  it("制約を満たせないなら解決しない（等級を落として埋めない）", () => {
    const c = standardSeed();
    // 通常にローカルのモデルは無い。**高速のローカルへ勝手に落ちない**
    assert.equal(c.resolveForWorker("standard", { local: true }), undefined);
  });

  it("要求した等級に候補が無ければ解決しない", () => {
    const c = seed({
      cloud: { auth: true, models: [{ id: "only", input: ["text"] }] },
    });
    c.setTier("cloud", "only", "fast");

    assert.equal(
      c.resolveForWorker("reasoning"),
      undefined,
      "**安いつもりが一番高いモデルに落ちる**のを止める（決定104）"
    );
    // 要求どおりの等級なら解決する
    assert.equal(c.resolveForWorker("fast")?.model.id, "only");
  });

  it("職人が使えないモデルは候補に入らない", () => {
    const c = standardSeed();
    // 第一候補を決めていないので、高速では cloud/small が先に来る
    assert.equal(c.resolveForWorker("fast")?.model.id, "small");

    c.setPolicy("cloud", "small", "worker", false);
    assert.equal(c.resolveForWorker("fast")?.model.id, "tiny");
  });

  it("鍵が要らないプロバイダのモデルは、既定で無料として扱う", () => {
    const c = standardSeed();
    const r = c.resolveForWorker("fast", { free: true });
    assert.equal(r?.model.provider, "local", "auth.json に鍵が無いので無料扱い");
  });

  it("番頭は tier を通らず、自分の既定モデルを使う", () => {
    const c = standardSeed();
    c.setRole("steward", "cloud", "big");
    assert.equal(c.resolveHostDefault()?.id, "big");
  });
});

/**
 * **文脈長を手で入れられる**（PO要望 2026-08-11）。
 *
 * プロバイダの `/models` は文脈長を返さないことがある（huihui の
 * `deepseek-v4-flash-abliterated` は 1M あるのに分からない）。分からないままだと
 * 章立ての閾値も文脈の目盛りも効かず、**実際より短いものとして**進む。
 */
describe("[PO要望 2026-08-11] 文脈長が分からないモデルに、手で入れる", () => {
  it("入れた値が一覧に出る（分からないままにしない）", () => {
    const c = standardSeed();
    assert.equal(
      c.models().find((m) => m.id === "small")?.contextWindow,
      undefined,
      "この検体は文脈長を持たない（前提）"
    );

    c.setContextWindow("cloud", "small", 1_000_000);
    assert.equal(c.models().find((m) => m.id === "small")?.contextWindow, 1_000_000);
  });

  it("**手で入れた値が優先**（あとからプロバイダが返してきても上書きしない）", () => {
    const c = standardSeed();
    c.setContextWindow("cloud", "small", 1_000_000);
    // プロバイダが「実は 8192 でした」と言ってくる
    c.mergeModels("cloud", [
      { id: "big" },
      { id: "mid" },
      { id: "small", contextWindow: 8192 },
    ]);
    assert.equal(
      c.models().find((m) => m.id === "small")?.contextWindow,
      1_000_000,
      "人が入れた意図を、取得のたびに上書きしてはいけない"
    );
  });

  it("空にすると手入力を取り消し、プロバイダが言う値に戻る", () => {
    const c = standardSeed();
    c.mergeModels("cloud", [{ id: "small", contextWindow: 8192 }]);
    c.setContextWindow("cloud", "small", 1_000_000);
    assert.equal(c.models().find((m) => m.id === "small")?.contextWindow, 1_000_000);

    c.setContextWindow("cloud", "small", undefined);
    assert.equal(c.models().find((m) => m.id === "small")?.contextWindow, 8192);
  });

  it("打ち間違いは受けない（I2）", () => {
    const c = standardSeed();
    // 1M のつもりで 1000 と入れても動きはするが、会話が数往復で畳まれるようになる
    assert.throws(() => c.setContextWindow("cloud", "small", 0), /文脈長は/u);
    assert.throws(() => c.setContextWindow("cloud", "small", -1), /文脈長は/u);
    assert.throws(() => c.setContextWindow("cloud", "small", 1.5), /整数/u);
    assert.throws(() => c.setContextWindow("cloud", "small", 10 ** 12), /文脈長は/u);
    assert.equal(c.models().find((m) => m.id === "small")?.contextWindow, undefined);
  });

  it("保存され、読み直しても残る", () => {
    const c = standardSeed();
    c.setContextWindow("cloud", "small", 200_000);
    const reopened = new LlmCatalog({
      authJsonPath: path.join(dir, "auth.json"),
      modelsJsonPath: path.join(dir, "models.json"),
      overlayPath: path.join(dir, "llm-registry.json"),
      resolver: { find: () => undefined, getKnownModels: () => undefined },
    });
    assert.equal(reopened.models().find((m) => m.id === "small")?.contextWindow, 200_000);
  });
});

describe("LLM Registry — 解決先を失う操作は止める", () => {
  it("役割に割り当てたモデルは、その役割の採用から外せない", () => {
    const c = standardSeed();
    c.setRole("steward", "cloud", "big");
    assert.throws(() => c.setPolicy("cloud", "big", "host", false), /steward/);
  });

  it("職人の役割に割り当てたモデルも外せない", () => {
    const c = standardSeed();
    c.setRole("worker.standard", "cloud", "mid");
    assert.throws(() => c.setPolicy("cloud", "mid", "worker", false), /worker\.standard/);
  });

  /**
   * **等級は束縛ではなくなった**（ADR-0020 決定94）。
   *
   * 以前は「第一候補のまま等級を移せない」という番人が居た——`picks`（等級→モデル）が
   * `tiers`（モデル→等級）の逆写像で、片方を動かすともう片方が壊れたため。
   * 束縛を `roles` 1つにしたので、**等級はいつでも動かせて、割り当ては動かない**。
   */
  it("割り当てたモデルの等級は、いつでも動かせる（逆写像が消えたので）", () => {
    const c = standardSeed();
    c.setRole("worker.standard", "cloud", "mid");

    c.setTier("cloud", "mid", "fast");

    assert.equal(c.getTier("cloud", "mid"), "fast", "等級は動く");
    assert.deepEqual(
      c.roles()["worker.standard"],
      { provider: "cloud", model: "mid" },
      "**割り当ては等級と無関係に残る**——ここが1つの表にした利得"
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

  it("旧形式（職人の既定が具体モデル）は、役割へ移る", () => {
    // 先に旧形式のオーバーレイを置いてから読ませる
    fs.writeFileSync(
      path.join(dir, "llm-registry.json"),
      JSON.stringify({
        tiers: { cloud: { mid: "standard" } },
        defaults: { worker: { provider: "cloud", model: "mid" } },
      })
    );
    const c = seed({ cloud: { auth: true, models: [{ id: "mid" }] } });

    // ADR-0020 決定94: 旧形式は `roles` へ移る（束縛の表は1つ）
    assert.deepEqual(c.roles()["worker.standard"], { provider: "cloud", model: "mid" });

    const saved = JSON.parse(fs.readFileSync(path.join(dir, "llm-registry.json"), "utf-8"));
    // **同じ問いに2箇所が答える状態を残さない**（D3）。空になった旧欄ごと落とす
    assert.equal(saved.defaults, undefined, "旧形式は残さない");
    assert.equal(saved.picks, undefined, "第一候補の表も残さない");
  });
});

/**
 * 画面からプロバイダ・キー・モデルを足せるようにするための書き込み（PO要望 2026-08-04）。
 *
 * ここまで pi の設定ファイルは**読むだけ**だった。書くようになったので、
 * (a) 手で入れた設定を壊さない、(b) キーを読み出せる口を作らない、
 * (c) 消えたモデルを黙って消さない、の3つを守る。
 */
describe("プロバイダ・キー・モデルの編集", () => {
  it("プロバイダを足せる。既にあるものは上書きしない（手入れした設定を壊さない）", () => {
    const c = seed({ cloud: { auth: true, models: [{ id: "mid" }] } });

    c.addProvider({ id: "新規", baseUrl: "http://例.invalid/v1" });
    c.reload();

    const added = c.providers().find((p) => p.id === "新規");
    assert.ok(added, "足したプロバイダが一覧に出る");
    assert.equal(added.baseUrl, "http://例.invalid/v1");
    assert.equal(added.modelCount, 0, "モデルはまだ無い（取り込みは別の操作）");

    assert.throws(() => c.addProvider({ id: "cloud", baseUrl: "http://別.invalid" }), /既にあります/);
    const kept = JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf-8"));
    assert.equal(kept.providers.cloud.models.length, 1, "既存のモデル定義は残る");
  });

  it("キーを入れ直せて、消せる。ファイルは本人しか読めないまま", () => {
    const c = seed({ cloud: { models: [{ id: "mid" }] } });
    assert.equal(c.providers().find((p) => p.id === "cloud")?.hasAuth, false);

    c.setKey("cloud", "sk-新しい鍵");
    c.reload();
    assert.equal(c.providers().find((p) => p.id === "cloud")?.hasAuth, true);
    // 0600（本人だけ読み書き）
    assert.equal(fs.statSync(path.join(dir, "auth.json")).mode & 0o777, 0o600);

    // 一覧にキーの値は出ない（名前と状態だけ）
    assert.equal(JSON.stringify(c.catalog()).includes("sk-新しい鍵"), false, "キーの値は外へ出さない");

    c.removeKey("cloud");
    c.reload();
    assert.equal(c.providers().find((p) => p.id === "cloud")?.hasAuth, false);
  });

  it("キーは末尾だけを手がかりに出す（値そのものは出さない）", () => {
    const c = seed({ cloud: { models: [{ id: "mid" }] } });
    c.setKey("cloud", "sk-very-secret-f3a2");
    c.reload();

    const key = c.providers().find((p) => p.id === "cloud")?.keys[0];
    assert.equal(key?.hint, "…f3a2", "どの鍵が入っているかが分かる最小限");
    // 値は決して出さない
    assert.equal(JSON.stringify(c.catalog()).includes("sk-very-secret"), false);
  });

  it("キーの状態は確かめるまで未確認のまま。確かめた時刻も持つ", () => {
    const c = seed({ cloud: { auth: true, models: [{ id: "mid" }] } });
    assert.equal(c.providers().find((p) => p.id === "cloud")?.keys[0]?.state, "untested");

    c.markKeyOk("cloud", "cloud");
    const ok = c.providers().find((p) => p.id === "cloud")?.keys[0];
    assert.equal(ok?.state, "ok");
    assert.ok(ok?.checkedAt, "いつ確かめたかを持つ");

    // 受け付けられなかった鍵は、そうと分かる形で残る（黙って候補に残さない）
    c.markKeyInvalid("cloud", "cloud");
    assert.equal(c.providers().find((p) => p.id === "cloud")?.keys[0]?.state, "invalid");
  });

  it("プロバイダを消すと、キーと設定も一緒に消える", () => {
    const c = seed({ cloud: { auth: true, models: [{ id: "mid" }] } });
    c.setProviderLocal("cloud", true);
    c.setTier("cloud", "mid", "fast");

    c.removeProvider("cloud");
    c.reload();

    assert.equal(c.providers().find((p) => p.id === "cloud"), undefined);
    const auth = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf-8"));
    assert.equal(auth.cloud, undefined, "鍵も残さない（同名で足し直したとき蘇らない）");
    const overlay = JSON.parse(fs.readFileSync(path.join(dir, "llm-registry.json"), "utf-8"));
    assert.equal(overlay.providers?.cloud, undefined);
  });

  it("取り込んだモデルは足すだけ。既存の設定は据え置き、消えたものは消す", () => {
    const c = seed({ cloud: { auth: true, models: [{ id: "mid", input: ["text", "image"] }] } });

    const result = c.mergeModels("cloud", [
      { id: "新モデル", contextWindow: 128000, maxTokens: 4096 },
      { id: "mid" },
    ]);
    c.reload();

    assert.deepEqual(result.added, ["新モデル"]);
    assert.deepEqual(result.removed, [], "取得結果に含まれているものは消さない");

    const models = c.models().filter((m) => m.providerId === "cloud");
    assert.equal(models.length, 2);
    // 手で入れた画像可の設定が消えていない
    assert.equal(models.find((m) => m.id === "mid")?.vision, true);
    // 取得では画像可否が分からないので、名乗らない（I1）
    assert.equal(models.find((m) => m.id === "新モデル")?.vision, false);

    // プロバイダ側から消えたものは、こちらからも消す（残しても選べば必ず失敗する）
    const second = c.mergeModels("cloud", [{ id: "新モデル" }]);
    assert.deepEqual(second.removed, ["mid"]);
    const left = c.models().filter((m) => m.providerId === "cloud");
    assert.deepEqual(left.map((m) => m.id), ["新モデル"]);
  });

  it("消えたモデルを指していた既定は、警告を返しつつ選び直される", () => {
    const c = seed({
      cloud: { auth: true, models: [{ id: "消える" }, { id: "残る" }] },
    });
    c.setTier("cloud", "消える", "standard");
    c.setTier("cloud", "残る", "standard");
    c.setRole("steward", "cloud", "消える");
    c.setRole(workerRoleOf(c.getTier("cloud", "消える")), "cloud", "消える");

    c.mergeModels("cloud", [{ id: "残る" }]);
    c.reload();
    const changes = c.repairDefaults();
    c.reload();

    // 何をどう変えたかを返す（黙って別のモデルに変えない）
    assert.equal(changes.length, 2, `got: ${JSON.stringify(changes)}`);
    assert.ok(changes.every((x) => x.from === "cloud/消える" && x.to === "cloud/残る"));
    assert.deepEqual(c.defaults().host, { backend: "pi", provider: "cloud", model: "残る" },
      "**付け替えでも経路を明示する**（決定103：backend を落とす経路を作らない）");
    assert.deepEqual(c.tiers().find((t) => t.tier === "standard")?.pick, {
      backend: "pi",
      provider: "cloud",
      model: "残る",
    });
  });

  it("採用しているものが無ければ、採用していないものを採用してでも付け替える", () => {
    const c = seed({ cloud: { auth: true, models: [{ id: "唯一" }] } });
    c.setRole("steward", "cloud", "唯一");

    // 新しく来た「別物」は採用されていない（既定は false）
    c.mergeModels("cloud", [{ id: "別物" }]);
    c.reload();
    assert.equal(c.models().find((m) => m.id === "別物")?.policy.includes("host"), false);

    // それでも番頭が動かないよりましなので、採用した上で付け替える
    const changes = c.repairDefaults();
    c.reload();
    assert.deepEqual(changes, [{ role: "番頭の標準", from: "cloud/唯一", to: "cloud/別物" }]);
    assert.deepEqual(c.defaults().host, { backend: "pi", provider: "cloud", model: "別物" });
    assert.equal(c.models().find((m) => m.id === "別物")?.policy.includes("host"), true, "選んだものは採用済みにする");
  });

  it("新しく取り込んだモデルは採用されない（選択肢が勝手に増えない）", () => {
    const c = seed({ cloud: { auth: true, models: [{ id: "はじめから" }] } });
    // 既存のものは移行で採用済み
    assert.equal(c.models().find((m) => m.id === "はじめから")?.policy.includes("host"), true);

    c.mergeModels("cloud", [{ id: "はじめから" }, { id: "あとから" }]);
    c.reload();
    assert.equal(c.models().find((m) => m.id === "あとから")?.policy.includes("host"), false);
    assert.equal(c.models().find((m) => m.id === "はじめから")?.policy.includes("host"), true);
  });

  it("欠けている能力（画像可否・文脈長）は後から埋まる", () => {
    const c = seed({ cloud: { auth: true, models: [{ id: "mid" }] } });
    // 1回目：到達先からは ID しか分からない（能力は空のまま）
    c.mergeModels("cloud", [{ id: "mid" }, { id: "new" }]);
    c.reload();
    assert.equal(c.models().find((m) => m.id === "new")?.contextWindow, undefined);

    // 2回目：組み込み定義から補完する（信頼できる出どころなので既存も直す）
    c.mergeModels(
      "cloud",
      [
        { id: "mid", input: ["text", "image"], contextWindow: 200000 },
        { id: "new", input: ["text"], contextWindow: 32000 },
      ],
      undefined,
      true
    );
    c.reload();

    const models = c.models();
    assert.equal(models.find((m) => m.id === "mid")?.contextWindow, 200000);
    assert.equal(models.find((m) => m.id === "mid")?.vision, true, "text だけと記録していたものを直せる");
    assert.equal(models.find((m) => m.id === "new")?.contextWindow, 32000);
  });

  it("信頼できない出どころは、埋まっているところを壊さない", () => {
    const c = seed({ cloud: { auth: true, models: [{ id: "mid", input: ["text", "image"] }] } });
    c.mergeModels("cloud", [{ id: "mid", input: ["text"] }]);
    c.reload();
    assert.equal(c.models().find((m) => m.id === "mid")?.vision, true, "手で入れた画像可を消さない");
  });

  it("壊れた models.json を黙って上書きしない（手で書いた設定を消さない）", () => {
    const c = seed({ cloud: { models: [{ id: "mid" }] } });
    fs.writeFileSync(path.join(dir, "models.json"), "{壊れている");

    assert.throws(() => c.addProvider({ id: "新規", baseUrl: "http://例.invalid" }), /壊れた JSON/);
    assert.equal(fs.readFileSync(path.join(dir, "models.json"), "utf-8"), "{壊れている");
  });
});

/**
 * 鍵だけがあるプロバイダ（opencode 等）。**pi は到達先とモデルを内蔵している**ので、
 * models.json に何も無くてもモデルを取り込める——ここを塞ぐと、画面では
 * 「キー 1・モデル 0」のまま取り込みボタンが押せず、理由も分からない（実際にそうなっていた）。
 */
describe("鍵だけがあるプロバイダ（到達先は pi が知っている）", () => {
  function seedBuiltinOnly(): LlmCatalog {
    const c = seed({
      cloud: { baseUrl: "https://example.invalid", auth: true, models: [{ id: "mid" }] },
      zen: {
        auth: true,
        builtin: [
          { id: "zen-big", input: ["text", "image"], baseUrl: "https://zen.invalid/v1", api: "openai-completions" },
          { id: "zen-small", input: ["text"], baseUrl: "https://zen.invalid/v1" },
        ],
      },
    });
    return c;
  }

  it("到達先が無くても、組み込みの定義があるなら取り込める", () => {
    const c = seedBuiltinOnly();
    const zen = c.providers().find((p) => p.id === "zen");
    assert.ok(zen);
    assert.equal(zen.baseUrl, "", "models.json には居ない");
    assert.equal(zen.modelCount, 0);
    assert.equal(zen.canFetchModels, true, "組み込み定義があるので取り込める");

    const known = c.knownModels("zen");
    const result = c.mergeModels(
      "zen",
      known.map((m) => ({ id: m.id, ...(m.input ? { input: m.input } : {}) })),
      { baseUrl: known[0]?.baseUrl, api: known[0]?.api }
    );
    c.reload();

    assert.deepEqual(result.added.sort(), ["zen-big", "zen-small"]);
    const models = c.models().filter((m) => m.providerId === "zen");
    assert.equal(models.length, 2);
    // 組み込み定義は画像可否まで分かっているので、text と偽らない
    assert.equal(models.find((m) => m.id === "zen-big")?.vision, true);
    assert.equal(models.find((m) => m.id === "zen-small")?.vision, false);
    // 取り込みのときに到達先も一緒に登録される
    assert.equal(c.providers().find((p) => p.id === "zen")?.baseUrl, "https://zen.invalid/v1");
  });

  it("到達先も組み込み定義も無いなら、取り込めないと名乗る", () => {
    const c = seed({ 謎: { auth: true } });
    assert.equal(c.providers().find((p) => p.id === "謎")?.canFetchModels, false);
  });
});

/**
 * 数百のモデルを持つプロバイダ（OpenRouter は337件）でも成り立つか。
 *
 * **列挙ではなく採用と検索**に変えたのが要点（ADR-0011 決定47）。
 */
describe("数百のモデルがあるプロバイダ", () => {
  function bigSeed(): LlmCatalog {
    const models = Array.from({ length: 337 }, (_, i) => ({
      id: `model-${String(i).padStart(3, "0")}`,
      input: i % 3 === 0 ? ["text", "image"] : ["text"],
    }));
    return seed({ big: { auth: true, baseUrl: "https://big.invalid/v1", models } });
  }

  it("移行では全部採用済みになる（いま使えているものを取り上げない）", () => {
    const c = bigSeed();
    assert.equal(c.models().filter((m) => m.policy.includes("host")).length, 337);
  });

  it("移行後に増えたモデルは採用されない（選択肢が勝手に337件にならない）", () => {
    const c = seed({ big: { auth: true, models: [{ id: "はじめ" }] } });
    const many = Array.from({ length: 300 }, (_, i) => ({ id: `新-${i}` }));
    c.mergeModels("big", [{ id: "はじめ" }, ...many]);
    c.reload();

    assert.equal(c.models().length, 301, "台帳には全部載る");
    assert.deepEqual(
      c.models().filter((m) => m.policy.includes("host")).map((m) => m.id),
      ["はじめ"],
      "選べるのは採用したものだけ"
    );
  });

  it("職人の解決も採用したものからしか選ばない", () => {
    const c = seed({ big: { auth: true, models: [{ id: "採用" }, { id: "未採用" }] } });
    // 「未採用」を落とし、「採用」だけ残す
    c.setPolicy("big", "未採用", "worker", false);
    c.setPolicy("big", "未採用", "host", false);
    const r = c.resolveForWorker("standard", {});
    assert.equal(r?.model.id, "採用");
  });
});

/**
 * 公開台帳（models.dev）からの文脈長の引き当て。
 *
 * 文脈長が空のままだと pi は 0 として扱い、`shouldCompact` が常に真になって
 * **毎ターン自動要約が走る**（実測で確認）。推測値を置くのではなく、公開されている
 * 実際の値を引く——ここはその引き当ての規則だけを見る（通信はしない）。
 */
describe("公開台帳からの文脈長の引き当て", () => {
  const catalog = {
    opencode: { models: { "claude-opus-5": { limit: { context: 1000000, output: 128000 } } } },
    anthropic: { models: { "claude-opus-5": { limit: { context: 200000, output: 64000 } } } },
    other: { models: { "solo-model": { limit: { context: 32000 } } } },
  };

  it("同じプロバイダのものを先に採る", () => {
    assert.deepEqual(contextWindowFromCatalog(catalog, "opencode", "claude-opus-5"), {
      context: 1000000,
      output: 128000,
    });
  });

  it("そのプロバイダに無ければ、同じ ID を横断で探す", () => {
    // 経路（opencode 経由等）が違っても同じモデルなら文脈長は引ける
    assert.equal(contextWindowFromCatalog(catalog, "知らないプロバイダ", "solo-model")?.context, 32000);
  });

  it("台帳が無い・載っていないなら undefined（推測しない）", () => {
    assert.equal(contextWindowFromCatalog(undefined, "opencode", "claude-opus-5"), undefined);
    assert.equal(contextWindowFromCatalog(catalog, "opencode", "知らないモデル"), undefined);
  });
});

/**
 * **概念を畳む**（ADR-0020 決定98・task-0102）。
 *
 * 決定94 は「概念を 7 → 5 に」と決めたが、畳めたのは束縛の表だけだった。残りの
 * `hostUsable`/`workerUsable` → `policy`、`LlmDefaults.workerTier` の撤去はここで固定する。
 */
describe("[決定98] 採用は policy 1つ", () => {
  it("旧い2つの欄（hostUsable / workerUsable）は読み込みで policy へ移る", () => {
    const c = standardSeed();
    // 実データと同じ形をオーバーレイへ直に書く（移行の前の姿）
    const overlayPath = path.join(dir, "llm-registry.json");
    const overlay = JSON.parse(fs.readFileSync(overlayPath, "utf-8")) as Record<string, unknown>;
    overlay["models"] = {
      cloud: {
        big: { hostUsable: true, workerUsable: true, contextWindow: 200000 },
        mid: { hostUsable: false, workerUsable: true },
        small: { hostUsable: false, workerUsable: false },
      },
    };
    fs.writeFileSync(overlayPath, JSON.stringify(overlay));
    c.reload();

    const models = c.models();
    assert.deepEqual(models.find((m) => m.id === "big")?.policy, ["host", "worker"]);
    assert.deepEqual(models.find((m) => m.id === "mid")?.policy, ["worker"]);
    assert.deepEqual(models.find((m) => m.id === "small")?.policy, []);
    // **古い欄は消す**——残すと、片方だけ書く経路が次に足されたときに食い違う
    const after = JSON.parse(fs.readFileSync(overlayPath, "utf-8")) as {
      models: Record<string, Record<string, Record<string, unknown>>>;
    };
    assert.equal(after.models["cloud"]!["big"]!["hostUsable"], undefined);
    assert.equal(after.models["cloud"]!["big"]!["workerUsable"], undefined);
    // 併記されていた他の欄は落とさない
    assert.equal(after.models["cloud"]!["big"]!["contextWindow"], 200000);
  });

  it("採用を外しても、もう一方の用途は残る（1つの集合で両方を持つ）", () => {
    const c = standardSeed();
    c.setPolicy("cloud", "mid", "host", true);
    c.setPolicy("cloud", "mid", "worker", true);
    c.setPolicy("cloud", "mid", "host", false);
    assert.deepEqual(c.models().find((m) => m.id === "mid")?.policy, ["worker"]);
  });

  it("既定は職人の等級を名乗らない（工房が持つものを二重に答えない）", () => {
    const c = standardSeed();
    assert.deepEqual(Object.keys(c.defaults()).filter((k) => k !== "host"), []);
  });
});
