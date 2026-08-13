/**
 * **役の台帳**（ADR-0021 決定101・task-0106）。
 *
 * ここで守りたい性質は4つ。
 *   - **版が合わなければ止まる**（決定101a）。番頭ホストと工房は別サービスで再起動が
 *     独立し、工房は走行中に読み直す——黙って別のモデルで走るのが一番困る
 *   - **役へ書くのは部分更新**（決定101c）。全置換が `backend` 落ちの原因だった
 *   - **読むだけの口からは書けない**（決定101d）
 *   - **移行で `backend` を落とさない**。`backend` の無い旧データは pi
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  LlmCatalog,
  ModelLedger,
  MODEL_LEDGER_SCHEMA_VERSION,
  type LlmModelResolver,
} from "@banto/core";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-ledger-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const ledgerPath = (): string => path.join(dir, "model-roles.json");

function ledger(readOnly = false): ModelLedger {
  return new ModelLedger({ path: ledgerPath(), ...(readOnly ? { readOnly: true } : {}) });
}

describe("[決定101a] 版が合わなければ止まる", () => {
  it("知らない版の台帳は読まずに投げる（黙って別のモデルで走らせない）", () => {
    fs.writeFileSync(ledgerPath(), JSON.stringify({ schemaVersion: 99, adopted: [], roles: {} }));
    assert.throws(() => ledger().roles(), /版が合いません/);
  });

  it("版が無い台帳も投げる（版印の前のファイルを読み分けない）", () => {
    fs.writeFileSync(ledgerPath(), JSON.stringify({ adopted: [], roles: {} }));
    assert.throws(() => ledger().roles(), /版が合いません/);
  });

  it("壊れた JSON は空から始めない（割り当てを失ったことに気づけない）", () => {
    fs.writeFileSync(ledgerPath(), "{ こわれている");
    assert.throws(() => ledger().roles(), /壊れた JSON/);
  });

  it("書いたものは同じ版で読み戻せる", () => {
    const l = ledger();
    l.updateRole("steward", { default: { backend: "claude-agent-sdk", provider: "claude", model: "opus" } });
    const saved = JSON.parse(fs.readFileSync(ledgerPath(), "utf-8")) as { schemaVersion: number };
    assert.equal(saved.schemaVersion, MODEL_LEDGER_SCHEMA_VERSION);
    assert.deepEqual(ledger().role("steward")?.default, {
      backend: "claude-agent-sdk",
      provider: "claude",
      model: "opus",
    });
  });
});

describe("[決定101c] 役へ書くのは部分更新（全置換にしない）", () => {
  it("既定を変えても、絞りと条件は残る", () => {
    const l = ledger();
    l.updateRole("worker.fast", {
      default: { backend: "pi", provider: "p", model: "a" },
      only: [{ backend: "pi", provider: "p", model: "a" }],
      constraints: { local: true },
    });
    l.updateRole("worker.fast", { default: { backend: "pi", provider: "p", model: "b" } });

    const after = ledger().role("worker.fast");
    assert.deepEqual(after?.default, { backend: "pi", provider: "p", model: "b" });
    assert.deepEqual(after?.only, [{ backend: "pi", provider: "p", model: "a" }], "絞りが消えない");
    assert.deepEqual(after?.constraints, { local: true }, "条件が消えない");
  });

  it("明示的に undefined を渡したときだけ落ちる", () => {
    const l = ledger();
    l.updateRole("steward", {
      default: { backend: "pi", provider: "p", model: "a" },
      constraints: { free: true },
    });
    l.updateRole("steward", { constraints: undefined });
    assert.equal(ledger().role("steward")?.constraints, undefined);
    assert.ok(ledger().role("steward")?.default, "既定は残る");
  });
});

describe("[決定101d] 読むだけの口からは書けない", () => {
  it("readOnly で開いた台帳への書き込みは投げる（黙って捨てない）", () => {
    ledger().updateRole("steward", { default: { backend: "pi", provider: "p", model: "a" } });
    const reader = ledger(true);
    assert.deepEqual(reader.role("steward")?.default, { backend: "pi", provider: "p", model: "a" });
    assert.throws(
      () => reader.updateRole("steward", { default: { backend: "pi", provider: "p", model: "b" } }),
      /読み取り専用/
    );
  });

  it("書き手の更新を読み直す（抱え込まない）", () => {
    const writer = ledger();
    const reader = ledger(true);
    writer.updateRole("steward", { default: { backend: "pi", provider: "p", model: "a" } });
    assert.equal(reader.role("steward")?.default?.model, "a");
    writer.updateRole("steward", { default: { backend: "pi", provider: "p", model: "b" } });
    assert.equal(reader.role("steward")?.default?.model, "b", "更新時刻で読み直す");
  });
});

describe("[決定101e] 母集団は1つ", () => {
  it("採用は冪等で、役に割り当てられているものは外せない", () => {
    const l = ledger();
    const ref = { backend: "pi", provider: "p", model: "a" };
    l.adopt(ref);
    l.adopt(ref);
    assert.equal(l.adopted().length, 1);

    l.updateRole("worker.standard", { default: ref });
    assert.throws(() => l.unadopt(ref), /割り当てられています/);

    l.clearRole("worker.standard");
    l.unadopt(ref);
    assert.deepEqual(l.adopted(), []);
  });
});

/** pi を呼ばない解決器（models.json に載っているものはそのまま解決できる）。 */
function seedCatalog(withLedger: boolean): LlmCatalog {
  fs.writeFileSync(
    path.join(dir, "models.json"),
    JSON.stringify({
      providers: {
        cloud: { name: "cloud", baseUrl: "https://x.invalid", models: [{ id: "big" }, { id: "small" }] },
      },
    })
  );
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ cloud: { type: "api", key: "x" } }));
  const resolver: LlmModelResolver = {
    find: (provider, id) =>
      provider === "cloud" && ["big", "small"].includes(id)
        ? { provider, id, name: id, input: ["text"] }
        : undefined,
    getKnownModels: () => undefined,
  };
  return new LlmCatalog({
    ...(withLedger ? { ledger: ledger() } : {}),
    authJsonPath: path.join(dir, "auth.json"),
    modelsJsonPath: path.join(dir, "models.json"),
    overlayPath: path.join(dir, "llm-registry.json"),
    resolver,
  });
}

describe("[決定101] 役を pi の台帳から核の台帳へ移す", () => {
  it("旧い roles は台帳へ移り、オーバーレイからは消える", () => {
    // 移行前の姿：役が llm-registry.json にある（backend 有りと無しの両方）
    fs.writeFileSync(
      path.join(dir, "llm-registry.json"),
      JSON.stringify({
        roles: {
          steward: { backend: "claude-agent-sdk", provider: "claude", model: "opus" },
          "worker.standard": { provider: "cloud", model: "big" },
        },
      })
    );
    const c = seedCatalog(true);
    const roles = c.roles();

    assert.deepEqual(roles.steward, {
      backend: "claude-agent-sdk",
      provider: "claude",
      model: "opus",
    });
    assert.deepEqual(
      roles["worker.standard"],
      { backend: "pi", provider: "cloud", model: "big" },
      "**backend の無い旧データは pi**（決定94）"
    );

    const overlay = JSON.parse(fs.readFileSync(path.join(dir, "llm-registry.json"), "utf-8")) as {
      roles?: unknown;
    };
    assert.equal(overlay.roles, undefined, "同じ問いに2箇所が答える状態を残さない");
    assert.ok(fs.existsSync(ledgerPath()), "役の台帳ができている");
  });

  it("台帳を使う設定でも、`setRole` は backend を落とさない", () => {
    const c = seedCatalog(true);
    c.setRole("steward", "claude", "opus", "claude-agent-sdk");
    assert.equal(c.roles().steward?.backend, "claude-agent-sdk");
    // 経路を明示しない呼び出しは pi（決定103）
    c.setRole("worker.fast", "cloud", "small");
    assert.equal(c.roles()["worker.fast"]?.backend, "pi");
  });

  it("台帳を渡さない呼び出し元は、従来どおりオーバーレイで動く", () => {
    const c = seedCatalog(false);
    c.setRole("steward", "cloud", "big");
    assert.equal(c.roles().steward?.provider, "cloud");
    const overlay = JSON.parse(fs.readFileSync(path.join(dir, "llm-registry.json"), "utf-8")) as {
      roles?: Record<string, unknown>;
    };
    assert.ok(overlay.roles?.["steward"], "台帳が無ければオーバーレイが持つ");
  });

  it("役の割り当ては、台帳越しでも職人の解決に効く（挙動が変わらない）", () => {
    const c = seedCatalog(true);
    c.setPolicy("cloud", "big", "worker", true);
    c.setPolicy("cloud", "small", "worker", true);
    c.setTier("cloud", "big", "standard");
    c.setTier("cloud", "small", "standard");
    c.setRole("worker.standard", "cloud", "small");
    const resolved = c.resolveForWorker("standard");
    assert.equal(resolved?.model.id, "small", "第一候補は roles が決める（台帳から引く）");
  });
});

/**
 * **入れ替えの窓**（決定101a の運用面）。
 *
 * 番頭ホストと工房は別サービスで再起動が独立する。**工房を先に上げる**ので、
 * 新しい版の工房が「まだ移行されていないファイル」に出会う窓が必ずできる。
 */
describe("[決定101a] 移行の前後どちらでも、工房は同じ答えを出す", () => {
  it("台帳がまだ無いときは、従来どおりオーバーレイの roles を読む", () => {
    fs.writeFileSync(
      path.join(dir, "llm-registry.json"),
      JSON.stringify({ roles: { steward: { provider: "cloud", model: "big" } } })
    );
    // 工房の開き方（読み取り専用・台帳はまだ無い）
    fs.writeFileSync(
      path.join(dir, "models.json"),
      JSON.stringify({ providers: { cloud: { name: "cloud", baseUrl: "", models: [{ id: "big" }] } } })
    );
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({}));
    const reader = new LlmCatalog({
      ledger: ledger(true),
      authJsonPath: path.join(dir, "auth.json"),
      modelsJsonPath: path.join(dir, "models.json"),
      overlayPath: path.join(dir, "llm-registry.json"),
      resolver: { find: () => undefined, getKnownModels: () => undefined },
    });
    assert.equal(
      reader.roles().steward?.provider,
      "cloud",
      "**空を返すと候補の先頭が黙って選ばれる**"
    );
    assert.equal(fs.existsSync(ledgerPath()), false, "読むだけの口は移行を走らせない");
  });

  it("書き手が移行した後は、工房は台帳を読む", () => {
    const writer = ledger();
    writer.updateRole("steward", { default: { backend: "pi", provider: "cloud", model: "big" } });
    const reader = ledger(true);
    assert.equal(reader.role("steward")?.default?.model, "big");
  });
});

describe("[決定101e] 採用は母集団1つ（台帳へ移す）", () => {
  it("旧い policy は母集団へ移り、オーバーレイからは消える", () => {
    fs.writeFileSync(
      path.join(dir, "llm-registry.json"),
      JSON.stringify({
        adoptionMigratedAt: "2026-08-04T00:00:00.000Z",
        models: {
          cloud: {
            big: { policy: ["host", "worker"], contextWindow: 200000 },
            small: { policy: ["host"] },
          },
        },
      })
    );
    const c = seedCatalog(true);
    const models = c.models();
    // **役ごとの区別は畳む**——母集団は1つ（画面に二度手間を出さない）
    assert.deepEqual(models.find((m) => m.id === "big")?.policy, ["host", "worker"]);
    assert.deepEqual(models.find((m) => m.id === "small")?.policy, ["host", "worker"]);

    const overlay = JSON.parse(fs.readFileSync(path.join(dir, "llm-registry.json"), "utf-8")) as {
      models: Record<string, Record<string, Record<string, unknown>>>;
    };
    assert.equal(overlay.models["cloud"]!["big"]!["policy"], undefined, "古い欄は消す");
    assert.equal(overlay.models["cloud"]!["big"]!["contextWindow"], 200000, "併記は落とさない");
    assert.equal(ledger().adopted().length, 2, "母集団に2件");
  });

  it("採用していないものは母集団に入らない", () => {
    fs.writeFileSync(
      path.join(dir, "llm-registry.json"),
      JSON.stringify({
        adoptionMigratedAt: "2026-08-04T00:00:00.000Z",
        models: { cloud: { big: { policy: [] }, small: { policy: ["worker"] } } },
      })
    );
    const c = seedCatalog(true);
    assert.deepEqual(c.models().find((m) => m.id === "big")?.policy, []);
    assert.deepEqual(
      ledger().adopted().map((r) => r.model),
      ["small"]
    );
  });

  /**
   * **症状1が消えたか**（ADR-0021・task-0107 の a2）。
   *
   * 「入れ物（3成分の母集団）は移したが、書く経路が pi 限定のまま」だと、Claude の
   * モデルには旗が立たない。ここが立たない限り、母集団は pi の言い換えでしかない。
   */
  it("役の面で Claude のモデルを選べば、母集団に旗が立つ（症状1）", () => {
    const c = seedCatalog(true);
    c.models(); // 移行を走らせる（台帳をここで作る）
    c.setRole("steward", "claude", "opus", "claude-agent-sdk");

    assert.deepEqual(
      ledger().adopted().find((r) => r.backend === "claude-agent-sdk"),
      { backend: "claude-agent-sdk", provider: "claude", model: "opus" },
      "**pi 限定の番人を外した**——どのバックエンドのモデルも母集団へ入る"
    );
    assert.deepEqual(
      c.adoptedRefs().filter((r) => r.backend !== "pi").map((r) => r.model),
      ["opus"],
      "`models()` は pi の供給しか並べないので、母集団はここから読む"
    );
  });

  /**
   * **番人を外しただけでは、既に割り当ててあるものは治らない。**
   *
   * 実機の台帳は4つの役すべてが Claude を指しているのに母集団は pi の32件だけ、
   * という形で残っていた（2026-08-13 実測）。選び直すまで直らないのでは、
   * 「入れ物は移したが症状は治っていない」がそのまま再演する。
   */
  it("割り当て済みの役は、読み込みのたびに母集団へ揃えられる（不変条件）", () => {
    // 番人が居た頃の姿：役は Claude を指しているのに、母集団には居ない
    const l = ledger();
    l.updateRole("steward", {
      default: { backend: "claude-agent-sdk", provider: "claude", model: "opus" },
    });
    assert.deepEqual(l.adopted(), []);

    seedCatalog(true).models(); // 読み込み（＝移行）を走らせる
    assert.deepEqual(
      ledger().adopted().filter((r) => r.backend !== "pi"),
      [{ backend: "claude-agent-sdk", provider: "claude", model: "opus" }],
      "割り当てられているものは必ず母集団に居る"
    );
  });

  it("役に割り当てた Claude のモデルは母集団から外せない（解決先を失う）", () => {
    const c = seedCatalog(true);
    c.models();
    c.setRole("worker.fast", "claude", "haiku", "claude-agent-sdk");
    assert.throws(
      () => ledger().unadopt({ backend: "claude-agent-sdk", provider: "claude", model: "haiku" }),
      /割り当てられています/
    );
  });

  it("Claude の採用は、同じ名前の pi のモデルに旗を立てない（バックエンドで絞る）", () => {
    const c = seedCatalog(true);
    c.models();
    // pi 側の `cloud/big` を採用から外し、同名を Claude 側で採用する
    c.setPolicy("cloud", "big", "host", false);
    c.setRole("steward", "cloud", "big", "claude-agent-sdk");
    assert.deepEqual(
      c.models().find((m) => m.id === "big")?.policy,
      [],
      "**pi の供給の旗は pi の母集団だけで決まる**——ここで漏れると、採用していない pi の" +
        "モデルが「採用済み」に見え、そのまま職人の候補に並ぶ"
    );
  });

  it("台帳がまだ無い呼び出し元は、従来どおり pi のオーバーレイに旗を立てる（入れ替えの窓）", () => {
    const c = seedCatalog(false);
    c.setRole("steward", "cloud", "big");
    assert.ok(
      c.models().find((m) => m.id === "big")?.policy.includes("host"),
      "台帳が無ければ書き先は pi のオーバーレイしか無い"
    );
  });

  it("採用の切り替えは母集団を出入りする（用途に依らず1つ）", () => {
    // 何も無いところから作ると、2026-08-04 の移行が「いま在るものを全採用」にする
    const c = seedCatalog(true);
    c.models(); // 移行を走らせる（台帳はここで出来る）
    const has = (model: string): boolean =>
      ledger().adopted().some((r) => r.provider === "cloud" && r.model === model);
    assert.equal(has("big"), true);

    // **どちらの用途で外しても母集団から出る**（役ごとに採り直さないため）
    c.setPolicy("cloud", "big", "worker", false);
    assert.equal(has("big"), false);
    assert.equal(has("small"), true, "他のモデルは巻き添えにしない");

    c.setPolicy("cloud", "big", "host", true);
    assert.equal(has("big"), true);
  });
});
