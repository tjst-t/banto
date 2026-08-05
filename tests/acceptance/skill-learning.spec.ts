/**
 * SKILL の学習層（記憶の第二層。ADR-0010 決定26・task-0017・提案§5）の受け入れ検証。
 *
 * 決定26 が名指しした危険——**オーバーライドが既定の改良を黙って隠す**——への対処が
 * 眼目である。層A資産は「壊れると静かに劣化する」（`spec-improvement-loop` §1）ので、
 * 隠していることに気づける機構が無ければ、モジュールを直しても番頭には永久に届かない。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  LearnedSkillStore,
  createSkillTools,
  detectStaleOverrides,
  renderStaleOverrides,
  resolveSkills,
  skillHash,
  type BantoSkill,
} from "@banto/host";

let dir: string;
let learned: LearnedSkillStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-skill-learning-"));
  learned = new LearnedSkillStore(path.join(dir, "learned"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 既定の SKILL をディスクに作る。 */
function makeDefault(name: string, body: string): BantoSkill {
  const skillDir = path.join(dir, "defaults", name);
  fs.mkdirSync(skillDir, { recursive: true });
  const filePath = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(
    filePath,
    `---\nname: ${name}\ndescription: 既定の${name}\n---\n\n${body}\n`,
    "utf-8"
  );
  return { name, description: `既定の${name}`, filePath };
}

// ── a1: 保存できる ──────────────────────────────────────────────────────────

describe("[task-0017/a1] 番頭が得た手順の改善を学習層に保存できる", () => {
  it("保存して読み戻せる", () => {
    learned.save({
      name: "work-handoff",
      description: "起票のやり方（学んだ版）",
      body: "1. ADR を accepted にしたら\n2. その場で work/tasks を起票する",
    });

    const list = learned.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.skill.name, "work-handoff");
    assert.equal(list[0]!.skill.description, "起票のやり方（学んだ版）");
    assert.match(fs.readFileSync(list[0]!.skill.filePath, "utf-8"), /work\/tasks を起票/);
  });

  it("既定と同じ形式（agentskills.io の frontmatter）で書かれる", () => {
    const saved = learned.save({ name: "test-skill", description: "説明", body: "本体" });
    const raw = fs.readFileSync(saved.skill.filePath, "utf-8");

    assert.match(raw, /^---\nname: test-skill\ndescription: 説明\n---/u);
  });

  it("捨てられる（既定に戻す）", () => {
    learned.save({ name: "test-skill", description: "説明", body: "本体" });
    learned.remove("test-skill");
    assert.deepEqual(learned.list(), []);
  });

  it("名前にパスを含められない（../ で外へ出させない・I2）", () => {
    assert.throws(() => learned.save({ name: "../evil", description: "d", body: "b" }), /名前は/);
    assert.throws(() => learned.remove("../evil"), /名前は/);
  });
});

// ── a2: 学習層が既定より優先される ──────────────────────────────────────────

describe("[task-0017/a2] 同名なら学習層が既定より優先される（決定26）", () => {
  it("resolveSkills の先頭に置くと既定を上書きする", () => {
    const base = makeDefault("work-handoff", "既定の手順");
    const override = learned.save({
      name: "work-handoff",
      description: "学んだ版",
      body: "学んだ手順",
    });

    const resolved = resolveSkills([
      [{ skill: override.skill, origin: "learned" }],
      [{ skill: base, origin: "core" }],
    ]);

    assert.equal(resolved.length, 1, "同名は1つに解決される");
    assert.equal(resolved[0]!.origin, "learned");
    assert.match(fs.readFileSync(resolved[0]!.skill.filePath, "utf-8"), /学んだ手順/);
  });

  it("同名でなければ両方残る", () => {
    const base = makeDefault("work-handoff", "既定");
    const other = learned.save({ name: "my-skill", description: "自作", body: "本体" });

    const resolved = resolveSkills([
      [{ skill: other.skill, origin: "learned" }],
      [{ skill: base, origin: "core" }],
    ]);
    assert.equal(resolved.length, 2);
  });
});

// ── a3: 元にした版を記録する ────────────────────────────────────────────────

describe("[task-0017/a3] オーバーライドは元にした既定の版を記録する", () => {
  it("basedOn が保存され、読み戻せる", () => {
    const base = makeDefault("work-handoff", "既定の手順");
    const hash = skillHash(fs.readFileSync(base.filePath, "utf-8"));

    learned.save({
      name: "work-handoff",
      description: "学んだ版",
      body: "学んだ手順",
      basedOn: { origin: "core", hash },
    });

    assert.deepEqual(learned.list()[0]!.basedOn, { origin: "core", hash });
  });

  it("新しく作った SKILL には basedOn が付かない（上書きしていない）", () => {
    learned.save({ name: "my-skill", description: "自作", body: "本体" });
    assert.equal(learned.list()[0]!.basedOn, undefined);
  });

  it("上書きをやめて作り直すと basedOn が消える", () => {
    learned.save({ name: "s", description: "d", body: "b", basedOn: { origin: "core", hash: "x" } });
    learned.save({ name: "s", description: "d", body: "b2" });
    assert.equal(learned.list()[0]!.basedOn, undefined);
  });

  it("壊れた baseline は黙って無視せずエラーにする（I2）", () => {
    learned.save({ name: "s", description: "d", body: "b", basedOn: { origin: "core", hash: "x" } });
    fs.writeFileSync(path.join(dir, "learned", "s", "baseline.json"), "{ broken", "utf-8");

    assert.throws(() => learned.list(), /baseline が読めません/);
  });

  it("ハッシュは末尾の空白の違いでは変わらない", () => {
    assert.equal(skillHash("本体"), skillHash("本体\n\n"));
  });
});

// ── a4: 陳腐化の検出 ────────────────────────────────────────────────────────

describe("[task-0017/a4] 既定が変わったオーバーライドを見つける（P3・決定26）", () => {
  it("既定が変わっていなければ何も出ない", () => {
    const base = makeDefault("work-handoff", "既定の手順");
    learned.save({
      name: "work-handoff",
      description: "学んだ版",
      body: "学んだ手順",
      basedOn: { origin: "core", hash: skillHash(fs.readFileSync(base.filePath, "utf-8")) },
    });

    assert.deepEqual(detectStaleOverrides(learned.list(), [base]), []);
  });

  it("既定が変わったら見つかる——これが無いと改良が永久に届かない", () => {
    const base = makeDefault("work-handoff", "既定の手順");
    learned.save({
      name: "work-handoff",
      description: "学んだ版",
      body: "学んだ手順",
      basedOn: { origin: "core", hash: skillHash(fs.readFileSync(base.filePath, "utf-8")) },
    });

    // 既定側が改良された
    fs.writeFileSync(
      base.filePath,
      "---\nname: work-handoff\ndescription: 既定のwork-handoff\n---\n\n改良された手順\n",
      "utf-8"
    );

    const stale = detectStaleOverrides(learned.list(), [base]);
    assert.equal(stale.length, 1);
    assert.equal(stale[0]!.name, "work-handoff");
    assert.equal(stale[0]!.reason, "既定が変わった");
    assert.notEqual(stale[0]!.now, stale[0]!.was.hash);
  });

  it("既定が無くなったときも見つかる", () => {
    learned.save({
      name: "gone",
      description: "学んだ版",
      body: "本体",
      basedOn: { origin: "some-module", hash: "abc123" },
    });

    const stale = detectStaleOverrides(learned.list(), []);
    assert.equal(stale.length, 1);
    assert.equal(stale[0]!.reason, "既定が無くなった");
    assert.equal(stale[0]!.now, undefined);
  });

  it("上書きでない学習層は陳腐化しない", () => {
    learned.save({ name: "my-skill", description: "自作", body: "本体" });
    assert.deepEqual(detectStaleOverrides(learned.list(), []), []);
  });

  it("人が読める形に整えられる（incident の本文に使う）", () => {
    learned.save({
      name: "s",
      description: "d",
      body: "b",
      basedOn: { origin: "core", hash: "oldhash" },
    });
    const text = renderStaleOverrides(detectStaleOverrides(learned.list(), []));

    assert.match(text, /s: 既定が無くなった/);
    assert.match(text, /oldhash/);
    assert.match(text, /core/);
  });
});

// ── Tool ────────────────────────────────────────────────────────────────────

describe("[task-0017] skill.learn / skill.unlearn", () => {
  it("学習層を渡さなければ登録されない（既存の構成は変わらない）", () => {
    const names = createSkillTools([]).map((t) => t.name);
    assert.deepEqual(names, ["skill.list", "skill.read"]);
  });

  it("学習層を渡すと登録される", () => {
    const names = createSkillTools([], { learned }).map((t) => t.name);
    assert.deepEqual(names, ["skill.list", "skill.read", "skill.learn", "skill.unlearn"]);
  });

  it("skill.learn は既定を上書きするとき、元の版を記録する（a3）", async () => {
    const base = makeDefault("work-handoff", "既定の手順");
    const learn = createSkillTools([base], { learned, defaults: [base] }).find(
      (t) => t.name === "skill.learn"
    )!;

    await learn.execute({
      name: "work-handoff",
      description: "学んだ版",
      body: "学んだ手順",
    } as never);

    const saved = learned.list()[0]!;
    assert.ok(saved.basedOn, "元の版が記録されていない");
    assert.equal(saved.basedOn.hash, skillHash(fs.readFileSync(base.filePath, "utf-8")));
  });

  it("skill.learn は既定に無い名前なら新規として保存する", async () => {
    const learn = createSkillTools([], { learned, defaults: [] }).find(
      (t) => t.name === "skill.learn"
    )!;
    const out = await learn.execute({ name: "my-skill", description: "d", body: "b" } as never);

    assert.match(out.content[0]!.text, /新しく作りました/);
    assert.equal(learned.list()[0]!.basedOn, undefined);
  });

  it("skill.learn は「次のセッションから効く」と伝える（今の会話では変わらない）", async () => {
    const learn = createSkillTools([], { learned }).find((t) => t.name === "skill.learn")!;
    const out = await learn.execute({ name: "s", description: "d", body: "b" } as never);
    assert.match(out.content[0]!.text, /次のセッションから効きます/);
  });

  it("skill.unlearn は学習層を捨てる", async () => {
    learned.save({ name: "s", description: "d", body: "b" });
    const unlearn = createSkillTools([], { learned }).find((t) => t.name === "skill.unlearn")!;

    await unlearn.execute({ name: "s" } as never);
    assert.deepEqual(learned.list(), []);
  });

  it("skill.learn は不正な名前を弾く（I2）", async () => {
    const learn = createSkillTools([], { learned }).find((t) => t.name === "skill.learn")!;
    await assert.rejects(
      () => learn.execute({ name: "../evil", description: "d", body: "b" } as never),
      /名前は/
    );
  });
});
