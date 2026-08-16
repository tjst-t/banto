/**
 * `kobo.task` に**知らせの宛先**を出す（task-0224）。
 *
 * いま、幹（番頭）からは「そのタスクの知らせが誰に届くか」がまったく見えない。機構が
 * 自動で配るので、幹からは宛先が分からない——結果、幹が「この基準も見てほしい」と
 * 一次受けの枝へ伝える道が無い。
 *
 * ここで固めるのは**見せ方だけ**。配達の経路（番頭ホストの `routeNotice` / `deliver`）は
 * 一切触っていない。「畳んだ枝へ知らせが来たら開き直して配る」（a5）は
 * `closed-thread-delivery.spec.ts` が引き続き固定する。
 *
 * 宛先の決まり方は番頭ホストの決まりをそのまま写している:
 *   - origin が**枝**なら、その枝へ（畳んであっても開き直して配られる）
 *   - origin が**幹**なら、鍵 `kobo:<projectTag>/<taskId>` の枝へ回る（`findBySubject`：
 *     開いている枝を優先し、無ければ畳んだ枝）。無ければ機構がその場で立てる
 *   - origin の会話が**引けない**なら、`deliver()` の catch が既定の宛先（幹）へ逃がす
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { Daemon } from "@banto/daemon";
import { createKoboTools } from "../../packages/banto-daemon/src/kobo-tools.js";

const PROJ = "proj";

/** 索引の1件。番頭ホストの `StoredThread` のうち、宛先を決めるのに要るものだけ。 */
interface Row {
  id: string;
  title: string;
  kind?: "trunk" | "branch";
  isMain?: boolean;
  parentId?: string;
  subjectKey?: string;
  state?: "open" | "closed";
}

let tmpDir: string;
let threadsDir: string;
let daemon: Daemon;
let tools: ReturnType<typeof createKoboTools>;
let seq = 0;

/** `kobo.task` を叩いて、本文と details を返す。 */
async function koboTask(taskId: string): Promise<{ text: string; details: Record<string, unknown> }> {
  const t = tools.find((x) => x.name === "kobo.task");
  if (!t) throw new Error("no tool: kobo.task");
  const r = await t.execute({ projectTag: PROJ, taskId } as never, { toolCallId: "t" });
  const first = r.content?.[0];
  return {
    text: first && first.type === "text" ? first.text : "",
    details: (r.details ?? {}) as Record<string, unknown>,
  };
}

/** 宛先の行だけ抜く（本文の他の行に引きずられない）。 */
function destinationLine(text: string): string {
  const line = text.split("\n").find((l) => l.startsWith("知らせの宛先:"));
  assert.ok(line !== undefined, `本文に「知らせの宛先:」の行が無い:\n${text}`);
  return line;
}

/** origin 付きでタスクを1本積む。origin を渡さなければ「記録されていない」形になる。 */
async function enqueue(origin?: string): Promise<string> {
  const t = tools.find((x) => x.name === "kobo.enqueue");
  if (!t) throw new Error("no tool: kobo.enqueue");
  seq += 1;
  const r = await t.execute(
    {
      projectTag: PROJ,
      title: `宛先を見たい仕事 ${seq}`,
      kind: "fix",
      body: "## 背景\n\n知らせの宛先が見えるかを確かめる。",
      scope: { paths: ["src/**"] },
      acceptance: [{ text: "宛先が読める" }],
      originRef: "task-0224 の試験",
      ...(origin ? { origin } : {}),
    } as never,
    { toolCallId: "t" }
  );
  const id = (r.details as { taskId?: string } | undefined)?.taskId;
  assert.ok(typeof id === "string" && id.length > 0, `積めなかった: ${JSON.stringify(r.details)}`);
  return id;
}

/** 会話の索引を置き直す。**番頭ホストが書くファイルの写し**（Kobo は読むだけ）。 */
function writeIndex(threads: Row[]): void {
  fs.mkdirSync(threadsDir, { recursive: true });
  fs.writeFileSync(
    path.join(threadsDir, "index.json"),
    JSON.stringify({ version: 1, counter: threads.length, threads }),
    "utf-8"
  );
}

/** 索引そのものを消す（番頭ホストがまだ一度も書いていない・置き場が違う）。 */
function removeIndex(): void {
  fs.rmSync(path.join(threadsDir, "index.json"), { force: true });
}

const TRUNK: Row = { id: "thread-1", title: "banto開発", kind: "trunk", isMain: true, state: "open" };

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-notice-dest-"));
  threadsDir = path.join(tmpDir, "threads");
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(repoDir, { recursive: true });
  const git = (args: string[]): void => {
    execFileSync("git", args, { cwd: repoDir, stdio: "ignore" });
  };
  git(["init", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(repoDir, "README.md"), "x\n");
  git(["add", "."]);
  git(["commit", "-m", "init"]);

  daemon = Daemon.create({
    port: 0,
    dataDir: path.join(tmpDir, "data"),
    // **索引の在り処は明示で渡す**（task-0224）。実機では番頭ホストの BANTO_DATA_DIR と
    // Kobo の BANTO_DATA_DIR が別の場所を指しており、自分の dataDir からは導けない
    threadsDir,
    tickIntervalMs: 99999,
    disableAutoSpawn: true,
    disableAuditSpawn: true,
    worktreeBaseDir: path.join(tmpDir, "worktrees"),
    // 稼働中のサービスに触らせない（直に node --test で走らせたときの事故防止）
    workerPoolUrl: "http://127.0.0.1:1/api/worker-pool",
    environmentPoolUrl: "http://127.0.0.1:1/api/environment-pool",
  });
  await daemon.start();
  daemon.registerProject(PROJ, repoDir);
  tools = createKoboTools(daemon);
});

after(async () => {
  await daemon.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  writeIndex([TRUNK]);
});

describe("[task-0224] a1: 知らせが届く会話の id と名前が出る", () => {
  it("origin が開いている枝なら、その枝の id と名前が出る", async () => {
    writeIndex([
      TRUNK,
      { id: "thread-156", title: "大掃除して5本に絞る", kind: "branch", parentId: "thread-1", state: "open" },
    ]);
    const id = await enqueue("banto:thread-156");

    const { text, details } = await koboTask(id);
    assert.equal(destinationLine(text), "知らせの宛先: thread-156「大掃除して5本に絞る」");
    assert.deepEqual(details["noticeDestination"], {
      via: "branch",
      threadId: "thread-156",
      title: "大掃除して5本に絞る",
      state: "open",
    });
  });

  it("origin が幹なら、同じ鍵の用件の枝へ回ることが読める", async () => {
    const id = await enqueue("banto:thread-1");
    // 幹が origin。知らせは鍵 kobo:<projectTag>/<taskId> の枝へ回る（T3）
    writeIndex([
      TRUNK,
      {
        id: "thread-200",
        title: `工場の知らせ: ${PROJ}/${id}`,
        kind: "branch",
        parentId: "thread-1",
        subjectKey: `kobo:${PROJ}/${id}`,
        state: "open",
      },
    ]);

    const { text, details } = await koboTask(id);
    assert.equal(destinationLine(text), `知らせの宛先: thread-200「工場の知らせ: ${PROJ}/${id}」`);
    const dest = details["noticeDestination"] as Record<string, unknown>;
    assert.equal(dest["via"], "trunk-subject");
    assert.equal(dest["threadId"], "thread-200");
    assert.deepEqual(dest["trunk"], { id: "thread-1", title: "banto開発" });
  });

  it("幹が origin で用件の枝がまだ無いなら、幹の id と名前＋これから立つ枝の鍵が出る", async () => {
    const id = await enqueue("banto:thread-1");

    const { text, details } = await koboTask(id);
    assert.equal(
      destinationLine(text),
      `知らせの宛先: 幹 thread-1「banto開発」（知らせが来たら用件の枝 kobo:${PROJ}/${id} が立つ。まだ無い）`
    );
    const dest = details["noticeDestination"] as Record<string, unknown>;
    assert.equal(dest["via"], "trunk-pending");
    assert.equal(dest["subjectKey"], `kobo:${PROJ}/${id}`);
  });

  it("同じ鍵の枝が開き／畳みの両方あるなら、開いている方が宛先（findBySubject と同じ）", async () => {
    const id = await enqueue("banto:thread-1");
    const key = `kobo:${PROJ}/${id}`;
    writeIndex([
      TRUNK,
      { id: "thread-300", title: "古い方", kind: "branch", parentId: "thread-1", subjectKey: key, state: "closed" },
      { id: "thread-301", title: "いま開いている方", kind: "branch", parentId: "thread-1", subjectKey: key, state: "open" },
    ]);

    const { text } = await koboTask(id);
    assert.equal(destinationLine(text), "知らせの宛先: thread-301「いま開いている方」");
  });
});

describe("[task-0224] a2: 畳んである宛先は「畳んである」と読める", () => {
  it("origin が畳んだ枝なら、開き直して配られる旨が付く", async () => {
    writeIndex([
      TRUNK,
      {
        id: "thread-156",
        title: "大掃除して5本に絞る",
        kind: "branch",
        parentId: "thread-1",
        state: "closed",
      },
    ]);
    const id = await enqueue("banto:thread-156");

    const { text, details } = await koboTask(id);
    assert.equal(
      destinationLine(text),
      "知らせの宛先: thread-156「大掃除して5本に絞る」（畳んである・知らせが来たら開き直る）"
    );
    assert.equal((details["noticeDestination"] as Record<string, unknown>)["state"], "closed");
  });

  it("用件の枝が畳んだ1本だけなら、それが宛先で「畳んである」と出る", async () => {
    const id = await enqueue("banto:thread-1");
    writeIndex([
      TRUNK,
      {
        id: "thread-300",
        title: "前に立てた用件の枝",
        kind: "branch",
        parentId: "thread-1",
        subjectKey: `kobo:${PROJ}/${id}`,
        state: "closed",
      },
    ]);

    const { text } = await koboTask(id);
    assert.equal(
      destinationLine(text),
      "知らせの宛先: thread-300「前に立てた用件の枝」（畳んである・知らせが来たら開き直る）"
    );
  });
});

describe("[task-0224] a3: 宛先が記録されていないタスクは「不明」（空欄にしない）", () => {
  it("origin の無いタスクは「不明」と書かれる", async () => {
    const id = await enqueue();

    const { text, details } = await koboTask(id);
    assert.equal(destinationLine(text), "知らせの宛先: 不明（この会話は記録されていません）");
    assert.deepEqual(details["noticeDestination"], { via: "unknown-origin" });
  });

  it("宛先の行そのものが消えない（空欄で握り潰さない）", async () => {
    const id = await enqueue();
    const { text } = await koboTask(id);
    assert.ok(
      text.includes("知らせの宛先:"),
      `宛先の行ごと落ちている。空欄にせず「不明」と書くこと:\n${text}`
    );
  });
});

describe("[task-0224] a4: 宛先が辿れないときは幹へ配られ、その旨が出る", () => {
  it("origin の会話が索引に無いなら、幹の名前と「元の枝が見つからない」が出る", async () => {
    const id = await enqueue("banto:thread-消えた");

    const { text, details } = await koboTask(id);
    assert.equal(destinationLine(text), "知らせの宛先: 幹 thread-1「banto開発」（元の枝が見つからないため）");
    const dest = details["noticeDestination"] as Record<string, unknown>;
    assert.equal(dest["via"], "fallback-trunk");
    assert.equal(dest["threadId"], "thread-1");
  });

  it("origin が banto:<threadId> の形でなくても、幹へ逃がすと読める", async () => {
    const id = await enqueue("po:手で置いた");

    const { text } = await koboTask(id);
    assert.equal(destinationLine(text), "知らせの宛先: 幹 thread-1「banto開発」（元の枝が見つからないため）");
  });

  it("幹が isMain で無くても、幹があればそこへ逃がす（古い索引に isMain は無い）", async () => {
    writeIndex([{ id: "thread-9", title: "唯一の幹", state: "open" }]);
    const id = await enqueue("banto:thread-消えた");

    const { text } = await koboTask(id);
    assert.equal(destinationLine(text), "知らせの宛先: 幹 thread-9「唯一の幹」（元の枝が見つからないため）");
  });
});

describe("[task-0224] 索引が読めなくても kobo.task は落ちない（I2: 「不明」で誤魔化さない）", () => {
  it("索引が無いなら、読めなかった旨が出る（推測で「幹へ行く」と言い切らない）", async () => {
    const id = await enqueue("banto:thread-1");
    removeIndex();

    const { text, details } = await koboTask(id);
    const line = destinationLine(text);
    assert.match(line, /^知らせの宛先: 不明（会話の索引を読めません: .+）$/);
    assert.match(line, /がありません/);
    // 読めていないのだから、幹かどうかも分かっていない
    assert.ok(!line.includes("幹"), `読めていないのに宛先を断定している: ${line}`);
    assert.equal((details["noticeDestination"] as Record<string, unknown>)["via"], "index-unreadable");
  });

  it("索引が壊れていても落ちず、壊れている旨が出る", async () => {
    const id = await enqueue("banto:thread-1");
    fs.mkdirSync(threadsDir, { recursive: true });
    fs.writeFileSync(path.join(threadsDir, "index.json"), "{ これは JSON ではない", "utf-8");

    const { text } = await koboTask(id);
    assert.match(destinationLine(text), /^知らせの宛先: 不明（会話の索引を読めません: .+壊れています.+）$/);
  });

  it("索引に会話の一覧が無くても落ちない", async () => {
    const id = await enqueue("banto:thread-1");
    fs.mkdirSync(threadsDir, { recursive: true });
    fs.writeFileSync(path.join(threadsDir, "index.json"), JSON.stringify({ version: 1 }), "utf-8");

    const { text } = await koboTask(id);
    assert.match(destinationLine(text), /会話の一覧がありません/);
  });

  it("索引を読むだけで、Kobo が会話を作ったり書き換えたりしない", async () => {
    const id = await enqueue("banto:thread-1");
    const file = path.join(threadsDir, "index.json");
    const before_ = fs.readFileSync(file, "utf-8");

    await koboTask(id);

    assert.equal(fs.readFileSync(file, "utf-8"), before_, "Kobo が会話の索引を書き換えている");
  });

  it("索引が無くても作らない（番頭ホストの持ち物）", async () => {
    const id = await enqueue("banto:thread-1");
    removeIndex();

    await koboTask(id);

    assert.equal(
      fs.existsSync(path.join(threadsDir, "index.json")),
      false,
      "Kobo が会話の索引を作っている（番頭ホストの持ち物を横から書いてはいけない）"
    );
  });
});
