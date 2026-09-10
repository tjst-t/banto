// **Project を畳んだら、その Project のために立てたものを落とす**
// （`relay-lifecycle-and-elicitation`、2026-09-10）。
//
// 寿命の設計（アーキ仕様 §5.4-0・v4-security.md）は決まっていたのに、**畳む側が
// 書かれていなかった**——記録だけ閉じて、Module のプロセスは残り続けていた。
// 鍵を持つもの（Vault の ssh-agent 等）まで生き残るので、放置できない。
//
// 規則14：「閉じられた」で終わらせず、**プロセスが実際に消えたか**を見る。
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);
test.use({ viewport: { width: 390, height: 844 } });

const PROJECT_NAME = "E2E Close Release Project";

/**
 * その Project のために立っている Module のプロセス数。
 *
 * **どの Project のものかは、コマンド行では分からない**（Landlock の launcher が
 * node を exec するので、引数にルールセットの名前が残らない）。プロセスの
 * 環境変数（`BANTO_PROJECT_ROOT`）で見分ける。
 */
function moduleProcessesFor(projectRoot: string): number {
  const out = execSync('pgrep -f "modules/(shell|filesystem)/dist/server.js" || true').toString();
  const pids = out.split("\n").filter(Boolean);
  return pids.filter((pid) => {
    try {
      return readFileSync(`/proc/${pid}/environ`, "utf8").includes(`BANTO_PROJECT_ROOT=${projectRoot}`);
    } catch {
      return false; // もう居ない
    }
  }).length;
}

test("Project を畳むと、その Project の Module のプロセスが落ちる", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-close-"));
  const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

  await openApp(page);
  await createProject(page, PROJECT_NAME, projectRoot);

  const projects = await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json();
  const project = projects.find((p: { name: string }) => p.name === PROJECT_NAME);

  // 開いた時点で Project の Module が立つ（§5.4-0）——立っていることを先に見る。
  // 立っていないなら、この試験は「落ちた」を見たことにならない。
  //
  // **待つのは host の「繋がった」**（プロセスの有無ではない）。プロセスは spawn した
  // 瞬間から見えるが、host が台帳に載せるのは MCP の握手と申告の突き合わせが
  // 終わってから——ここを取り違えると、**登録前に畳んで「落とすものが無い」**に
  // なる（実測・2026-09-10、この試験自身が最初そう falsely 落ちた）
  await expect
    .poll(
      async () => {
        const res = await page.request.post(`${CORE_BASE_URL}/api/projects/${project.id}/modules/prepare`, {
          headers,
        });
        return ((await res.json()).connected ?? []) as string[];
      },
      { timeout: 60_000, message: "Module が繋がるまで" },
    )
    .toEqual(expect.arrayContaining(["shell", "filesystem"]));
  expect(moduleProcessesFor(projectRoot), "繋がったのにプロセスが居ない").toBe(2);

  // 畳む
  const closed = await page.request.post(`${CORE_BASE_URL}/api/projects/${project.id}/close`, { headers });
  expect(closed.ok()).toBe(true);
  const body = await closed.json();
  expect(body.released, "何を落としたかを返していない").toEqual(
    expect.arrayContaining([`shell-${project.id}`, `filesystem-${project.id}`]),
  );

  // **本当に消えたか**を見る（記録が閉じただけでは足りない）
  await expect
    .poll(() => moduleProcessesFor(projectRoot), { timeout: 30_000, message: "プロセスが落ちるまで" })
    .toBe(0);

  // 開き直せば、また立つ（畳んだきり使えなくなっていない）
  const reopened = await page.request.post(`${CORE_BASE_URL}/api/projects/${project.id}/reopen`, { headers });
  expect(reopened.ok()).toBe(true);
  await expect
    .poll(
      async () => {
        const res = await page.request.post(`${CORE_BASE_URL}/api/projects/${project.id}/modules/prepare`, {
          headers,
        });
        return ((await res.json()).connected ?? []) as string[];
      },
      { timeout: 60_000, message: "開き直したら、また繋がる" },
    )
    .toEqual(expect.arrayContaining(["shell", "filesystem"]));
  expect(moduleProcessesFor(projectRoot)).toBe(2);

  // 後始末（この spec が立てたものを残さない）
  await page.request.post(`${CORE_BASE_URL}/api/projects/${project.id}/close`, { headers });
  await expect.poll(() => moduleProcessesFor(projectRoot), { timeout: 30_000 }).toBe(0);
});
