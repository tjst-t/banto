import { test } from "node:test";
import assert from "node:assert/strict";
import { decideCanvasMessage } from "./canvas-message.ts";
import { quoteFromAttachment, quoteSourceLabel, quoteToAttachment } from "../canvas-quotes.ts";

const ok = { fromConversation: true, activated: true, role: "user", content: [{ type: "text", text: "`a.pdf` へのコメント（1件）" }] };

test("ui/message は会話の中の画面から・人が押した直後・文だけを受ける", () => {
  assert.deepEqual(decideCanvasMessage(ok), { text: "`a.pdf` へのコメント（1件）" });
  assert.match((decideCanvasMessage({ ...ok, fromConversation: false }) as { error: string }).error, /会話の外/);
  assert.match((decideCanvasMessage({ ...ok, activated: false }) as { error: string }).error, /押した直後/);
  assert.match((decideCanvasMessage({ ...ok, role: "assistant" }) as { error: string }).error, /role/);
  assert.match((decideCanvasMessage({ ...ok, content: [{ type: "image", data: "x", mimeType: "image/png" }] }) as { error: string }).error, /文/);
  assert.match((decideCanvasMessage({ ...ok, content: [] }) as { error: string }).error, /中身/);
  assert.match((decideCanvasMessage({ ...ok, content: [{ type: "text", text: " " }] }) as { error: string }).error, /空/);
  assert.match((decideCanvasMessage({ ...ok, content: [{ type: "text", text: "あ".repeat(20_001) }] }) as { error: string }).error, /長すぎ/);
  assert.deepEqual(decideCanvasMessage({ ...ok, content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), { text: "a\n\nb" });
});

test("塊は添付の形で出所を持ち回り、第三者は強く出す", () => {
  const quote = { module: "filesystem", thirdParty: false, slot: "filesystem ui://x {}", text: "本文" };
  const attachment = quoteToAttachment(quote);
  assert.equal(attachment.name, "filesystem の画面から");
  assert.deepEqual(quoteFromAttachment({ id: attachment.id!, type: attachment.type!, content: attachment.content as never }), quote);
  assert.equal(quoteSourceLabel({ module: "outsider", thirdParty: true }), "第三者の Module「outsider」の画面から");
  // 画像の添付は塊ではない
  assert.equal(quoteFromAttachment({ id: "x", type: "image", content: [] }), undefined);
  // 出所の読めないものは第三者として扱う
  const odd = quoteFromAttachment({ id: 'canvas-quote:{"module":"m","slot":"s"}', type: "banto-canvas-quote", content: [{ type: "text", text: "t" }] });
  assert.equal(odd?.thirdParty, true);
});

test("見回りの気づきの引用は、出所を「見回り〈名前〉の気づきの引用」と出し、添付に戻しても見回りの名前が残る", () => {
  const quote = { module: "banto", thirdParty: true, slot: "3:0", text: "題：CI", patrol: "CI の見回り" };
  assert.equal(quoteSourceLabel(quote), "見回り〈CI の見回り〉の気づきの引用");
  const attachment = quoteToAttachment(quote);
  assert.equal(attachment.name, "見回り〈CI の見回り〉の気づきの引用");
  assert.deepEqual(quoteFromAttachment({ id: attachment.id!, type: attachment.type!, content: attachment.content as never }), quote);
});
