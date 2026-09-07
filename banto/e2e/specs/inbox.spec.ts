// 受信箱（アーキ仕様§2.4、Stage 4・決定・2026-09-05）の回帰。
// **Phase 0 の完了条件「判断待ちが1画面に出る」がこれ。**
//
// 判断待ちを実際に起こすには permissionMode を `default` にする（`auto` は
// canUseTool を通らない——実測・2026-09-05）。その状態で tool を使わせると
// hold-the-line で止まり、受信箱に出る。
//
// 規則14：一覧に「出た」だけで終わらせない——**Project 名・Thread の別・
// 本文**まで見て、バッジの件数も数え、答えたら消えるところまで確認する。
import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
// 実AIターン＋hold-the-lineの待ち＋受信箱のポーリング（5秒間隔）が入るので、
// 既定の60秒では足りない。**待ち条件そのものは緩めない**（規則6）——
// 全体の持ち時間だけを実測（約80秒）に見合う値へ広げる
test.setTimeout(180_000);
test.use({ viewport: { width: 390, height: 844 } });

const PROJECT_NAME = "E2E Inbox Project";

test("判断待ちが受信箱に出る→バッジが立つ→答えると消える", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-inbox-"));
  // 承認が**実際にhost側のtool呼び出しを解決した**ことを、tool の結果の中身で
  // 確かめるための目印（見直し・2026-09-06）。「回答：許可する」だけでは
  // クライアントのローカルstateで出てしまい、hostから1バイト返らなくても緑になる
  const markerFile = `banto-e2e-marker-${Date.now()}.txt`;
  writeFileSync(join(projectRoot, markerFile), "目印\n");

  // 承認したあと**画面が生きているか**を見る（規則14）。host側の決着だけを
  // page.requestで確かめていた頃は、承認後にReactが落ちてもこのspecは通っていた
  // ——実際に `Duplicate key toolCallId-… in useResources` を素通りさせた
  // （2026-09-06）。以後はページ例外を1つでも拾ったら落とす。
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);

  await page.getByRole("button", { name: "新しい Project", exact: true }).click();
  await page.getByLabel("Project 名").fill(PROJECT_NAME);
  await page.getByLabel("Base パス").fill(projectRoot);
  await page.getByRole("button", { name: "作成する" }).click();
  await expect(page.getByText(`Base Thread — ${PROJECT_NAME}`)).toBeVisible({ timeout: 15_000 });

  // permissionMode を default に（auto のままだと承認を求めずに実行される）
  await page.getByRole("button", { name: /permissionMode/ }).click();
  await page.getByRole("menuitemradio", { name: /default/ }).click();
  // メニューが閉じきるまで待つ——開いたままだと composer への入力が届かない
  await expect(page.getByRole("menu")).not.toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: /permissionMode（現在：default）/ })).toBeVisible();

  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("filesystem の listDirectory で「.」の中身を一覧してください。");
  await composer.press("Enter");

  // Thread 側に判断待ちのカードが出る（hold-the-line で止まっている）
  await expect(page.getByText("があなたの判断を待っています")).toBeVisible({ timeout: 60_000 });

  // バッジが1件を示す（受信箱を開く前に見る——シートが開くとページの他が
  // aria-hidden になり、バッジをロールで引けなくなる）
  await expect(page.getByRole("button", { name: "受信箱" })).toContainText("1", { timeout: 15_000 });

  // 受信箱に出る——中身まで見る（規則14）。**受信箱の中に限定して探す**
  // ——同じ文言がThread側の判断待ちカードにも出ているので、ページ全体から
  // 引くと後ろのカードを掴む（実測・2026-09-05）
  await page.getByRole("button", { name: "受信箱" }).click();
  const inbox = page.getByRole("dialog", { name: "受信箱" });
  const row = inbox.getByText("tool呼び出しの承認: mcp__filesystem__listDirectory");
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(inbox.getByText(PROJECT_NAME)).toBeVisible();
  await expect(inbox.getByText("Base Thread")).toBeVisible();

  // 行から Thread へ飛ぶ（アプリ本来の導線。これでシートも閉じる）
  await row.click();
  await expect(inbox).toBeHidden({ timeout: 15_000 });

  // 答えるとその判断待ちは決着する（§2.4.1「解決済みは状態として持たない」）。
  // **バッジが0になることでは見ない**——答えた直後にAIがターンを続けて
  // 別の判断待ちを出しうるので非決定的（実測・2026-09-05）。
  // 「この判断待ちが answered になったか」をhost側の記録で見る。
  const before = await (
    await page.request.get(`${CORE_BASE_URL}/api/inbox`, { headers: { authorization: `Bearer ${AUTH_TOKEN}` } })
  ).json();
  const target = before.find((i: { kind: string }) => i.kind === "judgment");
  expect(target).toBeTruthy();

  // 「許可する」は選択肢——選んでから「この内容で送る」で確定する
  await page.getByRole("button", { name: "許可する" }).click();
  await page.getByRole("button", { name: "この内容で送る" }).click();

  await expect
    .poll(
      async () => {
        const open = await (
          await page.request.get(`${CORE_BASE_URL}/api/inbox`, {
            headers: { authorization: `Bearer ${AUTH_TOKEN}` },
          })
        ).json();
        return open.some((i: { id: string }) => i.id === target.id);
      },
      { timeout: 30_000 },
    )
    .toBe(false);

  // 答えたあと、会話が実際に進む——判断待ちのカードが「回答：許可する」に変わり、
  // hostから続きが届く（承認したtoolの結果を受けてAIが返事をする）。
  await expect(page.getByText("回答：許可する")).toBeVisible({ timeout: 60_000 });

  // **承認がhost側の呼び出しを本当に解決したか**は、tool の結果の中身で見る
  // ——「回答：許可する」はローカルstateだけで出るので、これが無いと
  // 幽霊承認（答えても何も起きない）を素通りする（規則14・見直し・2026-09-06）
  // **どこに出ても構わない**——tool の結果カードでも、AI の本文でもよい。
  // ファイル名には時刻が入っていて一時ディレクトリにしか無いので、
  // **どちらに出ても「tool が実際に走った」証明**になる。
  // （両方に出ることがあり、厳密一致だと strict mode 違反で落ちた・実測 2026-09-06）
  await expect(page.getByText(markerFile, { exact: false }).first()).toBeVisible({ timeout: 90_000 });

  // 画面が落ちていないこと。Reactのkey衝突はここでしか現れない
  expect(pageErrors, `ページ例外: ${pageErrors.join(" / ")}`).toEqual([]);
});
