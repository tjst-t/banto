// specから共通で使う手順。真実は一箇所（規則3）——同じ待ちを各specに写さない。
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { CORE_BASE_URL, CORE_BROWSER_URL, AUTH_TOKEN } from "./config.js";
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
  host: string = CORE_BROWSER_URL,
): Promise<void> {
  // ログインは test-base が済ませている（Cookie）。画面には繋ぐ先だけを渡す（localhost でだけ読まれる）
  await page.goto(`/?bantoHost=${host}`);
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
  // ダイアログが開いたことを先に見る——開かないまま fill すると、試験の上限まで黙って待つ（2026-10-06、プローブで3分止まった）
  // （携帯の幅では閉じた Drawer も role=dialog で残るので、入力欄で見る）
  const nameInput = page.getByLabel("Project 名");
  await expect(nameInput, "「新しい Project」を押してもダイアログが開かない").toBeVisible({ timeout: 15_000 });
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

  // **作った Project の画面に移り終わるまで待つ**（2026-10-06、Backlog #217）。名前はサイドバーに先に出るので、名前が
  // 見えただけでは URL はまだ前の Project のことがある（`router.push` の前）。その隙に `page.reload()` すると前の
  // Project の会話が開き、送った発言がそちらへ行っていた（turn-reattach の「判断待ち…」で承認カードが60秒出なかった
  // 原因——前の Project の Thread は承認を求めないモードで、tool がそのまま走っていた。ログの session で確かめた）
  //
  // 行き先の id は、作る要求の返事から取る。同じ根の Project が既にあるときは作らずにそれを開く（要求が出ない）ので、
  // 返事が無ければ名前で host に引く——どちらでも決まらなければ理由を言って落とす（黙って「名前まで」に戻すと、
  // 重いときに同じ不具合が静かに戻る。Fable のレビュー）
  const created = page
    .waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/projects", { timeout: 30_000 })
    .catch(() => undefined);
  await submit.click();
  await expectProjectOpen(page, projectName);
  const res = await created;
  let id = res && res.ok() ? ((await res.json().catch(() => undefined)) as { id?: string } | undefined)?.id : undefined;
  if (!id) {
    const projects = (await (
      await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers: { authorization: `Bearer ${AUTH_TOKEN}` } })
    ).json()) as { id: string; name: string }[];
    const named = projects.filter((p) => p.name === projectName);
    if (named.length !== 1) {
      throw new Error(
        `作った Project の id が決まらない（作る要求の返事=${res ? res.status() : "無し"}、同じ名前の Project=${named.length} 件）`,
      );
    }
    id = named[0]!.id;
  }
  await page.waitForURL((url) => url.pathname === `/p/${id}`, { timeout: 30_000 });
  await expect(page.getByPlaceholder(/に送る/).first()).toBeVisible({ timeout: 30_000 });
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
      lastTurn?: { outcome?: string };
    };
    const said = (detail.messages ?? [])
      .filter((m) => m.role === "assistant" && (m.text ?? "").trim() !== "")
      .map((m) => m.text!.trim());
    // 返事は書き終えるごとに記録に入る（2026-10-05）——返事があってもターンが終わったとは限らない。終わりは lastTurn で見る
    if (said.length === 0 || detail.lastTurn?.outcome === undefined) {
      return (
        "**ターンが終わっていない**（CLI が遅いか、止まっている）" +
        (said.length > 0 ? `。ここまでの返答: ${said[said.length - 1]!.slice(0, 300)}` : "——AI はまだ何も答えていない")
      );
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
/**
 * **そのターンが最後まで終わるまで待つ**（追加・2026-10-05）。AI の発言は書き終えるごとに記録に入る（アーキ仕様 §2.5
 * 「書き終えた発言ごとに記録する」）ので、**記録の AI の件数はターンの最初の発言で増える**——終わりの合図にならない
 * （そのあとの tool の結果・続きの文・resume-point はまだ）。見るのは：AI の発言（ターンごとに1件）が `replies` 件ある・
 * 最後の発言が最後のターンのもの・そのターンが終わりを書いた（`lastTurn.outcome`）。終わったときの記録を返す
 */
export async function waitTurnEnded(
  page: Page,
  threadId: string,
  replies: number,
  timeout = 60_000,
): Promise<{ messages: Array<{ seq: number; role: string; text: string }>; resumePoint?: string }> {
  type Thread = {
    messages: Array<{ seq: number; role: string; text: string }>;
    resumePoint?: string;
    lastTurn?: { startedSeq: number; outcome?: string };
  };
  let last: Thread | undefined;
  await expect
    .poll(
      async () => {
        last = (await (
          await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers: { authorization: `Bearer ${AUTH_TOKEN}` } })
        ).json()) as Thread;
        const said = last.messages.filter((m) => m.role === "assistant");
        const reply = said.at(-1);
        if (said.length !== replies) return `AI の発言が ${said.length} 件（待っているのは ${replies} 件）`;
        if (!last.lastTurn || !reply || reply.seq < last.lastTurn.startedSeq) return "最後の発言が最後のターンのものではない";
        return last.lastTurn.outcome ?? "ターンがまだ終わっていない";
      },
      { timeout, message: "ターンが最後まで終わらない" },
    )
    .toBe("completed");
  return last!;
}

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

/**
 * **AI の発言の文のうち、その言葉を含む段落**（2026-10-06、Backlog #215）。`page.getByText` は会話の中の tool の
 * カードの結果（開いていれば）も拾う——判断待ちが出ている間、結果の無い tool のカードは自動で開くので、開く順番
 * しだいで数がずれる。AI の文だけを数えたいときはこれを使う
 */
/** AI の文にその言葉が何回出ているか（1つの段落に2回出ても数える） */
export async function countAiText(page: Page, text: RegExp): Promise<number> {
  const paragraphs = await page.locator('[data-slot="aui_assistant-message-content"] p.aui-md-p').allInnerTexts();
  const global = new RegExp(text.source, text.flags.includes("g") ? text.flags : `${text.flags}g`);
  return paragraphs.reduce((n, p) => n + (p.match(global)?.length ?? 0), 0);
}

export function aiTextMentioning(page: Page, text: RegExp | string) {
  // 段落は markdown の `aui-md-p`。tool のカード（「Result:」の見出し・判断待ちの文）の <p> は拾わない
  return page.locator('[data-slot="aui_assistant-message-content"] p.aui-md-p').filter({ hasText: text });
}

/** 受信箱の1件（`GET /api/inbox`）。判断待ち・レビュー待ちは Thread に、お知らせは Project に（無ければ banto 全体に）付く */
export type InboxItem = {
  id: string;
  kind: "judgment" | "notice" | "review";
  liveness?: string;
  source?: string;
  projectId?: string;
  threadId?: string;
  title?: string;
  message?: string;
};

async function coreGet<T>(path: string): Promise<T> {
  const res = await fetch(`${CORE_BASE_URL}${path}`, { headers: { authorization: `Bearer ${AUTH_TOKEN}` } });
  if (!res.ok) throw new Error(`[e2e] ${path} を読めません：${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** 名前（か id）で Project を選び、その Project とその Thread に付いた受信箱の1件かを見る関数を返す */
async function projectFilter(projects: string[]): Promise<(item: InboxItem) => boolean> {
  const all = await coreGet<{ id: string; name: string }[]>("/api/projects");
  const mine = all.filter((p) => projects.includes(p.name) || projects.includes(p.id));
  const threadIds = new Set<string>();
  for (const p of mine) {
    for (const t of await coreGet<{ id: string }[]>(`/api/projects/${p.id}/threads`)) threadIds.add(t.id);
  }
  const projectIds = new Set(mine.map((p) => p.id));
  return (item) =>
    (item.threadId !== undefined && threadIds.has(item.threadId)) || (item.projectId !== undefined && projectIds.has(item.projectId));
}

/**
 * **その Project の受信箱**（追加・2026-10-08）。受信箱は banto 全体で1つ（`GET /api/inbox`）なので、件数を数える試験が
 * 全体を数えると、同じ回の前の spec が残したものまで数える（permission-mode-and-two-approvals が 0 にならなかった）。
 * 試験が見たいのは自分の Project のものだけ——Project の名前か id で絞る。Project を作り直さない限り、Thread が
 * 増えても毎回引き直す
 */
export async function projectInbox(project: string): Promise<InboxItem[]> {
  const ours = await projectFilter([project]);
  return (await coreGet<InboxItem[]>("/api/inbox")).filter(ours);
}

/**
 * **受信箱を片づける**（一般化・2026-10-08。もとは `settleProjectsInbox`、2026-10-06、Backlog #215）。答えていない判断待ちは
 * 断り（deny）、お知らせ・レビュー待ちは見たにする。断ると裏の仕事が失敗して**新しいお知らせが出る**ことがあるので、
 * 決まった秒数を待つのではなく、**何も片づけるものが無い見回りが2回続くまで**繰り返す（上限つき）。
 *
 * 片づけられなかったもの（待っている呼び出しがもう無い判断待ち＝409 等）は理由つきで返す——呼ぶ側が落とすか警告する。
 * `filter` を渡せばその分だけ、渡さなければ全部（spec の替わり目の後片づけ、`test-base.ts`）
 */
export async function settleInbox(filter: (item: InboxItem) => boolean = () => true): Promise<string[]> {
  const headers = { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };
  const unsettled = new Map<string, string>();
  let quietRounds = 0;
  for (let round = 0; round < 15 && quietRounds < 2; round++) {
    if (round > 0) await new Promise((r) => setTimeout(r, 500));
    let acted = 0;
    for (const item of (await coreGet<InboxItem[]>("/api/inbox")).filter(filter)) {
      if (unsettled.has(item.id)) continue;
      if (item.kind === "judgment") {
        // 期限切れ（timed_out）は一覧に残るが、答えられず数にも入らない（画面のバッジは live だけを数える）
        if (item.liveness !== "live") continue;
        const res = await fetch(`${CORE_BASE_URL}/api/inbox/${item.id}/answer`, {
          method: "POST",
          headers,
          body: JSON.stringify({ answer: { behavior: "deny", message: "試験の後片づけ" } }),
        });
        if (!res.ok) unsettled.set(item.id, `判断待ち ${item.id}（source=${item.source ?? "?"}、${res.status} ${await res.text()}）`);
      } else {
        const res = await fetch(`${CORE_BASE_URL}/api/inbox/${item.id}/acknowledge`, { method: "POST", headers });
        if (!res.ok) unsettled.set(item.id, `${item.kind} ${item.id}（${item.title ?? ""}、${res.status} ${await res.text()}）`);
      }
      acted++;
    }
    quietRounds = acted === 0 ? quietRounds + 1 : 0;
  }
  if (quietRounds < 2) unsettled.set("-", "見回るたびに新しいものが出て、落ち着かなかった");
  return [...unsettled.values()];
}

/**
 * **その spec が作った Project の受信箱を片づける**（2026-10-06、Backlog #215）。spec の替わり目に test-base が受信箱を
 * 全部片づけるようになった（2026-10-08）ので、ここは spec の中で自分の分を先に片づけたいときに使う
 */
export async function settleProjectsInbox(_request: APIRequestContext, projectNames: string[]): Promise<void> {
  const left = await settleInbox(await projectFilter(projectNames));
  if (left.length > 0) {
    console.warn(`[e2e] 片づけられなかった受信箱の項目が残っている——後ろの spec の受信箱の数がずれうる: ${left.join(" / ")}`);
  }
}

/** いま開いている Project の id（URL の `/p/<id>`）。`createProject` のあとに呼ぶ */
export function currentProjectId(page: Page): string {
  const id = /\/p\/([0-9a-f-]+)/.exec(new URL(page.url()).pathname)?.[1];
  if (!id) throw new Error(`[e2e] Project を開いていない（URL=${page.url()}）`);
  return id;
}

/**
 * **閉じている tool のカード（「Used tool: <名前>」）を全部開く**（追加・2026-10-08）。承認を求めるカードではない tool の
 * カードは自動で開かない（v4-frontend.md「答え方」の改訂・2026-10-06）——結果を画面で見るときは、押して開いてから見る
 */
export async function openToolCards(page: Page, toolName: string): Promise<void> {
  const closed = page.getByRole("button", { name: `Used tool: ${toolName}`, expanded: false });
  for (let i = 0; i < 10 && (await closed.count()) > 0; i++) await closed.first().click();
  await expect(closed, `「Used tool: ${toolName}」のカードが開かない`).toHaveCount(0);
}

/**
 * **Command Palette から Module の入口を開く**（追加・2026-10-08）。入口はその Project の Module が立ってから出る——
 * 負荷が高いとコンテナの起動に 40 秒を超え、action の上限（30 秒、`playwright.config.ts`）では押す前に切れた
 * （vault-directory:1009）。出るまで 60 秒は待ち、出なければ「入口が出ない」と言って落ちる
 */
export async function openPaletteEntry(page: Page, name: RegExp): Promise<void> {
  await page.getByRole("button", { name: "検索（Command Palette）" }).click();
  const entry = page.getByRole("option", { name });
  await expect(entry, `Command Palette に入口 ${name} が出ない（その Module が立っていない？）`).toBeVisible({ timeout: 60_000 });
  await entry.click();
}
