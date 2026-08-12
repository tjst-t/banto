/**
 * **在庫と提示を分ける**の受け入れ検証（ADR-0019 決定82・83・85・84-5）。
 *
 * 守りたい不変条件は3つ:
 *   1. 登録した道具は**減らない**（在庫）。減らすと GUI の HTTP 面と wire名の逆引きが壊れる
 *   2. モデルに渡るのは**表に在るものだけ**で、**表の順**（提示）
 *   3. 表の道具が1本も無いなら**黙って道具ゼロにしない**（I2）
 *
 * 実測（2026-08-12・ローカル vLLM・n=80 の対比較）が動機: 100個そのままだと番頭は
 * 48.8% のターンで道具を1本も呼ばず、43本に絞ると 98.8%（p<0.001）。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getModel } from "@earendil-works/pi-ai/compat";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import {
  createBantoHostSession,
  defineNamespacedTool,
  PRESENTED_TOOL_NAMES,
  presentedWireNames,
  renderToolCategories,
  selectPresentedTools,
  toWireToolName,
} from "@banto/host";

function stub(name: `${string}.${string}`) {
  return defineNamespacedTool({
    name,
    label: name,
    description: `Stub ${name}.`,
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text" as const, text: "ok" }] };
    },
  });
}

/** 表に在るもの2本＋表に無いもの2本。 */
const PRESENT_A = "worker.delegate" as const;
const PRESENT_B = "memory.save" as const;
const HIDDEN_A = "llm.set_key" as const;
const HIDDEN_B = "repo.clone" as const;

async function session(tools: ReturnType<typeof stub>[], presentSelectedTools: boolean) {
  return createBantoHostSession({
    systemPrompt: "You are the Banto host under test.",
    tools,
    presentSelectedTools,
    cwd: process.cwd(),
    loadBantoSkills: false,
    model: getModel("anthropic", "claude-sonnet-4-5-20250929"),
    modelRuntime: await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      modelsPath: null,
    }),
    sessionManager: SessionManager.inMemory(),
  });
}

describe("[ADR-0019] 在庫と提示を分ける", () => {
  it("表に無い道具はモデルに渡らない（提示）", async () => {
    const tools = [stub(HIDDEN_A), stub(PRESENT_A), stub(HIDDEN_B), stub(PRESENT_B)];
    const { session: s } = await session(tools, true);
    const active = s.getActiveToolNames();
    assert.ok(active.includes(toWireToolName(PRESENT_A)));
    assert.ok(active.includes(toWireToolName(PRESENT_B)));
    assert.ok(!active.includes(toWireToolName(HIDDEN_A)));
    assert.ok(!active.includes(toWireToolName(HIDDEN_B)));
  });

  it("隠した道具も**在庫には残る**——GUI の HTTP 面と逆引きが生きる", async () => {
    const tools = [stub(HIDDEN_A), stub(PRESENT_A)];
    const { session: s } = await session(tools, true);
    // getAllTools は登録簿。ここから消えると module-serve と wire名逆引きが壊れる
    const all = s.getAllTools().map((t) => t.name);
    assert.ok(all.includes(toWireToolName(HIDDEN_A)), "隠した道具が在庫から消えている");
    assert.ok(all.includes(toWireToolName(PRESENT_A)));
  });

  it("提示の順は表の順（決定85）——登録順ではない", async () => {
    // 表では worker.delegate が memory.save より先。登録は逆順で渡す
    const tools = [stub(PRESENT_B), stub(PRESENT_A)];
    const { session: s } = await session(tools, true);
    const active = s.getActiveToolNames();
    assert.deepEqual(active, [toWireToolName(PRESENT_A), toWireToolName(PRESENT_B)]);
  });

  it("既定（false）では従来どおり全部見せる", async () => {
    const tools = [stub(HIDDEN_A), stub(PRESENT_A)];
    const { session: s } = await session(tools, false);
    const active = s.getActiveToolNames();
    assert.ok(active.includes(toWireToolName(HIDDEN_A)));
    assert.ok(active.includes(toWireToolName(PRESENT_A)));
  });

  it("表の道具が1本も無いなら、黙って道具ゼロにせず失敗する（I2）", async () => {
    await assert.rejects(
      () => session([stub(HIDDEN_A), stub(HIDDEN_B)], true),
      /PRESENTED_TOOL_NAMES/
    );
  });

  it("散文の一覧はドメイン単位。道具1本ずつを再掲しない（決定84-5）", async () => {
    // 本番と同じく、1ドメインに複数本あるときは `worker.*` と畳む
    const picked = selectPresentedTools([
      stub(PRESENT_A),
      stub("worker.close"),
      stub(PRESENT_B),
      stub("memory.recall"),
      stub(HIDDEN_A),
    ]);
    const prose = renderToolCategories(picked);
    assert.match(prose, /# Available tools/);
    assert.match(prose, /worker\.\*/);
    assert.match(prose, /memory\.\*/);
    // 隠したドメインは出さない
    assert.ok(!prose.includes("llm."));
    // 道具名の全列挙をしない（決定84-2「盛らない」）
    assert.ok(!prose.includes("worker.delegate"));
    assert.ok(!prose.includes("worker.close"));
  });

  it("ドメインに1本しか無いときは、その道具名で出す", () => {
    const prose = renderToolCategories(selectPresentedTools([stub("inbox.post")]));
    assert.match(prose, /\*\*inbox\.post\*\*/);
  });

  it("散文の一覧がシステムプロンプトに載る（載っていなかったのが元の欠陥）", async () => {
    const { session: s } = await session([stub(PRESENT_A)], true);
    assert.match(s.agent.state.systemPrompt, /# Available tools/);
  });

  it("提示しないときは散文の一覧も出さない", async () => {
    const { session: s } = await session([stub(PRESENT_A)], false);
    assert.ok(!s.agent.state.systemPrompt.includes("# Available tools"));
  });

  it("表は wire 名に変換できる名前だけを持つ（決定22）", () => {
    for (const name of PRESENTED_TOOL_NAMES) {
      assert.match(name, /^[a-z][a-z0-9]*\./, `表の名前が名前空間つきでない: ${name}`);
      assert.doesNotThrow(() => toWireToolName(name));
    }
    // 重複が入ると同じ道具を二度提示することになる
    assert.equal(new Set(PRESENTED_TOOL_NAMES).size, PRESENTED_TOOL_NAMES.length);
  });

  it("在庫に無い名前が表にあっても落ちない（Kobo 無しの構成が正当にある）", () => {
    const picked = presentedWireNames([stub(PRESENT_A)]);
    assert.deepEqual(picked, [toWireToolName(PRESENT_A)]);
  });
});
