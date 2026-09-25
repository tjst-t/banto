// **Shell 専用のホーム**（決定・2026-09-23、ユーザー）。
//
// Shell のコマンドは閉じ込めの中で走り、人のホームは読めない。以前は host の HOME を継いで
// いたので、**ローカルの `git commit` すら落ちていた**（`~/.gitconfig` が読めず致命的）。
// Project ごとに書けるホームを用意し、人が選んだ設定だけを写す（Dev Containers と同じ形）。
//
// 見ること（規則14——動いたかだけでなく、中身まで）：
//   - HOME が Shell のホームを指し、git が写した名前で commit でき、npm のキャッシュも書ける
//   - **資格情報の取り出し役と include は外れている**（元の設定には在る）
//   - 閉じ込めの外を触って落ちたら、結果に理由が添えられる
//   - 設定で写すものを外すと、立っている Shell からも消える。資格情報の置き場は足せない
//
// 写す元は偽のホーム（`SHELL_HOME_SOURCE`）——本物の人の設定を試験に使わない。

import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AUTH_TOKEN, CORE_BASE_URL, DATA_DIR, SHELL_HOME_SOURCE, E2E_CONTAINERS } from "../config.js";
import { createProject, openApp, waitForProjectModule } from "../helpers.js";

const HEADERS = { authorization: `Bearer ${AUTH_TOKEN}` };
const PROJECT_NAME = "E2E Shell Home";

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

interface Ran {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  confinementNote?: string;
}

/** AI を通さずに、AI が通る経路そのもの（代理サーバ）で runCommand を呼ぶ。 */
async function run(projectId: string, command: string): Promise<Ran> {
  const client = new Client({ name: "e2e-shell-home", version: "0.0.0" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${CORE_BASE_URL}/agent-relay/shell-${projectId}`), {
      requestInit: { headers: HEADERS },
    }),
  );
  try {
    const result = await client.callTool({ name: "runCommand", arguments: { command } });
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Ran;
  } finally {
    await client.close();
  }
}

async function projectId(page: Page): Promise<string> {
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers: HEADERS })).json()) as Array<{
    id: string;
    name: string;
  }>;
  return projects.find((p) => p.name === PROJECT_NAME)!.id;
}

async function openShellHomeSettings(page: Page) {
  await page.goto(`/settings?bantoToken=${AUTH_TOKEN}&bantoHost=${CORE_BASE_URL}`);
  await page.getByRole("button", { name: "Shell のホーム", exact: true }).click();
  await expect(page.getByTestId("shell-home-panel")).toBeVisible({ timeout: 20_000 });
}

test("Shell のホームに git の設定が写り、名前で commit でき、資格情報の取り出し役は外れている", async ({ page }) => {
  await openApp(page);
  await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-shell-home-")));
  await waitForProjectModule(page, PROJECT_NAME, "shell");
  const id = await projectId(page);
  const shellHome = join(DATA_DIR, "modules", `shell-${id}`, "home");

  const r = await run(
    id,
    [
      'echo "HOME=$HOME"',
      "git config --global user.name",
      "git config --global --get-regexp '^(credential|include)' || echo NO-CREDENTIAL-OR-INCLUDE",
      "git init -q repo && cd repo && git commit -q --allow-empty -m first && git log --format='author=%an'",
      "cd ..",
      // npm のキャッシュが Shell のホームに書ける（以前は `~/.npm` に書けず落ちていた）
      'npm cache verify >/dev/null && test -d "$HOME/.npm/_cacache" && echo NPM-CACHE-IN-SHELL-HOME',
    ].join(" && "),
  );
  expect(r.exitCode, r.stderr).toBe(0);
  expect(r.stdout).toContain(`HOME=${shellHome}`);
  expect(r.stdout, "写した git の名前が見えない").toContain("E2E Taro");
  expect(r.stdout, "資格情報の取り出し役か include が残っている").toContain("NO-CREDENTIAL-OR-INCLUDE");
  expect(r.stdout, "ローカルの commit ができない").toContain("author=E2E Taro");
  expect(r.stdout, "npm のキャッシュが Shell のホームに書けていない").toContain("NPM-CACHE-IN-SHELL-HOME");

  // **人のホームは読めないまま**。落ちたら、結果に理由が添えられる
  const outside = await run(id, `cat ${SHELL_HOME_SOURCE}/.gitconfig`);
  expect(outside.exitCode).not.toBe(0);
  expect(outside.stdout, "閉じ込めの外が読めた").not.toContain("E2E Taro");
  // コンテナの形では、人のホームのものは弾かれるのではなく中に無い（`docs/specs/v4-security.md` §1）
  expect(outside.confinementNote ?? "", "閉じ込めで落ちた理由が添えられていない").toContain(
    E2E_CONTAINERS
      ? `Project のコンテナの中にありません：${SHELL_HOME_SOURCE}/.gitconfig`
      : `閉じ込めの外にあるため触れませんでした：${SHELL_HOME_SOURCE}/.gitconfig`,
  );
});

test("設定で写すものを選べる——外すと立っている Shell からも消え、資格情報の置き場は足せない", async ({ page }) => {
  const id = await projectId(page);
  await openShellHomeSettings(page);
  const files = page.getByTestId("shell-home-files");
  await expect(files.locator("[data-file]")).toHaveText(["~/.gitconfig", "~/.config/git"]);
  // 写したときに外したものが出ている（黙って外さない）
  await expect(page.getByTestId("shell-home-sanitized")).toContainText("credential.https://github.com.helper");
  await expect(page.getByTestId("shell-home-sanitized")).toContainText("include.path");

  // 外す → 立っている Shell のホームからも消える（再起動は要らない）
  await page.getByRole("button", { name: "~/.config/git を写すのをやめる" }).click();
  await expect(files.locator("[data-file]")).toHaveText(["~/.gitconfig"]);
  expect((await run(id, "test -e $HOME/.config/git/ignore && echo STILL || echo GONE")).stdout).toContain("GONE");

  // 資格情報の置き場は足せない——理由がその場に出る
  const input = page.getByLabel("写すものを足す");
  await input.fill(".ssh");
  await page.getByRole("button", { name: "足す", exact: true }).click();
  await expect(page.getByTestId("shell-home-save-error")).toContainText(".ssh は写せません");
  await expect(files.locator("[data-file]")).toHaveText(["~/.gitconfig"]);

  // 足し直すと戻る
  await input.fill(".config/git");
  await page.getByRole("button", { name: "足す", exact: true }).click();
  await expect(files.locator("[data-file]")).toHaveText(["~/.gitconfig", "~/.config/git"]);
  expect((await run(id, "cat $HOME/.config/git/ignore")).stdout).toContain("*.e2e-ignored");
});
