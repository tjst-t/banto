// **Repositories の読むだけの GitHub の tool**（追加・2026-10-20、Backlog #424。アーキ仕様 §4.4「土台：読むだけの印」の最後の項）。
// 偽の GitHub（`github-login-fixture`。Module の単体試験と同じ偽物）に、PAT のアカウントでしか見えない非公開のリポジトリを置き、
// その clone を根にした Project の AI が Issue・PR・CI を読む。見ること（会話のカードの中身と、偽の GitHub に来た要求で、規則14）：
//   1. ふつうの会話：AI が読むと、Repositories が Vault の PAT を引く中継の初回だけ人に聞く。許すと Issue の中身が届く
//   2. 読むだけの会話（見回りの印。「承認をすべて自動で許可する」がオン・承認モードが「毎回聞く」でも）：6つの tool がどれも
//      聞かれずに使え、Issue（PR を除く）・コメント・PR とその head の CI・CI の実行の一覧と job・step の結果まで届く
//   3. ほかのリポジトリは断る：owner・repo・URL を渡すと、GitHub に行かずに断る。偽の GitHub に来た要求は、どれもこの Project の
//      リポジトリのもので、PAT の持ち主として読んでいる。台帳から外したリポジトリは読まない
//   4. 判断待ちは1枚も出ず、受信箱にも積まれない。トークンは画面に出ない
import { test, expect, type Page } from "../test-base.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_TOKEN, CORE_BASE_URL, DATA_DIR } from "../config.js";
import { createProject, fakeTurn, openApp, openToolCards, waitTurnEnded } from "../helpers.js";
import { E2E_GITHUB_PAT, E2E_GITHUB_PAT_LOGIN, setGithubLoginFixture } from "../github-login-fixture.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const headers = { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };
const OWNER = E2E_GITHUB_PAT_LOGIN;
const NAME = `watched-${Date.now().toString(36)}`;
const PROJECT_NAME = "E2E GitHub Read";
const SHA = "c0ffee".padEnd(40, "0");
const base = realpathSync(mkdtempSync(join(tmpdir(), "banto-e2e-github-read-")));
const repoPath = join(base, NAME);

let projectId = "";
let baseThreadId = "";
let forkId = "";

/** 人の画面と同じ口で Repositories の管理の tool を呼ぶ（試験の準備。画面そのものは repositories.spec.ts が見る） */
async function admin(page: Page, tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const res = await page.request.post(`${CORE_BASE_URL}/api/ui-tool-call`, { headers, data: { server: "repositories", tool, arguments: args } });
  const body = (await res.json()) as { content?: { text: string }[]; isError?: boolean };
  const text = body.content?.[0]?.text ?? "";
  if (!res.ok() || body.isError) throw new Error(`repositories の ${tool} が失敗しました：${res.status()} ${text}`);
  return JSON.parse(text) as unknown;
}

/** その会話の tool のカード（畳まれた「N tool calls」を開き、カードも開いてから中身を見る） */
async function toolCards(page: Page, toolName: string) {
  const groups = page.getByRole("button", { name: /tool calls?$/, expanded: false });
  for (let i = 0; i < 10 && (await groups.count()) > 0; i++) await groups.first().click();
  await expect(groups, "畳まれた tool の呼び出しが開かない").toHaveCount(0);
  await openToolCards(page, toolName);
  return page.locator('[data-slot="tool-fallback-root"]').filter({ has: page.getByRole("button", { name: `Used tool: ${toolName}` }) });
}

/** カードに出た結果（MCP の content の text）を読む——画面に出ている文字から（規則14：画面が提示している中身を見る） */
async function resultOf(card: ReturnType<Page["locator"]>): Promise<Record<string, unknown>> {
  const shown = (await card.textContent()) ?? "";
  const at = shown.indexOf("Result:");
  expect(at, `結果がカードに出ていない：${shown.slice(0, 200)}`).toBeGreaterThanOrEqual(0);
  const content = JSON.parse(shown.slice(at + "Result:".length)) as Array<{ text: string }>;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

function relayEvents(): Array<{ seq: number; type: string; payload: Record<string, unknown> }> {
  return readFileSync(join(DATA_DIR, "events.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.includes('"relay.'))
    .map((line) => JSON.parse(line) as { seq: number; type: string; payload: Record<string, unknown> })
    .filter((e) => e.type.startsWith("relay."));
}

test.beforeAll(async () => {
  // 偽の GitHub：PAT の持ち主だけが読める非公開のリポジトリと、その Issue・PR・CI。別のリポジトリも置く（読みに行かないことを見る）
  await setGithubLoginFixture({ addRepo: { owner: OWNER, name: NAME, private: true } });
  await setGithubLoginFixture({
    addContent: {
      repo: `${OWNER}/${NAME}`,
      issues: [
        { number: 1, title: "起動すると落ちる", body: "設定画面を開くと落ちます", user: "reporter", labels: ["bug"], comments: [{ user: OWNER, body: "手元で再現しました" }] },
        { number: 2, title: "もう閉じた話", state: "closed" },
      ],
      pulls: [{ number: 3, title: "落ちるのを直す", body: "#1 を直します", head: "fix-crash", headSha: SHA, user: OWNER, comments: [{ user: "reviewer", body: "テストを足してください" }] }],
      runs: [
        {
          id: 7001,
          name: "CI",
          status: "completed",
          conclusion: "failure",
          headSha: SHA,
          branch: "fix-crash",
          event: "pull_request",
          jobs: [{ name: "unit", status: "completed", conclusion: "failure", steps: [{ name: "npm test", status: "completed", conclusion: "failure" }] }],
        },
        { id: 7000, name: "CI", status: "completed", conclusion: "success", headSha: "d".repeat(40), branch: "main" },
      ],
    },
  });
  await setGithubLoginFixture({ addRepo: { owner: "e2e-other", name: "secret-plans", private: true, readers: [OWNER] } });
  await setGithubLoginFixture({ addContent: { repo: "e2e-other/secret-plans", issues: [{ number: 1, title: "見えてはいけない Issue" }] } });

  // 手元の clone（origin は GitHub の場所。API は偽の GitHub に向いている）
  mkdirSync(repoPath);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "-c", "init.defaultBranch=main", ...args], { cwd: repoPath, stdio: "ignore" });
  git("init", "-q");
  git("remote", "add", "origin", `git@github.com:${OWNER}/${NAME}.git`);
  git("commit", "-q", "--allow-empty", "-m", "first");
});

test.afterAll(async ({ request }) => {
  // 台帳とアカウントを元に戻す（PAT は Vault に残す決まり——ほかの spec も同じ alias を選ぶ）
  const call = (tool: string, args: Record<string, unknown>) =>
    request.post(`${CORE_BASE_URL}/api/ui-tool-call`, { headers, data: { server: "repositories", tool, arguments: args } });
  await call("remove_repository", { path: repoPath });
  await call("remove_github_account", { login: OWNER });
  rmSync(base, { recursive: true, force: true });
});

test("ふつうの会話：AI が Project のリポジトリの Issue を読み、Vault の PAT を引く中継の初回だけ人に聞く", async ({ page }) => {
  // ---- 準備：PAT のアカウント（前の spec が Vault に残した alias があれば選ぶ）と、台帳の行 ----
  const accounts = (await admin(page, "list_github_accounts")) as { accounts: Array<{ login: string }> };
  if (!accounts.accounts.some((a) => a.login === OWNER)) {
    const choices = (await admin(page, "list_credential_aliases")) as { secrets: Array<{ implementation: string; name: string; group?: string }> };
    const existing = choices.secrets.find((s) => s.name === `github-${OWNER}-pat`);
    await admin(page, "add_github_account_with_pat", existing ? { patAlias: existing } : { pat: E2E_GITHUB_PAT });
  }
  await admin(page, "import_repository", { path: repoPath });
  // 一覧を開くと、持ち主と同じ login のアカウントで扱う行になる
  const row = JSON.stringify(await admin(page, "list_repositories"));
  expect(row, "台帳の行が無い").toContain(repoPath);
  expect(row, "台帳の行が PAT のアカウントで扱われていない").toContain(`"login":"${OWNER}"`);

  await openApp(page);
  await createProject(page, PROJECT_NAME, repoPath);
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as { id: string; name: string }[];
  projectId = projects.find((p) => p.name === PROJECT_NAME)!.id;
  baseThreadId = ((await (await page.request.get(`${CORE_BASE_URL}/api/projects/${projectId}/threads`, { headers })).json()) as { id: string }[])[0]!.id;

  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("Issue を見て。" + fakeTurn({ tools: [{ server: "repositories", name: "getIssue", args: { number: 1 } }], then: "見ました。" }));
  await composer.press("Enter");
  const asked: string[] = [];
  await expect(async () => {
    const cards = page.locator('[data-role="judgment-card"]').filter({ has: page.getByRole("button", { name: "許可する" }) });
    if ((await cards.count()) > 0) {
      asked.push((await cards.last().textContent()) ?? "");
      await cards.last().getByRole("button", { name: "許可する" }).click();
    }
    await waitTurnEnded(page, baseThreadId, 1, 1_500);
  }).toPass({ timeout: 120_000, intervals: [1000] });
  expect(asked.some((t) => t.includes("repositories が vault-local の resolveAlias")), `PAT を引く中継の承認を聞いていない：${asked.join(" / ")}`).toBe(true);
  const card = await toolCards(page, "mcp__repositories__getIssue");
  await expect(card).toContainText("起動すると落ちる");
  await expect(card).toContainText("設定画面を開くと落ちます");
  await expect(card).toContainText("手元で再現しました");
  await expect(card).toContainText(`${OWNER}/${NAME}`);
});

test("読むだけの会話：Issue・PR・CI の一覧と中身が聞かれずに届き、ほかのリポジトリと台帳に無いものは断る", async ({ page }) => {
  // 「承認をすべて自動で許可する」をオン、承認モードは「毎回聞く」——ふつうの会話ならどれも自動で通るところ
  expect((await page.request.put(`${CORE_BASE_URL}/api/projects/${projectId}/auto-approve`, { headers, data: { enabled: true } })).ok()).toBe(true);
  expect((await page.request.post(`${CORE_BASE_URL}/api/threads/${baseThreadId}/permission-mode`, { headers, data: { mode: "default" } })).ok()).toBe(true);
  const created = await page.request.post(`${CORE_BASE_URL}/api/test-only/read-only-thread`, { headers, data: { threadId: baseThreadId, title: "見回り（GitHub）" } });
  expect(created.ok(), await created.text()).toBe(true);
  forkId = ((await created.json()) as { id: string }).id;

  const readsBefore = (await setGithubLoginFixture({})).apiReads.length;
  const relaySince = Math.max(0, ...relayEvents().map((e) => e.seq));
  await openApp(page);
  await page.goto(`/p/${projectId}?fork=${forkId}`);
  const composer = page.getByPlaceholder("この Fork Thread に送る");
  await expect(composer, "読むだけの会話が開かない").toBeVisible({ timeout: 30_000 });
  await composer.fill(
    "GitHub を見回って。" +
      fakeTurn({
        tools: [
          { server: "repositories", name: "listIssues", args: {} },
          { server: "repositories", name: "listPullRequests", args: { state: "all", limit: 5 } },
          { server: "repositories", name: "getPullRequest", args: { number: 3 } },
          { server: "repositories", name: "listCiRuns", args: { status: "failure" } },
          { server: "repositories", name: "getCiRun", args: { runId: 7001 } },
          { server: "repositories", name: "getIssue", args: { owner: "e2e-other", repo: "secret-plans", number: 1 } },
        ],
        then: "見回りおわり。",
      }),
  );
  await composer.press("Enter");
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "見回りおわり。" })).toBeVisible({ timeout: 120_000 });
  await waitTurnEnded(page, forkId, 1, 30_000);

  // (1) 一覧と中身。Issue の一覧は開いているものだけで PR を含まない
  const issues = await toolCards(page, "mcp__repositories__listIssues");
  await expect(issues).toContainText("起動すると落ちる");
  const issueList = await resultOf(issues);
  expect(issueList.repository).toBe(`${OWNER}/${NAME}`);
  expect(issueList.issues).toEqual([
    expect.objectContaining({ number: 1, title: "起動すると落ちる", state: "open", author: "reporter", labels: ["bug"], comments: 1 }),
  ]);
  const pulls = await resultOf(await toolCards(page, "mcp__repositories__listPullRequests"));
  expect(pulls.pullRequests).toEqual([expect.objectContaining({ number: 3, title: "落ちるのを直す", head: "fix-crash", base: "main", author: OWNER })]);
  const pull = await resultOf(await toolCards(page, "mcp__repositories__getPullRequest"));
  expect(pull.pullRequest).toEqual(expect.objectContaining({ number: 3, body: "#1 を直します", headSha: SHA }));
  expect(pull.comments).toEqual([expect.objectContaining({ author: "reviewer", body: "テストを足してください" })]);
  // その head の CI だけ（main の成功した実行は入らない）
  expect((pull.ci as Array<{ id: number; conclusion: string }>).map((r) => [r.id, r.conclusion])).toEqual([[7001, "failure"]]);
  const runs = await resultOf(await toolCards(page, "mcp__repositories__listCiRuns"));
  expect((runs.runs as Array<{ id: number; conclusion: string; branch: string }>).map((r) => [r.id, r.conclusion, r.branch])).toEqual([[7001, "failure", "fix-crash"]]);
  const run = await resultOf(await toolCards(page, "mcp__repositories__getCiRun"));
  expect(run.run).toEqual(expect.objectContaining({ id: 7001, status: "completed", conclusion: "failure", event: "pull_request" }));
  expect(run.jobs).toEqual([
    expect.objectContaining({ name: "unit", conclusion: "failure", steps: [{ name: "npm test", status: "completed", conclusion: "failure" }] }),
  ]);

  // (2) ほかのリポジトリは断る（GitHub に行かない）
  const other = await toolCards(page, "mcp__repositories__getIssue");
  await expect(other).toContainText("getIssue が受けるのは number だけです（owner・repo は受けません）");
  await expect(other).not.toContainText("見えてはいけない Issue");

  // (3) 偽の GitHub に来た要求：どれもこの Project のリポジトリで、PAT の持ち主として
  const reads = (await setGithubLoginFixture({})).apiReads.slice(readsBefore);
  expect(reads.length, "GitHub を読みに行っていない").toBeGreaterThan(0);
  for (const r of reads) {
    expect(r.path, "ほかのリポジトリを読みに行った").toMatch(new RegExp(`^/repos/${OWNER}/${NAME}/`));
    expect(r.login).toBe(OWNER);
  }

  // (4) 判断待ちは出さない・受信箱に積まない・承認を新しく覚えない。PAT を引く中継は、ふつうの会話で許したもので通った
  await expect(page.locator('[data-role="judgment-card"]')).toHaveCount(0);
  const inbox = (await (await page.request.get(`${CORE_BASE_URL}/api/inbox`, { headers })).json()) as Array<{ threadId?: string }>;
  expect(inbox.filter((i) => i.threadId === forkId), "読むだけの会話の判断待ちが受信箱にある").toEqual([]);
  const mine = relayEvents().filter((e) => e.seq > relaySince);
  expect(mine.filter((e) => e.type === "relay.grant_created"), "読むだけの回で承認を覚えた").toEqual([]);
  const resolves = mine.filter((e) => e.type === "relay.call_recorded" && e.payload.name === "resolveAlias");
  expect(resolves.length, "PAT を引いていない").toBeGreaterThan(0);
  for (const e of resolves) expect(e.payload, "PAT を引く中継が断られた").toMatchObject({ callerModule: "repositories", targetModule: "vault-local", allowed: true });
  for (const frame of page.frames()) expect((await frame.content().catch(() => "")).includes(E2E_GITHUB_PAT), "PAT が画面に出ている").toBe(false);

  // ---- 台帳から外したリポジトリは、根にした Project からでも読まない ----
  await admin(page, "remove_repository", { path: repoPath });
  const readsMid = (await setGithubLoginFixture({})).apiReads.length;
  await composer.fill("もう一度。" + fakeTurn({ tools: [{ server: "repositories", name: "listPullRequests", args: {} }], then: "二回目おわり。" }));
  await composer.press("Enter");
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "二回目おわり。" })).toBeVisible({ timeout: 120_000 });
  await waitTurnEnded(page, forkId, 2, 30_000);
  const second = (await toolCards(page, "mcp__repositories__listPullRequests")).last();
  await expect(second).toContainText("このリポジトリは Repositories の一覧にありません");
  expect((await setGithubLoginFixture({})).apiReads.length, "台帳に無いのに GitHub を読みに行った").toBe(readsMid);
});
