// **鍵を置き換えたら、その鍵で立てた ssh-agent は落とす**（追加・2026-10-07、値の置き換え `replaceSecretValue`）。
// 組み込み Vault（vault-local の vault.integration.test.ts）と同じ規律。Infisical の口は記録する接続で代え、
// ssh-keygen・ssh-agent・ssh-add は本物を使う
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { InfisicalBackend } from "./infisical-backend.js";
import { fakeConnection } from "./testing/fake-connection.js";

const execFileP = promisify(execFile);

test("鍵を置き換えると、古い鍵を抱えた ssh-agent を落とし、次は新しい鍵で立て直す（別の鍵の agent は残す）", async () => {
  const { conn } = fakeConnection();
  const backend = new InfisicalBackend(conn);
  try {
    const { privateKeyRef } = await backend.generateKeypair("ssh", "keys/deploy");
    const other = await backend.generateKeypair("ssh", "keys/other");
    const before = await backend.loadIntoAgent(privateKeyRef);
    const otherAgent = await backend.loadIntoAgent(other.privateKeyRef);

    const { publicKey: renewed } = await backend.generateKeypair("ssh", privateKeyRef);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(existsSync(before.socketPath), false, "置き換えたのに古い鍵の agent が残っている");
    assert.ok(existsSync(otherAgent.socketPath), "別の鍵の agent まで落とした");

    const after = await backend.loadIntoAgent(privateKeyRef);
    const listed = await execFileP("ssh-add", ["-L"], { env: { ...process.env, SSH_AUTH_SOCK: after.socketPath } });
    const body = (k: string) => k.trim().split(/\s+/).slice(0, 2).join(" ");
    assert.equal(body(listed.stdout), body(renewed), "立て直した agent が新しい鍵を持っていない");
  } finally {
    await backend.stopAgents();
  }
});
