// **別のサーバの Project で、Backlog の push・fetch を Repositories が引き受ける**（v4-modules.md §2.4「ブランチを送る口」の
// 「別のサーバの Project」、Backlog #466）。相手は SSH で入れる入れ子のコンテナ（`ssh-host.ts`、machine）。Backlog は向こうで
// 動き、Repositories は host で動く。
//
// 向こうのリポジトリの origin は**偽の GitHub**（`github-login-fixture.ts`）の URL——向こうからは届かない場所でよい：中身は
// core が実行場所の接続で bundle にして運び、Repositories が host から、登録したアカウント（PAT、持ち主と同じ login）で送る。
// 向こうの git には資格情報が無い（以前はここで `could not read Username` になっていた）。
//
// 見るもの（規則14——偽の GitHub の ref と中身、向こうの ref まで）：
//   1. AI の createItem が書けて送れる——偽の GitHub の backlog が向こうの手元と同じ。返事に送れなかったと出ない。
//      listItems は送っていない変更が無いと言う（向こうの追跡の ref が送ったコミットに合う）
//   2. 偽の GitHub の側で一覧が進んだ（別の手元から送られた）あと、もう1件書くと、取ってきて取り込んでから書き、送れる
//      ——偽の GitHub の一覧に、向こうで書いた2件と GitHub の側で変えたものが全部ある
//   2b. 承認のカードに送り先とアカウントが出る。origin を別のリポジトリに書き換えると、最初に決めた送り先と違うので送らない
//   3. PAT は向こうのどこにも無い
import { test, expect } from "../test-base.js";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AUTH_TOKEN, CORE_BASE_URL, GITHUB_LOGIN_FIXTURE_FILE } from "../config.js";
import { E2E_GITHUB_PAT, E2E_GITHUB_PAT_LOGIN, setGithubLoginFixture } from "../github-login-fixture.js";
import { withSshHost } from "../ssh-host.js";

test.describe.configure({ mode: "serial" });
// 初めての回は SSH の相手の土台を作り、向こうへ banto のコード（約 1GB）を送る
test.setTimeout(1_200_000);

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

/** 人の画面からの呼び出し（banto 全体の Module の admin の口） */
async function uiToolCall(server: string, tool: string, args: Record<string, unknown>): Promise<string> {
  const r = await api<{ isError?: boolean; content?: Array<{ text?: string }> }>("/api/ui-tool-call", {
    method: "POST",
    body: { server, tool, arguments: args },
  });
  const text = r.body?.content?.[0]?.text ?? "";
  expect(r.status, `${server} の ${tool}：${JSON.stringify(r.body).slice(0, 500)}`).toBe(200);
  expect(r.body.isError, `${server} の ${tool}：${text}`).not.toBe(true);
  return text;
}

/**
 * AI が通る経路そのもの（代理サーバ）で、その Project の Module の tool を呼ぶ。Backlog → Repositories の中継は人の承認を
 * 待つので、その Project の判断待ちを許可しながら待つ（承認の画面は relay-cards.spec.ts で見ている）
 */
async function callAsAgent(
  connName: string,
  tool: string,
  args: Record<string, unknown>,
  ctx: { projectId: string; threadId: string },
): Promise<{ text: string; isError: boolean; structured?: Record<string, unknown> }> {
  const client = new Client({ name: "e2e-remote-backlog-repositories", version: "0.0.0" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${CORE_BASE_URL}/agent-relay/${connName}`), {
      requestInit: { headers: { ...headers, "x-banto-project-id": ctx.projectId, "x-banto-thread-id": ctx.threadId } },
    }),
  );
  let done = false;
  const call = (
    client.callTool({ name: tool, arguments: args }, undefined, { timeout: 300_000 }) as Promise<{
      content: Array<{ text?: string }>;
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    }>
  ).finally(() => (done = true));
  try {
    const answered = new Set<string>();
    while (!done) {
      const inbox = (await api<Array<{ id: string; kind: string; liveness?: string; projectId?: string; threadId?: string }>>("/api/inbox")).body;
      for (const item of inbox) {
        if (item.kind !== "judgment" || item.liveness !== "live" || answered.has(item.id)) continue;
        if (item.projectId !== ctx.projectId && item.threadId !== ctx.threadId) continue;
        answered.add(item.id);
        answeredCards.push(JSON.stringify(item));
        const res = await api(`/api/inbox/${item.id}/answer`, { method: "POST", body: { answer: { behavior: "allow" } } });
        expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      }
      await Promise.race([call.catch(() => undefined), new Promise((r) => setTimeout(r, 500))]);
    }
    const r = await call;
    return {
      text: r.content.map((c) => c.text ?? "").join(""),
      isError: r.isError === true,
      ...(r.structuredContent ? { structured: r.structuredContent } : {}),
    };
  } finally {
    await client.close();
  }
}

/** 許可した判断待ち（中身ごと。承認のカードに送り先とアカウントが出ていたかを見る） */
const answeredCards: string[] = [];

async function connectedModules(projectId: string): Promise<string[]> {
  const r = await api<{ connected?: string[] }>(`/api/projects/${projectId}/modules/prepare`, { method: "POST" });
  return r.body.connected ?? [];
}

/** 偽の GitHub に話しかける git（試験の側から。資格情報は URL に入れる——試験の側の一時の clone だけ） */
function gitHere(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

test.beforeAll(async () => {
  const res = await fetch(`${CORE_BASE_URL}/api/modules/catalog/backlog`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name: "backlog" }),
  });
  if (!res.ok && !(await res.text()).includes("その名前はもう使われています")) {
    throw new Error(`Backlog を目録から入れられませんでした: ${res.status}`);
  }
});

test.afterAll(async () => {
  await fetch(`${CORE_BASE_URL}/api/modules/backlog`, { method: "DELETE", headers });
});

test("別のサーバの Project で、Backlog の一覧のブランチを Repositories が host から GitHub へ送り、取ってくる——資格情報は向こうへ出ない", async () => {
  const name = `bkr-${randomBytes(3).toString("hex")}`;
  const repoName = `remote-backlog-${randomBytes(3).toString("hex")}`;
  const { web } = JSON.parse(readFileSync(GITHUB_LOGIN_FIXTURE_FILE, "utf8")) as { web: string };
  const originUrl = `${web}/${E2E_GITHUB_PAT_LOGIN}/${repoName}.git`;
  // 偽の GitHub：持ち主＝登録する PAT のアカウント（持ち主と同じ login でアカウントが決まる）
  await setGithubLoginFixture({ addRepo: { owner: E2E_GITHUB_PAT_LOGIN, name: repoName } });
  // Repositories にアカウントが無ければ PAT で登録する（ほかの spec が残したものはそのまま使い、外さない）
  const accounts = JSON.parse(await uiToolCall("repositories", "list_github_accounts", {})) as { accounts: Array<{ login: string }> };
  const added = !accounts.accounts.some((a) => a.login === E2E_GITHUB_PAT_LOGIN);
  if (added) {
    // 前の spec が Vault に残した PAT の alias があればそれを選ぶ（外しても PAT は残す決まり）、無ければ貼る
    const choices = JSON.parse(await uiToolCall("repositories", "list_credential_aliases", {})) as {
      secrets: Array<{ implementation: string; name: string; group?: string }>;
    };
    const left = choices.secrets.find((a) => a.name === `github-${E2E_GITHUB_PAT_LOGIN}-pat`);
    await uiToolCall(
      "repositories",
      "add_github_account_with_pat",
      left ? { patAlias: { implementation: left.implementation, name: left.name, ...(left.group ? { group: left.group } : {}) } } : { pat: E2E_GITHUB_PAT },
    );
  }
  const alias = `e2e-bkrepo-${Date.now()}`;
  const scratch = mkdtempSync(join(tmpdir(), "banto-e2e-bkrepo-"));
  try {
    await withSshHost(
      async (host) => {
        // ---- 向こう：Project の根（コードのコミット1つ）。origin は偽の GitHub（向こうからは届かない） -------------------
        const home = `/home/${host.user}`;
        const prepared = await host.ssh(
          [
            "set -e",
            "mkdir -p ~/work/proj",
            "cd ~/work/proj",
            "git init -q -b main",
            "git -c user.name=e2e -c user.email=e2e@example.com commit -q --allow-empty -m code",
            `git remote add origin '${originUrl}'`,
          ].join(" && "),
        );
        expect(prepared.code, prepared.stderr).toBe(0);
        const remoteRef = async (ref: string) =>
          // 持ち主の違う root から読むので --git-dir で（-C だと safe.directory で断られる）
          (await host.rootExec(`git --git-dir ${home}/work/proj/.git rev-parse --verify -q ${ref} || echo 無い`)).stdout.trim();
        const githubRef = () => gitHere(scratch, "ls-remote", originUrl, "refs/heads/backlog").split("\t")[0] || "無い";

        const target = { name, host: host.address, user: host.user, port: host.port, identity: alias };
        const scanned = await api<{ hostKey: { type: string; key: string } }>("/api/runtimes/scan", { method: "POST", body: target });
        expect(scanned.status, JSON.stringify(scanned.body)).toBe(200);
        const registered = await api("/api/runtimes", { method: "POST", body: { runtime: target, hostKey: scanned.body.hostKey } });
        expect(registered.status, JSON.stringify(registered.body)).toBe(201);
        const created = await api<{ id: string }>("/api/projects", {
          method: "POST",
          body: { name: `E2E Backlog を Repositories で ${name}`, root: "~/work/proj", runtime: `remote:${name}` },
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const projectId = created.body.id;
        const threadId = (await api<{ id: string }>(`/api/projects/${projectId}/threads`, { method: "POST" })).body.id;
        const ctx = { projectId, threadId };
        await expect
          .poll(() => connectedModules(projectId), { timeout: 600_000, message: "向こうで Backlog が繋がるまで（初回はコードを送る）" })
          .toEqual(expect.arrayContaining(["backlog"]));
        const conn = `backlog-${projectId}`;

        // ---- 1. 書いて送れる：偽の GitHub の backlog が向こうの手元と同じ。追跡の ref も合う -----------------------------
        const first = await callAsAgent(conn, "createItem", { kind: "task", title: "Written far away" }, ctx);
        expect(first.isError, first.text).toBe(false);
        expect(first.text, "Repositories が送っていない").not.toContain("origin に送れませんでした");
        const local1 = await remoteRef("refs/heads/backlog");
        expect(local1).toMatch(/^[0-9a-f]{40}$/);
        expect(githubRef(), "偽の GitHub に backlog が届いていない").toBe(local1);
        expect(await remoteRef("refs/remotes/origin/backlog"), "向こうの追跡の ref が送ったコミットに合っていない").toBe(local1);
        const listed = await callAsAgent(conn, "listItems", {}, ctx);
        expect(listed.isError, listed.text).toBe(false);
        expect(listed.text).not.toContain("送っていない変更");
        expect(listed.structured?.sync).toMatchObject({ origin: true, ahead: 0 });

        // ---- 2. GitHub の側で進んだあと、もう1件書く：取ってきて取り込んでから書き、送れる ------------------------------
        const other = join(scratch, "other");
        const withPat = originUrl.replace("://", `://${E2E_GITHUB_PAT_LOGIN}:${E2E_GITHUB_PAT}@`);
        gitHere(scratch, "clone", "-q", "--no-checkout", withPat, other);
        gitHere(other, "fetch", "-q", "origin", "backlog:backlog");
        const doc = JSON.parse(gitHere(other, "show", "backlog:tasks.json")) as { items: Array<{ title: string }> };
        doc.items[0]!.title = "Renamed on GitHub";
        const file = join(scratch, "tasks.json");
        writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
        const blob = gitHere(other, "hash-object", "-w", file);
        const tree = execFileSync("git", ["-C", other, "mktree"], { input: `100644 blob ${blob}\ttasks.json\n`, encoding: "utf8" }).trim();
        const commit = gitHere(other, "commit-tree", tree, "-p", "backlog", "-m", "backlog: renamed on GitHub");
        gitHere(other, "push", "-q", "origin", `${commit}:refs/heads/backlog`);
        expect(githubRef()).toBe(commit);

        const second = await callAsAgent(conn, "createItem", { kind: "task", title: "Written after fetch" }, ctx);
        expect(second.isError, second.text).toBe(false);
        expect(second.text, "取り込んでから送れていない").not.toContain("origin に送れませんでした");
        const local2 = await remoteRef("refs/heads/backlog");
        expect(githubRef()).toBe(local2);
        expect((await host.rootExec(`git --git-dir ${home}/work/proj/.git merge-base --is-ancestor ${commit} ${local2} && echo yes`)).stdout.trim(), "GitHub の側のコミットを取り込んでいない").toBe("yes");
        gitHere(other, "fetch", "-q", "origin", "+backlog:backlog");
        const onGithub = JSON.parse(gitHere(other, "show", "backlog:tasks.json")) as { items: Array<{ title: string }> };
        expect(onGithub.items.map((i) => i.title)).toEqual(["Renamed on GitHub", "Written after fetch"]);

        // 承認のカードに、送り先とアカウントが出ていた（名乗った引数——branch_target で引いたもの。レビュー H1）
        const pushCard = answeredCards.find((c) => c.includes("push_branch"));
        expect(pushCard, "push_branch の承認のカードが出ていない").toBeTruthy();
        expect(pushCard).toContain(`github.com/${E2E_GITHUB_PAT_LOGIN}/${repoName}`);
        expect(pushCard).toContain(E2E_GITHUB_PAT_LOGIN);

        // ---- 2b. origin を別のリポジトリ（同じ持ち主）に書き換える：最初に決めた送り先と違うので送らない（レビュー H1） ---
        const otherRepo = `${repoName}-other`;
        await setGithubLoginFixture({ addRepo: { owner: E2E_GITHUB_PAT_LOGIN, name: otherRepo } });
        const otherUrl = `${web}/${E2E_GITHUB_PAT_LOGIN}/${otherRepo}.git`;
        const rewired = await host.ssh(`cd ~/work/proj && git remote set-url origin '${otherUrl}'`);
        expect(rewired.code, rewired.stderr).toBe(0);
        const third = await callAsAgent(conn, "createItem", { kind: "task", title: "After origin rewrite" }, ctx);
        expect(third.isError, third.text).toBe(false);
        expect(third.text).toContain("origin に送れませんでした");
        expect(third.text).toContain(`github.com/${E2E_GITHUB_PAT_LOGIN}/${repoName}`);
        expect(third.text).toContain("決めてあります");
        expect(gitHere(scratch, "ls-remote", otherUrl, "refs/heads/backlog"), "書き換えた先に送った").toBe("");
        expect(githubRef(), "決めた送り先が動いた").toBe(local2);

        // ---- 3. PAT は向こうのどこにも無い（SSH の外から root で探す） ------------------------------------------------
        const leaked = await host.rootExec(`grep -rlF -- '${E2E_GITHUB_PAT}' /home /tmp /var/tmp /run/user 2>/dev/null || true`);
        expect(leaked.stdout.trim(), "PAT が向こうに出ている").toBe("");

        await api(`/api/projects/${projectId}/close`, { method: "POST" });
      },
      { vaultAlias: alias },
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    if (added) await uiToolCall("repositories", "remove_github_account", { login: E2E_GITHUB_PAT_LOGIN }).catch(() => undefined);
  }
});
