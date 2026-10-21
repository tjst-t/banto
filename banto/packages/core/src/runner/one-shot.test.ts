import { test } from "node:test";
import assert from "node:assert/strict";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { askSmallModel, SMALL_MODEL, type OneShotQuery } from "./one-shot.js";

/** 偽の Runner：受けた引数を覚え、決めたメッセージを流す */
function fakeRunner(messages: unknown[]): { run: OneShotQuery; calls: Array<{ prompt: string; options: Options }> } {
  const calls: Array<{ prompt: string; options: Options }> = [];
  return {
    calls,
    run: (params) => {
      calls.push(params);
      return (async function* () {
        for (const m of messages) yield m as SDKMessage;
      })();
    },
  };
}

const success = (result: string) => ({ type: "result", subtype: "success", is_error: false, result });

test("書き込みを渡すと、答えの最初の空でない行を1行で返す。道具なし・1ターン・記録なし・人の設定を混ぜない", async () => {
  const f = fakeRunner([{ type: "system", subtype: "init" }, success("\n  家計簿アプリの相談  \n2行目は捨てる\n")]);
  const env = { ANTHROPIC_BASE_URL: "http://127.0.0.1:1/claude-login" };
  const title = await askSmallModel({ systemPrompt: "題を付ける", prompt: "家計簿を作りたい", env, sessionId: "s-once" }, f.run);
  assert.equal(title, "家計簿アプリの相談");
  assert.equal(f.calls.length, 1);
  const { prompt, options } = f.calls[0]!;
  assert.equal(prompt, "家計簿を作りたい");
  assert.equal(options.model, SMALL_MODEL);
  assert.equal(options.systemPrompt, "題を付ける");
  assert.deepEqual(options.tools, []);
  assert.equal(options.maxTurns, 1);
  assert.equal(options.persistSession, false);
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.env, env);
  assert.equal(options.sessionId, "s-once");
});

test("モデルを渡せば、それで呼ぶ", async () => {
  const f = fakeRunner([success("題")]);
  await askSmallModel({ systemPrompt: "", prompt: "x", model: "haiku" }, f.run);
  assert.equal(f.calls[0]!.options.model, "haiku");
});

test("エラーで終わったら、理由を添えて投げる", async () => {
  const f = fakeRunner([{ type: "result", subtype: "error_during_execution", is_error: true, errors: ["401 Unauthorized"] }]);
  await assert.rejects(askSmallModel({ systemPrompt: "", prompt: "x" }, f.run), /失敗しました（error_during_execution）: 401 Unauthorized/);
});

test("success でも is_error なら投げる（API のエラーの文が result に入る）", async () => {
  const f = fakeRunner([{ type: "result", subtype: "success", is_error: true, result: "API Error: 529 Overloaded" }]);
  await assert.rejects(askSmallModel({ systemPrompt: "", prompt: "x" }, f.run), /529 Overloaded/);
});

test("答えが空・届かない・途中で落ちたら投げる", async () => {
  await assert.rejects(askSmallModel({ systemPrompt: "", prompt: "x" }, fakeRunner([success(" \n ")]).run), /答えが空/);
  await assert.rejects(askSmallModel({ systemPrompt: "", prompt: "x" }, fakeRunner([]).run), /届きませんでした/);
  const broken: OneShotQuery = () =>
    (async function* (): AsyncGenerator<SDKMessage> {
      throw new Error("CLI が落ちた");
    })();
  await assert.rejects(askSmallModel({ systemPrompt: "", prompt: "x" }, broken), /CLI が落ちた/);
});

test("止めたら SDK の呼び出しも止める", async () => {
  const f = fakeRunner([success("題")]);
  const ac = new AbortController();
  ac.abort();
  await askSmallModel({ systemPrompt: "", prompt: "x", signal: ac.signal }, f.run);
  assert.equal(f.calls[0]!.options.abortController?.signal.aborted, true);
});
