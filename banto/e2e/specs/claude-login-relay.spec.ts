// **Claude のログインの中継**（core に常設、決定・2026-09-27、`docs/specs/v4-security.md` §2）。
//
// Project のコンテナの環境には、core が中継の住所とその Project の合言葉・契約の種類を入れておく。Shell のコマンドは
// 何も書かずに本体のログインで推論を呼べ、本物のトークンは中に入らない。人は Project 設定で、使わせるかを切り替え、
// 使われた回数と時刻を見る。上流は偽物（`start-core.ts`——受け取った Authorization とパスを返す）。
//
// 見るもの（規則14——呼べたで終わらせず、何が上流に届いたか・画面に何が出たかまで）：
//   1. Shell のコマンドの環境に4つが入り、本物のトークンは入っていない
//   2. コマンドから中継を呼ぶと、上流には本物のトークンが届く。推論以外は断る
//   3. 同じ合言葉でも、コンテナの外（この試験のプロセス）からは断る（送り元の縛り）
//   4. Project 設定に「使わせる」（既定オン）・本体のログイン（契約）・回数・最後の時刻・直近の 401 が出る
//   5. 切ると、その時点で同じ合言葉が断られ、回数は増えない。入れ直しても古い合言葉は通らない
import { test, expect, type Page } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AUTH_TOKEN, CORE_BASE_URL } from "../config.js";
import { openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

interface Ran {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** AI を通さずに、AI が通る経路そのもの（代理サーバ）で runCommand を呼ぶ */
async function run(projectId: string, command: string): Promise<Ran> {
  const client = new Client({ name: "e2e-claude-login-relay", version: "0.0.0" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${CORE_BASE_URL}/agent-relay/shell-${projectId}`), { requestInit: { headers } }),
  );
  try {
    const result = await client.callTool({ name: "runCommand", arguments: { command } });
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Ran;
  } finally {
    await client.close();
  }
}

/** コマンドの中から中継へ POST し、状態と本文を1行ずつ返す */
const CALL_RELAY = (path: string) =>
  `curl -s -o /tmp/relay-out -w '%{http_code}\\n' -X POST "$ANTHROPIC_BASE_URL${path}" ` +
  `-H "authorization: Bearer $CLAUDE_CODE_OAUTH_TOKEN" -H 'content-type: application/json' -d '{}' && cat /tmp/relay-out`;

async function relayState(page: Page, projectId: string) {
  const res = await page.request.get(`${CORE_BASE_URL}/api/projects/${projectId}/claude-login`, { headers });
  return (await res.json()) as { enabled: boolean; stats: { requests: number; lastRequestAt?: string; lastUnauthorizedAt?: string } };
}

test("Claude のログインの中継：コンテナのコマンドから本体のログインで呼べ、Project 設定で見て切れる", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  const project = (await (
    await page.request.post(`${CORE_BASE_URL}/api/projects`, {
      headers,
      data: { name: "E2E Claude Login Relay", root: mkdtempSync(join(tmpdir(), "banto-e2e-claude-relay-")) },
    })
  ).json()) as { id: string };
  await page.request.post(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers });
  await expect
    .poll(
      async () => {
        const res = await page.request.post(`${CORE_BASE_URL}/api/projects/${project.id}/modules/prepare`, { headers });
        return ((await res.json()).connected ?? []) as string[];
      },
      { timeout: 120_000, message: "Shell が繋がるまで" },
    )
    .toEqual(expect.arrayContaining(["shell"]));

  // ---- 1. 環境に4つが入り、本物のトークンは入っていない ----------------------------------------------
  const env = await run(
    project.id,
    'echo "base=$ANTHROPIC_BASE_URL"; echo "secret=$CLAUDE_CODE_OAUTH_TOKEN"; ' +
      'echo "sub=$CLAUDE_CODE_SUBSCRIPTION_TYPE tier=$CLAUDE_CODE_RATE_LIMIT_TIER"; echo "real=$(env | grep -c e2e-not-a-token)"',
  );
  expect(env.exitCode, env.stderr).toBe(0);
  expect(env.stdout).toMatch(/^base=http:\/\/[0-9.]+:\d+\/claude-login$/m);
  expect(env.stdout).toContain("sub=max tier=e2e-tier");
  expect(env.stdout, "本物のトークンがコンテナの環境に入っている").toContain("real=0");
  const secret = /^secret=(banto-\S+)$/m.exec(env.stdout)?.[1];
  expect(secret, env.stdout).toBeTruthy();

  // ---- 2. 中継を呼ぶ：上流には本物のトークン。推論以外は断る --------------------------------------------
  const through = await run(project.id, CALL_RELAY("/v1/messages?beta=true"));
  expect(through.exitCode, through.stderr).toBe(0);
  const [status, body] = through.stdout.split("\n");
  expect(status).toBe("200");
  expect(JSON.parse(body!)).toEqual({ fakeUpstream: true, path: "/v1/messages?beta=true", auth: "Bearer e2e-not-a-token" });
  const other = await run(project.id, CALL_RELAY("/api/oauth/profile"));
  expect(other.stdout.split("\n")[0]).toBe("403");
  expect(other.stdout).toContain("推論");

  // ---- 3. 同じ合言葉でも、コンテナの外からは断る --------------------------------------------------------
  const outside = await page.request.post(`${CORE_BASE_URL}/claude-login/v1/messages`, {
    headers: { authorization: `Bearer ${secret}` },
    data: {},
  });
  expect(outside.status()).toBe(403);
  expect(await outside.text()).toContain("その Project のコンテナからしか使えません");
  expect((await relayState(page, project.id)).stats.requests, "断ったものまで数えている").toBe(1);

  // ---- 4. Project 設定に出る -----------------------------------------------------------------------------
  await openApp(page);
  await page.goto(`/settings?project=${project.id}&section=project-general`);
  const section = page.getByTestId("project-claude-login-section");
  await expect(section).toBeVisible({ timeout: 30_000 });
  const toggle = section.getByTestId("project-claude-login");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(section.getByTestId("project-claude-login-host")).toHaveText("ログインしています（契約：max）");
  await expect(section.getByTestId("project-claude-login-requests")).toHaveText("1 回（banto を起こしてから）");
  const lastAt = (await relayState(page, project.id)).stats.lastRequestAt!;
  await expect(section.getByTestId("project-claude-login-last")).toHaveText(
    await page.evaluate(
      (iso) => new Date(iso).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      lastAt,
    ),
  );
  await expect(section.getByTestId("project-claude-login-unauthorized")).toHaveText("ありません");

  // ---- 5. 切る → その時点で断られ、数えない。入れ直しても古い合言葉は通らない ---------------------------------
  await toggle.click();
  // **成功したときにだけ現れるもの**を待つ：host が切れたと答える
  await expect.poll(async () => (await relayState(page, project.id)).enabled, { timeout: 30_000 }).toBe(false);
  await expect(toggle).toBeEnabled({ timeout: 30_000 });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  const refused = await run(project.id, CALL_RELAY("/v1/messages"));
  expect(refused.stdout.split("\n")[0], "切ったのに通った").toBe("401");
  await page.reload();
  await expect(section.getByTestId("project-claude-login")).toHaveAttribute("aria-checked", "false", { timeout: 30_000 });
  await expect(section.getByTestId("project-claude-login-requests")).toHaveText("1 回（banto を起こしてから）");

  await section.getByTestId("project-claude-login").click();
  await expect.poll(async () => (await relayState(page, project.id)).enabled, { timeout: 30_000 }).toBe(true);
  await expect(section.getByTestId("project-claude-login")).toHaveAttribute("aria-checked", "true");
  const stale = await run(project.id, CALL_RELAY("/v1/messages"));
  expect(stale.stdout.split("\n")[0], "入れ直したのに古い合言葉が通った").toBe("401");

  expect(pageErrors).toEqual([]);
});
