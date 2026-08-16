/**
 * task-0157: `review: banto` を名乗って来たことが、道具の説明文と札から読めること。
 *
 * **挙動の試験ではない**——`resolveReviewStage` も `autoLandBlockers` も触っていない。
 * ここで押さえるのは、機構がそう動いていることを**読んだ側が誤読しない**こと：
 * `kobo.approve` の説明文は「ここへ来ているのは自動着地の条件を満たさなかったものだけ」と
 * 言い切っていて、`banto` を名乗ったタスクが条件を満たしていても来ることを落としていた。
 * その誤読で「`review: banto` を指定しても番頭を通らずに通る」という報告が PO まで上がった。
 *
 * 組み立ては `kobo-enqueue-review.spec.ts` に倣う（工場は本物・番頭ホスト側はモジュールの写し）。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";
import { createKoboModule } from "../../packages/banto-daemon/src/kobo-module.js";
import { KOBO_MODULE_PATH } from "../../packages/banto-daemon/src/http-server.js";
import { startKoboNotices } from "../../packages/banto-host/src/kobo-notice.js";
import { threadOrigin } from "../../packages/banto-host/src/worker-notice.js";
import type { NamespacedToolDefinition } from "../../packages/banto-host/src/tool-registry.js";

const THREAD = "thread-po-1";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      const { port } = address;
      s.close(() => resolve(port));
    });
  });
}

async function until(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("待っていた状態にならなかった");
}

function git(args: string[], cwd: string): void {
  const r = childProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

interface Harness {
  daemon: Daemon;
  tools: NamespacedToolDefinition[];
  tmpDir: string;
  proj: string;
  enqueue(args?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** 証拠（検査コマンド）の揃った受け入れ条件——**自動着地の条件は満たしている**形。 */
const WITH_VERIFY = [{ text: "動くこと", verify: "true" }];

const TASK_INPUT = {
  title: "番頭が一次受けする仕事",
  kind: "feature",
  body: "この依頼の本文。",
  scope: { paths: ["src/**"] },
  acceptance: WITH_VERIFY,
  originRef: "試験",
};

async function harness(): Promise<Harness> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-wording-"));
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(path.join(repoDir, "work", "tasks"), { recursive: true });
  git(["init", "-b", "main"], repoDir);
  git(["config", "user.email", "t@example.com"], repoDir);
  git(["config", "user.name", "t"], repoDir);
  fs.writeFileSync(path.join(repoDir, "README.md"), "x\n");
  git(["add", "."], repoDir);
  git(["commit", "-m", "init"], repoDir);

  const port = await freePort();
  const daemon = Daemon.create({
    port,
    dataDir: path.join(tmpDir, "data"),
    tickIntervalMs: 200,
    disableAutoSpawn: true,
    disableAuditSpawn: true,
  });
  await daemon.start();
  const proj = "kobo-proj";
  daemon.registerProject(proj, repoDir);

  const module = createKoboModule(`http://127.0.0.1:${port}${KOBO_MODULE_PATH}`);
  const tools = module.tools as unknown as NamespacedToolDefinition[];

  return {
    daemon,
    tools,
    tmpDir,
    proj,
    async enqueue(args = {}) {
      const tool = tools.find((t) => t.name === "kobo.enqueue");
      if (!tool) throw new Error("no tool: kobo.enqueue");
      const result = await tool.execute(
        { projectTag: proj, ...TASK_INPUT, ...args } as never,
        { toolCallId: "t" }
      );
      return (result.details ?? {}) as Record<string, unknown>;
    },
  };
}

async function teardown(h: Harness): Promise<void> {
  await h.daemon.stop();
  fs.rmSync(h.tmpDir, { recursive: true, force: true });
}

// ── 道具の説明文（a1）──────────────────────────────────────────────────────

describe("[task-0157] kobo.approve の説明文", () => {
  it("`banto` を名乗った場合もここへ来ることが書いてあり、古い言い切りが残っていない", async () => {
    const h = await harness();
    try {
      const approve = h.tools.find((t) => t.name === "kobo.approve");
      assert.ok(approve, "kobo.approve が在ること");
      const description = approve.description ?? "";

      assert.match(
        description,
        /`banto`/,
        "`banto` を名乗る場合に触れていること（触れないと「banto は自動着地する側だ」と読まれる）"
      );
      assert.match(
        description,
        /`banto`[\s\S]{0,200}名乗/,
        "`banto` が「名乗っている」側の列挙に入っていること"
      );
      assert.match(
        description,
        /`manual`[\s\S]{0,40}旧称|旧称[\s\S]{0,40}`manual`/,
        "`manual` が `banto` の旧称（読み替えられる）ことが書いてあること"
      );

      /**
       * 古い言い切り。`banto` を挙げず `manual` と `po` だけを並べた形が残っていたら、
       * 読んだ側は「`banto` は自動着地する側だ」と受け取る（実際にそう報告された）。
       */
      assert.doesNotMatch(
        description,
        /`manual` や `po` を名乗っている/,
        "`banto` を挙げずに `manual` と `po` だけを並べた古い列挙が残っていないこと"
      );
      assert.doesNotMatch(
        description,
        /ここへ来ているのは条件を満たさなかったものだけ/,
        "「条件を満たさなかったものだけ」という言い切りが残っていないこと（`banto` は満たしていても来る）"
      );
    } finally {
      await teardown(h);
    }
  });
});

// ── 札（a2）────────────────────────────────────────────────────────────────

describe("[task-0157] review: banto は条件を満たしていても番頭で止まる", () => {
  it("刻みも検査コマンドも揃っていても review-ready で止まり、札に理由が載る", async () => {
    const h = await harness();
    const delivered: string[] = [];
    let stop: (() => void) | undefined;
    try {
      const id = String(
        (
          await h.enqueue({
            origin: threadOrigin(THREAD),
            review: { policy: "banto" },
            acceptance: WITH_VERIFY,
          })
        )["taskId"]
      );

      stop = startKoboNotices({
        tools: h.tools,
        notify: async (message) => {
          delivered.push(message);
        },
        cursorPath: path.join(h.tmpDir, "kobo-cursor.json"),
        intervalMs: 100,
        log: () => undefined,
      });

      await until(() => h.daemon.getTask(h.proj, id)?.status === "ready");
      for (const to of ["planning", "implementing", "auditing"]) {
        h.daemon.transition(h.proj, id, to, "test");
      }
      h.daemon.handleAuditVerdict(h.proj, id, "pass", []);

      // **merging へ行かない**。宣言がそのまま段になるので自動着地の条件は見られない
      assert.equal(
        h.daemon.getTask(h.proj, id)?.status,
        "review-ready",
        "review: banto は監査 pass の後 review-ready で止まること"
      );
      const events = h.daemon.getTaskEvents(h.proj, id) as ReadonlyArray<
        { type: string; to?: string; reason?: string }
      >;
      const reasons = events
        .filter((e) => e.type === "state_transitioned")
        .map((e) => `${e.to ?? ""}:${e.reason ?? ""}`);
      assert.ok(
        reasons.some((r) => r.startsWith("review-ready:audit_passed:banto")),
        `帳簿に audit_passed:banto が刻まれること（実際: ${reasons.join(" / ")}）`
      );
      assert.ok(
        !reasons.some((r) => r.startsWith("merging:")),
        `merging へは進まないこと（実際: ${reasons.join(" / ")}）`
      );
      assert.ok(
        !reasons.some((r) => r.includes("自動着地の条件を満たさない")),
        "落ちて来たのではなく、そう名乗って来たこと（条件は満たしている）"
      );

      await until(() => delivered.some((m) => /レビュー待ち/.test(m)));
      const notice = delivered.find((m) => /レビュー待ち/.test(m))!;
      assert.match(
        notice,
        /なぜあなたに来たか/,
        "「なぜあなたに来たか」が載ること（無いと毎回 kobo.task で調べ直すことになる）"
      );
      assert.match(
        notice,
        /なぜあなたに来たか[\s\S]{0,200}review: banto/,
        "その理由が `review: banto` を名乗っていることだと書いてあること"
      );
    } finally {
      stop?.();
      await teardown(h);
    }
  });
});
