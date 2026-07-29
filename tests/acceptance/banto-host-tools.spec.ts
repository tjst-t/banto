/**
 * banto-host の Tool 契約基盤の受け入れ検証。
 *
 * task-0004: 名前空間規則（ADR-0010 決定9）の型・登録関数の土台、pi SDKモードでの最小セッション
 * task-0006: 論理名↔wire名アダプタ（ADR-0010 決定22）
 *
 * Kobo には一切接続しない——ADR-0010 決定1（結合はTool/SKILLの公開I/Fのみ）により、
 * ローカルのスタブToolを挿せば番頭側のフレームワークだけを単体で検証できる。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getModel } from "@mariozechner/pi-ai";
import { AuthStorage, ModelRegistry, SessionManager } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

import {
  assertNamespacedToolName,
  createBantoHostSession,
  createToolRegistry,
  defineNamespacedTool,
  fromWireToolName,
  isNamespacedToolName,
  toolDomain,
  toWireTool,
  toWireToolName,
} from "@banto/host";

/** A stub tool standing in for a future Kobo tool. Returns a fixed result; touches nothing. */
function makeStubTool(name: `${string}.${string}`) {
  return defineNamespacedTool({
    name,
    label: name,
    description: `Stub tool ${name} (no Kobo connection).`,
    parameters: Type.Object({
      projectTag: Type.Optional(Type.String({ description: "optional project tag" })),
    }),
    async execute() {
      return { content: [{ type: "text" as const, text: `${name} ok` }], details: {} };
    },
  });
}

describe("[task-0004] Tool namespace convention (<domain>.<verb>, ADR-0010 決定9)", () => {
  it("[task-0004] accepts names that follow <domain>.<verb...>", () => {
    for (const name of ["kobo.query.ready", "kobo.action.spawn_worker", "canvas.open", "canvas.switch"]) {
      assert.equal(isNamespacedToolName(name), true, `${name} should be valid`);
    }
  });

  it("[task-0004] rejects names without a well-formed domain prefix", () => {
    for (const name of ["report_phase", "ready", "", "kobo.", ".ready", "Kobo.Query", "kobo.1query"]) {
      assert.equal(isNamespacedToolName(name), false, `${name} should be rejected`);
    }
  });

  it("[task-0004] assertNamespacedToolName throws for a malformed name (I2)", () => {
    assert.throws(() => assertNamespacedToolName("report_phase"), /namespace convention/);
  });

  it("[task-0004] toolDomain extracts the domain segment", () => {
    assert.equal(toolDomain("kobo.query.ready"), "kobo");
    assert.equal(toolDomain("canvas.open"), "canvas");
  });
});

describe("[task-0006] Logical name ↔ wire name adapter (ADR-0010 決定22)", () => {
  it("[task-0006] maps dotted logical names to underscore wire names", () => {
    assert.equal(toWireToolName("kobo.query.ready"), "kobo__query__ready");
    assert.equal(toWireToolName("canvas.open"), "canvas__open");
    // Single underscores inside a segment survive untouched.
    assert.equal(toWireToolName("kobo.action.spawn_worker"), "kobo__action__spawn_worker");
  });

  it("[task-0006] wire names use only characters openai-completions providers accept", () => {
    for (const logical of ["kobo.query.ready", "canvas.open", "kobo.action.spawn_worker"]) {
      assert.match(toWireToolName(logical as `${string}.${string}`), /^[a-zA-Z0-9_-]+$/);
    }
  });

  it("[task-0006] round-trips logical → wire → logical", () => {
    for (const logical of ["kobo.query.ready", "canvas.open", "kobo.action.spawn_worker", "a.b.c.d"]) {
      assert.equal(fromWireToolName(toWireToolName(logical as `${string}.${string}`)), logical);
    }
  });

  it("[task-0006] fromWireToolName throws when the result is not a valid logical name (I2)", () => {
    assert.throws(() => fromWireToolName("not_namespaced"), /namespace convention/);
  });

  it("[task-0006] a1/a2: the mapping is injective — ambiguous segments are rejected outright", () => {
    // `kobo__x.ready` and `kobo.x.ready` would both produce `kobo__x__ready`. The segment
    // grammar forbids consecutive underscores precisely so that case cannot arise.
    assert.equal(isNamespacedToolName("kobo__x.ready"), false);
    assert.throws(() => toWireToolName("kobo__x.ready" as `${string}.${string}`), /namespace convention/);
    // Trailing underscore is likewise rejected (would round-trip ambiguously).
    assert.equal(isNamespacedToolName("kobo_.ready"), false);

    // Distinct valid names never share a wire name.
    const names = ["kobo.query.ready", "kobo.query_ready", "kobo.query.ready_now", "canvas.open"];
    const wire = names.map((n) => toWireToolName(n as `${string}.${string}`));
    assert.equal(new Set(wire).size, names.length, `wire names must be distinct: ${wire.join(", ")}`);
  });

  it("[task-0006] toWireTool renames only `name`, preserving the rest of the contract", () => {
    const tool = makeStubTool("kobo.query.ready");
    const wired = toWireTool(tool);
    assert.equal(wired.name, "kobo__query__ready");
    assert.equal(wired.description, tool.description);
    assert.equal(wired.parameters, tool.parameters);
    assert.equal(wired.execute, tool.execute);
  });
});

describe("[task-0004][task-0006] Tool registry", () => {
  it("[task-0004] register/get/list/byDomain round-trip", () => {
    const registry = createToolRegistry();
    registry.register(makeStubTool("kobo.query.ready"));

    assert.deepEqual(registry.list().map((t) => t.name), ["kobo.query.ready"]);
    assert.equal(registry.get("kobo.query.ready")?.name, "kobo.query.ready");
    assert.equal(registry.get("kobo.query.nonexistent"), undefined);
    assert.deepEqual(registry.byDomain("kobo").map((t) => t.name), ["kobo.query.ready"]);
    assert.deepEqual(registry.byDomain("canvas"), []);
  });

  it("[task-0004] rejects re-registering the same tool name (I2)", () => {
    const registry = createToolRegistry();
    registry.register(makeStubTool("kobo.query.ready"));
    assert.throws(() => registry.register(makeStubTool("kobo.query.ready")), /already registered/);
  });

  it("[task-0006] a3: getByWireName maps a provider-side name back to the logical contract", () => {
    const registry = createToolRegistry();
    registry.register(makeStubTool("kobo.query.ready"));
    registry.register(makeStubTool("canvas.open"));

    assert.equal(registry.getByWireName("kobo__query__ready")?.name, "kobo.query.ready");
    assert.equal(registry.getByWireName("canvas__open")?.name, "canvas.open");
    assert.equal(registry.getByWireName("kobo.query.ready"), undefined);
    assert.equal(registry.getByWireName("unknown__tool"), undefined);
  });

  it("[task-0004] defineNamespacedTool rejects a malformed name at construction", () => {
    assert.throws(
      () =>
        defineNamespacedTool({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately bypassing the
          // NamespacedToolName type to exercise the runtime guard (I2) from a test
          name: "not_namespaced" as any,
          label: "Bad",
          description: "Malformed name",
          parameters: Type.Object({}),
          async execute() {
            return { content: [], details: {} };
          },
        }),
      /namespace convention/
    );
  });
});

describe("[task-0004][task-0006] Minimal SDK-mode session (no Kobo, no network)", () => {
  it("[task-0004] wires the system prompt and registers tools under their wire names", async () => {
    const koboReadyTool = makeStubTool("kobo.query.ready");

    const model = getModel("anthropic", "claude-opus-4-5");
    assert.ok(model, "claude-opus-4-5 should resolve from the built-in model registry");

    // Fully in-memory / hermetic: no filesystem writes, no network, no API key needed
    // to construct the session (only to actually call session.prompt()).
    const authStorage = AuthStorage.inMemory();
    const { session } = await createBantoHostSession({
      systemPrompt: "You are the Banto host skeleton under test.",
      tools: [koboReadyTool],
      cwd: process.cwd(),
      model,
      authStorage,
      modelRegistry: ModelRegistry.inMemory(authStorage),
      sessionManager: SessionManager.inMemory(),
    });

    // pi appends discovered context files (this repo's own CLAUDE.md) after the override base.
    assert.ok(session.agent.state.systemPrompt.startsWith("You are the Banto host skeleton under test."));
    assert.equal(session.agent.state.model?.id, model.id);

    // 決定22: the provider sees the wire name, never the dotted logical name.
    const registeredTool = session.agent.state.tools.find((t) => t.name === "kobo__query__ready");
    assert.ok(registeredTool, "the tool must be registered under its wire name");
    assert.equal(
      session.agent.state.tools.some((t) => t.name === "kobo.query.ready"),
      false,
      "the dotted logical name must not be handed to the provider"
    );

    // No built-in coding tools — 番頭 delegates file-level work to 職人 (D10).
    for (const builtin of ["read", "bash", "edit", "write"]) {
      assert.equal(
        session.agent.state.tools.some((t) => t.name === builtin),
        false,
        `${builtin} should not be active on the Banto host session`
      );
    }

    // One tool round trip: invoke exactly what the LLM would invoke.
    const result = await registeredTool!.execute("test-call-1", {}, undefined, undefined);
    assert.deepEqual(result, {
      content: [{ type: "text", text: "kobo.query.ready ok" }],
      details: {},
    });

    session.dispose();
  });
});
