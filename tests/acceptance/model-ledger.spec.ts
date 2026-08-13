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
