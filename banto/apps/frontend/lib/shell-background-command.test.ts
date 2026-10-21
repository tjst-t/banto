import { test } from "node:test";
import assert from "node:assert/strict";
import { shellBackgroundCommandOf } from "./shell-background-command.ts";

const started = JSON.stringify({ commandId: "cmd_1", status: "running", outputFile: "/x/commands/cmd_1/output.log" });

test("待たない形で流せた runCommand：Module 名と commandId（本文は文字列でも text の塊でも）", () => {
  assert.deepEqual(shellBackgroundCommandOf("mcp__shell__runCommand", { command: "sleep 9", runInBackground: true }, started), {
    server: "shell",
    commandId: "cmd_1",
  });
  assert.deepEqual(
    shellBackgroundCommandOf("mcp__my_shell__runCommand", { runInBackground: true }, [{ type: "text", text: started }]),
    { server: "my_shell", commandId: "cmd_1" },
  );
});

test("待つ形・断られた・まだ結果が無い・別の tool には何も足さない", () => {
  const waited = JSON.stringify({ stdout: "x", stderr: "", exitCode: 0 });
  assert.equal(shellBackgroundCommandOf("mcp__shell__runCommand", { command: "echo" }, waited), undefined);
  assert.equal(shellBackgroundCommandOf("mcp__shell__runCommand", { command: "echo" }, started), undefined, "待つ形なのに名乗った");
  assert.equal(shellBackgroundCommandOf("mcp__shell__runCommand", { runInBackground: true }, { error: "断りました" }), undefined);
  assert.equal(shellBackgroundCommandOf("mcp__shell__runCommand", { runInBackground: true }, undefined), undefined);
  assert.equal(shellBackgroundCommandOf("mcp__shell__runCommand", { runInBackground: true }, "待たない形が使えません"), undefined);
  assert.equal(shellBackgroundCommandOf("mcp__shell__listCommands", { runInBackground: true }, started), undefined);
  assert.equal(shellBackgroundCommandOf("runCommand", { runInBackground: true }, started), undefined);
});
