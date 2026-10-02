// specから共通で使う手順。真実は一箇所（規則3）——同じ待ちを各specに写さない。
import { expect, type Page } from "@playwright/test";
import { CORE_BASE_URL, AUTH_TOKEN } from "./config.js";
import { FAKE_RUNNER_MARKER, type FakePlan } from "./fake-runner.js";

/**
 * アプリを開き、**行き先が決まりきるまで待つ**。
 *
 * `/` は実Projectの読み込みが終わってから「先頭のProjectへ」自動で移る
 * （components/banto/project/home-content.tsx）。`/` と `/p/[id]` は
 * **それぞれ別の AppShell を持つ**ので、この移動でトップバーが作り直される
 * ——移動前に「新しい Project」を開くと、入力の途中でダイアログごと消える。
 *
 * Projectが増えるほど読み込みが伸びるため、**後ろのspecほど**この競走に
 * 負けていた（実測・2026-09-06、`作成する` が element detached で押せない）。
 * ここで決着を待ってから操作を始める。
 *
 * 待ち条件は「何秒か待つ」ではなく**実際に決着した印**で書く（規則6）：
 * Projectが有れば `/p/...` へ移り終わっていること、0件なら空状態が出ること。
 */
/**
 * **同梱の目録から Infisical を1本入れる**（追加・2026-09-20）。
 *
 * `vault-infisical` は 2026-09-20 に**既定から外した**——banto のコードだが
 * 誰もが使うものではないので、要る人が「Module を追加」から入れる形にした。
 * `vault` の実装が2本ある状態を見たい試験は、まずこれを呼ぶ。
 *
 * **画面ではなく口から入れる**——ここは前提を作るところで、試験の対象ではない
 * （目録の面そのものは `instance-modules.spec.ts` が画面から見る）。
 */
export async function installInfisical(page: Page, name = "vault-infisical"): Promise<void> {
  const res = await page.request.post(`${CORE_BASE_URL}/api/modules/catalog/vault-infisical`, {
    headers: { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" },
    data: { name },
  });
  if (res.ok()) return;
  // **もう在るなら、それでよい**——core は全 spec で1つなので、別の spec が先に
  // 入れていることがある。ここは前提を整えるところで、試験の対象ではない
  const body = await res.text();
  if (body.includes("その名前はもう使われています")) return;
  throw new Error(`Infisical を入れられませんでした: ${body}`);
}

export async function openApp(
  page: Page,
  /** 画面が繋ぐ先。既定は E2E の core——間に中継を挟んで接続を切る試験だけが変える */
  host: string = CORE_BASE_URL,
): Promise<void> {
  await page.goto(`/?bantoToken=${AUTH_TOKEN}&bantoHost=${host}`);
  await Promise.race([
    page.waitForURL(/\/p\/[0-9a-f-]+/, { timeout: 30_000 }),
    page.getByText("まだ Project がありません").waitFor({ state: "visible", timeout: 30_000 }),
  ]);
  // **URL が変わっただけでは、まだ着いていない**（改訂・2026-09-12、間欠 3/7 の
  // 調査）。`/` から先頭の Project へは `router.replace` で移るので、**URL は
  // 即座に変わるが、新しい画面が描き終わっているとは限らない**。
  // `/` と `/p/[id]` は別の AppShell を持つ（下の `createProject` のコメント参照）ので、
  // その差の間に開いたダイアログは作り直しに巻き込まれる。
  // **実際に期待する中身が出るまで待つ**（規則6）——会話の入力欄は
  // `/p/[id]` 側にしか無い
  if (/\/p\/[0-9a-f-]+/.test(page.url())) {
    await expect(page.getByPlaceholder(/に送る/).first()).toBeVisible({ timeout: 30_000 });
  }
  // ナビの入口があること。**幅で場所が変わる**（改訂・2026-09-09）——
  // デスクトップはサイドバーに、モバイルはヘッダの ≡（押すと Drawer）に出る
  await expect(
    isMobileViewport(page)
      ? page.getByRole("button", { name: "Project と Thread の一覧を開く" }).first()
      : page.getByRole("button", { name: "新しい Project", exact: true }),
  ).toBeVisible();
}

/** md 未満（携帯幅）か。ナビの出方がここで変わる */
function isMobileViewport(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1280) < 768;
}

/**
 * ナビ（Project 一覧・新しい Project・履歴・設定）を触れる状態にする。
 *
 * **入口は幅で変わる**（改訂・2026-09-09、モバイルの上部バーを廃止した）——
 * デスクトップはサイドバーに出ているのでそのまま。モバイルはパネルのヘッダの
 * ≡ を押して Drawer を開く。開いた Drawer は行き先を選ぶと自分で閉じる。
 */
export async function openNav(page: Page): Promise<void> {
  if (!isMobileViewport(page)) return;
  const newProject = page.getByRole("button", { name: "新しい Project", exact: true });
  if (await newProject.isVisible().catch(() => false)) return; // すでに開いている
  await page.getByRole("button", { name: "Project と Thread の一覧を開く" }).first().click();
  await expect(newProject).toBeVisible({ timeout: 10_000 });
}

/**
 * その Project の Base Thread が開いていること。**題は Project 名だけ**
 * （改訂・2026-09-11、ユーザー要望——「Base Thread —」の接頭辞をやめた。
 * その面が何かは、いま開いているもので分かる）。待ち条件は各 spec に
 * 写さずここ1箇所に持つ（規則3）。
 */
export async function expectProjectOpen(
  page: Page,
  projectName: string,
  message?: string,
): Promise<void> {
  await expect(page.getByText(projectName, { exact: true }).first(), message).toBeVisible({
    timeout: 15_000,
  });
}

/** Project を1つ作り、その Base Thread が開くまで待つ（どの spec も同じ手順を踏む） */
export async function createProject(
  page: Page,
  projectName: string,
  projectRoot: string,
): Promise<void> {
  await openNav(page);
  await page.getByRole("button", { name: "新しい Project", exact: true }).click();
  const nameInput = page.getByLabel("Project 名");
  const pathInput = page.getByLabel("Root パス");
  const submit = page.getByRole("button", { name: "作成する" });

  await nameInput.fill(projectName);
  await pathInput.fill(projectRoot);

  // **打ったものが残っているか、その場で見る**（追加・2026-09-12）。
  //
  // ここは間欠で落ち続けていた箇所（通算 3/7、`docs/notes/2026-09-11-wide-project-root.md`）。
  // 症状は「`作成する` が**無効のまま** 5 分」——ボタンは消えていないので
  // `element detached` ではなく、**打った値が画面の state に無い**。
  // 原因は測り切れていないが、**待って時間切れになるより、その場で
  // 何が起きたかを言うほうがよい**（規則2・規則6——次に出たとき一発で分かる）。
  //
  // 5分の沈黙ではなく、10秒で「DOM に入っているのに押せない」まで言う。
  const enabled = await submit.isEnabled().catch(() => false);
  if (!enabled) {
    await expect
      .poll(async () => submit.isEnabled().catch(() => false), { timeout: 10_000 })
      .toBe(true)
      .catch(async () => {
        const [nameValue, pathValue, dialogs] = await Promise.all([
          nameInput.inputValue().catch(() => "(読めない)"),
          pathInput.inputValue().catch(() => "(読めない)"),
          page.locator('[role="dialog"]').count(),
        ]);
        throw new Error(
          "「作成する」が無効のまま。" +
            `入力欄の中身: 名前=${JSON.stringify(nameValue)} / Root=${pathValue ? "有" : "空"}、` +
            `開いているダイアログ=${dialogs}、URL=${page.url()}。` +
            (nameValue && pathValue
              ? "**DOM には入っているのに押せない**——画面の state に届いていない（作り直しに巻き込まれた疑い）"
              : "**DOM にも入っていない**——入力欄そのものが入れ替わった疑い"),
        );
      });
  }

  await submit.click();
  await expectProjectOpen(page, projectName);
}

/**
 * 設定の面を開く（改訂・2026-09-11——**会話ヘッダの歯車は無くした**。
 * 同じ機能への入口をサイドバーと2つ持たない、規則3）。
 *
 * 入口はサイドバーの「設定」——いま開いている Project の層も一緒に出る
 * （`docs/specs/v4-frontend.md` §6.16）。`section` を渡すと、その節まで開く。
 */
export async function openProjectSettings(page: Page, section?: string): Promise<void> {
  if (!/[?&]settings=1|\/settings/.test(page.url())) {
    await openNav(page);
    await page.getByRole("link", { name: "設定", exact: true }).first().click();
    await page.waitForURL(/[?&]settings=1|\/settings/, { timeout: 20_000 });
  }
  if (section) {
    await page.getByRole("button", { name: section, exact: true }).click();
  }
}

/**
 * **AI に tool を呼ばせる試験が落ちたとき、なぜかを言う**（追加・2026-09-20、ユーザー指示）。
 *
 * これらの試験は「AI に頼む → その結果 UI が出る」形なので、UI が出ないときに
 * **2つの別々の原因が同じ沈黙になる**：
 *
 *   1. **AI がそもそも tool を呼ばなかった**（試験の作りの問題）
 *   2. **呼んだのに UI が出ない**（実装の問題）
 *
 * 待ち条件が UI だけだと、どちらでも「180 秒待って出ませんでした」としか出ず、
 * **直す先が分からない**。ここでは host に**実際の会話の記録**を聞いて分ける
 * ——画面ではなく host に聞く（規則1）。
 */
export async function explainMissingAiResult(page: Page, projectName: string): Promise<string> {
  const headers = { authorization: `Bearer ${AUTH_TOKEN}` };
  try {
    const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as Array<{
      id: string;
      name: string;
    }>;
    const project = projects.find((p) => p.name === projectName);
    if (!project) return "Project が host に無い（作成に失敗している）";
    const threads = (await (
      await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers })
    ).json()) as Array<{ id: string; kind: string }>;
    const thread = threads.find((t) => t.kind === "base") ?? threads[0];
    if (!thread) return "Thread が host に無い";
    const detail = (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${thread.id}`, { headers })).json()) as {
      messages?: Array<{ role: string; text?: string }>;
    };
    const said = (detail.messages ?? [])
      .filter((m) => m.role === "assistant" && (m.text ?? "").trim() !== "")
      .map((m) => m.text!.trim());
    if (said.length === 0) {
      return "AI はまだ何も答えていない——**ターンが終わっていない**（CLI が遅いか、止まっている）";
    }
    return (
      "AI は答えを返し終わっているのに UI が出ていない——**AI が tool を呼ばなかった**" +
      `（試験の作りの問題。実装ではない）。最後の返答: ${said[said.length - 1]!.slice(0, 300)}`
    );
  } catch (err) {
    return `理由を調べようとして失敗した: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * **偽 Runner への指示**（追加・2026-09-20、ユーザー決定）。
 *
 * E2E は実 LLM を使わない。プロンプトの末尾にこの印を付けると、
 * `fake-runner.ts` がそのとおりに動く——**言わせる／tool を呼ばせる**。
 *
 * 印より前は人が読む文のまま残す。**画面に出るのはそこ**なので、
 * 会話の見た目は今までどおりで、決まり方だけが決定的になる。
 *
 * **真実は一箇所**（規則3）——印の文字列は `fake-runner.ts` が持ち、ここは import する。
 */
export function fakeTurn(plan: FakePlan): string {
  return `\n${FAKE_RUNNER_MARKER}${JSON.stringify(plan)}`;
}

/**
 * **その Project の Module が立つまで待つ**（追加・2026-09-21）。
 *
 * Project ごとの Module（filesystem・shell）は **On demand** で、Project を
 * 作った直後はまだ立っていない。実 LLM を使っていた頃はターンに十数秒かかり、
 * その間に立っていたので誰も気づかなかった——**偽 Runner にしたら一瞬で
 * tool を呼ぶようになり、立つ前に呼んで空の結果が返った**（2026-09-21、
 * `module-canvas-inline` の Canvas が「ディレクトリ: .」だけになった）。
 *
 * **待ちを延ばすのではなく、待つべきものを名指しで待つ**（規則6）。
 */
export async function waitForProjectModule(page: Page, projectName: string, moduleName: string): Promise<void> {
  const headers = { authorization: `Bearer ${AUTH_TOKEN}` };
  await expect
    .poll(
      async () => {
        const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as Array<{
          id: string;
          name: string;
        }>;
        const project = projects.find((p) => p.name === projectName);
        if (!project) return "Project がまだ無い";
        const modules = (await (
          await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/modules`, { headers })
        ).json()) as Array<{ name: string; connected?: boolean; error?: string }>;
        const target = modules.find((m) => m.name === moduleName);
        if (!target) return `${moduleName} が一覧に無い`;
        return target.connected === true ? "ok" : (target.error ?? "まだ繋がっていない");
      },
      { timeout: 60_000, message: `${moduleName} が立ち上がらない` },
    )
    .toBe("ok");
}

/**
 * **Fork を押したあとの、名前を聞くダイアログに答える**（決定・2026-10-02、v4-frontend.md §6.32）。
 * ヘッダの「Fork を開く」も発言の下の「ここから Fork」も、押すとまずダイアログが出る——
 * 名前を空のまま「作る」を押せば、今までどおり連番の Fork になる。
 */
export async function confirmForkDialog(
  page: Page,
  options: { title?: string; start?: "continue" | "fresh" } = {},
): Promise<void> {
  const dialog = page.getByTestId("fork-dialog");
  await expect(dialog, "Fork の名前を聞くダイアログが出ない").toBeVisible({ timeout: 15_000 });
  if (options.title !== undefined) await dialog.getByLabel("名前").fill(options.title);
  if (options.start) await dialog.getByTestId(`fork-start-${options.start}`).click();
  await dialog.getByTestId("fork-dialog-submit").click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
}
