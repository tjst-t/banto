// **待たれている出どころを眠らせない**（アーキ仕様 §4.3「段2」、Backlog #346）。
//
// その Project に、ある Module の出来事を待つ自動化（一時停止していないもの）がある間は、core がその Module を起こしておく。
// 試験用の同梱扱いの Module（`e2e-events`、`fixtures/events-module`）で見ること——Module が起きているかは、起こさずに読める
// `GET /api/projects/:id/modules` の `connected` で見る（tool を呼ぶと、呼んだことで起きてしまう）：
//   1. 自動化が無い間は起きていない。出来事の自動化を作ると起きる
//   2. banto を起こし直しても、誰も Module を使わないまま起きる——止まっていた間に出口の箱に書いた出来事が届き、自動化が動く
//   3. Project を閉じると止まり、開き直すと起きる
//   4. 自動化を一時停止して起こし直すと、起こしておかない。再開すると起きる
//   5. 自動化を消して起こし直すと、起こしておかない
// 4・5 の「起きていない」は、同じ起こし直しで別の Project（待つ自動化がある）の Module が起きたのを見てから確かめる
// ——同じ見直しで起こすので、それが起きたなら待たれていない側も起こすならもう起きている
import { test, expect } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeTurn } from "../helpers.js";
import { withOwnHost } from "../own-host.js";

test.setTimeout(420_000);

const MODULE = "e2e-events";
const EVENT = `${MODULE}.happened`;

type Automation = { id: string; name: string; paused: boolean; runs: Array<{ cause: string; result: string; received?: number }> };

test("出来事を待つ自動化があると Module が起き、起こし直しても・開き直しても起きる。一時停止・消すと起こしておかない", async () => {
  await withOwnHost(async (host) => {
    const headers = { authorization: `Bearer ${host.token}`, "content-type": "application/json" };
    const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
      const res = await fetch(`${host.apiUrl}${path}`, {
        method: init.method ?? "GET",
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
    };
    const ok = async (path: string, init: { method?: string; body?: unknown } = {}) => {
      const res = await call(path, init);
      expect(res.status, `${init.method ?? "GET"} ${path}：${JSON.stringify(res.body)}`).toBeLessThan(300);
      return res.body;
    };

    expect((await call(`/api/modules/catalog/${MODULE}`, { method: "POST", body: { name: MODULE } })).status).toBeLessThan(300);
    const makeProject = async (name: string) => {
      const created = await ok("/api/projects", { method: "POST", body: { name, root: mkdtempSync(join(tmpdir(), "banto-e2e-keep-awake-")) } });
      const projectId = created.id as string;
      // API で作った Project には Base の会話がまだ無い——作る（専用の Fork はそこから分ける）
      await ok(`/api/projects/${projectId}/threads`, { method: "POST" });
      return projectId;
    };
    /** 起こさずに、その Project の e2e-events が起きているか */
    const awake = async (projectId: string) => {
      const modules = (await call(`/api/projects/${projectId}/modules`)).body as unknown as Array<{ name: string; connected: boolean }>;
      const found = modules.find((m) => m.name === MODULE);
      if (!found) throw new Error(`${MODULE} がこの Project の Module にありません：${JSON.stringify(modules)}`);
      return found.connected;
    };
    const automations = async (projectId: string) =>
      ((await ok(`/api/projects/${projectId}/automations`)) as { automations: Automation[] }).automations;
    const createAutomation = async (projectId: string, name: string) => {
      const body = await ok(`/api/projects/${projectId}/automations`, {
        method: "POST",
        body: { name, instruction: "起きた出来事を読んで。" + fakeTurn({ sayContext: true }), source: { kind: "event", event: EVENT, batchSeconds: 0 } },
      });
      return body.id as string;
    };
    const tool = async <T>(projectId: string, name: string, args: Record<string, unknown> = {}): Promise<T> => {
      const res = await ok(`/api/projects/${projectId}/ui-tool-call`, { method: "POST", body: { server: MODULE, tool: name, arguments: args } });
      const content = (res as { content?: Array<{ text: string }>; isError?: boolean }).content ?? [];
      if ((res as { isError?: boolean }).isError) throw new Error(`${name} が失敗：${content[0]?.text}`);
      return JSON.parse(content[0]!.text) as T;
    };
    const restart = async () => {
      await host.stop("SIGTERM");
      await host.start();
    };

    const project = await makeProject("E2E 待たれている Module");
    // 見比べ役：いつも待たれている Project（4・5 で「見直しが済んだ」の印に使う）
    const witness = await makeProject("E2E 待たれている Module（見比べ）");

    // ---- 1. 自動化が無い間は起きていない。作ると起きる -----------------------------------------------------------
    expect(await awake(project), "自動化が無いのに起きている").toBe(false);
    expect(await awake(witness), "自動化が無いのに起きている").toBe(false);
    const automationId = await createAutomation(project, "出来事を待つ");
    await createAutomation(witness, "見比べ役");
    await expect.poll(() => awake(project), { timeout: 120_000, message: "自動化を作っても Module が起きない" }).toBe(true);
    await expect.poll(() => awake(witness), { timeout: 120_000, message: "見比べ役の Module が起きない" }).toBe(true);

    // ---- 2. 起こし直しても、使われないまま起き、止まっていた間の出来事が届く ------------------------------------------
    // 箱に書くだけ（host に出さない）——起こし直したあと Module が自分で起きて繋がらなければ届かない
    expect((await tool<{ queued?: true }>(project, "emitForTest", { item: "a", level: "high", eventId: "night-1", queueOnly: true })).queued).toBe(true);
    await restart();
    await expect.poll(() => awake(project), { timeout: 120_000, message: "起こし直したあと Module が起きない" }).toBe(true);
    await expect
      .poll(async () => (await automations(project)).find((a) => a.id === automationId)!.runs.map((r) => `${r.cause}:${r.result}:${r.received ?? 0}`), {
        timeout: 120_000,
        message: "起こし直したあと、止まっていた間の出来事で動かない",
      })
      .toEqual(["event:done:1"]);

    // ---- 3. 閉じると止まり、開き直すと起きる -----------------------------------------------------------------
    await ok(`/api/projects/${project}/close`, { method: "POST" });
    expect(await awake(project), "閉じたのに起きている").toBe(false);
    await ok(`/api/projects/${project}/reopen`, { method: "POST" });
    await expect.poll(() => awake(project), { timeout: 120_000, message: "開き直しても Module が起きない" }).toBe(true);

    // ---- 4. 一時停止して起こし直すと、起こしておかない。再開すると起きる ---------------------------------------------
    expect((await ok(`/api/projects/${project}/automations/${automationId}`, { method: "PATCH", body: { paused: true } })).paused).toBe(true);
    await restart();
    await expect.poll(() => awake(witness), { timeout: 120_000, message: "起こし直したあと見比べ役の Module が起きない" }).toBe(true);
    expect(await awake(project), "一時停止した自動化しか無いのに起きている").toBe(false);
    await ok(`/api/projects/${project}/automations/${automationId}`, { method: "PATCH", body: { paused: false } });
    await expect.poll(() => awake(project), { timeout: 120_000, message: "再開しても Module が起きない" }).toBe(true);

    // ---- 5. 消して起こし直すと、起こしておかない ------------------------------------------------------------------
    await ok(`/api/projects/${project}/automations/${automationId}`, { method: "DELETE" });
    expect(await automations(project)).toEqual([]);
    await restart();
    await expect.poll(() => awake(witness), { timeout: 120_000, message: "起こし直したあと見比べ役の Module が起きない" }).toBe(true);
    expect(await awake(project), "待つ自動化が無いのに起きている").toBe(false);
  });
});
