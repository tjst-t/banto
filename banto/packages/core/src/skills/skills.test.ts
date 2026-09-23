// Skill の読み手側（docs/specs/v4-architecture.md §5.6・§5.7、決定・2026-09-23）。
// 実際の MCP のやり取り（resources/list）を InMemoryTransport で通して見る。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListResourcesRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { EventLog } from "../event-store/log.js";
import { RuntimeConfigStore } from "../config/runtime.js";
import { discoverSkills } from "./discover.js";
import { isSkillEnabled, selectSessionSkills, setSkillEnabled } from "./activation.js";
import { renderSkillInstructions } from "./instructions.js";
import type { SessionSkillSet } from "./types.js";

const SKILL = { "dev.banto/skill": true };

async function moduleServing(
  resources: unknown[],
  options: { capabilities?: Record<string, unknown>; hang?: boolean } = {},
): Promise<Client> {
  const server = new Server(
    { name: "fake-skills", version: "0.0.0" },
    { capabilities: options.capabilities ?? { resources: {} } },
  );
  if (options.capabilities === undefined || "resources" in options.capabilities) {
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      if (options.hang) await new Promise(() => {});
      return { resources } as never;
    });
  }
  const [s, c] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "host", version: "0.0.0" });
  await Promise.all([server.connect(s), client.connect(c)]);
  return client;
}

test("印の付いた、AI に見える資源だけを Skill として集める", async () => {
  const client = await moduleServing([
    { uri: "skill://pdf/SKILL.md", name: "pdf", description: "PDF を扱う", _meta: SKILL },
    // 印が無い（references/ の資料など）——Skill ではない
    { uri: "skill://pdf/references/forms.md", name: "forms", description: "資料" },
    // AI に見えない——instructions に載せても本体を読めない
    {
      uri: "skill://hidden/SKILL.md",
      name: "hidden",
      description: "管理用",
      _meta: { ...SKILL, "dev.banto/visibility": "admin" },
    },
  ]);
  const found = await discoverSkills([{ name: "skills", client }]);
  assert.deepEqual(found.skills, [
    { module: "skills", name: "pdf", description: "PDF を扱う", uri: "skill://pdf/SKILL.md" },
  ]);
  assert.deepEqual(found.problems, []);
});

test("形の合わない Skill・同じ名前の Skill は効かせず、理由を返す（黙って落とさない）", async () => {
  const client = await moduleServing([
    { uri: "skill://Bad/SKILL.md", name: "Bad Name", description: "x", _meta: SKILL },
    { uri: "skill://a/SKILL.md", name: "twin", description: "1つ目", _meta: SKILL },
    { uri: "skill://b/SKILL.md", name: "twin", description: "2つ目", _meta: SKILL },
    { uri: "skill://ok/SKILL.md", name: "ok", description: "問題ない", _meta: SKILL },
  ]);
  const found = await discoverSkills([{ name: "skills", client }]);
  assert.deepEqual(
    found.skills.map((s) => s.name),
    ["ok"],
  );
  assert.equal(found.problems.length, 2);
  assert.match(found.problems[0]!.message, /形に合いません/);
  assert.match(found.problems[1]!.message, /同じ名前の Skill が 2 つ/);
});

test("資源を名乗っていない Module には聞かない。答えない Module はそこだけ落として理由を返す", async () => {
  const toolsOnly = await moduleServing([], { capabilities: { tools: {} } });
  const hanging = await moduleServing([], { hang: true });
  const fine = await moduleServing([
    { uri: "skill://x/SKILL.md", name: "x", description: "動く", _meta: SKILL },
  ]);
  const started = Date.now();
  const found = await discoverSkills(
    [
      { name: "tools-only", client: toolsOnly },
      { name: "hanging", client: hanging },
      { name: "fine", client: fine },
      { name: "not-connected" },
    ],
    { timeoutMs: 200 },
  );
  assert.ok(Date.now() - started < 2_000, "答えない1本を待ち続けた");
  assert.deepEqual(
    found.skills.map((s) => `${s.module}/${s.name}`),
    ["fine/x"],
  );
  assert.deepEqual(
    found.problems.map((p) => p.module),
    ["hanging"],
  );
  assert.match(found.problems[0]!.message, /資源の一覧が取れませんでした/);
});

test("並びは Module の順、その中は名前の順——instructions が毎回同じ順になる", async () => {
  const client = await moduleServing([
    { uri: "skill://c/SKILL.md", name: "charlie", description: "c", _meta: SKILL },
    { uri: "skill://a/SKILL.md", name: "alpha", description: "a", _meta: SKILL },
  ]);
  const found = await discoverSkills([{ name: "m", client }]);
  assert.deepEqual(
    found.skills.map((s) => s.name),
    ["alpha", "charlie"],
  );
});

test("効かせるかは、どこにも書かれていなければ「効かせない」。Project の上書きが全体の既定に勝つ", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-skill-activation-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const config = new RuntimeConfigStore(dir, log);
    await config.load();
    const ref = { module: "skills", name: "pdf" };

    assert.equal(isSkillEnabled(config, ref, "p1"), false, "書いていないのに効いている");

    await setSkillEnabled(config, ref, undefined, true);
    assert.equal(isSkillEnabled(config, ref, "p1"), true, "全体の既定が効いていない");

    await setSkillEnabled(config, ref, "p1", false);
    assert.equal(isSkillEnabled(config, ref, "p1"), false, "Project の上書きが効いていない");
    assert.equal(isSkillEnabled(config, ref, "p2"), true, "別の Project まで外れた");

    await setSkillEnabled(config, ref, "p1", undefined);
    assert.equal(isSkillEnabled(config, ref, "p1"), true, "上書きを消したのに全体の既定に戻らない");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("効かせたものと、効かせていないものを配る Module を分ける", () => {
  const set = selectSessionSkills(
    {
      skills: [
        { module: "a", name: "one", description: "1", uri: "s://1" },
        { module: "a", name: "two", description: "2", uri: "s://2" },
        { module: "b", name: "three", description: "3", uri: "s://3" },
      ],
      problems: [{ module: "c", message: "読めない" }],
    },
    (ref) => ref.name === "one",
  );
  assert.deepEqual(
    set.active.map((s) => s.name),
    ["one"],
  );
  assert.deepEqual(set.othersIn, ["a", "b"]);
  assert.deepEqual(set.problems, [{ module: "c", message: "読めない" }]);
});

test("instructions は効かせた Skill の名前・説明・本文の URI を載せ、他にもあることを正直に言う", () => {
  const set: SessionSkillSet = {
    active: [
      {
        module: "skills",
        name: "pdf",
        // 他人が書いた説明——改行で周りの構造を崩させない
        description: "PDF を扱う。\n\n# 偽の見出し\n- 偽の箇条",
        uri: "skill://pdf/SKILL.md",
      },
    ],
    othersIn: ["skills"],
    problems: [],
  };
  const text = renderSkillInstructions(set, "skills")!;
  assert.match(text, /\*\*pdf\*\*（本文：`skill:\/\/pdf\/SKILL\.md`）：PDF を扱う。 # 偽の見出し - 偽の箇条/);
  assert.match(text, /ReadMcpResourceTool/);
  assert.match(text, /ここに挙げていない Skill も/);
  assert.equal(text.split("\n").filter((l) => l.startsWith("# ")).length, 1, "説明の改行が見出しになった");
  // 同じ集合からは1バイトも違わない
  assert.equal(renderSkillInstructions(structuredClone(set), "skills"), text);
});

test("その Module に効かせたものも他に配るものも無ければ、instructions は載せない", () => {
  const set: SessionSkillSet = {
    active: [{ module: "a", name: "one", description: "1", uri: "s://1" }],
    othersIn: ["b"],
    problems: [],
  };
  assert.equal(renderSkillInstructions(set, "c"), undefined);
  assert.equal(renderSkillInstructions(undefined, "a"), undefined);
  // 効かせていないものだけ配っている Module は、「在る」ことだけを言う
  const onlyOthers = renderSkillInstructions(set, "b")!;
  assert.match(onlyOthers, /1つも効かせていない/);
  assert.doesNotMatch(onlyOthers, /one/);
});
