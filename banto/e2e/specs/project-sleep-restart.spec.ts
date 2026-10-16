// **眠っている Project：届いたもので起きる・留めた届けものでは起きない・banto を起こし直しても眠ったまま**
// （決定・2026-10-16、アーキ仕様 §2.2「スリープ」、Backlog #354）。
//
// 自前の host（`own-host.ts`）で流す——起こし直すため。1時間に起こす上限を 1 に縮める（`BANTO_TEST_DELIVERY_WAKES_PER_HOUR`）
// ——上限で留めた届けものを短い試験で作るため。数えるのは Thread ごと・起こし直すと数え直す。
//
// 見るもの（規則14——「200 が返った」で終わらせず、記録・コンテナ・Module・受信箱まで）：
//   1. 別の Project の AI が send_message で送ると、眠っている宛先が起きて（`sleep` が外れる）、届いたものでターンが走り、
//      走り終えて何も残っていなければ眠りに戻る（by auto、コンテナも止まる——§2.2「眠りに戻す」）
//   2. 人が Incus でコンテナを起こしても、banto を起こし直すと止まり、眠ったまま
//   3. 上限で留めた届けものでは起きない——記録には届いたまま残り、受信箱に「自動では AI を起こしませんでした」、コンテナは止まったまま
import { test, expect } from "../test-base.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeTurn } from "../helpers.js";
import { withOwnHost, type OwnHost } from "../own-host.js";

test.setTimeout(420_000);

interface HostProject {
  id: string;
  name: string;
  status: string;
  sleep?: { since: string; by: string };
}
interface HostThread {
  id: string;
  kind: string;
  title?: string;
  messages: Array<{ role: string; text: string; origin?: { from: string; title: string } }>;
  deliveries?: Array<{ title: string }>;
  lastTurn?: { outcome?: string; cause: string };
}

async function api<T>(host: OwnHost, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${host.apiUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}
const get = async <T>(host: OwnHost, path: string): Promise<T> => {
  const r = await api<T>(host, "GET", path);
  if (r.status !== 200) throw new Error(`${path} が ${r.status}`);
  return r.body;
};
const projectOf = async (host: OwnHost, id: string) => (await get<HostProject[]>(host, "/api/projects")).find((p) => p.id === id)!;

/** 人が送ったターンを最後まで流す（流れの中に error が無いことも見る） */
async function send(host: OwnHost, threadId: string, prompt: string): Promise<void> {
  const res = await fetch(`${host.apiUrl}/api/threads/${threadId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  const stream = await res.text();
  expect(res.status, stream.slice(0, 500)).toBe(200);
  expect(stream, "ターンが error で終わった").not.toContain('"type":"error"');
}

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

/** 記録に積まれた、その Project の起きた理由（`project.woke` の cause） */
function wokeCauses(host: OwnHost, projectId: string): string[] {
  return readFileSync(join(host.dataDir, "events.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { type: string; payload: { id?: string; cause?: string } })
    .filter((e) => e.type === "project.woke" && e.payload.id === projectId)
    .map((e) => e.payload.cause!);
}

/** **眠りに戻った**（by auto・コンテナが止まる） */
async function expectReturnedToSleep(host: OwnHost, projectId: string): Promise<void> {
  await expect.poll(async () => (await projectOf(host, projectId)).sleep?.by, { timeout: 60_000, message: "用が済んだのに眠りに戻らない" }).toBe("auto");
  await expect.poll(() => containerState(projectId), { timeout: 60_000, message: "眠りに戻ったのにコンテナが動いている" }).toBe("STOPPED");
}

/** 動いているもの（直前のターンの終わり）が片づくまで、眠らせるのを試し直す */
async function sleepWhenIdle(host: OwnHost, projectId: string): Promise<{ released: string[] }> {
  let last: { status: number; body: { released?: string[]; error?: string } } | undefined;
  await expect
    .poll(
      async () => {
        last = await api(host, "POST", `/api/projects/${projectId}/sleep`);
        return last.status === 200 ? "ok" : `${last.status} ${last.body.error ?? ""}`;
      },
      { timeout: 30_000, message: "眠らせられない" },
    )
    .toBe("ok");
  return { released: last!.body.released ?? [] };
}

test("send_message で眠っている Project が起きて届く・起こし直しても眠ったまま・上限で留めた届けものでは起きない", async () => {
  await withOwnHost(
    async (host) => {
      const create = async (name: string) => {
        const r = await api<{ id: string }>(host, "POST", "/api/projects", { name, root: mkdtempSync(join(tmpdir(), "banto-e2e-sleep-")) });
        expect(r.status).toBe(201);
        const t = await api<{ id: string }>(host, "POST", `/api/projects/${r.body.id}/threads`);
        expect(t.status).toBe(201);
        return { id: r.body.id, baseId: t.body.id };
      };
      const sender = await create("E2E Sleep Sender");
      const receiver = await create("E2E Sleep Receiver");
      // 送り元を「承認なしで受け取ってよい」に載せておく（承認のカードは thread-messages が見る）
      expect((await api(host, "PUT", `/api/projects/${receiver.id}/message-senders`, { senders: [sender.id] })).status).toBe(200);

      // ---- 1. 眠っている宛先に send_message → 起きて届き、ターンが走る -------------------------------------------
      expect((await sleepWhenIdle(host, receiver.id)).released).toEqual([]);
      expect((await projectOf(host, receiver.id)).sleep?.by).toBe("human");
      await send(
        host,
        sender.baseId,
        "あちらに頼んで。" +
          fakeTurn({
            tools: [
              {
                server: "banto-thread",
                name: "send_message",
                // 宛先の返事の中身は見ない（偽 Runner への指示の印は入れ子にできない）——走り終えたかと件数で見る
                args: { projectId: receiver.id, title: "一通目", text: "見てください" },
              },
            ],
            then: "頼みました。",
          }),
      );
      let fork!: HostThread;
      await expect
        .poll(
          async () => {
            const threads = await get<HostThread[]>(host, `/api/projects/${receiver.id}/threads`);
            const f = threads.find((t) => t.kind === "fork" && t.title === "一通目");
            if (!f) return "Fork が立っていない";
            fork = await get<HostThread>(host, `/api/threads/${f.id}`);
            return `${fork.lastTurn?.outcome ?? "まだ"}:${fork.messages.at(-1)?.role ?? ""}`;
          },
          { timeout: 90_000, message: "眠っていた宛先で届いたもののターンが走り終わるまで" },
        )
        .toBe("completed:assistant");
      expect(fork.lastTurn?.cause).toBe("delivery");
      expect(fork.messages[0]!.origin?.title).toBe("一通目");
      // 届いたもので起きた（記録に project.woke の cause delivery）。用が済んだので眠りに戻る（人の操作も残りも無い）
      expect(wokeCauses(host, receiver.id), "届いたもので起きていない").toEqual(["delivery"]);
      await expectReturnedToSleep(host, receiver.id);
      expect(moduleProcessesInContainer(receiver.id)).toBe(0);

      // ---- 2. 人が起こしたコンテナも、banto を起こし直すと止まる -------------------------------------------------
      const started = spawnSync("incus", ["start", `banto-${receiver.id}`], { encoding: "utf8", input: "" });
      expect(started.status, started.stderr).toBe(0);
      expect(containerState(receiver.id)).toBe("RUNNING");
      await host.stop("SIGTERM");
      await host.start();
      expect(containerState(receiver.id), "起こし直したのに眠っている Project のコンテナが動いている").toBe("STOPPED");
      expect((await projectOf(host, receiver.id)).sleep?.by, "起こし直したら起きた").toBe("auto");
      // 少し待っても勝手に起きない（届けものの再開・Module の起こし直しが起こさない）
      await new Promise((r) => setTimeout(r, 5_000));
      expect((await projectOf(host, receiver.id)).sleep).toBeTruthy();
      expect(containerState(receiver.id)).toBe("STOPPED");

      // ---- 3. 上限で留めた届けものでは起きない -----------------------------------------------------------------
      // 起こし直すと数え直すので、まず1回起こして上限に当てる（同じ Fork へ送る）
      const replies = async () => (await get<HostThread>(host, `/api/threads/${fork.id}`)).messages.filter((m) => m.role === "assistant").length;
      expect(await replies()).toBe(1);
      const toFork = (title: string) =>
        "もう一度。" +
        fakeTurn({
          tools: [
            {
              server: "banto-thread",
              name: "send_message",
              args: { projectId: receiver.id, threadId: fork.id, title, text: "見てください" },
            },
          ],
          then: "送りました。",
        });
      await send(host, sender.baseId, toFork("二通目"));
      await expect.poll(replies, { timeout: 90_000, message: "二通目で起きて走るまで" }).toBe(2);
      await expect.poll(async () => (await get<HostThread>(host, `/api/threads/${fork.id}`)).lastTurn?.outcome, { timeout: 30_000 }).toBe("completed");
      expect(wokeCauses(host, receiver.id), "二通目で起きていない").toEqual(["delivery", "delivery"]);
      await expectReturnedToSleep(host, receiver.id);

      await send(host, sender.baseId, toFork("三通目"));
      await expect
        .poll(
          async () =>
            (await get<Array<{ kind: string; title?: string; detail?: string; projectId?: string }>>(host, "/api/inbox")).find(
              (i) => i.kind === "notice" && i.projectId === receiver.id && i.title === "三通目",
            )?.detail ?? "",
          { timeout: 30_000, message: "留めた届けもののお知らせが受信箱に出ない" },
        )
        .toContain("自動では AI を起こしませんでした");
      await new Promise((r) => setTimeout(r, 3_000));
      const held = await get<HostThread>(host, `/api/threads/${fork.id}`);
      expect(held.deliveries?.map((d) => d.title), "留めた届けものが記録に残っていない").toEqual(["三通目"]);
      expect(held.messages.filter((m) => m.role === "assistant").length, "留めたのにターンが走った").toBe(2);
      expect((await projectOf(host, receiver.id)).sleep, "留めた届けもので起きた").toBeTruthy();
      expect(containerState(receiver.id), "留めた届けものでコンテナが起きた").toBe("STOPPED");
    },
    { env: { BANTO_TEST_DELIVERY_WAKES_PER_HOUR: "1" } },
  );
});
