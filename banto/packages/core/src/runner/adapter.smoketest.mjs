// 捨てる前提のスモークテストではない実装だが、実行そのものは1回きりの手動確認用。
// 実際のAnthropic APIを叩く（規則1——測る前に犯人を決めない、実際に動くことを確かめる）。
import { runTurn } from "../../dist/runner/adapter.js";

const result = await runTurn({
  prompt: "Reply with exactly the single word: pong",
  permissionMode: "auto",
});

console.log("sessionId:", result.sessionId);
console.log("message count:", result.messages.length);
const finalMessage = result.messages.find((m) => m.type === "result");
console.log("result subtype:", finalMessage?.subtype);
console.log("result text:", JSON.stringify(finalMessage?.result ?? finalMessage));

if (!result.sessionId) {
  console.error("FAIL: no sessionId returned");
  process.exit(1);
}
if (finalMessage?.subtype !== "success") {
  console.error("FAIL: turn did not succeed");
  process.exit(1);
}
console.log("OK");
