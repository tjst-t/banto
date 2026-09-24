// **本物の Agent SDK との疎通確認**（`npm run check:agent-sdk`）。仕様 §6.5「実 LLM を使う
// E2E spec は作らない。SDK との接触は疎通確認1本に集約する」の、その1本。
//
// 実際の Anthropic API を叩く（課金される。安く済むよう Haiku で走らせる）ので、自動の試験には
// 含めない。**SDK を上げたら必ず回す**——E2E は偽 Runner なので、SDK の振る舞いの変化は
// ここでしか捕まらない。
//
// 見るもの（どれも banto が SDK に頼っている振る舞い）：
//   1. 選べるモデルの一覧が返る（`listModels`、runner/models.ts）
//   2. 1ターン目が返事をし、セッション id と文脈使用量が返る。選んだモデルで走る
//   3. **resume したターンでは、そのターンに渡した system prompt が効く**
//      ——SDK 0.3.267 から既定で「最初に記録した prompt を使い回す」になった。banto は
//      毎ターン組み立て直したものを使わせる（`snapshot: false`、adapter.ts）。ここが崩れると、
//      モデルを変えた後も AI が古いモデル名を名乗り、Fork の Memory の差し替えが効かない
import { listModels, runTurn } from "../../dist/runner/adapter.js";

const MODEL = "haiku";
let failed = false;
function check(ok, label, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
}

async function turn(opts) {
  const gen = runTurn({ permissionMode: "auto", model: MODEL, ...opts });
  const texts = [];
  let initModel;
  for (;;) {
    const step = await gen.next();
    if (step.done) return { ...step.value, text: texts.join(""), initModel };
    const event = step.value;
    if (event.type !== "message") continue;
    const m = event.message;
    if (m.type === "system" && m.subtype === "init") initModel = m.model;
    if (m.type === "assistant") {
      for (const block of m.message.content ?? []) if (block.type === "text") texts.push(block.text);
    }
  }
}

// ---- 1. 選べるモデル -------------------------------------------------------------
const models = await listModels();
const def = models.find((m) => m.value === "default");
check(models.length > 0 && def !== undefined, "モデルの一覧が返る", models.map((m) => `${m.value}→${m.resolvedModel ?? "?"}`).join(", "));

// ---- 2. 1ターン目 ----------------------------------------------------------------
const first = await turn({
  prompt: "Reply with exactly the single word: pong",
  systemPrompt: ["You are a terse test assistant.", "The codeword is PELICAN."],
});
check(/pong/i.test(first.text), "1ターン目が返事をする", JSON.stringify(first.text.slice(0, 80)));
check(Boolean(first.sessionId), "セッション id が返る", first.sessionId);
check(first.contextUsage !== undefined, "文脈使用量が返る（getContextUsage）");
check(typeof first.initModel === "string" && /haiku/i.test(first.initModel), "選んだモデルで走る", first.initModel);

// ---- 3. resume したターンの system prompt ------------------------------------------
const second = await turn({
  prompt: "What is the codeword stated in your system prompt? Reply with the codeword only.",
  systemPrompt: ["You are a terse test assistant.", "The codeword is WALRUS."],
  resumeSessionId: first.sessionId,
});
check(
  /WALRUS/i.test(second.text) && !/PELICAN/i.test(second.text),
  "resume したターンでは、そのターンに渡した system prompt が効く（snapshot: false）",
  JSON.stringify(second.text.slice(0, 80)),
);

if (failed) {
  console.error("FAIL: Agent SDK との疎通に問題があります");
  process.exit(1);
}
console.log("OK");
process.exit(0);
