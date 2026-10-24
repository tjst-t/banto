// **API キーだけの banto**（Backlog #515、`docs/specs/v4-distribution.md` §3）。
//
// 自前の host（`own-host.ts`）で、既定の並びからこのマシンのログインを抜き、使えるアカウントが無い状態から始める。画面の帯から
// API キーを入れ、会話の本体（本物の CLI）・Project のコンテナの Shell・コンテナの中のサブエージェントが、どれも中継を通って
// 偽の API（`fake-anthropic.ts`）にキーで届くことを見る。
//
// 見るもの（規則14——押せたかでなく、画面が出している値と、上流に届いたもの・コンテナの環境・host の台帳まで）：
//   1. 使えるアカウントが無い：画面の下の帯と、設定の中の帯
//   2. 帯から API キーのダイアログ：Console へのリンク・足すと一覧に増え、帯が消える。台帳には alias だけ（キーは書かない）
//   3. 会話：上流には x-api-key＝キー・Authorization 無し・oauth の beta 無し。一覧のメーターが台帳の使ったトークンと一致する
//   4. コンテナの Shell：合言葉は ANTHROPIC_AUTH_TOKEN、キー・CLAUDE_CODE_OAUTH_TOKEN・契約の種類は無い。中継で上流にキーが届く
//   5. コンテナの中のサブエージェント：中継を通って上流に届き、環境にキーは無い
//   6. 外す：Vault からも消え、使えるアカウントが無い帯に戻る
import { test, expect, type Page } from "../test-base.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FRONTEND_BASE_URL } from "../config.js";
import { withOwnHost, type OwnHost } from "../own-host.js";
import { startFakeAnthropic } from "../fake-anthropic.js";
import { createProject, currentProjectId, openApp } from "../helpers.js";
import { writeLoginLink } from "../../packages/core/dist/auth/login-links.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(600_000);

/** 試験を流している側の Claude Code の環境（本物の CLI に持ち込まない） */
const OUTER_CLAUDE_ENV = Object.keys(process.env).filter((k) => /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_VERSION|ANTHROPIC_.*)$/.test(k));
const KEY = "sk-ant-api03-e2e-ONLY-IN-VAULT";
const PROJECT = "E2E API キー";

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}
interface Accounts {
  accounts: Array<{ id: string; kind: string; label: string; keyAlias?: string; tokenUsage?: TokenUsage }>;
  defaultOrder: string[];
  noUsableAccount: boolean;
}

const humanHeaders = { "x-banto-client": "1", origin: FRONTEND_BASE_URL, "content-type": "application/json" };

async function human<T>(page: Page, host: OwnHost, path: string, init: { method?: "GET" | "PUT"; data?: unknown } = {}): Promise<T> {
  const res =
    init.method === "PUT"
      ? await page.context().request.put(`${host.url}${path}`, { headers: humanHeaders, data: init.data })
      : await page.context().request.get(`${host.url}${path}`, { headers: humanHeaders });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as T;
}

async function login(page: Page, host: OwnHost): Promise<void> {
  const { code } = await writeLoginLink(host.dataDir);
  const res = await page.context().request.post(`${host.url}/api/auth/redeem`, { headers: humanHeaders, data: { code } });
  if (!res.ok()) throw new Error(`自前の host にログインできませんでした：${res.status()} ${await res.text()}`);
}

async function api<T>(host: OwnHost, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${host.apiUrl}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

/** ターンを1本最後まで。SSE の終わりまで読む */
async function sendTurn(host: OwnHost, threadId: string, prompt: string): Promise<string> {
  const res = await fetch(`${host.apiUrl}/api/threads/${threadId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt, permissionMode: "bypassPermissions" }),
  });
  const text = await res.text();
  expect(res.status, text).toBe(200);
  expect(text, "ターンが失敗した").not.toContain('"type":"error"');
  return text;
}

/** AI を通さずに、AI が通る経路そのもの（代理サーバ）で Module の tool を呼ぶ */
async function callModule(host: OwnHost, connection: string, name: string, args: Record<string, unknown>): Promise<string> {
  const client = new Client({ name: "e2e-claude-api-key", version: "0.0.0" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${host.apiUrl}/agent-relay/${connection}`), { requestInit: { headers: { authorization: `Bearer ${host.token}` } } }),
  );
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(result.isError, text).toBeFalsy();
    return text;
  } finally {
    await client.close();
  }
}

/** 画面と同じ書き方（`claude-accounts-shared.tsx` の formatTokens） */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
const formatUsd = (usd: number) => `$${usd < 0.01 && usd > 0 ? "<0.01" : usd.toFixed(2)}`;

test("API キーだけの banto：帯からキーを入れ、会話・コンテナの Shell・サブエージェントが中継でキーを使い、キーはコンテナに入らない", async ({ page }) => {
  const fakeApi = await startFakeAnthropic();
  const securestorage = mkdtempSync(join(tmpdir(), "banto-e2e-api-key-cred-"));
  const root = mkdtempSync(join(tmpdir(), "banto-e2e-api-key-root-"));
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  // Console へのリンクの先（本物へは出ない）
  await page.context().route("https://console.anthropic.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<p>fake console</p>" }));
  try {
    await withOwnHost(
      async (own) => {
        const accounts = () => human<Accounts>(page, own, "/api/claude-accounts");
        await login(page, own);
        // このマシンのログインを既定の並びから抜く——API キーだけの banto（公開版と同じ形）
        await human(page, own, "/api/claude-accounts/settings", { method: "PUT", data: { defaultOrder: [], mode: "ordered" } });

        // ---- 1. 使えるアカウントが無い ------------------------------------------------------------------------
        expect((await accounts()).noUsableAccount).toBe(true);
        await openApp(page, own.url);
        const banner = page.getByTestId("claude-api-key-banner");
        await expect(banner).toBeVisible({ timeout: 30_000 });
        await expect(banner).toContainText("Claude を使うには API キーが要ります");

        // ---- 2. 帯からダイアログ → 足す ---------------------------------------------------------------------
        await banner.getByTestId("claude-api-key-banner-open").click();
        const dialog = page.getByTestId("claude-api-key-dialog");
        await expect(dialog.getByRole("heading", { name: "Claude の API キーを足す" })).toBeVisible({ timeout: 20_000 });
        const panel = page.getByTestId("claude-accounts-panel");
        await expect(panel.getByTestId("claude-accounts-no-usable")).toContainText("既定の並びに使える Claude のアカウントがありません。");
        // 設定を開いている間は画面の下の帯は出さない（設定の中の帯が言う）
        await expect(banner).toHaveCount(0);
        await expect(dialog.getByTestId("claude-api-key-console-link")).toHaveAttribute("href", "https://console.anthropic.com/settings/keys");
        await expect(dialog.getByTestId("claude-api-key-submit")).toBeDisabled();
        await dialog.getByTestId("claude-api-key-label").fill("E2E のキー");
        await dialog.getByTestId("claude-api-key-input").fill(KEY);
        await dialog.getByTestId("claude-api-key-submit").click();
        // **成功したときにだけ現れるもの**：一覧に API キーの行が増える
        const keyRow = panel.locator('[data-testid="claude-account-row"]').filter({ hasText: "E2E のキー" });
        await expect(keyRow).toHaveCount(1, { timeout: 30_000 });
        await expect(dialog).toHaveCount(0);
        await expect(page).not.toHaveURL(/addKey=1/);
        const added = (await accounts()).accounts.find((a) => a.kind === "api-key")!;
        expect(added.label).toBe("E2E のキー");
        expect(added.keyAlias).toBe(`claude-api-key-${added.id}`);
        expect((await accounts()).defaultOrder).toEqual([added.id]);
        expect((await accounts()).noUsableAccount).toBe(false);
        await expect(keyRow.getByTestId("claude-account-identity")).toHaveText(`API キー（Vault の ${added.keyAlias}）`);
        await expect(keyRow.getByTestId("claude-account-spend-cost")).toHaveText("$0.00");
        await expect(keyRow.getByTestId("claude-account-spend-input")).toHaveText("0");
        await expect(keyRow.getByTestId("claude-account-meter-5h")).toHaveCount(0);
        await expect(keyRow.getByTestId("claude-account-relogin")).toHaveCount(0);
        await expect(panel.getByTestId("claude-accounts-no-usable")).toHaveCount(0);
        await expect(panel.getByTestId("claude-accounts-default-order")).toContainText("E2E のキー");
        // 台帳にも Event Store にもキーは無い
        expect(readFileSync(join(own.dataDir, "claude-accounts.json"), "utf8")).not.toContain(KEY);
        expect(readFileSync(join(own.dataDir, "events.jsonl"), "utf8")).not.toContain(KEY);

        // ---- 3. 会話（本物の CLI が中継を通る） -----------------------------------------------------------------
        await openApp(page, own.url);
        await createProject(page, PROJECT, root);
        const projectId = currentProjectId(page);
        const threadId = (await api<{ id: string }>(own, `/api/projects/${projectId}/threads`, { method: "POST" })).body.id;
        const before = fakeApi.requests.length;
        const turn = await sendTurn(own, threadId, "はじめまして");
        expect(turn).toContain("ack(");
        const seen = fakeApi.requests.slice(before);
        expect(seen.length, "会話の要求が上流に届いていない").toBeGreaterThan(0);
        for (const r of seen) {
          expect(r.apiKey, "上流にキーが届いていない").toBe(KEY);
          expect(r.auth, "上流に Authorization が漏れた").toBeNull();
          expect(r.beta ?? "", "API キーに oauth の beta を付けた").not.toMatch(/oauth-/);
        }
        // 使ったトークンは台帳に足される（流し終わってから）。画面の値と台帳を照らす
        await expect.poll(async () => (await accounts()).accounts.find((a) => a.id === added.id)?.tokenUsage?.inputTokens ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
        await page.goto(`/settings?section=claude-accounts&project=${projectId}`);
        const spent = (await accounts()).accounts.find((a) => a.id === added.id)!.tokenUsage!;
        const keyRowAgain = page.getByTestId("claude-accounts-panel").locator(`[data-testid="claude-account-row"][data-account-id="${added.id}"]`);
        await expect(keyRowAgain.getByTestId("claude-account-spend-input")).toHaveText(formatTokens(spent.inputTokens), { timeout: 20_000 });
        await expect(keyRowAgain.getByTestId("claude-account-spend-output")).toHaveText(formatTokens(spent.outputTokens));
        await expect(keyRowAgain.getByTestId("claude-account-spend-cache-write")).toHaveText(formatTokens(spent.cacheWriteTokens));
        await expect(keyRowAgain.getByTestId("claude-account-spend-cache-read")).toHaveText(formatTokens(spent.cacheReadTokens));
        await expect(keyRowAgain.getByTestId("claude-account-spend-cost")).toHaveText(formatUsd(spent.costUsd));
        await expect(page.getByTestId("claude-api-key-banner")).toHaveCount(0);

        // ---- 4. コンテナの Shell ------------------------------------------------------------------------------
        await expect
          .poll(async () => ((await api<{ connected?: string[] }>(own, `/api/projects/${projectId}/modules/prepare`, { method: "POST" })).body.connected ?? []), {
            timeout: 180_000,
            message: "Shell・サブエージェントが繋がるまで",
          })
          .toEqual(expect.arrayContaining(["shell", "subagent"]));
        const run = async (command: string) => JSON.parse(await callModule(own, `shell-${projectId}`, "runCommand", { command })) as { stdout: string; stderr: string; exitCode: number };
        const env = await run(
          'echo "auth=$ANTHROPIC_AUTH_TOKEN"; echo "oauth=${CLAUDE_CODE_OAUTH_TOKEN:-none}"; echo "apikey=${ANTHROPIC_API_KEY:-none}"; ' +
            'echo "sub=${CLAUDE_CODE_SUBSCRIPTION_TYPE:-none}"; ' +
            `echo "key=$(env | grep -c ${KEY})"`,
        );
        expect(env.exitCode, env.stderr).toBe(0);
        expect(env.stdout).toMatch(/^auth=banto-\S+$/m);
        expect(env.stdout).toContain("oauth=none");
        expect(env.stdout).toContain("apikey=none");
        expect(env.stdout).toContain("sub=none");
        expect(env.stdout, "キーがコンテナの環境に入っている").toContain("key=0");
        const through = await run(
          `curl -s -o /tmp/relay-out -w '%{http_code}\\n' -X POST "$ANTHROPIC_BASE_URL/v1/messages?beta=true" ` +
            `-H "authorization: Bearer $ANTHROPIC_AUTH_TOKEN" -H 'content-type: application/json' -d '{}' && cat /tmp/relay-out`,
        );
        const [status, body] = through.stdout.split("\n");
        expect(status, through.stdout + through.stderr).toBe("200");
        expect(JSON.parse(body!)).toEqual({ fakeUpstream: true, path: "/v1/messages?beta=true", auth: null, apiKey: KEY });

        // ---- 5. コンテナの中のサブエージェント（本体のログインを使う形） -----------------------------------------------
        const subagent = (prompt: string) => callModule(own, `subagent-${projectId}`, "runSubagent", { agent: "fake-host", prompt, label: "API キー" });
        const sub = await subagent("[anthropic /v1/messages?beta=true]");
        expect(sub).toContain("anthropic: 200");
        expect(sub).toContain(KEY.slice(0, 12));
        expect(fakeApi.replies.at(-1)?.apiKey).toBe(KEY);
        const subEnv = await subagent(`[has ${KEY}]`);
        expect(subEnv, "キーがサブエージェントの環境に入っている").toContain("環境に 含まない");

        // ---- 6. 外す：Vault からも消え（消せなければ画面に警告が出る）、帯に戻る ----------------------------------------
        const panelAgain = page.getByTestId("claude-accounts-panel");
        await keyRowAgain.getByTestId("claude-account-remove").click();
        const confirm = page.getByTestId("claude-accounts-remove-dialog");
        await expect(confirm).toContainText("banto の Vault に置いたこの API キーを消し、並びから外します。");
        await confirm.getByTestId("claude-accounts-remove-confirm").click();
        await expect(keyRowAgain).toHaveCount(0, { timeout: 20_000 });
        await expect(panelAgain.getByTestId("claude-accounts-remove-warning")).toHaveCount(0);
        await expect(panelAgain.getByTestId("claude-accounts-no-usable")).toBeVisible();
        const after = await accounts();
        expect(after.accounts.map((a) => a.kind)).toEqual(["host"]);
        expect(after.noUsableAccount).toBe(true);
        expect(pageErrors, "画面で例外が出た").toEqual([]);
      },
      {
        // **本物の CLI を偽の API に当てる**（会話の本体は中継を通る）
        unsetEnv: OUTER_CLAUDE_ENV,
        env: {
          BANTO_FAKE_RUNNER: "",
          BANTO_CLAUDE_RELAY_UPSTREAM: fakeApi.url,
          BANTO_CLAUDE_RELAY_TOKEN_URL: `${fakeApi.url}/v1/oauth/token`,
          BANTO_CLAUDE_PROFILE_URL: `${fakeApi.url}/api/oauth/profile`,
          BANTO_CLAUDE_USAGE_URL: `${fakeApi.url}/api/oauth/usage`,
          CLAUDE_SECURESTORAGE_CONFIG_DIR: securestorage,
          DISABLE_TELEMETRY: "1",
          DISABLE_AUTOUPDATER: "1",
        },
      },
    );
  } finally {
    await fakeApi.close();
    rmSync(securestorage, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
