// **Project を畳んだら、その Project のために立てたものを落とす**
// （`relay-lifecycle-and-elicitation`、2026-09-10）。
//
// 寿命の設計（アーキ仕様 §5.4-0・v4-security.md）は決まっていたのに、**畳む側が
// 書かれていなかった**——記録だけ閉じて、Module のプロセスは残り続けていた。
// 鍵を持つもの（Vault の ssh-agent 等）まで生き残るので、放置できない。
//
// 規則14：「閉じられた」で終わらせず、**プロセスが実際に消えたか**を見る。
import { test, expect } from "../test-base.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);
test.use({ viewport: { width: 390, height: 844 } });

const PROJECT_NAME = "E2E Close Release Project";

/**
 * **その Project のために立っている Module のプロセス数**——Project のコンテナの中を数える（改訂・2026-09-25）。
 * 中のプロセスはホストからも見えるが、別の名前空間なので環境変数を読めない。見るのは banto の外（Incus）から
 * ——止まっていれば 0
 */
function containerState(projectId: string): string {
  return spawnSync("incus", ["list", `banto-${projectId}`, "-f", "csv", "-c", "s"], { encoding: "utf8", input: "" }).stdout.trim();
}
function moduleProcessesInContainer(projectId: string): number {
  if (containerState(projectId) !== "RUNNING") return 0;
  const r = spawnSync(
    "incus",
    ["exec", `banto-${projectId}`, "--", "sh", "-c", 'pgrep -f "modules/(shell|filesystem)/dist/server.js" | wc -l'],
    { encoding: "utf8", input: "" },
  );
  return Number(r.stdout.trim());
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
  expect(moduleProcessesInContainer(project.id), "繋がったのにプロセスが居ない").toBe(2);

  // 畳む
  const closed = await page.request.post(`${CORE_BASE_URL}/api/projects/${project.id}/close`, { headers });
  expect(closed.ok()).toBe(true);
  const body = await closed.json();
  expect(body.released, "何を落としたかを返していない").toEqual(
    expect.arrayContaining([`shell-${project.id}`, `filesystem-${project.id}`]),
  );

  // **本当に消えたか**を見る（記録が閉じただけでは足りない）
  await expect
    .poll(() => moduleProcessesInContainer(project.id), { timeout: 30_000, message: "プロセスが落ちるまで" })
    .toBe(0);
  // コンテナも止まる（道具を入れた状態は残し、開き直したら起こす）
  expect(containerState(project.id), "畳んだのにコンテナが動いている").toBe("STOPPED");

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
  expect(moduleProcessesInContainer(project.id)).toBe(2);

  // 後始末（この spec が立てたものを残さない）
  await page.request.post(`${CORE_BASE_URL}/api/projects/${project.id}/close`, { headers });
  await expect.poll(() => moduleProcessesInContainer(project.id), { timeout: 30_000 }).toBe(0);
});
