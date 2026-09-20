// **ログインが要るリモート MCP に繋ぐ**（追加・2026-09-18、ユーザー指示）。
//
// 見るのは5つ（規則14——「押せた」で終わらせない）：
//   1. ログイン前は**繋がらず、「ログインが要る」とそうと分かる形で言う**
//      （「繋がりません」と一緒くたにすると、押すボタンがあることに気付けない）
//   2. 「ログインする」で**押し先の URL が返る**
//   3. 戻ってくると**金庫に `oauth-token` として入る**——人の一覧で見え、消せる
//   4. そのあと**実際に繋がって、AI から tool が呼べて中身が返る**
//   5. **PKCE を相手が本当に検証している**（fixture が確かめる。確かめない
//      相手だと、壊れていても通ってしまう）
//
// 相手は試験が立てる**認可サーバ＋資源サーバ**。本物（claude.ai のコネクタ等）を
// 叩かない——外の都合で落ちる試験は、機構の故障と見分けが付かない（規則6）。
import { test, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CORE_BASE_URL, AUTH_TOKEN, CORE_PORT } from "../config.js";
import { openApp } from "../helpers.js";
import { startOAuthMcpFixture, type OAuthFixture } from "../oauth-mcp-fixture.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

const STAMP = Date.now();
const MODULE = `e2e-oauth-${STAMP}`;
/** core と同じ枠から、この実行だけの port を借りる。 */
const FIXTURE_PORT = CORE_PORT + 1100;

let fixture: OAuthFixture;

async function api(path: string, init: RequestInit = {}) {
  return fetch(`${CORE_BASE_URL}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

const wake = () => api("/api/ui-settings");

const moduleState = async () => {
  const list = (await (await api("/api/modules")).json()) as Array<{
    name: string;
    connected: boolean;
    error?: string;
  }>;
  return list.find((m) => m.name === MODULE);
};

const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? "");

test.beforeAll(async () => {
  fixture = await startOAuthMcpFixture(FIXTURE_PORT);
  const added = await api("/api/modules", {
    method: "POST",
    body: JSON.stringify({
      acknowledgeEgress: true,
      mcpServers: { [MODULE]: { type: "http", url: fixture.url } },
    }),
  });
  expect(added.status, `足せなかった：${await added.text()}`).toBe(200);
});

test.afterAll(async () => {
  await api(`/api/modules/${encodeURIComponent(MODULE)}`, { method: "DELETE" });
  await api("/api/ui-tool-call", {
    method: "POST",
    body: JSON.stringify({
      server: "vault-directory",
      tool: "deleteAlias",
      arguments: { name: `oauth-${MODULE}` },
    }),
  });
  await fixture.close();
});

test("ログイン前は繋がらない——「壊れている」ではなく「ログインが要る」と言う", async () => {
  await wake();
  await expect
    .poll(async () => (await moduleState())?.error ?? "理由なし", {
      timeout: 60_000,
      message: "繋がらなかった理由が残っていない",
    })
    .toContain("ログインが要ります");
  expect((await moduleState())?.connected, "ログイン前なのに繋がっている").toBe(false);
});

test("ログインすると金庫に入り、実際に繋がって tool が呼べる", async () => {
  // --- 押す先をもらう -------------------------------------------------------
  const started = await api(`/api/modules/${encodeURIComponent(MODULE)}/oauth/start`, { method: "POST" });
  const startedBody = await started.text();
  expect(started.status, `ログインを始められなかった：${startedBody}`).toBe(200);
  const { url } = JSON.parse(startedBody) as { url: string };
  expect(url, "押し先が相手の認可窓口になっていない").toContain(`127.0.0.1:${FIXTURE_PORT}/authorize`);
  // **戻り先は banto の1本**（相手に登録される値）
  expect(new URL(url).searchParams.get("redirect_uri")).toBe(`${CORE_BASE_URL}/api/oauth/callback`);
  // **PKCE で守る**（秘密を持たないクライアント）
  expect(new URL(url).searchParams.get("code_challenge_method")).toBe("S256");

  // --- 人がブラウザで承認した、ということにする -----------------------------
  const { redirectTo } = fixture.approve(url);
  const back = await fetch(redirectTo, { headers: { authorization: `Bearer ${AUTH_TOKEN}` } });
  const backBody = await back.text();
  expect(back.status, `戻りが通らなかった：${backBody.slice(0, 200)}`).toBe(200);
  expect(backBody, "人に結果を伝えていない").toContain("ログインしました");

  // --- 金庫に入ったか（人の一覧で見えて、消せる） ---------------------------
  const listed = await api("/api/ui-tool-call", {
    method: "POST",
    body: JSON.stringify({ server: "vault-directory", tool: "listAliases", arguments: {} }),
  });
  const aliases = (
    JSON.parse(textOf(await listed.json())) as { aliases: Array<{ name: string; kind: string }> }
  ).aliases;
  const stored = aliases.find((a) => a.name === `oauth-${MODULE}`);
  expect(stored, "ログイン情報が金庫に入っていない").toBeTruthy();
  expect(stored!.kind, "人が預けた秘密と同じ種別で入っている").toBe("oauth-token");

  // --- 繋がって、AI から呼べる ---------------------------------------------
  await wake();
  // **繋がらないときは、host の言い分をそのまま出す**（規則2・規則15
  // ——`false` だけでは次にどこを見ればよいか分からない）
  await expect
    .poll(
      async () => {
        const m = await moduleState();
        return m?.connected ? true : (m?.error ?? "まだ立っていない");
      },
      { timeout: 60_000, message: "ログインしたのに繋がらない" },
    )
    .toBe(true);

  const agent = new Client({ name: "e2e", version: "0.0.0" }, { capabilities: {} });
  await agent.connect(
    new StreamableHTTPClientTransport(new URL(`${CORE_BASE_URL}/agent-relay/${MODULE}`), {
      requestInit: { headers: { authorization: `Bearer ${AUTH_TOKEN}` } },
    }),
  );
  try {
    expect(textOf(await agent.callTool({ name: "secretWord" }))).toBe("ログインできています");
    expect(textOf(await agent.callTool({ name: "echo", arguments: { word: "やあ" } }))).toBe("oauth-said:やあ");
  } finally {
    await agent.close();
  }

  // **相手が実際にトークンを発行している**（こちらの言い分ではなく、相手の記録）
  expect(fixture.issuedTokens().length, "相手はトークンを出していない").toBeGreaterThan(0);
});

// **画面に押せる場所がある**（規則13——繋がっていない要素を残さない）。
// 「繋がりません」と一緒くたにすると、押すボタンがあることに気付けない
test("ログインが要る Module は、画面でそう出て「ログインする」が押せる", async ({ page }) => {
  const LOGIN_MODULE = `e2e-oauth-ui-${STAMP}`;
  await api("/api/modules", {
    method: "POST",
    body: JSON.stringify({
      acknowledgeEgress: true,
      mcpServers: { [LOGIN_MODULE]: { type: "http", url: fixture.url } },
    }),
  });
  await wake();

  await openApp(page);
  await page.goto("/settings");
  await page.getByRole("button", { name: "Module", exact: true }).click();
  const row = page.locator(`[data-module="${LOGIN_MODULE}"]`);
  await expect(row, "足した Module が一覧に出ない").toBeVisible({ timeout: 60_000 });

  // **「Failed」ではなく「Auth required」**（中身まで見る・規則14）
  // ——一緒くたに「繋がりません」と出すと、押すべきボタンがあることに気付けない
  await expect(page.getByTestId(`module-state-${LOGIN_MODULE}`)).toContainText("Auth required");

  // **押すと新しいタブが開く。** この試験の相手は承認画面を出さずに戻すので、
  // タブはそのまま banto の戻り先まで進む——**人が見る結果の文字まで見る**（規則14）
  const opened = page.waitForEvent("popup");
  await page.getByTestId(`module-login-${LOGIN_MODULE}`).click();
  const tab = await opened;
  await tab.waitForURL(/\/api\/oauth\/callback/, { timeout: 30_000 });
  await expect(tab.locator("body"), "人に結果を伝えていない").toContainText("ログインしました");
  await tab.close();

  // **押した結果、実際に繋がる**（画面の言い分ではなく host に聞く・規則1）
  await wake();
  await expect
    .poll(
      async () => {
        const list = (await (await api("/api/modules")).json()) as Array<{
          name: string;
          connected: boolean;
          error?: string;
        }>;
        const m = list.find((x) => x.name === LOGIN_MODULE);
        return m?.connected ? true : (m?.error ?? "まだ立っていない");
      },
      { timeout: 60_000, message: "画面からログインしたのに繋がらない" },
    )
    .toBe(true);

  await api(`/api/modules/${encodeURIComponent(LOGIN_MODULE)}`, { method: "DELETE" });
  await api("/api/ui-tool-call", {
    method: "POST",
    body: JSON.stringify({
      server: "vault-directory",
      tool: "deleteAlias",
      arguments: { name: `oauth-${LOGIN_MODULE}` },
    }),
  });
});

test("知らない印で戻ってきても通さない——どのログインか推測しない", async () => {
  const res = await fetch(`${CORE_BASE_URL}/api/oauth/callback?state=でたらめ&code=xxx`, {
    headers: { authorization: `Bearer ${AUTH_TOKEN}` },
  });
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("途中の記録がありません");
});
