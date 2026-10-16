// **Dialog の中の Select の一覧が、引き金のすぐ下（か上）に出る**（Backlog #291 `move-dialog-select-topleft`）。
//
// 2026-10-14 実機：設定の重ね（`?settings=1`）の「一般」→「別の実行場所へ移す…」で、まだ何も選んでいない移す先を開くと、
// 一覧が画面の左上（サイドバーの上）に出た。Radix の Select の既定 `item-aligned` は「選んでいる項目（無ければ先頭の項目）」を
// 引き金に重ねる置き方で、**項目が1つも無いと合わせる先が無く、一覧が (0,0) に置かれる**（測って確かめた——移す先の
// 別のサーバが無いとき。項目があれば引き金に重なって出る）。
//
// 見るもの：一覧（`data-slot=select-content`）の箱が引き金の箱の真下（か真上）に接し、左端が揃っていること。パソコンと携帯の幅で。
//   1. 設定の重ねの「別の実行場所へ移す」の移す先（何も選んでいない）——移す先が無いときと、あるとき
//   2. 新しい Project の「どこで動かすか」（この機械のコンテナを選んでいる）
//
// **別のサーバの一覧（`GET /api/runtimes`）だけはブラウザの側で差し替える**——登録には SSH で入れる相手が要り
// （runtime-move-ui.spec.ts）、ここで見たいのは一覧の置き場所だけだから。選べる・選べないの中身は runtime-move-ui と
// remote-runtime-registry が本物で見ている。
import { test, expect, type Locator, type Page } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { AUTH_TOKEN, CORE_BASE_URL } from "../config.js";
import { openApp, openNav, clickNewProject } from "../helpers.js";

test.setTimeout(180_000);

const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

function fakeRuntime(name: string, unavailableReason?: string) {
  return {
    name,
    host: "192.0.2.10",
    user: "dev",
    port: 22,
    identity: "e2e-select-position",
    runtime: `remote:${name}`,
    hostKey: { type: "ssh-ed25519", key: "AAAA", fingerprint: "SHA256:x", confirmedAt: new Date().toISOString() },
    checks: [],
    checkedAt: new Date().toISOString(),
    usedBy: [],
    ...(unavailableReason ? { unavailableReason } : {}),
  };
}

const TWO_RUNTIMES = [fakeRuntime("sel-a"), fakeRuntime("sel-b", "Project「ほか」が使っています")];

async function stubRuntimes(page: Page, runtimes: unknown[] = TWO_RUNTIMES): Promise<void> {
  await page.route(/\/api\/runtimes$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ runtimes }),
    });
  });
}

/** 開いた一覧が、引き金の真下（か真上）に接し、左端が揃っている */
async function expectListAttachedTo(page: Page, trigger: Locator, label: string): Promise<void> {
  const list = page.locator('[data-slot="select-content"]');
  // 項目が無いと一覧は高さ 0 になりうる（見えない扱い）——在ることだけ待つ
  await expect(list, `${label}：一覧が開かない`).toHaveCount(1);
  // 開く動き（zoom-in）が終わってから測る
  await expect(list).toHaveAttribute("data-state", "open");
  await page.waitForTimeout(250);
  const t = (await trigger.boundingBox())!;
  const l = (await list.boundingBox())!;
  const viewport = page.viewportSize()!;
  const where = `引き金 ${JSON.stringify(t)}・一覧 ${JSON.stringify(l)}・画面 ${viewport.width}x${viewport.height}`;
  const below = Math.abs(l.y - (t.y + t.height)) <= 12;
  const above = Math.abs(l.y + l.height - t.y) <= 12;
  expect(below || above, `${label}：一覧が引き金の下にも上にも接していない（${where}）`).toBe(true);
  expect(Math.abs(l.x - t.x), `${label}：一覧の左端が引き金と揃っていない（${where}）`).toBeLessThanOrEqual(2);
  expect(l.x + l.width, `${label}：一覧が画面の右からはみ出す（${where}）`).toBeLessThanOrEqual(viewport.width);
}

for (const size of [
  { name: "パソコン", viewport: { width: 1280, height: 800 } },
  { name: "携帯", viewport: { width: 390, height: 844 } },
]) {
  test.describe(`${size.name}の幅`, () => {
    test.use({ viewport: size.viewport });

    async function openMoveDialog(page: Page): Promise<Locator> {
      const created = await page.request.post(`${CORE_BASE_URL}/api/projects`, {
        headers,
        data: {
          name: `E2E Select の位置 ${randomBytes(3).toString("hex")}`,
          root: mkdtempSync(join(tmpdir(), "banto-e2e-select-position-")),
        },
      });
      expect(created.status(), await created.text()).toBe(201);
      const project = (await created.json()) as { id: string };
      await page.request.post(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers });

      await openApp(page);
      await page.goto(`/p/${project.id}?settings=1&project=${project.id}&section=project-general`);
      const runtimeBox = page.getByTestId("project-runtime");
      await expect(runtimeBox).toHaveAttribute("data-runtime", "host-container", { timeout: 30_000 });
      await runtimeBox.getByTestId("project-runtime-move").click();
      const dialog = page.getByTestId("move-runtime-dialog");
      await expect(dialog).toBeVisible();
      return dialog;
    }

    test("設定の重ねの「別の実行場所へ移す」——移す先が無いとき、開いた一覧が左上でなく引き金に接して出る", async ({ page }) => {
      await stubRuntimes(page, []);
      const dialog = await openMoveDialog(page);
      await expect(dialog).toContainText("移す先の別のサーバがありません。設定の「実行場所」で登録してください。");
      const trigger = dialog.getByTestId("move-to-select");
      await expect(trigger).toHaveText("選んでください");
      await trigger.click();
      await expect(page.getByTestId("move-to-option")).toHaveCount(0);
      await expectListAttachedTo(page, trigger, "移す先（無いとき）");
      await page.keyboard.press("Escape");
      await expect(page.locator('[data-slot="select-content"]')).toHaveCount(0);
      await expect(dialog).toBeVisible();
      // 一覧が閉じてから、もう一度で小窓が閉じる
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
    });

    test("設定の重ねの「別の実行場所へ移す」——何も選んでいない移す先の一覧が引き金に接して出る", async ({ page }) => {
      await stubRuntimes(page);
      const dialog = await openMoveDialog(page);
      const trigger = dialog.getByTestId("move-to-select");
      await expect(trigger).toHaveText("選んでください");
      await trigger.click();
      // 一覧の中身（差し替えた2つ。いまの実行場所は出ない）
      const options = page.getByTestId("move-to-option");
      await expect(options).toHaveCount(2);
      await expect(options.nth(0)).toContainText("sel-a");
      await expect(options.nth(1)).toContainText("sel-b");
      await expect(options.nth(1)).toHaveAttribute("aria-disabled", "true");
      await expectListAttachedTo(page, trigger, "移す先");

      // 選ぶと引き金に出て、もう一度開いても接して出る
      await options.nth(0).click();
      await expect(trigger).toContainText("sel-a");
      await trigger.click();
      await expectListAttachedTo(page, trigger, "移す先（選んだあと）");
      await page.keyboard.press("Escape");
      await expect(page.locator('[data-slot="select-content"]')).toHaveCount(0);
      await expect(dialog).toBeVisible();
      // 一覧が閉じてから、もう一度で小窓が閉じる
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
    });

    test("新しい Project の「どこで動かすか」の一覧が引き金に接して出る", async ({ page }) => {
      await stubRuntimes(page);
      await openApp(page);
      await openNav(page);
      await clickNewProject(page);
      await expect(page.getByLabel("Project 名")).toBeVisible({ timeout: 15_000 });
      const trigger = page.getByTestId("new-project-runtime-select");
      await expect(trigger).toContainText("この機械のコンテナ");
      await trigger.click();
      const options = page.getByTestId("new-project-runtime-option");
      await expect(options).toHaveCount(2);
      await expect(options.nth(0)).toContainText("sel-a");
      await expectListAttachedTo(page, trigger, "どこで動かすか");
      await page.keyboard.press("Escape");
      await expect(page.locator('[data-slot="select-content"]')).toHaveCount(0);
    });
  });
}
