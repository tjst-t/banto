/**
 * task-0008: 記憶Toolの公開とSKILL読み込みの配線。ADR-0010 決定9・決定10 / D11。
 *
 * Kobo には接続しない（受け入れ条件 a4）。番頭が記憶とSKILLを実際に使える状態に
 * なったことだけを、番頭核の中で完結して検証する。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getModel } from "@earendil-works/pi-ai/compat";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";

import { JsonlMemoryStore, ScopedMemory } from "@banto/core";
import {
  bantoSkillsDir,
  createBantoHostSession,
  createMemoryTools,
  createSkillTools,
  loadBantoSkills,
  readBantoSkill,
  renderMemoryForPrompt,
} from "@banto/host";

/**
 * ToolDefinition.execute の第5引数 ExtensionContext は、ここで検証するTool群が
 * 一切参照しないためスタブを渡す。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 上記の理由によるテスト用スタブ (I4)
const TOOL_CTX = {} as any;

/** ツール結果からテキストだけを取り出す（content は text|image のunion）。 */
function textOf(result: { content: ReadonlyArray<{ type: string }> }): string {
  return result.content
    .map((c) => (c.type === "text" ? (c as { type: "text"; text: string }).text : ""))
    .join("\n");
}

let dir: string;
let store: JsonlMemoryStore;
/** ADR-0003 の二層。この検証は人の記憶だけを使う（プロジェクトの記憶は別の describe） */
let memory: ScopedMemory;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-host-memory-"));
  store = new JsonlMemoryStore(path.join(dir, "memory.jsonl"));
  memory = new ScopedMemory(store);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** セッション構築は完全にヘルメティック：ネットワーク・APIキー・実ファイル書き込みなし。 */
async function makeSession(overrides: Record<string, unknown> = {}) {
  const model = getModel("anthropic", "claude-opus-4-5");
  assert.ok(model);
  return createBantoHostSession({
    systemPrompt: "あなたは番頭です。",
    tools: [],
    memory,
    cwd: process.cwd(),
    model,
    // pi 0.84: 資格情報とモデル表は ModelRuntime に一本化された。
    // 試験では**どこにも触らないもの**を渡す（`modelsPath: null` でファイルを読ませない）
    modelRuntime: await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      modelsPath: null,
    }),
    sessionManager: SessionManager.inMemory(),
    ...overrides,
  });
}

describe("[task-0008/a1] memory.save / memory.recall Tools", () => {
  it("[task-0008/a1] follow the namespace convention (決定9)", () => {
    const names = createMemoryTools(memory).map((t) => t.name);
    assert.deepEqual(names, ["memory.save", "memory.recall", "memory.search", "memory.forget"]);
  });

  it("[task-0008/a1] memory.save persists through the MemoryStore", async () => {
    const [saveTool] = createMemoryTools(memory);
    const result = await saveTool!.execute({ kind: "preference", text: "POは統合UIのモックを好む" });

    assert.match(textOf(result), /saved memory/);
    assert.deepEqual(store.list().map((r) => r.text), ["POは統合UIのモックを好む"]);
  });

  it("[task-0008/a1] memory.save with supersedes corrects an existing memory", async () => {
    const original = store.save({ kind: "preference", text: "古い好み" });
    const [saveTool] = createMemoryTools(memory);

    await saveTool!.execute({ kind: "preference", text: "新しい好み", supersedes: original.id });

    assert.deepEqual(store.list().map((r) => r.text), ["新しい好み"]);
  });

  it("[task-0008/a1] memory.save on an unknown supersedes id propagates the error (I2)", async () => {
    const [saveTool] = createMemoryTools(memory);
    await assert.rejects(
      () =>
        saveTool!.execute({ kind: "preference", text: "訂正", supersedes: "no-such-id" }),
      /Cannot supersede unknown memory/
    );
  });

  it("[task-0008/a1] memory.recall returns active memories and filters by kind", async () => {
    store.save({ kind: "preference", text: "好みA" });
    store.save({ kind: "habit", text: "習慣B" });
    const [, recallTool] = createMemoryTools(memory);

    const all = await recallTool!.execute({});
    assert.match(textOf(all), /好みA/);
    assert.match(textOf(all), /習慣B/);

    const onlyHabits = await recallTool!.execute({ kind: "habit" });
    assert.doesNotMatch(textOf(onlyHabits), /好みA/);
    assert.match(textOf(onlyHabits), /習慣B/);
  });

  it("[task-0008/a1] memory.recall excludes superseded memories", async () => {
    const original = store.save({ kind: "preference", text: "古い前提" });
    store.supersede(original.id, { kind: "preference", text: "新しい前提" });
    const [, recallTool] = createMemoryTools(memory);

    const out = await recallTool!.execute({});
    assert.doesNotMatch(textOf(out), /古い前提/);
    assert.match(textOf(out), /新しい前提/);
  });

  it("[task-0008/a1] memory.recall on an empty store says so rather than erroring", async () => {
    const [, recallTool] = createMemoryTools(memory);
    const out = await recallTool!.execute({});
    assert.equal(textOf(out), "記憶なし");
  });
});

describe("[task-0008/a3] memory injection into the system prompt", () => {
  it("[task-0008/a3] renderMemoryForPrompt is empty when there is nothing remembered", () => {
    assert.equal(renderMemoryForPrompt(memory), "");
  });

  it("[task-0008/a3] renderMemoryForPrompt groups by kind and omits superseded", () => {
    store.save({ kind: "preference", text: "好みA" });
    store.save({ kind: "habit", text: "習慣B" });
    const stale = store.save({ kind: "preference", text: "古い好み" });
    store.supersede(stale.id, { kind: "preference", text: "訂正後の好み" });

    const rendered = renderMemoryForPrompt(memory);
    assert.match(rendered, /### 好み/);
    assert.match(rendered, /### 習慣/);
    assert.match(rendered, /好みA/);
    assert.match(rendered, /習慣B/);
    assert.match(rendered, /訂正後の好み/);
    assert.doesNotMatch(rendered, /古い好み/, "superseded memories must not be injected");
  });

  it("[task-0008/a3] a session started with memory carries it in the system prompt", async () => {
    store.save({ kind: "preference", text: "POはコスト意識が高い" });

    const { session } = await makeSession();
    assert.match(session.agent.state.systemPrompt, /あなたは番頭です。/);
    assert.match(session.agent.state.systemPrompt, /POはコスト意識が高い/);
    session.dispose();
  });

  it("[task-0008/a3] memory saved in one session is visible to the next (cross-session)", async () => {
    // セッション1：記憶を保存する
    const { session: first } = await makeSession();
    const saveTool = first.agent.state.tools.find((t) => t.name === "memory__save");
    assert.ok(saveTool, "memory.save must be registered under its wire name");
    // セッションに載った側は AgentTool（ctx は pi が内部で束ねるため引数に取らない）
    await saveTool!.execute(
      "call-1",
      { kind: "habit", text: "テスト結果は直接実行して確かめる" },
      undefined,
      undefined
    );
    first.dispose();

    // セッション2：同じ保存先を指す新しいストア = 再起動した番頭
    const reopened = new JsonlMemoryStore(path.join(dir, "memory.jsonl"));
    const { session: second } = await makeSession({ memory: new ScopedMemory(reopened) });
    assert.match(second.agent.state.systemPrompt, /テスト結果は直接実行して確かめる/);
    second.dispose();
  });

  it("[task-0008/a3] a session without memory registers no memory tools", async () => {
    const { session } = await makeSession({ memory: undefined });
    assert.equal(
      session.agent.state.tools.some((t) => t.name.startsWith("memory__")),
      false
    );
    session.dispose();
  });
});

describe("[task-0008/a2] SKILL loading (自前 progressive disclosure)", () => {
  it("[task-0008/a2] loadBantoSkills finds work-handoff with its description", () => {
    const skills = loadBantoSkills();
    const workHandoff = skills.find((s) => s.name === "work-handoff");

    assert.ok(workHandoff, `work-handoff must be discovered (found: ${skills.map((s) => s.name).join(", ")})`);
    assert.ok(workHandoff!.description.length > 0);
    assert.ok(fs.existsSync(workHandoff!.filePath));
  });

  it("[task-0008/a2] bantoSkillsDir points at the SKILL root", () => {
    assert.ok(fs.existsSync(path.join(bantoSkillsDir(), "work-handoff", "SKILL.md")));
  });

  it("[task-0008/a2] the session advertises the SKILL in the system prompt", async () => {
    const { session } = await makeSession();
    assert.match(session.agent.state.systemPrompt, /使えるSKILL/);
    assert.match(session.agent.state.systemPrompt, /work-handoff/);
    session.dispose();
  });

  it("[task-0008/a2] only the description is injected, never the SKILL body", async () => {
    const { session } = await makeSession();
    const body = readBantoSkill("work-handoff", loadBantoSkills());
    const bodyMarker = "## 手順2：定期棚卸し";

    assert.match(body, new RegExp(bodyMarker), "sanity: the marker exists in the SKILL body");
    assert.doesNotMatch(
      session.agent.state.systemPrompt,
      new RegExp(bodyMarker),
      "the body must stay out of the prompt until skill.read is called"
    );
    session.dispose();
  });

  it("[task-0008/a2] skill.read returns the full SKILL body", async () => {
    const skills = loadBantoSkills();
    const [, readTool] = createSkillTools(skills);
    const out = await readTool!.execute({ name: "work-handoff" });

    assert.match(textOf(out), /## 手順1/);
    assert.match(textOf(out), /## 手順2/);
  });

  it("[task-0008/a2] skill.list returns names and descriptions", async () => {
    const [listTool] = createSkillTools(loadBantoSkills());
    const out = await listTool!.execute({});

    assert.match(textOf(out), /work-handoff:/);
  });

  it("[task-0008/a2] skill.read on an unknown SKILL throws with the available names (I2)", async () => {
    const [, readTool] = createSkillTools(loadBantoSkills());
    await assert.rejects(
      () => readTool!.execute({ name: "no-such-skill" }),
      /Unknown SKILL "no-such-skill".*work-handoff/s
    );
  });

  it("[task-0008/a2] skill tools are registered on the session under wire names", async () => {
    const { session } = await makeSession();
    const names = session.agent.state.tools.map((t) => t.name);

    assert.ok(names.includes("skill__list"));
    assert.ok(names.includes("skill__read"));
    session.dispose();
  });

  it("[task-0008/a2] loadBantoSkills:false opts out entirely", async () => {
    const { session } = await makeSession({ loadBantoSkills: false });

    assert.doesNotMatch(session.agent.state.systemPrompt, /work-handoff/);
    assert.equal(session.agent.state.tools.some((t) => t.name.startsWith("skill__")), false);
    session.dispose();
  });

  it("[task-0008/a2] a SKILL whose frontmatter lacks a description is rejected (I2)", () => {
    const bad = path.join(dir, "skills", "broken");
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, "SKILL.md"), "---\nname: broken\n---\n\nbody\n", "utf-8");

    assert.throws(() => loadBantoSkills(path.join(dir, "skills")), /missing "description"/);
  });

  it("[task-0008/a2] a SKILL whose name disagrees with its directory is rejected (I2)", () => {
    const bad = path.join(dir, "skills", "dirname");
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(
      path.join(bad, "SKILL.md"),
      "---\nname: other-name\ndescription: x\n---\n\nbody\n",
      "utf-8"
    );

    assert.throws(() => loadBantoSkills(path.join(dir, "skills")), /must match its directory name/);
  });

  it("[task-0008/a2] a missing skills directory yields no skills", () => {
    assert.deepEqual(loadBantoSkills(path.join(dir, "does-not-exist")), []);
  });
});

// ── task-0032: 記憶に fact（事実）を足す（決定31。提案 memory-kind-fact より） ──────

describe("[task-0032] 記憶の種類 fact", () => {
  it("[task-0032/a1] 事実として保存・取り出しができる", () => {
    const store = new JsonlMemoryStore(path.join(dir, "m.jsonl"));
    store.save({ kind: "fact", text: "POの名前は「たくみ」である" });
    store.save({ kind: "preference", text: "結論から話す" });

    assert.deepEqual(
      store.list({ kind: "fact" }).map((r) => r.text),
      ["POの名前は「たくみ」である"]
    );
  });

  it("[task-0032/a1] 事実は好みの一覧に混ざらない（決定31a の眼目）", () => {
    const store = new JsonlMemoryStore(path.join(dir, "m.jsonl"));
    store.save({ kind: "fact", text: "POの名前は「たくみ」である" });

    // ここが混ざると、番頭が名前を「変えてよいもの」として扱いうる
    assert.deepEqual(store.list({ kind: "preference" }), []);
    assert.equal(store.list().length, 1, "種別を指定しなければ出る");
  });

  it("[task-0032/a2] プロンプトに「事実」の節が出る。順は 事実 → 好み → 習慣", () => {
    const store = new JsonlMemoryStore(path.join(dir, "m.jsonl"));
    store.save({ kind: "habit", text: "習慣X" });
    store.save({ kind: "preference", text: "好みY" });
    store.save({ kind: "fact", text: "事実Z" });

    const prompt = renderMemoryForPrompt(new ScopedMemory(store));
    assert.match(prompt, /### 事実\n- 事実Z/);
    // 決定31d: 事実が最も安定しているので先に読ませる
    assert.ok(prompt.indexOf("### 事実") < prompt.indexOf("### 好み"));
    assert.ok(prompt.indexOf("### 好み") < prompt.indexOf("### 習慣"));
  });

  it("[task-0032/a2] 事実だけでもプロンプトに出る（好み・習慣が無くても空にしない）", () => {
    const store = new JsonlMemoryStore(path.join(dir, "m.jsonl"));
    store.save({ kind: "fact", text: "事実だけ" });

    assert.match(renderMemoryForPrompt(new ScopedMemory(store)), /### 事実/);
  });

  it("[task-0032/a3] memory.save Tool が fact を受ける", async () => {
    const store = new JsonlMemoryStore(path.join(dir, "m.jsonl"));
    const save = createMemoryTools(new ScopedMemory(store)).find((t) => t.name === "memory.save")!;

    await save.execute({ kind: "fact", text: "POの役割はプロダクトオーナー" } as never);
    assert.equal(store.list({ kind: "fact" }).length, 1);
  });

  it("[task-0032/a4] 既存の記憶は影響を受けない（リテラルの追加なので）", () => {
    const file = path.join(dir, "m.jsonl");
    // fact を足す前に書かれた記録を再現する
    fs.writeFileSync(
      file,
      JSON.stringify({
        id: "old-1",
        kind: "preference",
        text: "前からある好み",
        createdAt: "2026-07-01T00:00:00.000Z",
      }) + "\n"
    );

    const store = new JsonlMemoryStore(file);
    assert.deepEqual(store.list().map((r) => r.text), ["前からある好み"]);
    store.save({ kind: "fact", text: "後から足した事実" });
    assert.equal(store.list().length, 2);
  });

  it("[task-0032] 事実の訂正も supersede で表す（好みと同じ機構）", () => {
    const store = new JsonlMemoryStore(path.join(dir, "m.jsonl"));
    const first = store.save({ kind: "fact", text: "POの名前は「たくみ」" });
    store.supersede(first.id, { kind: "fact", text: "POの名前は「たくみ（辻下）」" });

    assert.deepEqual(store.list({ kind: "fact" }).map((r) => r.text), ["POの名前は「たくみ（辻下）」"]);
    assert.equal(store.list({ kind: "fact", includeSuperseded: true }).length, 2);
  });
});
