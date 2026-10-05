// **更新の「待つ」は、続けられないものだけを待つ**（追加・2026-10-05、アーキ仕様 §2.5「画面から banto を更新する」の
// 待つ段・「起こし直しをまたいで続ける」の 3.）。
//
// 完了条件：AI のターンとサブエージェントの仕事が走っていても、実行中の tool の呼び出しが無ければ「待って更新」がすぐ
// 起こし直しに進み、起き直したあと両方が続く。本物の `update.mjs` と systemd は E2E で使えないので、`update.mjs` が見る
// `GET /api/admin/activity` の `restartable` を自前の host（`own-host.ts`）で見て、起こし直しは host への SIGTERM と
// 起こし直し（`systemctl restart` と同じ止め方）で代える。`restartable` で進むこと自体は update.mjs の単体が見ている。
// 見るもの（規則14）：
//   - 人の返事待ち（Vault の承認）で止まっている呼び出しは待たない（restartable・待つものは空・ターンは人待ち）
//   - tool の呼び出し（待つ形のサブエージェント）が実行中の間は restartable にならない——待つものにその呼び出し
//     （どの Project のどの会話の何か）が出る
//   - ターンが文を書いている途中＋サブエージェントの待たない仕事（runInBackground）が走っている間は restartable。
//     待つものは空、続くものにそのターンと仕事。全部空（idle）ではない
//   - その状態で host を SIGTERM で起こし直すと、ターンは続きが最後まで流れ、サブエージェントは続けると答えて結果が同じ
//     札で届く（「途中で終わりました」は届かない）
import { test, expect, type Page } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRONTEND_BASE_URL } from "../config.js";
import { createProject, openApp, fakeTurn } from "../helpers.js";
import { withOwnHost, type OwnHost } from "../own-host.js";
import { writeLoginLink } from "../../packages/core/dist/auth/login-links.js";
import type { ActivityReport } from "../../packages/core/dist/http/activity.js";

test.setTimeout(300_000);

const PROJECT_NAME = "E2E Update Wait Restartable";
/** 20 秒かけて [1]〜[20] を流すターン（文を書いている途中に起こし直す隙を作る） */
const LINES = Array.from({ length: 20 }, (_, i) => `[${i + 1}]`);

interface HostThread {
  messages: Array<{ seq: number; role: string; text: string; origin?: { from: string; title: string } }>;
  awaitingReplies?: Array<{ moduleName: string; keptAt?: string }>;
  lastTurn?: { outcome?: string; startedSeq: number };
}

async function api<T>(host: OwnHost, path: string): Promise<T> {
  const res = await fetch(`${host.apiUrl}${path}`, { headers: { authorization: `Bearer ${host.token}` } });
  if (!res.ok) throw new Error(`${path} が ${res.status}`);
  return (await res.json()) as T;
}

async function login(page: Page, host: OwnHost): Promise<void> {
  const { code } = await writeLoginLink(host.dataDir);
  const res = await page.context().request.post(`${host.url}/api/auth/redeem`, {
    headers: { "x-banto-client": "1", origin: FRONTEND_BASE_URL, "content-type": "application/json" },
    data: { code },
  });
  if (!res.ok()) throw new Error(`自前の host にログインできませんでした：${res.status()} ${await res.text()}`);
}

/** 待つもの・続くものを、試験で比べやすい形に（どの会話の何か） */
function summary(a: ActivityReport, threadId: string, projectId: string) {
  const where = (i: { threadId?: string }) => (i.threadId === threadId ? "この会話" : (i.threadId ?? "会話なし"));
  const what = (i: ActivityReport["continuesAfterRestart"][number]): string =>
    i.kind === "turn"
      ? `ターン（${where(i)}${i.waitingOnHuman ? "・人待ち" : ""}）`
      : i.kind === "reply"
        ? `返事待ち（${where(i)}・${i.module}）`
        : i.kind === "moduleReply"
          ? `Module 宛ての返事待ち（${i.module}）`
          : `呼び出し（${where(i)}・${i.connName.replace(`-${projectId}`, "")}・${i.origin}${i.waitingOnHuman ? "・人待ち" : ""}）`;
  return {
    restartable: a.restartable,
    idle: a.idle,
    blocking: a.blocking.map(what).sort(),
    continuesAfterRestart: a.continuesAfterRestart.map(what).sort(),
  };
}

test("文を書いているターンとサブエージェントの待たない仕事は待たず（restartable）、起こし直すと両方続く。tool の呼び出しの間は待つ", async ({
  page,
}) => {
  await withOwnHost(async (host) => {
    await login(page, host);
    await openApp(page, host.url);
    await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-update-wait-")));
    const project = (await api<Array<{ id: string; name: string }>>(host, "/api/projects")).find((p) => p.name === PROJECT_NAME)!;
    const threadId = (await api<Array<{ id: string }>>(host, `/api/projects/${project.id}/threads`))[0]!.id;
    const thread = () => api<HostThread>(host, `/api/threads/${threadId}`);
    const activity = async () => summary(await api<ActivityReport>(host, "/api/admin/activity"), threadId, project.id);
    const composer = page.getByPlaceholder(/に送る/);
    const allow = page.getByRole("button", { name: "許可する" });

    expect(await activity(), "試験の前提：何も動いていない").toEqual({ restartable: true, idle: true, blocking: [], continuesAfterRestart: [] });

    // ---- 1. 待つ形でサブエージェントに頼む（tool の呼び出しが 20 秒実行中になる）-----------------------------------
    await composer.fill(
      "サブエージェントに頼んで、終わるまで待って。" +
        fakeTurn({ tools: [{ server: "subagent", name: "runSubagent", args: { agent: "fake", prompt: "[slow 20] 待つ仕事" } }] }),
    );
    await composer.press("Enter");
    // 鍵を使うエージェントは初回に Vault の在りかを聞く（Project ごとに1回）。答えを待つ間、呼び出しは人を待っている
    // ——待つと人が答えるまで終わらないので待たない
    await expect(allow.last(), "試験の前提：初回の Vault の承認が出ない").toBeVisible({ timeout: 180_000 });
    await expect
      .poll(activity, { timeout: 30_000, message: "人の答えを待っている呼び出しを待っている" })
      .toEqual({ restartable: true, idle: false, blocking: [], continuesAfterRestart: ["ターン（この会話・人待ち）"] });
    // 答えたら、呼び出しは実行中——切れると結果が分からないので待つ（ターンは続くものに残る）
    await expect(async () => {
      if ((await allow.count()) > 0) await allow.last().click();
      expect(await activity()).toEqual({
        restartable: false,
        idle: false,
        blocking: ["呼び出し（この会話・subagent・turn）"],
        continuesAfterRestart: ["ターン（この会話）"],
      });
    }).toPass({ timeout: 60_000, intervals: [500] });
    const busy = await api<ActivityReport>(host, "/api/admin/activity");
    expect(busy.blocking[0], "待つものに Project と会話の題が無い").toMatchObject({ kind: "call", projectId: project.id, projectName: PROJECT_NAME });
    // 呼び出しが終わってターンも終われば、全部空
    await expect.poll(async () => (await thread()).lastTurn?.outcome, { timeout: 90_000 }).toBe("completed");
    expect(await activity()).toEqual({ restartable: true, idle: true, blocking: [], continuesAfterRestart: [] });

    // ---- 2. 待たずに頼む（runInBackground）——返事待ちの札が残る ----------------------------------------------------
    await composer.fill(
      "サブエージェントに待たずに頼んで。" +
        fakeTurn({
          tools: [{ server: "subagent", name: "runSubagent", args: { agent: "fake", prompt: "[slow 60] [then-slow 8] 長い仕事", runInBackground: true } }],
        }),
    );
    await composer.press("Enter");
    await expect(async () => {
      if ((await allow.count()) > 0) await allow.last().click();
      await expect(page.getByText(/待たずに頼みました/).first()).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 120_000 });
    await expect.poll(async () => (await thread()).lastTurn?.outcome, { timeout: 60_000 }).toBe("completed");
    expect(await activity(), "続けられる Module の仕事を待っている").toEqual({
      restartable: true,
      idle: false,
      blocking: [],
      continuesAfterRestart: ["返事待ち（この会話・subagent）"],
    });

    // ---- 3. ターンが文を書いている途中＋待たない仕事が走っている：待つものは無い ------------------------------------
    await composer.fill("1 から 20 まで数えて。" + fakeTurn({ say: LINES.join("\n"), streamMs: 20_000 }));
    await composer.press("Enter");
    await expect
      .poll(
        async () => {
          const t = await thread();
          const said = t.messages.filter((m) => m.role === "assistant" && m.seq > (t.lastTurn?.startedSeq ?? Infinity));
          return said.at(-1)?.text ?? "";
        },
        { timeout: 60_000, message: "ターンが流れ始めない" },
      )
      .toContain("[3]");
    expect(await activity(), "文を書いているターンと待たない仕事を待っている").toEqual({
      restartable: true,
      idle: false,
      blocking: [],
      continuesAfterRestart: ["ターン（この会話）", "返事待ち（この会話・subagent）"],
    });
    const before = await thread();
    expect(before.lastTurn?.outcome, "起こし直す前にターンが終わった（試験の前提が崩れた）").toBeUndefined();
    expect(before.awaitingReplies?.map((r) => r.moduleName), "起こし直す前に仕事が終わった（試験の前提が崩れた）").toEqual(["subagent"]);
    const said = before.messages.length;

    // ---- 4. restartable なので起こし直す（update.mjs の restart と同じく SIGTERM）-----------------------------------
    await host.stop("SIGTERM");
    await host.start();

    // サブエージェントが続く：続けると答え、結果が同じ札で届く（「途中で終わりました」は届かない）
    await expect
      .poll(async () => (await thread()).messages.filter((m) => m.origin?.from === "subagent").map((m) => m.origin!.title), {
        timeout: 120_000,
        message: "サブエージェントの結果が届かない",
      })
      .toEqual(["Fake Agent（試験用） の仕事が終わりました"]);
    // 続きのターンと、結果で起きたターンが終われば、全部空
    await expect.poll(activity, { timeout: 120_000 }).toEqual({ restartable: true, idle: true, blocking: [], continuesAfterRestart: [] });
    const done = await thread();
    expect(done.messages.find((m) => m.origin?.from === "subagent")!.text).toContain(
      "受け取った：banto を起こし直したため、作業が途中で切れました。切れたとき実行中だった tool：sleep 60——結果は分かりません",
    );
    expect(done.messages.some((m) => /途中で終わりました/.test(m.origin?.title ?? "")), "「途中で終わりました」も届いた").toBe(false);
    expect(host.log()).toMatch(/前の走行の返事待ち（subagent・Thread [^）]+）→ 続けると答えた/);
    // ターンが続く：切れた吹き出しに印、banto の続き、続きが最後まで（結果で起きたターンはその後ろ）
    const after = done.messages.slice(said - 1);
    expect(after[0]!.text, "切れた吹き出しに印が無い").toMatch(/\[3\][\s\S]*（起こし直しで切れました）$/);
    const continued = after.findIndex((m) => m.origin?.from === "banto");
    expect(after[continued]?.origin?.title, "banto の続きが無い").toBe("banto を起こし直したため、直前のターンが途中で切れました");
    expect(
      after.slice(continued + 1).some((m) => m.role === "assistant" && m.text.includes("[20]")),
      "続きが最後まで流れない",
    ).toBe(true);
    // 届いたもの（banto の続き・サブエージェントの結果）は origin つき——人の発言は送った3つのまま
    expect(done.messages.filter((m) => m.role === "user" && !m.origin).length, "続きが人の発言として積まれた").toBe(3);

    // 画面：続きと届いた結果が会話に出る
    await expect(page.locator('[data-role="assistant"]').filter({ hasText: "（起こし直しで切れました）" })).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId("delivered-message").filter({ hasText: "subagent から届きました" })).toHaveCount(1, { timeout: 60_000 });

  });
});
