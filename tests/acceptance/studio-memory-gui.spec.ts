/**
 * 記憶・SKILL の GUI が、実装に追随していることの検証。
 *
 * GUI は「番頭が何を覚えていて、どう動くつもりか」を PO に見せる面（task-0031）なので、
 * **中身が変わったのに見え方が古い**と、PO と番頭で前提が割れる。ここが守るのは3つ:
 *
 * 1. **出所が見える**（決定28）。抽出した記憶は自動で有効になるので、PO が
 *    「自分が言ったこと」と「番頭が拾ったこと」を見分けられなければならない
 * 2. **忘れさせられる**（決定28）。PO 確認なしで抽出を有効にする条件がこれだった
 * 3. **層が見える**（ADR-0003）。人の記憶とプロジェクトの記憶が混ざらない
 *
 * 加えて、SKILL ビューアが**学習層を含めて**見せること（決定26）。ここが既定だけを
 * 見せていると、番頭は学んだ手順で動いているのに PO には古い手順が見える。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { JsonlMemoryStore, ScopedMemory } from "@banto/core";
import { LEARNED_ORIGIN, LearnedSkillStore, createStudioModule, resolveSkills } from "@banto/host";

let dir: string;
let person: JsonlMemoryStore;
let memory: ScopedMemory;
let learned: LearnedSkillStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-studio-gui-"));
  person = new JsonlMemoryStore(path.join(dir, "memory.jsonl"));
  memory = new ScopedMemory(
    person,
    (placeId) =>
      new JsonlMemoryStore(path.join(dir, "projects", encodeURIComponent(placeId), "memory.jsonl"))
  );
  learned = new LearnedSkillStore(path.join(dir, "learned"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 既定の SKILL をディスクに作る。 */
function makeDefault(name: string, body: string): { name: string; description: string; filePath: string } {
  const skillDir = path.join(dir, "defaults", name);
  fs.mkdirSync(skillDir, { recursive: true });
  const filePath = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(filePath, `---\nname: ${name}\ndescription: 既定\n---\n\n${body}\n`, "utf-8");
  return { name, description: "既定", filePath };
}

function studio(overrides: Partial<Parameters<typeof createStudioModule>[0]> = {}) {
  return createStudioModule({
    memory,
    skills: () =>
      resolveSkills([
        learned.list().map((e) => ({ skill: e.skill, origin: LEARNED_ORIGIN })),
        [],
      ]),
    ...overrides,
  });
}

async function run(
  module: ReturnType<typeof createStudioModule>,
  name: string,
  args: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const tool = module.internalTools!.find((t) => t.name === name);
  assert.ok(tool, `${name} が無い`);
  const result = await tool.execute(args as never);
  return (result.details ?? {}) as Record<string, unknown>;
}

// ── 決定28: 出所が見える ────────────────────────────────────────────────────

describe("[決定28] 記憶ビューアは出所を見せる", () => {
  it("origin が一覧に載る（POが言ったこと／番頭が抽出したもの）", async () => {
    person.save({ kind: "fact", text: "POが言った事実", origin: "explicit" });
    person.save({ kind: "fact", text: "抽出した事実", origin: "extracted" });

    const records = (await run(studio(), "studio.memory"))["records"] as Array<
      Record<string, unknown>
    >;
    const byText = new Map(records.map((r) => [r["text"], r["origin"]]));

    assert.equal(byText.get("POが言った事実"), "explicit");
    assert.equal(byText.get("抽出した事実"), "extracted");
  });

  it("validFrom が一覧に載る（記録した時刻とは別軸）", async () => {
    person.save({ kind: "fact", text: "Node 22 前提", validFrom: "2026-08-01" });

    const records = (await run(studio(), "studio.memory"))["records"] as Array<
      Record<string, unknown>
    >;
    assert.equal(records[0]!["validFrom"], "2026-08-01");
  });

  it("いま有効かをサーバが付ける（画面に導出させない・D3/D5）", async () => {
    const stale = person.save({ kind: "preference", text: "古い前提" });
    person.supersede(stale.id, { kind: "preference", text: "新しい前提" });

    const withHistory = (await run(studio(), "studio.memory", { includeSuperseded: true }))[
      "records"
    ] as Array<Record<string, unknown>>;

    const old = withHistory.find((r) => r["text"] === "古い前提");
    const now = withHistory.find((r) => r["text"] === "新しい前提");
    assert.equal(old?.["active"], false, "訂正されたものは無効と分かること");
    assert.equal(now?.["active"], true);
  });

  it("忘れた記憶は既定で隠れ、履歴では無効として見える", async () => {
    const gone = person.save({ kind: "habit", text: "やめた習慣" });
    person.forget(gone.id, "もうやらない");

    const active = (await run(studio(), "studio.memory"))["records"] as unknown[];
    assert.equal(active.length, 0);

    const history = (await run(studio(), "studio.memory", { includeSuperseded: true }))[
      "records"
    ] as Array<Record<string, unknown>>;
    const found = history.find((r) => r["text"] === "やめた習慣");
    assert.ok(found, "履歴からは辿れること");
    assert.equal(found["active"], false);
  });
});

// ── 決定28: 忘れさせられる ──────────────────────────────────────────────────

describe("[決定28] 記憶ビューアから忘れさせられる", () => {
  it("studio.memory.forget が記憶を無効にする", async () => {
    const saved = person.save({ kind: "fact", text: "誤って覚えた事実", origin: "extracted" });

    await run(studio(), "studio.memory.forget", { id: saved.id, reason: "誤り" });

    assert.deepEqual(person.list(), [], "有効な記憶から外れること");
    const raw = fs.readFileSync(path.join(dir, "memory.jsonl"), "utf-8");
    assert.match(raw, /誤って覚えた事実/, "記録は残ること（D3）");
  });

  it("プロジェクトの記憶も忘れさせられる", async () => {
    const saved = memory.forProject("proj-a").save({ kind: "fact", text: "Aの誤り" });

    await run(studio(), "studio.memory.forget", {
      id: saved.id,
      scope: "project",
      place: "proj-a",
    });

    assert.deepEqual(memory.forProject("proj-a").list(), []);
  });

  it("知らないIDは黙って成功にせずエラーにする（I2）", async () => {
    await assert.rejects(
      () => run(studio(), "studio.memory.forget", { id: "no-such-id" }),
      /Cannot forget unknown memory/
    );
  });
});

// ── ADR-0003: 層が見える ────────────────────────────────────────────────────

describe("[ADR-0003] 記憶ビューアは層を切り替えられる", () => {
  it("既定では人の記憶を返し、そう名乗る", async () => {
    person.save({ kind: "fact", text: "人の事実" });
    memory.forProject("proj-a").save({ kind: "fact", text: "Aの事実" });

    const out = await run(studio(), "studio.memory");
    assert.equal(out["scope"], "person");
    const texts = (out["records"] as Array<Record<string, unknown>>).map((r) => r["text"]);
    assert.deepEqual(texts, ["人の事実"], "プロジェクトの記憶が混ざってはいけない");
  });

  it("場所を指定するとそのプロジェクトの記憶だけを返す", async () => {
    person.save({ kind: "fact", text: "人の事実" });
    memory.forProject("proj-a").save({ kind: "fact", text: "Aの事実" });
    memory.forProject("proj-b").save({ kind: "fact", text: "Bの事実" });

    const out = await run(studio(), "studio.memory", { scope: "project", place: "proj-a" });
    assert.equal(out["scope"], "project");
    assert.equal(out["place"], "proj-a");
    const texts = (out["records"] as Array<Record<string, unknown>>).map((r) => r["text"]);
    assert.deepEqual(texts, ["Aの事実"]);
  });

  it("studio.memory.scopes が切り替え先の場所を返す", async () => {
    const module = studio({
      places: async () => [
        { id: "proj-a", label: "プロジェクトA" },
        { id: "proj-b", label: "プロジェクトB" },
      ],
    });

    const places = (await run(module, "studio.memory.scopes"))["places"] as Array<
      Record<string, string>
    >;
    assert.deepEqual(places.map((p) => p.id), ["proj-a", "proj-b"]);
    assert.equal(places[0]!["label"], "プロジェクトA");
  });

  it("場所を渡さない構成では空を返す（人の記憶だけの画面になる）", async () => {
    const places = (await run(studio(), "studio.memory.scopes"))["places"] as unknown[];
    assert.deepEqual(places, []);
  });

  it("scope=project で場所を省いたら、人の記憶へ落とさずエラーにする（I2）", async () => {
    await assert.rejects(
      () => run(studio(), "studio.memory", { scope: "project" }),
      /requires a place id/
    );
  });
});

// ── 決定26: SKILL ビューアが学習層を見せる ──────────────────────────────────

describe("[決定26] SKILLビューアは学習層を含めて見せる", () => {
  it("学んだ SKILL が origin: learned として出る", async () => {
    learned.save({ name: "work-handoff", description: "学んだ版", body: "学んだ手順" });

    const skills = (await run(studio(), "studio.skills"))["skills"] as Array<
      Record<string, string>
    >;
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!["origin"], "learned");
    assert.match(skills[0]!["body"]!, /学んだ手順/);
  });

  it("学習層が同名の既定を上書きした結果が出る（実際に効いている版）", async () => {
    const base = makeDefault("work-handoff", "既定の手順");
    learned.save({ name: "work-handoff", description: "学んだ版", body: "学んだ手順" });

    const module = createStudioModule({
      memory,
      skills: () =>
        resolveSkills([
          learned.list().map((e) => ({ skill: e.skill, origin: LEARNED_ORIGIN })),
          [{ skill: base, origin: "core" }],
        ]),
    });

    const skills = (await run(module, "studio.skills"))["skills"] as Array<Record<string, string>>;
    assert.equal(skills.length, 1, "同名は1つに解決される");
    assert.equal(skills[0]!["origin"], "learned");
    assert.match(skills[0]!["body"]!, /学んだ手順/);
    assert.doesNotMatch(skills[0]!["body"]!, /既定の手順/);
  });

  it("**取り直すと最新になる**——学んだ直後に再起動を待たされない", async () => {
    const module = studio();
    assert.equal(((await run(module, "studio.skills"))["skills"] as unknown[]).length, 0);

    learned.save({ name: "new-skill", description: "学んだ", body: "本体" });

    const after = (await run(module, "studio.skills"))["skills"] as unknown[];
    assert.equal(after.length, 1, "同じモジュールのまま新しい SKILL が見えること");
  });
});
