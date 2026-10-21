// **小さいモデルを1回呼ぶ口の、本物の SDK との疎通確認**（`npm run check:one-shot`、Backlog #497）。
// 実際の API を叩く（課金される）ので自動の試験には含めない。`askSmallModel` を変えたとき・SDK を上げたときに回す。
// 人の `~/.claude` に記録を残さない（`adapter.smoketest.mjs` と同じ置き方。認証だけ本物の置き場から読む）
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
const scratch = mkdtempSync(join(tmpdir(), "banto-check-one-shot-"));
process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ??= join(homedir(), ".claude");
process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude");
process.chdir(scratch);
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

const { askSmallModel, SMALL_MODEL } = await import("../../dist/runner/one-shot.js");

const started = Date.now();
const title = await askSmallModel({
  systemPrompt: "人の書き込みに、日本語で20字以内の題を1行だけ付ける。題だけを書く",
  prompt: "家計簿を付けるアプリを作りたい。レシートを撮ったら自動で分類してほしい",
});
const ok = title.length > 0 && !title.includes("\n");
console.log(`${ok ? "OK  " : "FAIL"} ${SMALL_MODEL} で1回呼んで題が返る — 「${title}」（${Date.now() - started}ms）`);
if (!ok) process.exitCode = 1;
