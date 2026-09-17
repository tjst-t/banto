// **URL に繋ぐ Module**（追加・2026-09-17、ユーザー指示）。
//
// 見るのは4つ（規則14——「繋がった」で終わらせない）：
//   1. **承知していなければ足せない**。断る理由に**相手の名前**が出る
//   2. 承知すれば繋がり、**AI から実際に tool が呼べて、中身が返る**
//   3. **`${secret:…}` がヘッダで相手に届く**——受け取った側から確かめる
//   4. **消したら承認も忘れる**——同じ名前で繋ぎ直すときに聞き直す
//
// 相手は**試験が立てるローカルのサーバ**。本物の公開サーバ（Cloudflare Docs・
// DeepWiki）で繋がることは別に実測してある（`docs/notes/2026-09-17-remote-mcp.md`）
// ——外の都合で落ちる試験は、機構の故障と見分けが付かない（規則6）。
import { test, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CORE_BASE_URL, AUTH_TOKEN, CORE_PORT } from "../config.js";
import { startRemoteMcpFixture, type RemoteFixture } from "../remote-mcp-fixture.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

const STAMP = Date.now();
const MODULE = `e2e-remote-${STAMP}`;
const ALIAS = `e2e-remote-key-${STAMP}`;
const SECRET = `rk-${STAMP}`;

/** core と同じ枠から、この実行だけの port を1つ借りる（他の実行とぶつからない）。 */
const FIXTURE_PORT = CORE_PORT + 1000;

let fixture: RemoteFixture;

async function api(path: string, init: RequestInit = {}) {
  return fetch(`${CORE_BASE_URL}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

/** banto 全体の Module を起こす口——一覧を読むだけでは立たない。 */
const wake = () => api("/api/ui-settings");

/** AI から見えるのと同じ経路（代理サーバ）で繋ぐ。 */
async function asAgent(connName: string): Promise<Client> {
  const client = new Client({ name: "e2e", version: "0.0.0" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${CORE_BASE_URL}/agent-relay/${connName}`), {
      requestInit: { headers: { authorization: `Bearer ${AUTH_TOKEN}` } },
    }),
  );
  return client;
}

const textOf = (result: unknown) => ((result as { content: { text: string }[] }).content[0]?.text ?? "");

test.beforeAll(async () => {
  fixture = await startRemoteMcpFixture(FIXTURE_PORT);
  await api("/api/ui-tool-call", {
    method: "POST",
    body: JSON.stringify({
      server: "vault-directory",
      tool: "createAlias",
      arguments: { name: ALIAS, kind: "secret", value: SECRET },
    }),
  });
});

test.afterAll(async () => {
  await api(`/api/modules/${encodeURIComponent(MODULE)}`, { method: "DELETE" });
  await api("/api/ui-tool-call", {
    method: "POST",
    body: JSON.stringify({ server: "vault-directory", tool: "deleteAlias", arguments: { name: ALIAS } }),
  });
  await fixture.close();
});

test("承知していなければ足せない——断る理由に、相手の名前が出る", async () => {
  const res = await api("/api/modules", {
    method: "POST",
    body: JSON.stringify({ mcpServers: { [MODULE]: { type: "http", url: fixture.url } } }),
  });
  expect(res.status, "外へ出す Module が、承認なしで足せてしまう").toBe(400);
  const body = (await res.json()) as { error: string; needsEgressAcknowledgement?: unknown[] };
  // **どこへ出るのかが、断り文句に入っている**（規則14——文言の中身まで見る）
  expect(body.error, "相手の名前を言っていない").toContain(`127.0.0.1:${FIXTURE_PORT}`);
  expect(body.needsEgressAcknowledgement, "何を承認すればよいか返していない").toHaveLength(1);

  // **足されていない**（断ったのに登録だけ残っていない）
  const list = (await (await api("/api/modules")).json()) as Array<{ name: string }>;
  expect(list.some((m) => m.name === MODULE), "断ったのに登録が残っている").toBe(false);
});

test("承知すれば繋がり、AI から呼べて中身が返る——秘密はヘッダで相手に届く", async () => {
  const added = await api("/api/modules", {
    method: "POST",
    body: JSON.stringify({
      acknowledgeEgress: true,
      mcpServers: {
        [MODULE]: {
          type: "http",
          url: fixture.url,
          headers: { Authorization: `Bearer \${secret:${ALIAS}}` },
        },
      },
    }),
  });
  expect(added.status, `足せなかった：${await added.text()}`).toBe(200);

  // **宣言に値は残っていない**——名前だけ
  const exported = (await (await api("/api/modules/export")).json()) as {
    mcpServers: Record<string, { url?: string; headers?: Record<string, string> }>;
  };
  expect(exported.mcpServers[MODULE]?.headers?.Authorization).toBe(`Bearer \${secret:${ALIAS}}`);
  expect(JSON.stringify(exported), "取り出した設定に秘密そのものが混ざっている").not.toContain(SECRET);

  await wake();
  await expect
    .poll(
      async () => {
        const list = (await (await api("/api/modules")).json()) as Array<{
          name: string;
          connected: boolean;
          error?: string;
        }>;
        const m = list.find((x) => x.name === MODULE);
        return m?.connected ? true : (m?.error ?? "まだ立っていない");
      },
      { timeout: 60_000, message: "URL に繋げていない" },
    )
    .toBe(true);

  // **AI から実際に呼べて、相手の答えが返る**（規則14）
  const agent = await asAgent(MODULE);
  try {
    const tools = (await agent.listTools()).tools.map((t) => t.name).sort();
    expect(tools, "リモートの tool が AI に届いていない").toEqual(["echo", "whoCalled"]);
    expect(textOf(await agent.callTool({ name: "echo", arguments: { word: "こんにちは" } }))).toBe(
      "remote-said:こんにちは",
    );
    // **秘密が本当にヘッダで届いたか**を、受け取った側から確かめる（規則1）
    expect(textOf(await agent.callTool({ name: "whoCalled" })), "秘密がヘッダで届いていない").toBe(
      `Bearer ${SECRET}`,
    );
  } finally {
    await agent.close();
  }
  // 試験の側から見ても同じ（fixture が実際に受け取った値）
  expect(fixture.lastAuthorization()).toBe(`Bearer ${SECRET}`);
});

test("消したら承認も忘れる——同じ名前で繋ぎ直すときは聞き直す", async () => {
  const removed = await api(`/api/modules/${encodeURIComponent(MODULE)}`, { method: "DELETE" });
  expect(removed.status).toBe(200);

  // **同じ名前・同じ URL でも、もう一度承知が要る**（前の承認を引き継がない）
  const again = await api("/api/modules", {
    method: "POST",
    body: JSON.stringify({ mcpServers: { [MODULE]: { type: "http", url: fixture.url } } }),
  });
  expect(again.status, "消したのに前の承認が効いている").toBe(400);
});
