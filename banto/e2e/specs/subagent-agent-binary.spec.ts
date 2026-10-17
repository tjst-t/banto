// **エージェントの本体を取ってくる**（決定・2026-10-17、アーキ仕様 §4.1「エージェントの本体を取ってくる」）。偽のエージェント
// `fake` は本物の opencode と同じ道を通る：core が目録（`BANTO_AGENT_BINARY_CATALOG`、`agent-binary-fixture.ts` の偽の登録簿）
// から取ってきて sha512 で確かめ、1件だけ取り出して host の置き場に置き、この機械のコンテナには親を読み取り専用で見せる。
//
// 見るもの（規則14——呼べたで終わらせず、置き場・コンテナの中・設定画面の文まで）：
//   1. 設定画面の「本体（この機械）」が置き場の様子と合う（まだ無ければ「まだありません——…約1KB」）
//   2. 頼むと取ってきて、その本体で仕事が通る。呼び出しに進み具合が流れる
//   3. host の置き場：版のフォルダ（0555）に実行ファイル1本（0755・中身が登録簿のもの）。作業フォルダは残らない
//   4. コンテナの中から同じパスで見え、書けない（読み取り専用）
//   5. 二度目は取らない（登録簿への頼みが増えない）。設定画面は「取ってきました（版 0.0.1・1KB）」
import { test, expect, type Page } from "../test-base.js";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AUTH_TOKEN, CORE_BASE_URL, DATA_DIR } from "../config.js";
import { openApp } from "../helpers.js";
import { FAKE_AGENT_BINARY_PATH, FAKE_AGENT_BINARY_SCRIPT, agentBinaryFixture } from "../agent-binary-fixture.js";

test.setTimeout(300_000);

const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${CORE_BASE_URL}${path}`, {
    method: init.method ?? "GET",
    headers: { ...headers, "content-type": "application/json" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

/** AI が通る経路そのもの（代理サーバ）で、その Project の Module の tool を呼ぶ。届いた進み具合も返す */
async function callTool(
  connName: string,
  tool: string,
  args: Record<string, unknown>,
  ctx: { projectId: string; threadId?: string },
): Promise<{ text: string; isError: boolean; progress: string[] }> {
  const client = new Client({ name: "e2e-agent-binary", version: "0.0.0" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${CORE_BASE_URL}/agent-relay/${connName}`), {
      requestInit: {
        headers: { ...headers, "x-banto-project-id": ctx.projectId, ...(ctx.threadId ? { "x-banto-thread-id": ctx.threadId } : {}) },
      },
    }),
  );
  const progress: string[] = [];
  try {
    const result = (await client.callTool({ name: tool, arguments: args }, undefined, {
      timeout: 180_000,
      onprogress: (p) => void progress.push(p.message ?? ""),
    })) as { content: Array<{ text?: string }>; isError?: boolean };
    return { text: result.content.map((c) => c.text ?? "").join(""), isError: result.isError === true, progress };
  } finally {
    await client.close();
  }
}

async function hits(): Promise<number> {
  const all = (await (await fetch(agentBinaryFixture().hitsUrl)).json()) as Record<string, number>;
  return all[FAKE_AGENT_BINARY_PATH] ?? 0;
}

async function openSubagentSettings(page: Page) {
  await page.goto("/settings");
  await page.getByRole("button", { name: "サブエージェント", exact: true }).click();
  const canvas = page.locator('[data-testid="module-settings-canvas"][data-module="subagent-settings"]');
  await expect(canvas, "サブエージェントの設定画面が出ていない").toBeVisible({ timeout: 30_000 });
  return canvas.locator("iframe").contentFrame().frameLocator("iframe");
}

test("偽のエージェントの本体を取ってきて、コンテナから同じパスで読み取り専用に見え、その本体で仕事が通る。二度目は取らない", async ({ page }) => {
  const root = join(DATA_DIR, "agent-binaries");
  // この core の置き場の版のフォルダ（前の spec が取っていれば消して、取る道を通す。同じ core の spec は一度に1本）
  for (const name of existsSync(root) ? readdirSync(root) : []) {
    spawnSync("chmod", ["-R", "u+w", join(root, name)]);
    spawnSync("rm", ["-rf", join(root, name)]);
  }
  expect(statSync(root).mode & 0o777, "親は 0755 で作られている").toBe(0o755);

  // ---- 1. 設定画面：まだ無い -----------------------------------------------------------------------------
  await openApp(page);
  let inner = await openSubagentSettings(page);
  await expect(inner.locator('[data-role="agent-binary"]')).toHaveText("本体（この機械）：まだありません——初めて使うときに約1KB を取ってきます", {
    timeout: 30_000,
  });
  await expect(inner.locator('section.card[data-agent="fake"] [data-role="agent-binary"]')).toHaveAttribute("data-state", "absent");
  // 本体のログインを使うほうには出ない
  await expect(inner.locator('section.card[data-agent="fake-host"] [data-role="agent-binary"]')).toHaveCount(0);

  // ---- 2. 頼むと取ってきて、その本体で仕事が通る ----------------------------------------------------------
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-agent-binary-"));
  const created = await api<{ id: string }>("/api/projects", { method: "POST", body: { name: `E2E 本体を取ってくる ${Date.now()}`, root: projectRoot } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const projectId = created.body.id;
  const threadId = (await api<{ id: string }>(`/api/projects/${projectId}/threads`, { method: "POST" })).body.id;
  // 既定の鍵（Vault）を名前で引くので、人への承認を自動で通す
  expect((await api(`/api/projects/${projectId}/auto-approve`, { method: "PUT", body: { enabled: true } })).status).toBe(200);
  await expect
    .poll(async () => (await api<{ connected?: string[] }>(`/api/projects/${projectId}/modules/prepare`, { method: "POST" })).body.connected ?? [], {
      timeout: 120_000,
    })
    .toEqual(expect.arrayContaining(["subagent", "shell"]));

  const before = await hits();
  const first = await callTool(`subagent-${projectId}`, "runSubagent", { agent: "fake", prompt: "本体から起きた" }, { projectId, threadId });
  expect(first.isError, first.text).toBe(false);
  expect((JSON.parse(first.text) as { text: string }).text).toContain("本体から起きた");
  expect(await hits(), "登録簿から取っていない").toBe(before + 1);
  expect(first.progress.some((m) => m.startsWith("Fake Agent を取ってきています")), `進み具合が呼び出しに届かない：${JSON.stringify(first.progress)}`).toBe(true);

  // ---- 3. host の置き場 -----------------------------------------------------------------------------------
  const dirs = readdirSync(root);
  expect(dirs, "版のフォルダが1つだけ（作業フォルダが残っていない）").toHaveLength(1);
  expect(dirs[0]).toMatch(/^fake-0\.0\.1-x64(-baseline)?-[0-9a-f]{12}$/);
  const dir = join(root, dirs[0]!);
  expect(readdirSync(dir)).toEqual(["fake"]);
  expect(statSync(dir).mode & 0o777).toBe(0o555);
  expect(statSync(join(dir, "fake")).mode & 0o777).toBe(0o755);
  expect(readFileSync(join(dir, "fake"), "utf8")).toBe(FAKE_AGENT_BINARY_SCRIPT);

  // ---- 4. コンテナの中から同じパスで見え、書けない ----------------------------------------------------------
  const inside = await callTool(
    `shell-${projectId}`,
    "runCommand",
    { command: `cat ${join(dir, "fake")}; touch ${join(root, "x")} 2>/dev/null && echo writable || echo readonly` },
    { projectId, threadId },
  );
  expect(inside.isError, inside.text).toBe(false);
  const out = JSON.parse(inside.text) as { stdout: string; exitCode: number };
  expect(out.stdout).toBe(`${FAKE_AGENT_BINARY_SCRIPT}readonly\n`);

  // ---- 5. 二度目は取らない。設定画面は取ってきたと出す -------------------------------------------------------
  const second = await callTool(`subagent-${projectId}`, "runSubagent", { agent: "fake", prompt: "二度目" }, { projectId, threadId });
  expect(second.isError, second.text).toBe(false);
  expect((JSON.parse(second.text) as { text: string }).text).toContain("二度目");
  expect(await hits(), "二度目も取った").toBe(before + 1);

  inner = await openSubagentSettings(page);
  await expect(inner.locator('section.card[data-agent="fake"] [data-role="agent-binary"]')).toHaveText("本体（この機械）：取ってきました（版 0.0.1・1KB）", {
    timeout: 30_000,
  });
  await expect(inner.locator('section.card[data-agent="fake"] [data-role="agent-binary"]')).toHaveAttribute("data-state", "present");
});
