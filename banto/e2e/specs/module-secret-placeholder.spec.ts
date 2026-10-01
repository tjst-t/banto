// **`${secret:名前}` が本当に金庫から届く**（追加・2026-09-16、
// `docs/specs/v4-architecture.md`「秘密は `${secret:名前}` で書く」）。
//
// ここで見たいのは「起動が通った」ではない（規則14）。**値が届いたこと**を、
// Module 自身が書き出したものを読んで確かめる——host の自己申告を信じない。
//
// **試験が秘密を平文で持つ**が、それは試験が作った使い捨てで、実運用の
// 秘密ではない。書き出す先は Module の置き場（閉じ込めが唯一許す書き先）。
import { test, expect } from "../test-base.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN, DATA_DIR } from "../config.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

const STAMP = Date.now();
const ALIAS = `e2e-secret-${STAMP}`;
const VALUE = `value-${STAMP}`;
const OK_MODULE = `e2e-secret-ok-${STAMP}`;
const MISSING_MODULE = `e2e-secret-missing-${STAMP}`;

/** Module の置き場（`${moduleDataDir}`）——core の組み立てと同じ規則（規則3）。 */
const outputOf = (moduleName: string) => join(DATA_DIR, "modules", moduleName, "out.txt");

/** 受け取った値をそのまま自分の置き場へ書いて終わる。MCP サーバではない。 */
const WRITE_BACK = "require('node:fs').writeFileSync(process.env.OUT, process.env.TOKEN ?? '')";

async function api(path: string, init: RequestInit = {}) {
  return fetch(`${CORE_BASE_URL}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

/** banto 全体の Module を起こす口——**一覧を読むだけでは立たない**ので、ここを叩く。 */
async function wakeInstanceModules() {
  await api("/api/ui-settings");
}

function declarationFor(name: string, alias: string) {
  return {
    mcpServers: {
      [name]: {
        command: "${nodeExec}",
        args: ["-e", WRITE_BACK],
        env: { TOKEN: `\${secret:${alias}}`, OUT: "${moduleDataDir}/out.txt" },
      },
    },
  };
}

test.beforeAll(async () => {
  // **共通グループに置く**——banto 全体に1本立つ Module の刻印は
  // `{instance:true}` で、Project に紐付いた秘密は引けない（引けてはいけない）
  const created = await api("/api/ui-tool-call", {
    method: "POST",
    body: JSON.stringify({
      server: "vault-directory",
      tool: "createAlias",
      arguments: { name: ALIAS, kind: "secret", value: VALUE },
    }),
  });
  expect(created.status, "秘密を置けなかった").toBeLessThan(400);
});

test.afterAll(async () => {
  for (const name of [OK_MODULE, MISSING_MODULE]) {
    await api(`/api/modules/${encodeURIComponent(name)}`, { method: "DELETE" });
  }
  await api("/api/ui-tool-call", {
    method: "POST",
    body: JSON.stringify({ server: "vault-directory", tool: "deleteAlias", arguments: { name: ALIAS } }),
  });
});

test("金庫の値が、起動する Module の環境変数に届く——宣言には名前しか無い", async () => {
  const added = await api("/api/modules", {
    method: "POST",
    body: JSON.stringify(declarationFor(OK_MODULE, ALIAS)),
  });
  expect(added.status, "Module を足せなかった").toBeLessThan(400);

  // **宣言に値が入っていない**ことを、取り出し口で確かめる（ここが目的）
  const exported = (await (await api("/api/modules/export")).json()) as {
    mcpServers: Record<string, { env?: Record<string, string> }>;
  };
  expect(exported.mcpServers[OK_MODULE]?.env?.TOKEN, "宣言に平文が入っている").toBe(
    `\${secret:${ALIAS}}`,
  );
  expect(JSON.stringify(exported), "取り出した設定に値そのものが混ざっている").not.toContain(VALUE);

  await wakeInstanceModules();

  // **Module 自身が書いたものを読む**。これが「届いた」の唯一の証拠。
  // **書き出しが無いときは、host が持っている理由をそのまま出す**（規則2・規則15
  // ——「出ませんでした」だけでは、次にどこを見ればよいか分からない）
  await expect
    .poll(
      async () => {
        try {
          return readFileSync(outputOf(OK_MODULE), "utf8");
        } catch {
          const list = (await (await api("/api/modules")).json()) as Array<{
            name: string;
            error?: string;
            connected?: boolean;
          }>;
          const found = list.find((m) => m.name === OK_MODULE);
          return `書き出しが無い（host の言い分：${found?.error ?? "理由なし"} / connected=${found?.connected}）`;
        }
      },
      { timeout: 60_000, message: "Module が値を受け取っていない" },
    )
    .toBe(VALUE);
});

test("引けない名前を書いたら、起動せずに理由が出る——空文字で立ち上がらない", async () => {
  const added = await api("/api/modules", {
    method: "POST",
    body: JSON.stringify(declarationFor(MISSING_MODULE, `${ALIAS}-does-not-exist`)),
  });
  expect(added.status, "Module を足せなかった").toBeLessThan(400);

  await wakeInstanceModules();

  // **理由が残る**（規則2——黙って落ちない）
  await expect
    .poll(
      async () => {
        const list = (await (await api("/api/modules")).json()) as Array<{ name: string; error?: string }>;
        return list.find((m) => m.name === MISSING_MODULE)?.error ?? null;
      },
      { timeout: 60_000, message: "引けなかったのに理由が残っていない" },
    )
    // **何を引けなかったのかが分かること**。文言そのものは金庫の並びで変わる
    // （読めない金庫があれば、そう言う）ので、そこには縛らない
    .toContain(`秘密 "${ALIAS}-does-not-exist" を引けませんでした`);

  // **空文字で立ち上げていない**——立っていたら書き出しが在る
  expect(() => readFileSync(outputOf(MISSING_MODULE), "utf8")).toThrow();
});
