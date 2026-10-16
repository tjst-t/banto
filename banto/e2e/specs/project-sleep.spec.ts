// **Project のスリープ**（決定・2026-10-16、アーキ仕様 §2.2「スリープ」、Backlog #354）。眠らせる口・起こす2か所
// （`modules/prepare` とターンを開く口）・起こさない門（設定・入口・Skills）。画面（サイドバーの「スリープ中」）は別の作業
// （Backlog `project-sleep-ui`）なので、眠らせるのは HTTP の口から。開くのは本物の画面で。
//
// 見るもの（規則14——「200 が返った」で終わらせず、記録・コンテナ・Module のプロセスまで）：
//   1. ターンが走っている・裏の仕事（待たずに頼んだサブエージェント）の返事を待っていると、理由つきで断る（409 busy）。
//      止まるもの（sleep-preview）には断る理由が出る
//   2. 眠らせると Module のプロセスが落ち、コンテナが止まる。記録は active のまま sleep が立つ
//   3. 設定・入口・Skills の口は「眠っています」（409 asleep）を返し、コンテナは止まったまま
//   4. 画面で開くと起きる（sleep が外れ、Module が立ち、コンテナが動く）
//   5. 自動化の時刻が来ると、眠っている Project が起きて回のターンが走り、回が終わると眠りに戻る（by auto、コンテナも止まる）
//   6. 眠りに戻す（§2.2「眠りに戻す」、Backlog #358）：回が人を待って終わったら（決めることがある）起きたまま・起きている間に
//      人が画面で開いたら戻らない・裏の仕事（待たずに頼んだサブエージェント）が残っていれば、返事が届いて読み終えてから戻る
//   7. 眠らせている途中に送った発言は切れない——ターンは最後まで走り、終わったとき Project は起きている
import { test, expect } from "../test-base.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, currentProjectId, fakeTurn, openApp, waitForProjectModule, waitTurnEnded } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(420_000);

const PROJECT_NAME = "E2E Project Sleep";
const headers = { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };

interface HostProject {
  id: string;
  status: string;
  sleep?: { since: string; by: string };
}
interface HostThread {
  messages: Array<{ role: string; text: string }>;
  lastTurn?: { outcome?: string; cause: string };
}

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${CORE_BASE_URL}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}
const projectOf = async (id: string) => (await api<HostProject[]>("GET", "/api/projects")).body.find((p) => p.id === id)!;
const threadOf = async (id: string) => (await api<HostThread>("GET", `/api/threads/${id}`)).body;

function containerState(projectId: string): string {
  return spawnSync("incus", ["list", `banto-${projectId}`, "-f", "csv", "-c", "s"], { encoding: "utf8", input: "" }).stdout.trim();
}
function moduleProcessesInContainer(projectId: string): number {
  if (containerState(projectId) !== "RUNNING") return 0;
  const r = spawnSync("incus", ["exec", `banto-${projectId}`, "--", "sh", "-c", 'pgrep -f "modules/(shell|filesystem)/dist/server.js" | wc -l'], {
    encoding: "utf8",
    input: "",
  });
  return Number(r.stdout.trim());
}

/** 人が送ったターン（SSE）。流れを最後まで読んで返す——待たずに投げて、あとで await する */
function send(threadId: string, prompt: string): Promise<{ status: number; stream: string }> {
  return fetch(`${CORE_BASE_URL}/api/threads/${threadId}/messages`, { method: "POST", headers, body: JSON.stringify({ prompt }) }).then(
    async (res) => ({ status: res.status, stream: await res.text() }),
  );
}

async function expectAwakeWithModules(projectId: string): Promise<void> {
  expect((await projectOf(projectId)).sleep, "起きていない").toBeUndefined();
  await expect
    .poll(async () => ((await api<{ connected: string[] }>("POST", `/api/projects/${projectId}/modules/prepare`)).body.connected ?? []).sort(), {
      timeout: 60_000,
      message: "起きたのに Module が繋がらない",
    })
    .toEqual(expect.arrayContaining(["filesystem", "shell"]));
  expect(moduleProcessesInContainer(projectId), "起きたのに Module のプロセスが居ない").toBe(2);
}

/** 眠らせて、止まったことを見る（Module のプロセス・コンテナ・記録） */
async function sleepAndCheck(projectId: string): Promise<void> {
  const slept = await api<{ ok: boolean; released: string[] }>("POST", `/api/projects/${projectId}/sleep`);
  expect(slept.status, JSON.stringify(slept.body)).toBe(200);
  expect(slept.body.released, "何を落としたかを返していない").toEqual(expect.arrayContaining([`shell-${projectId}`, `filesystem-${projectId}`]));
  expect(containerState(projectId), "眠らせたのにコンテナが動いている").toBe("STOPPED");
  const p = await projectOf(projectId);
  expect([p.status, p.sleep?.by]).toEqual(["active", "human"]);
}

let projectId = "";
let baseId = "";

test("動いているものがあると断り、眠らせると Module とコンテナが止まり、設定の口では起きず、開くと起きる", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  await openApp(page);
  await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-sleep-")));
  projectId = currentProjectId(page);
  baseId = (await api<Array<{ id: string; kind: string }>>("GET", `/api/projects/${projectId}/threads`)).body.find((t) => t.kind === "base")!.id;
  await expectAwakeWithModules(projectId);

  // ---- 1a. ターンが走っていれば断る ---------------------------------------------------------------------------------
  const running = send(baseId, "考えて。" + fakeTurn({ thinkMs: 8_000, say: "考え終えました" }));
  await expect.poll(async () => (await threadOf(baseId)).lastTurn?.cause, { timeout: 30_000, message: "ターンが始まらない" }).toBe("human");
  const busy = await api<{ code: string; reasons: string[] }>("POST", `/api/projects/${projectId}/sleep`);
  expect(busy.status).toBe(409);
  expect(busy.body.code).toBe("busy");
  expect(busy.body.reasons).toEqual([expect.stringMatching(/^ターンが走っています/)]);
  const preview = await api<{ blockers: string[] }>("GET", `/api/projects/${projectId}/sleep-preview`);
  expect(preview.body.blockers).toEqual([expect.stringMatching(/^ターンが走っています/)]);
  expect((await running).status).toBe(200);
  await waitTurnEnded(page, baseId, 1);
  expect((await projectOf(projectId)).sleep, "断ったのに眠った").toBeUndefined();

  // ---- 1b. 待たずに頼んだ仕事の返事を待っていれば断る -------------------------------------------------------------------
  await waitForProjectModule(page, PROJECT_NAME, "subagent");
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill(
    "サブエージェントに待たずに頼んで。" +
      fakeTurn({
        tools: [{ server: "subagent", name: "runSubagent", args: { agent: "fake", prompt: "[slow 15] 「仕事を終えました」と返して", runInBackground: true } }],
      }),
  );
  await composer.press("Enter");
  // 鍵を使うエージェントは初回に Vault の在りかを聞く——呼び出しの中で
  await expect(async () => {
    const allow = page.getByRole("button", { name: "許可する" });
    if ((await allow.count()) > 0) await allow.last().click();
    await expect(page.getByText(/待たずに頼みました/).first()).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: 120_000 });
  await waitTurnEnded(page, baseId, 2);
  const waiting = await api<{ code: string; reasons: string[] }>("POST", `/api/projects/${projectId}/sleep`);
  expect(waiting.status, "裏の仕事が残っているのに眠らせた").toBe(409);
  expect(waiting.body.code).toBe("busy");
  expect(waiting.body.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/^裏の仕事の返事を待っています（subagent/)]));
  // 届いて、AI が起きて読み終えるまで待つ
  await waitTurnEnded(page, baseId, 3, 120_000);
  expect((await threadOf(baseId)).messages.at(-1)?.text).toContain("仕事を終えました");

  // ---- 2. 眠らせる。開いている画面は閉じておく（開いたままだと画面が開き直したときに起こす） ---------------------------
  await page.goto("about:blank");
  const stops = await api<{ stops: Array<{ kind: string }>; blockers: string[] }>("GET", `/api/projects/${projectId}/sleep-preview`);
  expect(stops.status).toBe(200);
  expect(stops.body.blockers).toEqual([]);
  expect(Array.isArray(stops.body.stops)).toBe(true);
  await sleepAndCheck(projectId);
  expect(moduleProcessesInContainer(projectId)).toBe(0);
  // もう一度押しても何もしない
  expect((await api<{ released: string[] }>("POST", `/api/projects/${projectId}/sleep`)).body.released).toEqual([]);

  // ---- 3. 設定・入口・Skills の口では起きない ------------------------------------------------------------------------
  for (const path of [`/api/projects/${projectId}/ui-settings`, `/api/projects/${projectId}/ui-launchers`, `/api/skills?projectId=${projectId}`]) {
    const r = await api<{ code: string; error: string }>("GET", path);
    expect([r.status, r.body.code, r.body.error], path).toEqual([409, "asleep", "この Project は眠っています。起こすと見られます"]);
  }
  // Module の一覧（立っているか）は起こさずに読める
  expect((await api("GET", `/api/projects/${projectId}/modules`)).status).toBe(200);
  await page.waitForTimeout(3_000);
  expect(containerState(projectId), "設定の口を開いただけでコンテナが起きた").toBe("STOPPED");
  expect((await projectOf(projectId)).sleep, "設定の口を開いただけで起きた").toBeTruthy();

  // ---- 4. 画面で開くと起きる ----------------------------------------------------------------------------------------
  await page.goto(`/p/${projectId}`);
  await expect(page.getByPlaceholder(/に送る/).first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await projectOf(projectId)).sleep, { timeout: 30_000, message: "開いても起きない" }).toBeUndefined();
  await expectAwakeWithModules(projectId);
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "仕事を終えました" }).last(), "起きた Project の会話が出ない").toBeVisible({
    timeout: 30_000,
  });
  expect(pageErrors, "画面で例外が起きた").toEqual([]);
});

/** 眠りに戻ったことを見る（記録の by auto・コンテナ・Module のプロセス） */
async function expectReturnedToSleep(projectId: string): Promise<void> {
  await expect.poll(async () => (await projectOf(projectId)).sleep?.by, { timeout: 60_000, message: "用が済んだのに眠りに戻らない" }).toBe("auto");
  await expect.poll(() => containerState(projectId), { timeout: 60_000, message: "眠りに戻ったのにコンテナが動いている" }).toBe("STOPPED");
  expect((await projectOf(projectId)).status).toBe("active");
}

/** すぐ（今すぐ動かす口で）動かす自動化を作る。時刻は動かないところ（いまの2時間前）に置く */
async function createManualAutomation(projectId: string, name: string, instruction: string): Promise<{ id: string; forkId: string }> {
  const at = new Date(Date.now() - 2 * 60 * 60_000);
  const created = await api<{ id: string; target: { threadId?: string } }>("POST", `/api/projects/${projectId}/automations`, {
    name,
    instruction,
    source: { kind: "time", repeat: { kind: "daily", time: `${at.getUTCHours()}:${String(at.getUTCMinutes()).padStart(2, "0")}` }, timeZone: "UTC" },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { id: created.body.id, forkId: created.body.target.threadId! };
}
/** 今すぐ動かして、回の結末が台帳に出るまで待つ（機械のトークンで——人の操作に数えない） */
async function runToEnd(projectId: string, automationId: string, result: string): Promise<void> {
  const r = await api<{ runId: string; result: string }>("POST", `/api/projects/${projectId}/automations/${automationId}/run`);
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  await expect
    .poll(
      async () =>
        (await api<{ runs: Array<{ runId: string; result: string }> }>("GET", `/api/projects/${projectId}/automations/${automationId}`)).body.runs.find(
          (x) => x.runId === r.body.runId,
        )?.result,
      { timeout: 120_000, message: "回の結末が台帳に出ない" },
    )
    .toBe(result);
}

test("自動化の時刻が来ると、眠っている Project が起きて回のターンが走り、回が終わると眠りに戻る", async ({ page }) => {
  expect(projectId, "前の試験が Project を作っていない").not.toBe("");
  await page.goto("about:blank");
  // 次の分（UTC）に毎日動く自動化。境目の直前なら、その次の分
  const now = Date.now();
  let slot = Math.ceil(now / 60_000) * 60_000;
  if (slot - now < 20_000) slot += 60_000;
  const at = new Date(slot);
  const created = await api<{ id: string; target: { threadId?: string } }>("POST", `/api/projects/${projectId}/automations`, {
    name: "眠りの見回り",
    instruction: "見回ってください。" + fakeTurn({ say: "眠っていた Project で見回りました" }),
    source: { kind: "time", repeat: { kind: "daily", time: `${at.getUTCHours()}:${String(at.getUTCMinutes()).padStart(2, "0")}` }, timeZone: "UTC" },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const forkId = created.body.target.threadId!;
  await sleepAndCheck(projectId);

  // 時刻の前は眠ったまま
  await page.waitForTimeout(3_000);
  expect((await projectOf(projectId)).sleep).toBeTruthy();
  await expect
    .poll(async () => (await api<{ runs: Array<{ result: string }> }>("GET", `/api/projects/${projectId}/automations/${created.body.id}`)).body.runs.map((r) => r.result), {
      timeout: slot - Date.now() + 90_000,
      message: "時刻が来ても回が終わらない",
    })
    .toEqual(["done"]);
  const fork = await waitTurnEnded(page, forkId, 1);
  expect(fork.messages.at(-1)?.text).toContain("眠っていた Project で見回りました");
  expect((await threadOf(forkId)).lastTurn?.cause).toBe("delivery");
  // 人の操作も残りも無いので、回が終わると眠りに戻る
  await expectReturnedToSleep(projectId);
  expect(moduleProcessesInContainer(projectId)).toBe(0);
  // 後始末：次の日まで動かないが、残さない
  expect((await api("DELETE", `/api/projects/${projectId}/automations/${created.body.id}`)).status).toBeLessThan(300);
});

test("眠りに戻す：回が人を待って終わったら起きたまま・起きている間に人が開いたら戻らない・裏の仕事が残っていれば返事を読み終えてから戻る", async ({ page }) => {
  expect(projectId, "前の試験が Project を作っていない").not.toBe("");
  await page.goto("about:blank");

  // ---- a. 回が人を待って終わった（まとめに決めることがある）→ 起きたまま ------------------------------------------------
  expect((await api("PUT", `/api/projects/${projectId}/turn-summary`, { enabled: true })).status).toBe(200);
  const decide = await createManualAutomation(
    projectId,
    "決めることを残す見回り",
    "見回ってください。" +
      fakeTurn({
        say: "古い依存が1つあります",
        tools: [
          {
            server: "banto-thread",
            name: "report_turn",
            args: {
              request: "見回り",
              outcome: { status: "done", headline: "古い依存が1つあります", points: [] },
              decisions: [{ question: "上げますか？", options: [{ label: "上げる", reply: "上げて。" }, { label: "上げない", reply: "上げないで。" }] }],
            },
          },
        ],
      }),
  );
  if ((await projectOf(projectId)).sleep === undefined) await sleepAndCheck(projectId);
  await runToEnd(projectId, decide.id, "done");
  await expect.poll(async () => (await threadOf(decide.forkId)).lastTurn?.outcome, { timeout: 30_000 }).toBe("completed");
  // 受信箱に「決めることがある」回のカード（人を待っている）
  await expect
    .poll(
      async () =>
        (await api<Array<{ kind: string; threadId?: string; automation?: { attention?: string } }>>("GET", "/api/inbox")).body.find(
          (i) => i.kind === "review" && i.threadId === decide.forkId,
        )?.automation?.attention,
      { timeout: 30_000, message: "決めることのある回のカードが出ない" },
    )
    .toBe("decisions");
  await page.waitForTimeout(5_000);
  expect((await projectOf(projectId)).sleep, "人を待って終わった回なのに眠りに戻った").toBeUndefined();
  expect(containerState(projectId)).toBe("RUNNING");
  expect((await api("PUT", `/api/projects/${projectId}/turn-summary`, { enabled: false })).status).toBe(200);
  expect((await api("DELETE", `/api/projects/${projectId}/automations/${decide.id}`)).status).toBeLessThan(300);

  // ---- b. 起きている間に人が画面で開いた → 回が終わっても戻らない ------------------------------------------------------
  await sleepAndCheck(projectId);
  const slow = await createManualAutomation(projectId, "ゆっくりの見回り", "見回ってください。" + fakeTurn({ thinkMs: 15_000, say: "ゆっくり見回りました" }));
  const slowRun = runToEnd(projectId, slow.id, "done");
  await expect.poll(async () => (await projectOf(projectId)).sleep, { timeout: 60_000, message: "回で起きない" }).toBeUndefined();
  // 回が走っている間に、人が画面で開く（画面が prepare を投げる——人のセッションの要求）
  await page.goto(`/p/${projectId}`);
  await expect(page.getByPlaceholder(/に送る/).first()).toBeVisible({ timeout: 30_000 });
  await slowRun;
  const slowFork = await waitTurnEnded(page, slow.forkId, 1);
  expect(slowFork.messages.at(-1)?.text).toContain("ゆっくり見回りました");
  await page.goto("about:blank");
  await page.waitForTimeout(5_000);
  expect((await projectOf(projectId)).sleep, "人が開いたのに眠りに戻った").toBeUndefined();
  expect(containerState(projectId)).toBe("RUNNING");
  expect((await api("DELETE", `/api/projects/${projectId}/automations/${slow.id}`)).status).toBeLessThan(300);

  // ---- c. 裏の仕事が残っている → 返事が届いて AI が読み終えてから戻る -------------------------------------------------
  await sleepAndCheck(projectId);
  const bg = await createManualAutomation(
    projectId,
    "裏で頼む見回り",
    "サブエージェントに待たずに頼んで。" +
      fakeTurn({
        tools: [{ server: "subagent", name: "runSubagent", args: { agent: "fake", prompt: "[slow 15] 「裏の仕事を終えました」と返して", runInBackground: true } }],
        then: "裏で頼みました",
      }),
  );
  await runToEnd(projectId, bg.id, "done");
  const firstTurn = await waitTurnEnded(page, bg.forkId, 1, 120_000);
  expect(firstTurn.messages.at(-1)?.text).toBe("裏で頼みました");
  // 札が閉じるまでは起きたまま
  const stillAwake = await projectOf(projectId);
  expect(stillAwake.sleep, "裏の仕事が残っているのに眠りに戻った").toBeUndefined();
  expect(containerState(projectId)).toBe("RUNNING");
  // 返事が届き、AI が読み終えたら戻る
  const secondTurn = await waitTurnEnded(page, bg.forkId, 2, 120_000);
  expect(secondTurn.messages.at(-1)?.text).toContain("裏の仕事を終えました");
  await expectReturnedToSleep(projectId);
  expect((await api("DELETE", `/api/projects/${projectId}/automations/${bg.id}`)).status).toBeLessThan(300);
});

test("眠らせている途中に送った発言は切れない——ターンは最後まで走り、終わったとき Project は起きている", async ({ page }) => {
  expect(projectId, "前の試験が Project を作っていない").not.toBe("");
  // 前の試験で眠りに戻っている——起こしておく
  expect((await api("POST", `/api/projects/${projectId}/modules/prepare`)).status).toBe(200);
  await expectAwakeWithModules(projectId);
  const before = (await threadOf(baseId)).messages.filter((m) => m.role === "assistant").length;
  // 眠らせる（Module とコンテナを止めるので数秒かかる）のと、ほぼ同時に送る
  const sleeping = api<{ code?: string }>("POST", `/api/projects/${projectId}/sleep`);
  await new Promise((r) => setTimeout(r, 100));
  const sent = send(baseId, "眠らせている途中です。" + fakeTurn({ say: "途中でも届きました" }));
  const [slept, turn] = await Promise.all([sleeping, sent]);
  expect(turn.status).toBe(200);
  expect(turn.stream, "送った発言のターンが error で終わった").not.toContain('"type":"error"');
  const after = await waitTurnEnded(page, baseId, before + 1);
  expect(after.messages.at(-1)?.text).toBe("途中でも届きました");
  expect(after.messages.filter((m) => m.role === "user").at(-1)?.text).toContain("眠らせている途中です。");
  // 先に眠った（200）ならターンが起こした。先にターンが鍵を取った（409 busy）なら眠っていない。どちらでも、いまは起きている
  expect([200, 409], JSON.stringify(slept.body)).toContain(slept.status);
  if (slept.status === 409) expect(slept.body.code).toBe("busy");
  await expectAwakeWithModules(projectId);
  console.log(`[e2e] 眠らせる要求の結果：${slept.status}（200 ならターンが印を待って起こした）`);

  // 後始末
  await api("POST", `/api/projects/${projectId}/close`);
});
