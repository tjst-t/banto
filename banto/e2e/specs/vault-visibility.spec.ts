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
import { fakeTurn } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

/** AI（Runner）に見えている vault の道具の一覧を、同じ経路で取る。 */
async function toolsVisibleToAgent(server = "vault-local"): Promise<string[]> {
  const client = new Client({ name: "e2e-visibility", version: "0.0.0" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${CORE_BASE_URL}/agent-relay/${server}`), {
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

  // **申請の入口は窓口（`vault-directory`）が1本だけ持つ**（改訂・2026-09-12）。
  // backend が2本になったとき、`requestAlias` が AI に2つ並んで**選ぶ材料が無い**
  // ——実際、走らせるたびに選ぶ先が変わった。なので backend 側の `requestAlias` は
  // `module` へ降格し、AI に見えるのは窓口の1本だけにした。
  // 片側だけでは「そもそも繋がっていない」と区別できないので、**ここで動いている
  // ことを確かめる**——`mcp__vault-directory__requestAlias` が見えていること。
  expect(names, `backend 側に AI 向けの入口が残っている: ${names.join(", ")}`).not.toContain(
    "requestAlias",
  );
  // 片側だけでは「そもそも繋がっていない」と区別できないので、**窓口には
  // 出ていること**をここで確かめる（消えたのではなく、移った）
  expect(
    await toolsVisibleToAgent("vault-directory"),
    "backend からも窓口からも申請の入口が消えている（ただ繋がっていないだけかもしれない）",
  ).toContain("requestAlias");

  // **実際の値を取る道具・管理操作は、AI からは見えない**
  for (const hidden of ["resolveAlias", "startSshAgent", "verify"]) {
    expect(names, `${hidden} が AI から見えている（module 限定のはず）`).not.toContain(hidden);
  }
  for (const hidden of [
    "createAlias",
    "updateAlias",
    "deleteAlias",
    "listAliases",
    "listGroups",
    "createGroup",
    "listGroupBindings",
    "setGroupBinding",
    "generateSecret",
    "generateKeypair",
    "migrateTo",
  ]) {
    expect(names, `${hidden} が AI から見えている（admin 限定のはず）`).not.toContain(hidden);
  }

  // Module 自身の申告（host だけが読む）も、AI の道具として漏れていない
  expect(names.some((n) => n.toLowerCase().includes("module"))).toBe(false);
});

// **画面 API も同じ境界を持つ**（決定・2026-09-10、docs/specs/v4-security.md）。
// 以前は合言葉さえあれば画面から任意の tool 名を呼べたので、AI には見せていない
// `resolveAlias` が**ブラウザ経由で呼べて、秘密の値が返っていた**
// ——可視性の強制がフロントエンドの自制だけに乗っていた。
test("画面 API からも、値を取る道具は呼べない——人の管理操作だけが通る", async ({ request }) => {
  await ensureModulesConnected();
  const headers = { authorization: `Bearer ${AUTH_TOKEN}` };
  const alias = `e2e-visibility-${Date.now()}`;
  const secret = `画面からは見えないはず${Date.now()}`;

  // 人の管理操作（admin）は通る——ここが通らないと設定画面が動かない
  const created = await request.post(`${CORE_BASE_URL}/api/ui-tool-call`, {
    headers,
    data: {
      server: "vault-local",
      tool: "createAlias",
      // scope は instance——この試験が見たいのは可視性の境界で、対象の割り当て
      // ではない（`scope: "project"` は projectId とセットでないと作れない）
      arguments: { name: alias, kind: "secret", value: secret },
    },
  });
  expect(created.status(), "人の管理操作まで塞いでしまっている").toBe(200);

  // **値を取る道具（module 可視性）は拒否される**
  const resolved = await request.post(`${CORE_BASE_URL}/api/ui-tool-call`, {
    headers,
    data: { server: "vault-local", tool: "resolveAlias", arguments: { name: alias } },
  });
  expect(resolved.status(), "画面 API から resolveAlias が通ってしまった").toBe(403);
  const body = await resolved.text();
  expect(body, "拒否したのに値が返っている").not.toContain(secret);
  expect(body).toContain("Module 間専用");
});

// **AI が実際に Vault を読めるか**（追加・2026-09-12、ユーザー指摘）。
//
// 仕様は「Runner は resource を組み込み tool 経由で読む」と決めているのに、
// Runner の `tools` 指定が基底集合を置き換えるため `ListMcpResourcesTool` 等が
// 落ちていて、**AI は Module の resource を1つも読めなかった**。
// 一覧に載せる・説明を書く、だけでは足りない——**本物のターンで読めること**を見る。
//
// **AI に見えている `vault://aliases` は窓口のもの**（改訂・2026-09-12）
// ——backend 側の同名の資源は `module` へ降ろしたので、AI が読めるのは
// `vault-directory` が横断してまとめた1本だけ。ここで値を置くのは backend
// （`vault`）なので、**窓口が横断できていなければこの試験は落ちる**。
test("AI は vault://aliases を実際に読める——名前は見え、値は見えない", async ({ request }) => {
  const headers = { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };
  const alias = `e2e-agent-reads-${Date.now()}`;
  const secret = `AI-MUST-NOT-SEE-${Date.now()}`;

  await ensureModulesConnected();
  const created = await fetch(`${CORE_BASE_URL}/api/ui-tool-call`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      server: "vault-local",
      tool: "createAlias",
      arguments: { name: alias, kind: "secret", value: secret, note: "E2E が置いた" },
    }),
  });
  expect(created.status).toBe(200);

  const project = await (
    await fetch(`${CORE_BASE_URL}/api/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "E2E Agent Reads Vault", root: mkdtempSync(join(tmpdir(), "banto-e2e-reads-")) }),
    })
  ).json();
  const thread = await (
    await fetch(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { method: "POST", headers })
  ).json();

  const res = await fetch(`${CORE_BASE_URL}/api/threads/${thread.id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt:
        "resource `vault://aliases` を読んで、登録されている alias の名前を" +
        "そのまま箇条書きで挙げてください。説明は要りません。" +
        // **読めた中身をそのまま発言に載せさせる**（訂正・2026-09-21）。この spec だけ
        // 偽 Runner への指示が入っておらず、「はい」とだけ返って落ちていた。
        // **読むのは偽物ではない**——偽 Runner は `vault-directory` の中継の口へ
        // 実際に繋いで `vault://aliases` を読む。つまりこの試験が見ているものは
        // 変わらない：**名前は見え、値は見えない**が中継越しに保たれているか。
        // むしろモデルの機嫌に依らなくなったぶん強い（notes/2026-09-21）
        fakeTurn({ resources: [{ server: "vault-directory", uri: "vault://aliases" }] }),
    }),
  });
  const transcript = await res.text();

  expect(
    transcript,
    "AI が vault://aliases を読めていない（組み込みの resource 読み取り tool が落ちている可能性）",
  ).toContain(alias);
  // **名前は見えても、値は見えない**——A節の原則がターン越しでも保たれている
  expect(transcript, "AI の文脈に秘密の値が流れている").not.toContain(secret);
});

// **使える範囲は、置き場（グループ）が決める**（決定・2026-09-13、ユーザー指摘）。
//
// 以前は alias の `scope` がただの札で、**別の Project からでも普通に引けた**
// （規則13——画面が制約を示しているのに実装は制約していない）。ここでは
// 本物の host 越しに、**AI が別 Project の秘密を見つけられないこと**を見る。
test("別の Project の秘密は、AI からは名前も見えない", async () => {
  const headers = { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };
  const mine = `e2e-mine-${Date.now()}`;
  const shared = `e2e-shared-${Date.now()}`;

  await ensureModulesConnected();
  const project = await (
    await fetch(`${CORE_BASE_URL}/api/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "E2E Vault Scope", root: mkdtempSync(join(tmpdir(), "banto-e2e-scope-")) }),
    })
  ).json();

  // その Project 専用のものと、共通のものを1つずつ置く
  for (const [name, args] of [
    [mine, { forProject: project.id }],
    [shared, {}],
  ] as Array<[string, Record<string, unknown>]>) {
    const res = await fetch(`${CORE_BASE_URL}/api/ui-tool-call`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        server: "vault-local",
        tool: "createAlias",
        arguments: { name, kind: "secret", value: "v", ...args },
      }),
    });
    expect(res.status).toBe(200);
  }

  const namesSeenBy = async (projectId: string) => {
    const client = new Client({ name: "e2e-scope", version: "0.0.0" }, { capabilities: {} });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${CORE_BASE_URL}/agent-relay/vault-directory`), {
        requestInit: {
          headers: { authorization: `Bearer ${AUTH_TOKEN}`, "x-banto-project-id": projectId },
        },
      }),
    );
    try {
      const read = await client.readResource({ uri: "vault://aliases" });
      return ((read.contents as { text: string }[])[0]!.text ?? "") as string;
    } finally {
      await client.close();
    }
  };

  const own = await namesSeenBy(project.id);
  expect(own, "自分の Project の秘密が見えない").toContain(mine);
  expect(own, "共通の秘密が見えない").toContain(shared);

  const other = await namesSeenBy("e2e-some-other-project");
  expect(other, "別の Project の秘密が名前ごと見えている").not.toContain(mine);
  expect(other, "共通の秘密まで隠れている").toContain(shared);

  for (const name of [mine, shared]) {
    await fetch(`${CORE_BASE_URL}/api/ui-tool-call`, {
      method: "POST",
      headers,
      body: JSON.stringify({ server: "vault-local", tool: "deleteAlias", arguments: { name } }),
    });
  }
});

// **公開鍵は秘密ではない**（追加・2026-09-13、ユーザー指摘「公開鍵は AI に
// 見せてもいいはず。その口は作らない？」）。相手方に登録するためのものなので、
// AI が読めないと鍵を作った意味が薄い。**秘密鍵は通らない**ことも同時に見る。
test("AI は公開鍵を読める——秘密鍵は返らない", async ({ request }) => {
  const headers = { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };
  const alias = `e2e-pubkey-${Date.now()}`;

  await ensureModulesConnected();
  const made = await fetch(`${CORE_BASE_URL}/api/ui-tool-call`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      server: "vault-directory",
      tool: "generateSecret",
      arguments: { implementation: "vault-local", name: alias, kind: "ssh-identity" },
    }),
  });
  expect(made.status).toBe(200);
  const publicKey = (JSON.parse(JSON.parse(await made.text()).content[0].text) as { publicKey: string })
    .publicKey;
  expect(publicKey).toMatch(/^ssh-ed25519 AAAA/);

  const project = await (
    await fetch(`${CORE_BASE_URL}/api/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "E2E Public Key", root: mkdtempSync(join(tmpdir(), "banto-e2e-pub-")) }),
    })
  ).json();
  const thread = await (
    await fetch(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { method: "POST", headers })
  ).json();

  const res = await fetch(`${CORE_BASE_URL}/api/threads/${thread.id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt:
        `alias "${alias}" の公開鍵を取得して、そのまま1行で書き出してください。説明は要りません。` +
        // 上の spec と同じ（訂正・2026-09-21）——**呼ぶ先は本物の中継**なので、
        // 「公開鍵は返るが秘密鍵は返らない」という検査はそのまま効く
        fakeTurn({ tools: [{ server: "vault-directory", name: "getPublicKey", args: { name: alias } }] }),
    }),
  });
  const transcript = await res.text();

  // **本物のターンで読めること**——一覧に載せるだけでは足りない（規則13）
  expect(transcript, "AI が公開鍵を読めていない").toContain(publicKey.split(" ")[1]!.slice(0, 40));
  expect(transcript, "秘密鍵が AI に渡っている").not.toContain("PRIVATE KEY");

  await fetch(`${CORE_BASE_URL}/api/ui-tool-call`, {
    method: "POST",
    headers,
    body: JSON.stringify({ server: "vault-directory", tool: "deleteAlias", arguments: { implementation: "vault-local", name: alias } }),
  });
});
