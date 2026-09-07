// Vault の3段の可視性（Phase 1、`phase1-modules-verified-in-browser`）。
//
// Vault の道具は3段に分かれている（v4-modules.md §2.1）：
//   agent  … AI に見せてよい（申請するだけ）
//   module … 他の Module にだけ（**実際の値を取る**・SSH agent を立てる 等）
//   admin  … 人の管理操作（alias の作成・削除）
//
// **壊れていても静か**——AI に「値を取る道具」が見えていても、AI がたまたま
// 呼ばない限り画面は正常に見える。だから**見えていないことを直接確かめる**。
//
// AI の言葉づかいに頼らず、**AI がつながる経路そのもの**（host の中継）に
// 問い合わせて一覧を取る。これが Runner に見えているものと同じ。
import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

/** AI（Runner）に見えている vault の道具の一覧を、同じ経路で取る。 */
async function toolsVisibleToAgent(): Promise<string[]> {
  const client = new Client({ name: "e2e-visibility", version: "0.0.0" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${CORE_BASE_URL}/agent-relay/vault`), {
      requestInit: { headers: { authorization: `Bearer ${AUTH_TOKEN}` } },
    }),
  );
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name);
  } finally {
    await client.close();
  }
}

/** Module は**ターンで初めて起動する**ので、1ターン走らせてから見る。 */
async function ensureModulesConnected(): Promise<void> {
  const h = { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };
  const project = await (
    await fetch(`${CORE_BASE_URL}/api/projects`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ name: "E2E Vault Visibility", root: mkdtempSync(join(tmpdir(), "banto-e2e-vault-")) }),
    })
  ).json();
  const thread = await (
    await fetch(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { method: "POST", headers: h })
  ).json();
  const res = await fetch(`${CORE_BASE_URL}/api/threads/${thread.id}/messages`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ prompt: "「1」とだけ返して。" }),
  });
  await res.text(); // ターンの終わりまで読み切る
}

test("AI に見える vault の道具は申請系だけ——値を取る道具も管理操作も見えない", async () => {
  await ensureModulesConnected();
  const names = await toolsVisibleToAgent();

  // 申請する道具は見えている（Vault が動いていることの確認。
  // 片側だけでは「そもそも繋がっていない」と区別できない）
  expect(names, `AI に見えた道具: ${names.join(", ")}`).toContain("requestAlias");

  // **実際の値を取る道具・管理操作は、AI からは見えない**
  for (const hidden of ["resolveAlias", "startSshAgent", "generateKeypair", "verify"]) {
    expect(names, `${hidden} が AI から見えている（module 限定のはず）`).not.toContain(hidden);
  }
  for (const hidden of ["createAlias", "deleteAlias", "listAliases", "migrateTo"]) {
    expect(names, `${hidden} が AI から見えている（admin 限定のはず）`).not.toContain(hidden);
  }

  // Module 自身の申告（host だけが読む）も、AI の道具として漏れていない
  expect(names.some((n) => n.toLowerCase().includes("module"))).toBe(false);
});
