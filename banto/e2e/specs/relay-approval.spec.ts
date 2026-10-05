// Module 間中継の初回承認ゲートと監査（アーキ仕様 §2.5・v4-frontend.md
// 「Module 間中継の承認（入れ子の承認）」）。
//
// 見るのは4つ：
//   1. **初回だけ**人に聞く——Shell が Vault の resolveAlias を呼ぶ手前で止まる
//   2. `bypassPermissions` でも出る（AI への信用と、Project の配線への信用は別の軸）
//   3. 許可すると中継が通り、**秘密の値が実際にコマンドへ届く**（規則14——
//      「カードを押せた」で終わらせず、画面に出る中身まで見る）
//   4. 2回目は聞かれない（同じ Project 内で自動許可）。記録は Event Store に残る
import { test, expect } from "../test-base.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN, DATA_DIR } from "../config.js";
import { createProject, openApp, fakeTurn } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);
test.use({ viewport: { width: 390, height: 844 } });

const PROJECT_NAME = "E2E Relay Approval Project";
/** 「中継が通ったときにしか画面に出ない」一意な値。 */
const SECRET = `RELAY-OK-${Date.now()}`;
const ALIAS = `e2e-relay-${Date.now()}`;

const PROMPT =
  "秘密を環境変数に入れて echo してください。" +
  fakeTurn({
    tools: [
      {
        server: "shell",
        name: "runCommand",
        args: { command: 'echo "got=$MY"', envSecrets: { MY: ALIAS } },
      },
    ],
  });

/** Event Store に積まれた中継の記録（監査の本体）。 */
function relayEvents(): Array<{ seq: number; type: string; payload: Record<string, unknown> }> {
  const raw = readFileSync(join(DATA_DIR, "events.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.includes('"relay.'))
    .map((line) => JSON.parse(line) as { seq: number; type: string; payload: Record<string, unknown> })
    .filter((e) => e.type.startsWith("relay."));
}

test("Module 間の中継は初回だけ人に聞き、許可すると通る——記録は Event Store に残る", async ({
  page,
}) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-relay-"));
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  // Vault に alias を1つ置く（人の管理操作＝admin 可視性なので、画面の口から）
  const created = await page.request.post(`${CORE_BASE_URL}/api/ui-tool-call`, {
    headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    data: {
      server: "vault-local",
      tool: "createAlias",
      // scope は instance——この試験が見たいのは中継の承認で、対象の割り当てではない
      arguments: { name: ALIAS, kind: "secret", value: SECRET },
    },
  });
  expect(created.ok()).toBe(true);

  await openApp(page);
  await createProject(page, PROJECT_NAME, projectRoot);

  const headers = { authorization: `Bearer ${AUTH_TOKEN}` };
  const projects = await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json();
  const project = projects.find((p: { name: string }) => p.name === PROJECT_NAME);
  const threads = await (
    await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers })
  ).json();
  const threadId: string = threads[0].id;
  /**
   * **この試験がこれから積む記録だけ**（訂正・2026-09-16）。
   *
   * ここは `events.jsonl` を直に読むが、**core は spec をまたいで1つ**なので、
   * 絞らないと他の spec が積んだ記録まで数えてしまう。実際、`${secret:…}` の
   * spec が `resolveAlias` を積むようになった時点で、下の「2回目のターンを待つ」
   * が**待たずに通り抜けた**（規則6——待ち条件が見ているものが、見たいものと
   * ずれていた）。**Project では絞れない**——窓口（instance に1本）が金庫へ
   * 中継する記録には Project が付かない。**連番で切る**（E2E は1 worker）。
   */
  const sinceSeq = Math.max(0, ...relayEvents().map((e) => e.seq));
  const mine = () => relayEvents().filter((e) => e.seq > sinceSeq);
  /** ターンが**終わった**数（assistant の発言は終わってから記録される）。
   *  走行中に次を送っても composer は受け取らないので、ここで区切る。 */
  const finishedTurns = async () => {
    const thread = (await (
      await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers })
    ).json()) as { messages: { role: string }[] };
    return thread.messages.filter((m) => m.role === "assistant").length;
  };

  // **確認を全部飛ばすモードにする**——それでも中継の確認は出る、が見たいこと
  await page.getByRole("button", { name: /permissionMode/ }).click();
  await page.getByRole("menuitemradio", { name: /bypassPermissions/ }).click();
  await page.getByRole("button", { name: "この会話で有効にする" }).click();
  await expect(page.getByRole("button", { name: /permissionMode（現在：bypassPermissions）/ })).toBeVisible({
    timeout: 15_000,
  });

  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill(PROMPT);
  await composer.press("Enter");

  // 1. 中継の手前で止まる（bypassPermissions でも出る）
  //
  // **秘密1つに中継が4本**（改訂・2026-09-12）。Shell は宛先の Vault を
  // 決め打ちしないので、経路がこうなる：
  //
  // ```
  // shell → vault-directory    lookupAlias    「その名前はどこ？」
  //   vault-directory → vault-local     listAliases   （窓口が横断して探す）
  //   vault-directory → vault-infisical listAliases
  // shell → vault-local        resolveAlias   「値をください」
  // ```
  //
  // **承認は（呼び出し元・宛先・tool）ごとに初回1回**なので、初回のターンでは
  // これが全部カードになる。**入れ子の中継も同じターンの仕事として扱われる**
  // ——さもないと窓口の問い合わせは「どのターンか分からない」で止まる。
  const firstCard = page.locator('[data-role="judgment-card"]').first();
  await expect(
    firstCard.getByText(/shell が vault-directory の lookupAlias を呼ぼうとしています/),
    "最初に聞かれるのは「在りかを聞いてよいか」のはず",
  ).toBeVisible({ timeout: 120_000 });
  // **何を承認するのかが、答える前に見えている**（§6.0）
  await expect(firstCard.getByText(/"呼び出し元": "shell"/)).toBeVisible();
  await expect(firstCard.getByText(/"宛先": "vault-directory"/)).toBeVisible();
  // **値は出さない**（§2.5——記録に残るのは宛名まで）。在りかを聞く段では、
  // そもそもまだ値に触れていない
  await expect(firstCard.getByText(SECRET)).toHaveCount(0);

  // まだ中継されていない＝コマンドは走っていない
  await expect(page.getByText(`got=${SECRET}`)).toHaveCount(0);

  /** 出ているカードに1枚答える。**答えるたびに次が出る**（入れ子なので）。 */
  const approveOnePending = async (): Promise<boolean> => {
    const allow = page.getByRole("button", { name: "許可する" });
    if ((await allow.count()) === 0) return false;
    await allow.last().click();
    // **カードは同時に何枚も出る**（窓口が2つの金庫を並列に聞くため）。押せばその札だけ送る
    return true;
  };

  // 2. 許可していくと中継が通り、**秘密の値が実際にコマンドへ届く**
  await expect(async () => {
    await approveOnePending();
    await expect(page.getByText(`got=${SECRET}`).first()).toBeVisible({ timeout: 20_000 });
  }).toPass({ timeout: 300_000 });

  // **聞かれた中身が、経路のとおりであること**（規則14——押せたで終わらせない）
  const asked = await page.locator('[data-role="judgment-card"]').allInnerTexts();
  for (const expected of ["shell が vault-directory の lookupAlias", "shell が vault-local の resolveAlias"]) {
    expect(asked.join("\n"), `「${expected}」を人に聞いていない`).toContain(expected);
  }
  // **値を返さない口は聞かない**（決定・2026-09-12、v4-security.md）。窓口が
  // 金庫を横断して一覧を組むところは値が通らないので、人を止めない
  expect(
    asked.join("\n"),
    "値を返さない口（listAliases）で人を止めている",
  ).not.toContain("listAliases");
  // **値は、どのカードにも出ていない**
  expect(asked.join("\n"), "承認カードに秘密の値が出ている").not.toContain(SECRET);
  const askedCount = asked.length;

  // 3. 2回目は聞かれない（同じ Project 内で自動許可）
  await expect.poll(finishedTurns, { timeout: 120_000, message: "1ターン目が終わるまで" }).toBe(1);
  await composer.fill(PROMPT);
  await composer.press("Enter");
  // **待つのは「2回目の経路が通ったこと」**（規則14）。件数の合計で待つと、
  // 1ターン目だけで既に4件あるので**待たずに通り抜ける**——実際そうなった
  await expect
    .poll(
      () => mine().filter((e) => e.type === "relay.call_recorded" && e.payload.name === "resolveAlias").length,
      { timeout: 180_000, message: "2回目のターンで値が取られるまで" },
    )
    .toBeGreaterThanOrEqual(2);
  // 判断待ちのカードは1枚も増えない（同じ Project 内は自動許可）
  await expect(page.locator('[data-role="judgment-card"]')).toHaveCount(askedCount);
  const openJudgments = await (
    await page.request.get(`${CORE_BASE_URL}/api/inbox`, {
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    })
  ).json();
  expect(
    openJudgments.filter((i: { kind: string; source?: string }) => i.source === "relay"),
  ).toHaveLength(0);

  // 4. 記録（監査）——許可は1回、呼び出しは毎回、値は残っていない
  const events = mine();
  const grants = events.filter((e) => e.type === "relay.grant_created");
  // **許可は（呼び出し元・宛先・tool）ごとに1回**——2回目のターンでは増えない。
  // 窓口が横断する先の数は環境で変わる（`vault-infisical` が設定されていない
  // ホストもある）ので、**順序と件数ではなく、要る組み合わせが在ることを見る**
  const pairs = grants.map((g) => `${g.payload.callerModule}→${g.payload.targetModule}:${g.payload.name}`);
  expect(pairs).toContain("shell→vault-directory:lookupAlias");
  expect(pairs).toContain("shell→vault-local:resolveAlias");
  // 聞かなかったものに許可は生えない
  expect(pairs.join(","), "聞いていない呼び出しに許可が記録されている").not.toContain("listAliases");
  expect(new Set(pairs).size, "同じ組み合わせを2回聞いている").toBe(pairs.length);

  // **聞かなくても、通したことは記録に残る**（規則2——黙って通らない）
  const listCalls = events.filter(
    (e) => e.type === "relay.call_recorded" && e.payload.name === "listAliases",
  );
  expect(listCalls.length, "窓口の横断が1度も記録されていない").toBeGreaterThan(0);
  for (const c of listCalls) {
    // **聞かずに通したことは、成否によらず記録に残る**
    expect(c.payload.allowed).toBe(true);
    // 宛先で失敗したものは、その理由が記録に残る（未設定の金庫など）
    // ——「聞かなかった理由」を見たいのは、実際に通った呼び出しのほう
    if (c.payload.ok === false) continue;
    expect(c.payload.reason, "なぜ聞かずに通したかが記録に無い").toBe("値を返さない口");
  }
  const calls = events.filter((e) => e.type === "relay.call_recorded");
  // **2ターンとも、経路を全部通っていること**（件数の合計ではなく中身で見る
  // ——窓口が横断する先の数は環境で変わる）
  const named = (n: string) => calls.filter((c) => c.payload.name === n).length;
  expect(named("lookupAlias"), `在りかの問い合わせが2回記録されていない: ${JSON.stringify(calls.map((c) => c.payload.name))}`).toBeGreaterThanOrEqual(2);
  expect(named("resolveAlias"), "値の取得が2回記録されていない").toBeGreaterThanOrEqual(2);
  for (const call of calls) {
    expect(call.payload.allowed).toBe(true);
    // **宛先で失敗したものも記録に残る**（規則2——監査で見たいのはむしろそちら）。
    // 未設定の金庫（`vault-infisical`）は横断のたびに理由つきで断る
    if (call.payload.ok === false) {
      expect(String(call.payload.reason), "失敗したのに理由が残っていない").not.toBe("");
    }
    // **どの記録にも、値は載らない**
    expect(JSON.stringify(call.payload)).not.toContain(SECRET);
  }

  expect(pageErrors).toEqual([]);
});
