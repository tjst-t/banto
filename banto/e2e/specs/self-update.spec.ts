// **設定の「更新」**（決定・2026-10-04、アーキ仕様 §2.5「画面から banto を更新する」・`docs/specs/v4-frontend.md`）。
//
// 本物の systemd は使えないので、置き場（`releaseDir`）・systemctl・動いているコードの場所を実行ごとの置き場に向ける
// （`config.ts` の SELF_UPDATE_DIR、`start-core.ts`）。**git は本物**：GitHub 役のリポジトリ・`repo.git`・
// `versions/<頭12>`（worktree）・`current` をここで作る。偽の systemctl は2通りに動く：
//
// - `hold`：start で頼みを受け取るだけ。この spec が `update.mjs` の代わりに `state.json` を書いて段を進める
//   （待つ間の残り・起こし直しの間に host が居ない・前の版に戻した、は E2E では本物で起こせない）
// - `run`：start で**本物の `scripts/update.mjs --from-request`**（unit と同じ）を走らせる（組み立ては差し替えた1行、
//   起こし直しは偽の systemctl）。
//   取ってくる→組み立てる→待つ→起こし直す→確かめるを本物が通り、host の「今の版」も本当に替わる
//
// パスキー（step-up）は求められない——リンクで入った直後の 10 分は本人を確かめたことになり、E2E では host の時計を
// 進められない（`connect-gate.spec.ts` と同じ事情）。求められたときに通すことは core の単体試験が見ている
import { test, expect } from "../test-base.js";
import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CORE_BASE_URL,
  CORE_BROWSER_URL,
  DATA_DIR,
  FAKE_SYSTEMCTL,
  FRONTEND_LISTEN_URL,
  RELEASE_DIR,
  SELF_UPDATE_DIR,
} from "../config.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

const GITHUB = join(SELF_UPDATE_DIR, "github");
const REPO = join(RELEASE_DIR, "repo.git");
const UPDATE_DIR = join(DATA_DIR, "update");
const UPDATE_SCRIPT = fileURLToPath(new URL("../../scripts/update.mjs", import.meta.url));
const short = (c: string) => c.slice(0, 7);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=E2E", "-c", "user.email=e2e@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

let n = 0;
function commitOnRelease(subject: string): string {
  writeFileSync(join(GITHUB, "banto", "README"), `${++n}\n`, { flag: "a" });
  git(GITHUB, "commit", "-q", "-am", subject);
  return git(GITHUB, "rev-parse", "HEAD");
}

/** 置き場を手順書 D の形に整える（repo.git・versions/<頭12>・current）。偽の systemctl も置く */
function prepareReleaseDir(): string {
  mkdirSync(join(GITHUB, "banto"), { recursive: true });
  git(SELF_UPDATE_DIR, "init", "-q", "-b", "release", GITHUB);
  writeFileSync(join(GITHUB, "banto", "README"), "v1\n");
  git(GITHUB, "add", ".");
  git(GITHUB, "commit", "-q", "-m", "最初の版");
  const first = git(GITHUB, "rev-parse", "HEAD");

  git(SELF_UPDATE_DIR, "init", "-q", "--bare", REPO);
  git(REPO, "remote", "add", "origin", GITHUB);
  git(REPO, "fetch", "-q", "--no-tags", "origin", "+refs/heads/release:refs/remotes/origin/release");
  const name = first.slice(0, 12);
  git(REPO, "worktree", "add", "-q", "--detach", join(RELEASE_DIR, "versions", name), first);
  symlinkSync(join("versions", name), join(RELEASE_DIR, "current"));

  writeFileSync(join(SELF_UPDATE_DIR, "active-state"), "inactive\n");
  writeFileSync(join(SELF_UPDATE_DIR, "on-start"), "hold\n");
  writeFileSync(
    FAKE_SYSTEMCTL,
    [
      "#!/bin/sh",
      "# 偽の systemctl（self-update.spec.ts）。呼ばれたものを残す",
      `D='${SELF_UPDATE_DIR}'`,
      'echo "$*" >> "$D/systemctl.calls"',
      'case "$1" in',
      "  show)",
      "    # show -p <名前,…> [--value] <unit>。banto-update.service の ActiveState だけ置き場のファイル、ほかは動いている",
      '    props="$3"; shift 3',
      '    value=; [ "$1" = --value ] && { value=1; shift; }',
      '    for p in $(echo "$props" | tr , " "); do',
      '      case "$p" in',
      "        LoadState) v=loaded ;;",
      '        ActiveState) if [ "$1" = banto-update.service ]; then v=$(cat "$D/active-state"); else v=active; fi ;;',
      "        SubState) v=running ;;",
      "        NRestarts) v=0 ;;",
      "        *) v= ;;",
      "      esac",
      '      if [ -n "$value" ]; then echo "$v"; else echo "$p=$v"; fi',
      "    done ;;",
      "  start)",
      '    echo active > "$D/active-state"',
      '    if [ "$(cat "$D/on-start")" = run ]; then',
      "      (",
      `        BANTO_UPDATE_BUILD="$(cat "$D/build-command")" BANTO_UPDATE_HOST_URL='${CORE_BASE_URL}' \\`,
      `        BANTO_UPDATE_UI_URL='${FRONTEND_LISTEN_URL}/' BANTO_UPDATE_VERIFY_TIMEOUT=30 \\`,
      "        BANTO_UPDATE_INTERVAL=0.5 BANTO_UPDATE_MARK_INTERVAL=0.2 \\",
      `        '${process.execPath}' '${UPDATE_SCRIPT}' --from-request`,
      '        echo inactive > "$D/active-state"',
      '      ) > "$D/update.out" 2>&1 < /dev/null &',
      "    fi ;;",
      "  restart) ;;",
      '  *) echo "偽の systemctl は $1 を知りません" >&2; exit 1 ;;',
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(FAKE_SYSTEMCTL, 0o755);
  return first;
}

/** `update.mjs` の代わりに頼みを受け取る（request.json を消す——消さないと host は「起こしたばかり」と見続ける） */
function pickUpRequest(): { id: string; commit: string; mode: string } {
  const path = join(UPDATE_DIR, "request.json");
  expect(existsSync(path), "頼みが書かれていない").toBe(true);
  const request = JSON.parse(readFileSync(path, "utf8")) as { id: string; commit: string; mode: string };
  rmSync(path);
  return request;
}

function writeState(state: Record<string, unknown>): void {
  mkdirSync(UPDATE_DIR, { recursive: true });
  writeFileSync(join(UPDATE_DIR, "state.json"), JSON.stringify({ updatedAt: new Date().toISOString(), ...state }));
}

function setActive(active: boolean): void {
  writeFileSync(join(SELF_UPDATE_DIR, "active-state"), active ? "active\n" : "inactive\n");
}

async function openUpdate(page: Page): Promise<void> {
  await page.goto(`/settings?section=update&bantoHost=${encodeURIComponent(CORE_BROWSER_URL)}`);
  await expect(page.getByTestId("update-panel")).toBeVisible({ timeout: 30_000 });
}

async function expectSteps(page: Page, statuses: Record<string, string>): Promise<void> {
  for (const [step, status] of Object.entries(statuses)) {
    await expect(page.locator(`[data-testid="update-steps"] [data-step="${step}"]`), `段「${step}」`).toHaveAttribute(
      "data-status",
      status,
      { timeout: 15_000 },
    );
  }
}

let first = "";
/** 確かめたあとの release の最新（新しい順） */
const newCommits: Array<{ commit: string; subject: string }> = [];
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

test("準備が済んでいないときは、理由と手順書だけ。ボタンは出さない", async ({ page }) => {
  await openUpdate(page);
  // 「banto 全体」の層に「更新」がある
  await expect(page.getByRole("button", { name: "更新", exact: true }).first()).toBeVisible();
  const card = page.getByTestId("update-not-ready");
  await expect(card).toContainText("この banto は、まだ画面から更新できる形で動いていません");
  const reasons = card.getByTestId("update-not-ready-reasons");
  await expect(reasons).toContainText(`${REPO} がありません`);
  await expect(reasons).toContainText("banto-update.service がありません");
  await expect(card).toContainText("docs/runbooks/release.md D");
  for (const id of ["update-wait", "update-now", "update-check", "update-current"]) {
    await expect(page.getByTestId(id), `${id} が出ている`).toHaveCount(0);
  }
});

test("整えたあと：今の版と「最新です」（確かめた時刻）", async ({ page }) => {
  first = prepareReleaseDir();
  await openUpdate(page);
  const current = page.getByTestId("update-current");
  await expect(current).toContainText("今の版");
  await expect(current).toContainText("最初の版");
  await expect(current).toContainText(short(first));
  const latest = page.getByTestId("update-latest");
  await expect(latest).toContainText("最新です");
  await expect(latest.getByTestId("update-checked-at")).toContainText(/最後に確かめた時刻 \d+月\d+日 \d+:\d\d/);
  await expect(page.getByTestId("update-available")).toHaveCount(0);
  await expect(page.getByTestId("update-not-ready")).toHaveCount(0);
});

test("「確かめる」で GitHub の新しいコミットが出る——5件と「ほか 3 件」、開くと全部", async ({ page }) => {
  for (let i = 1; i <= 8; i++) {
    const subject = `feat: ${i} つ目の変更`;
    newCommits.unshift({ commit: commitOnRelease(subject), subject });
  }
  await openUpdate(page);
  // まだ取ってきていないので、最新のまま
  await expect(page.getByTestId("update-latest")).toContainText("最新です");
  await page.getByTestId("update-check").click();

  const card = page.getByTestId("update-available");
  await expect(card).toContainText("新しいコミットが 8 件あります", { timeout: 30_000 });
  await expect(card).toContainText(`最新の版 ${short(newCommits[0]!.commit)}`);
  const items = card.getByTestId("update-commits").locator("li");
  await expect(items).toHaveCount(5);
  for (let i = 0; i < 5; i++) {
    await expect(items.nth(i)).toContainText(newCommits[i]!.subject);
    await expect(items.nth(i)).toContainText(short(newCommits[i]!.commit));
  }
  const more = card.getByTestId("update-commits-more");
  await expect(more).toHaveText("ほか 3 件を見る");
  await more.click();
  await expect(items).toHaveCount(8);
  await expect(items.nth(7)).toContainText("feat: 1 つ目の変更");
  await expect(more).toHaveText("たたむ");
  // 今の版はまだ最初の版
  await expect(page.getByTestId("update-current")).toContainText(short(first));
  await expect(card.getByTestId("update-wait")).toHaveText("AI が止まるまで待って更新");
  await expect(card.getByTestId("update-now")).toHaveText("すぐ更新");
});

test("携帯の幅でも、一覧が読めてボタンが押せる（はみ出さない）", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openUpdate(page);
  const card = page.getByTestId("update-available");
  await expect(card).toContainText("新しいコミットが 8 件あります");
  for (const id of ["update-wait", "update-now"]) {
    const box = await card.getByTestId(id).boundingBox();
    expect(box, `${id} が無い`).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, `${id} が画面の外にはみ出している`).toBeLessThanOrEqual(390);
    expect(box!.height, `${id} が押しにくい（低い）`).toBeGreaterThanOrEqual(36);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "横にはみ出している").toBeLessThanOrEqual(0);
});

test("待つ形：取ってくる→組み立てる→待つ（残りの会話）→「待つのをやめる」で最初の画面に戻る", async ({ page }) => {
  await openUpdate(page);
  await page.getByTestId("update-wait").click();
  // 頼んだら進み具合。update.mjs が受け取るまでは「取ってくる」
  await expect(page.getByTestId("update-progress")).toContainText(`版 ${short(newCommits[0]!.commit)} に更新しています`, {
    timeout: 30_000,
  });
  await expectSteps(page, { fetch: "current", build: "pending", wait: "pending", restart: "pending" });
  const request = pickUpRequest();
  expect(request.commit, "見せた最新と違う commit を頼んだ").toBe(newCommits[0]!.commit);
  expect(request.mode).toBe("wait");
  const base = { id: request.id, mode: "wait", from: first, to: request.commit, startedAt: new Date().toISOString() };

  writeState({ ...base, phase: "build" });
  await expectSteps(page, { fetch: "done", build: "current", wait: "pending", restart: "pending" });
  await expect(page.getByTestId("update-progress")).toContainText("今の banto はそのまま使えます。");

  writeState({
    ...base,
    phase: "wait",
    waiting: {
      idle: false,
      onlyWaitingOnHuman: false,
      turns: [
        { threadId: "t1", threadTitle: "初回描画のパフォーマンス調査", projectName: "banto", startedAt: ago(12), hop: 0, queued: 0, waitingOnHuman: false },
        { threadId: "t2", threadTitle: "仕様書の整理", projectName: "banto", startedAt: ago(3), hop: 0, queued: 0, waitingOnHuman: true },
      ],
      awaitingReplies: [{ threadId: "t3", threadTitle: "埋め込みの再計算コストを測る", projectName: "記憶の検証", module: "subagent", since: ago(41) }],
      moduleCalls: [{ threadId: "t1", connName: "shell", origin: "turn" }],
    },
  });
  await expectSteps(page, { fetch: "done", build: "done", wait: "current", restart: "pending" });
  const progress = page.getByTestId("update-progress");
  await expect(progress.getByTestId("update-remaining")).toHaveText("あと 3 件");
  const rows = progress.getByTestId("update-running").locator("li");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("初回描画のパフォーマンス調査");
  await expect(rows.nth(0)).toContainText("banto");
  await expect(rows.nth(0)).toContainText("12分前から");
  await expect(rows.nth(0)).toContainText("AI が動いています");
  await expect(rows.nth(1)).toContainText("仕様書の整理");
  await expect(rows.nth(1)).toContainText("人の返事待ち");
  await expect(rows.nth(2)).toContainText("埋め込みの再計算コストを測る");
  await expect(rows.nth(2)).toContainText("記憶の検証");
  await expect(rows.nth(2)).toContainText("41分前から");
  await expect(rows.nth(2)).toContainText("subagent の仕事の返事を待っています");

  await progress.getByTestId("update-stop-waiting").click();
  // host が印を置く。update.mjs の代わりに、それを見て止まる
  await expect.poll(() => existsSync(join(UPDATE_DIR, "cancel")), { timeout: 15_000 }).toBe(true);
  rmSync(join(UPDATE_DIR, "cancel"));
  writeState({ ...base, phase: "cancelled", result: "待つのをやめました（今の版のまま）" });
  setActive(false);

  await expect(page.getByTestId("update-cancelled")).toHaveText("更新をやめました。今の版のまま動いています。", { timeout: 15_000 });
  await expect(page.getByTestId("update-progress")).toHaveCount(0);
  await expect(page.getByTestId("update-available")).toContainText("新しいコミットが 8 件あります");
  await expect(page.getByTestId("update-current")).toContainText(short(first));
});

test("すぐ更新：途中で切れる会話を確かめてから頼む。起こし直しで host が居ない間は待ち、戻ったら結果（前の版に戻した・ログ）", async ({
  page,
}) => {
  // 今動いている会話（E2E の host では本物のターンを走らせ続けられないので、画面が読む答えだけ差し替える）
  await page.route("**/api/admin/activity", (route) =>
    route.fulfill({
      json: {
        idle: false,
        onlyWaitingOnHuman: false,
        turns: [
          { threadId: "t1", threadTitle: "初回描画のパフォーマンス調査", projectName: "banto", startedAt: ago(12), hop: 0, queued: 0, waitingOnHuman: false },
          { threadId: "t2", threadTitle: "仕様書の整理", projectName: "banto", startedAt: ago(3), hop: 0, queued: 0, waitingOnHuman: true },
        ],
        awaitingReplies: [],
        moduleCalls: [],
        now: new Date().toISOString(),
      },
    }),
  );
  await openUpdate(page);
  await page.getByTestId("update-now").click();
  const dialog = page.getByTestId("update-cutoff-dialog");
  await expect(dialog).toContainText("すぐ更新しますか？");
  await expect(dialog).toContainText("いま AI が動いている会話が 2 件あります");
  await expect(dialog.getByTestId("update-running").locator("li")).toHaveCount(2);
  await expect(dialog).toContainText("初回描画のパフォーマンス調査");
  await expect(dialog).toContainText("これらは途中で切れます。");
  // やめたら何も頼まない
  await dialog.getByRole("button", { name: "やめる" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("update-available")).toBeVisible();
  expect(existsSync(join(UPDATE_DIR, "request.json")), "やめたのに頼んだ").toBe(false);

  await page.getByTestId("update-now").click();
  await page.getByTestId("update-cutoff-dialog").getByTestId("update-cutoff-confirm").click();
  await expect(page.getByTestId("update-progress")).toBeVisible({ timeout: 30_000 });
  const request = pickUpRequest();
  expect(request.mode).toBe("now");
  const base = { id: request.id, mode: "now", from: first, to: request.commit, startedAt: new Date().toISOString() };
  writeState({ ...base, phase: "build" });
  // すぐ更新は待つ段を飛ばす
  await expectSteps(page, { fetch: "done", build: "current", wait: "skipped", restart: "pending" });

  writeState({ ...base, phase: "restart" });
  const overlay = page.getByTestId("update-reconnecting");
  await expect(overlay).toContainText("繋がり直すのを待っています", { timeout: 15_000 });

  // host が居なくなる（起こし直し）。その間に update.mjs は前の版に戻して終わる
  await page.route("**/api/admin/update", (route) => route.abort("connectionrefused"));
  const logFile = join(UPDATE_DIR, `${request.id}.log`);
  writeFileSync(logFile, ["[t] $ systemctl restart banto-host.service banto-frontend.service", "[t] 新しい版が起きません：120秒待ちました", "[t] 前の版に戻しました", ""].join("\n"));
  writeState({ ...base, phase: "rolled-back", failedPhase: "verify", error: "120秒待ちました。host：答えません", result: "前の版に戻しました", logFile });
  setActive(false);
  // 繋がらない間は失敗にしない——読み直しを2回以上またいでも、待つ画面のまま
  await page.waitForTimeout(7_000);
  await expect(overlay).toBeVisible();
  await expect(page.getByTestId("update-failed")).toHaveCount(0);
  // 読み直しの失敗も出さない（出すと、待っている最中に「失敗した」と読める）
  for (const id of ["update-load-error", "update-poll-error", "update-action-error"]) {
    await expect(page.getByTestId(id), `繋がらない間に ${id} が出た`).toHaveCount(0);
  }

  await page.unroute("**/api/admin/update");
  const failed = page.getByTestId("update-failed");
  await expect(failed).toContainText("「起こし直す」で止まりました", { timeout: 15_000 });
  await expect(overlay).toHaveCount(0);
  await expect(failed).toContainText("新しい版が起きなかったので、前の版に戻しました。");
  await expect(failed.getByTestId("update-failed-error")).toHaveText("120秒待ちました。host：答えません");
  await expectSteps(page, { fetch: "done", build: "done", wait: "skipped", restart: "failed" });
  await failed.getByTestId("update-log-toggle").click();
  await expect(failed.getByTestId("update-log")).toContainText("新しい版が起きません：120秒待ちました");
  await expect(failed.getByTestId("update-log-toggle")).toHaveText("ログを閉じる");
  await expect(page.getByTestId("update-current")).toContainText(short(first));

  await failed.getByTestId("update-retry").click();
  await expect(page.getByTestId("update-failed")).toHaveCount(0);
  await expect(page.getByTestId("update-available")).toContainText("新しいコミットが 8 件あります");
});

test("本物の update.mjs：組み立てで落ちたら「組み立てる」で止まり、今の版のまま。ログに組み立ての出力が出る", async ({ page }) => {
  writeFileSync(join(SELF_UPDATE_DIR, "on-start"), "run\n");
  writeFileSync(join(SELF_UPDATE_DIR, "build-command"), "echo '組み立てています'; echo 'error TS2339: 壊れた型' >&2; exit 2");
  await openUpdate(page);
  // 前の回の結果（前の版に戻した）は host の最後の結果なので、開き直しても出る。「もう一度ためす」で戻って押す
  await expect(page.getByTestId("update-failed")).toContainText("新しい版が起きなかったので、前の版に戻しました。");
  await page.getByTestId("update-retry").click();
  await page.getByTestId("update-wait").click();

  const failed = page.getByTestId("update-failed");
  await expect(failed).toContainText("「組み立てる」で止まりました", { timeout: 60_000 });
  await expect(failed).toContainText("今の版のまま動いています。");
  await expect(failed.getByTestId("update-failed-error")).toContainText("が失敗しました（終了コード 2）");
  await expectSteps(page, { fetch: "done", build: "failed" });
  await failed.getByTestId("update-log-toggle").click();
  const log = failed.getByTestId("update-log");
  await expect(log).toContainText("error TS2339: 壊れた型");
  await expect(log).toContainText("作りかけの");
  await expect(page.getByTestId("update-current")).toContainText(short(first));
  // 作りかけは消えている
  expect(readdirSync(join(RELEASE_DIR, "versions"))).toEqual([first.slice(0, 12)]);
});

test("本物の update.mjs：待つ→起こし直す→確かめる。終わったら「版 … になりました」と、今の版が替わって最新になる", async ({ page }) => {
  writeFileSync(join(SELF_UPDATE_DIR, "on-start"), "run\n");
  writeFileSync(join(SELF_UPDATE_DIR, "build-command"), "echo '組み立てました'");
  const latest = newCommits[0]!;
  await openUpdate(page);
  // 前の回の失敗が出ている。「もう一度ためす」で戻って押す
  await expect(page.getByTestId("update-failed")).toContainText("「組み立てる」で止まりました");
  await page.getByTestId("update-retry").click();
  await page.getByTestId("update-wait").click();

  const done = page.getByTestId("update-done");
  await expect(done).toHaveText(`版 ${short(latest.commit)} になりました`, { timeout: 90_000 });
  await expect(page.getByTestId("update-reconnecting")).toHaveCount(0);
  const current = page.getByTestId("update-current");
  await expect(current).toContainText(latest.subject);
  await expect(current).toContainText(short(latest.commit));
  await expect(page.getByTestId("update-latest")).toContainText("最新です");
  await expect(page.getByTestId("update-available")).toHaveCount(0);
  await expect(page.getByTestId("update-failed")).toHaveCount(0);

  // 本当に起こし直しを頼み、版を替えた（前の版は戻す先として残る）
  const calls = readFileSync(join(SELF_UPDATE_DIR, "systemctl.calls"), "utf8");
  expect(calls).toContain("restart banto-host.service banto-frontend.service");
  expect(readdirSync(join(RELEASE_DIR, "versions")).sort()).toEqual([first.slice(0, 12), latest.commit.slice(0, 12)].sort());

  // 読み直しても同じ（画面が覚えていたのではなく host の答え）
  await openUpdate(page);
  await expect(page.getByTestId("update-done")).toHaveText(`版 ${short(latest.commit)} になりました`);
  await expect(page.getByTestId("update-current")).toContainText(short(latest.commit));
});
