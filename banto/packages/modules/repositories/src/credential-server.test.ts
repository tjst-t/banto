// clone の間の資格情報の窓口：決めた相手（protocol・host）にだけ渡し、helper の引数に秘密が無く、閉じたら消える
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { openCredentialWindow } from "./credential-server.js";

/** git と同じ形で helper を呼ぶ（`!` の後をシェルで、最後に `get`） */
function ask(helperCommand: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", `${helperCommand.slice(1)} get`], { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.on("error", reject);
    child.on("close", () => resolve(out));
    child.stdin.end(input);
  });
}

test("決めた相手にだけ username と password を渡す。helper の引数に秘密は無く、閉じたら窓口ごと消える", async () => {
  const w = await openCredentialWindow({ protocol: "https", host: "github.com", username: "alice", password: "ghu_window_secret_1" });
  assert.ok(!w.helperCommand.includes("ghu_window_secret_1"), "helper の引数に秘密が入っている");
  assert.equal(await ask(w.helperCommand, "protocol=https\nhost=github.com\n\n"), "username=alice\npassword=ghu_window_secret_1\n");
  // 別の相手（リダイレクト先など）・暗号化しない http には渡さない
  assert.equal(await ask(w.helperCommand, "protocol=https\nhost=evil.example.com\n\n"), "");
  assert.equal(await ask(w.helperCommand, "protocol=http\nhost=github.com\n\n"), "");
  assert.equal(w.served(), 1);
  const socket = w.helperCommand.match(/"([^"]+\/s)"$/)![1]!;
  assert.ok(existsSync(socket));
  await w.close();
  assert.ok(!existsSync(socket), "閉じたのに窓口が残っている");
});
