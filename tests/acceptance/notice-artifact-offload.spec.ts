/**
 * task-0307: **知らせ（notice）の全文注入をやめ、大きいものは栞へ退避する**。
 *
 * 背景: 道具の戻り値には「大きいと栞（artifact）へ退避して本文には要約とポインタだけ
 * 載せる」皮がかかっている（`withArtifactOffload`）。ところが notice（`server.notify()`）
 * はこの皮を通らず、`routed.text` を長さを一切見ずにそのまま会話の記録へ積んでいた。
 * 知らせは以後のターンで毎回再送されるので、一度の大きい notice が延々と効き続ける。
 *
 * ここで固定するのは4つ:
 *   [a1] しきい値を超える notice は要約＋ポインタだけが記録（`role: notice`）に積まれ、
 *        全文は栞へ書かれて `artifact.read` で読める
 *   [a2] しきい値以下の notice はこれまでどおり全文が記録に積まれる
 *   [a3] 退避された場合でも broadcast（画面へ流れる notice イベント）には全文が入る
 *   [a4] 退避のしきい値・要約の書式・観測 id の採番が、道具の戻り値の退避
 *        （`withArtifactOffload`）と同じ仕組みを使っている（二重実装していない・
 *        同じディレクトリに書く道具の退避と ID が衝突しない）
 *
 * server は FakeSession（プロバイダを一切呼ばない）で組む。土台は
 * notice-wakes-folded-branch.spec.ts と同じ。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { BantoHarness, HarnessEvent } from "@banto/core";
import {
  BantoHostServer,
  BantoHostClient,
  BANTO_WS_PATH,
  ThreadRegistry,
  ArtifactStore,
  DEFAULT_ARTIFACT_THRESHOLD_CHARS,
  type Thread,
  type ServerEvent,
  type TranscriptEntry,
} from "@banto/host";
import { TRUNK, branchSpec } from "./threadSpecs.js";

/** テスト用セッション。プロバイダを呼ばず、渡された文字列だけ控える。 */
class FakeSession implements BantoHarness {
  readonly sessionId = "test-session";
  isStreaming = false;
  prompts: string[] = [];

  subscribe(_listener: (event: HarnessEvent) => void): () => void {
    return () => {};
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
  }

  async abort(): Promise<void> {}

  readonly backendId = "fake";
  contextWindow(): number | undefined {
    return undefined;
  }
  contextTokens(): number | undefined {
    return undefined;
  }
  messageCount(): number {
    return 0;
  }
  transcript(): string {
    return "";
  }
  async startChapter(): Promise<void> {}
}

let dir: string;
let previousDataDir: string | undefined;
let threads: ThreadRegistry;
let server: BantoHostServer | undefined;

/** そのスレッドに紐づいた FakeSession（スレッドごとに別物）。 */
function sessionOf(thread: Thread): FakeSession {
  return thread.harness as unknown as FakeSession;
}

/** 開いている枝を1本用意する（幹 → 枝）。畳まない——直接その枝へ配れる（T3）。 */
async function openBranch(title: string): Promise<{ trunk: Thread; branch: Thread }> {
  const trunk = await threads.open(TRUNK);
  const branch = await threads.open(branchSpec(title));
  return { trunk, branch };
}

async function startHost(): Promise<void> {
  server = await BantoHostServer.start({ threads, port: 0 });
}

/** その会話の栞置き場（bin.ts の threadFactory と同じ `artifacts/<threadId>` 規約）。 */
function artifactsOf(threadId: string): ArtifactStore {
  return new ArtifactStore(path.join(dir, "artifacts", threadId));
}

/** 指定の型のイベントが来るまで待つ（banto-host-server.spec.ts と同じ実装）。 */
function waitFor(
  events: ServerEvent[],
  type: ServerEvent["type"],
  timeoutMs = 2000,
  where: (e: ServerEvent) => boolean = () => true
): Promise<ServerEvent> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      const found = events.find((e) => e.type === type && where(e));
      if (found) {
        clearInterval(tick);
        resolve(found);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(tick);
        reject(
          new Error(`timed out waiting for "${type}"; got: ${events.map((e) => e.type).join(", ")}`)
        );
      }
    }, 10);
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "notice-artifact-offload-"));
  previousDataDir = process.env["BANTO_DATA_DIR"];
  process.env["BANTO_DATA_DIR"] = dir;
  threads = new ThreadRegistry(async () => ({
    harness: new FakeSession(),
    tools: [],
  }));
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (previousDataDir === undefined) delete process.env["BANTO_DATA_DIR"];
  else process.env["BANTO_DATA_DIR"] = previousDataDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("[task-0307] 知らせ（notice）の全文注入をやめ、大きいものは栞へ退避する", () => {
  it("[a1] しきい値を超える notice は要約＋ポインタだけが記録に積まれ、全文は artifact.read で読める", async () => {
    const { branch } = await openBranch("大きい知らせの退避");
    await startHost();

    const big = `# 職人の報告\n${"あ".repeat(DEFAULT_ARTIFACT_THRESHOLD_CHARS)}`;
    await server!.notify(big, { threadId: branch.id, source: "worker" });

    const recorded = branch.transcript.find(
      (e): e is Extract<TranscriptEntry, { role: "notice" }> => e.role === "notice" && e.source === "worker"
    );
    assert.ok(recorded, "notice が記録に無い");
    assert.notEqual(recorded!.text, big, "全文がそのまま記録に積まれている（退避されていない）");
    assert.ok(recorded!.text.length < 1000, `記録に積まれた本文が大きすぎる（${recorded!.text.length}字）`);
    assert.match(recorded!.text, /artifact\.read/, "読み戻す手立てが要る");
    assert.match(recorded!.text, /a-0001/, "栞のIDが要る");

    // 全文は失われていない——同じ会話の栞置き場から artifact.read で戻る
    const full = artifactsOf(branch.id).read("a-0001");
    assert.equal(full.text, big, "全文が1文字も変えずに残っていること");
  });

  it("[a2] しきい値以下の notice はこれまでどおり全文が記録に積まれる", async () => {
    const { branch } = await openBranch("小さい知らせ");
    await startHost();

    const small = "職人が質問を出しました：変換 UI はポップアップ表示か一覧切替か、どちらで進めますか";
    assert.ok(small.length <= DEFAULT_ARTIFACT_THRESHOLD_CHARS);
    await server!.notify(small, { threadId: branch.id, source: "worker" });

    const recorded = branch.transcript.find(
      (e): e is Extract<TranscriptEntry, { role: "notice" }> => e.role === "notice" && e.source === "worker"
    );
    assert.ok(recorded, "notice が記録に無い");
    assert.equal(recorded!.text, small, "しきい値以下の notice は退避せず全文のまま積むこと");

    // 番頭への prompt にも全文が渡る（配達そのものは変わっていない）
    assert.ok(sessionOf(branch).prompts[0]!.includes(small));
  });

  it("[a3] 退避された場合でも broadcast（画面）には全文が入っている", async () => {
    const { branch } = await openBranch("画面には全文");
    await startHost();

    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(
      `ws://localhost:${server!.port}${BANTO_WS_PATH}`,
      (e) => events.push(e)
    );

    const big = `# PO向け\n${"い".repeat(DEFAULT_ARTIFACT_THRESHOLD_CHARS * 2)}`;
    await server!.notify(big, { threadId: branch.id, source: "worker" });

    const notice = await waitFor(events, "notice", 2000, (e) => e.type === "notice" && e.threadId === branch.id);
    assert.ok(notice.type === "notice");
    assert.equal(notice.text, big, "画面へ流す本文は全文であること（PO が読めなくなってはいけない）");

    client.close();
  });

  it("[a4] しきい値・書式・採番は道具の戻り値の退避と同じ仕組み（IDが衝突しない）", async () => {
    const { branch } = await openBranch("道具の退避との整合");
    await startHost();

    // 道具の結果の退避（withArtifactOffload）が同じ会話で先に書いたのと同じ状況を再現する
    const toolStore = artifactsOf(branch.id);
    const toolRef = toolStore.write("道具の戻り値（先に退避された分）");
    assert.equal(toolRef.id, "a-0001");

    const big = `# 知らせ\n${"う".repeat(DEFAULT_ARTIFACT_THRESHOLD_CHARS + 1)}`;
    await server!.notify(big, { threadId: branch.id, source: "worker" });

    const recorded = branch.transcript.find(
      (e): e is Extract<TranscriptEntry, { role: "notice" }> => e.role === "notice" && e.source === "worker"
    );
    assert.ok(recorded);
    // 道具の退避と同じ書式（renderStub）を使っている
    assert.match(recorded!.text, /notice\(worker\)/);
    assert.match(recorded!.text, /全文・部分読み: artifact\.read/);
    assert.match(recorded!.text, /この出力は文脈に載せていない/);
    // 先に道具が使った a-0001 とは衝突せず、次の番号になる
    assert.match(recorded!.text, /a-0002/, "先に道具が書いた a-0001 と衝突している");

    // 衝突していない証拠: 道具側の内容がそのまま残っている
    assert.equal(toolStore.read("a-0001").text, "道具の戻り値（先に退避された分）");

    // しきい値ちょうどは退避しない（同じ DEFAULT_ARTIFACT_THRESHOLD_CHARS を使っている証拠）
    const { branch: branch2 } = await openBranch("ちょうどしきい値");
    const exact = "え".repeat(DEFAULT_ARTIFACT_THRESHOLD_CHARS);
    await server!.notify(exact, { threadId: branch2.id, source: "worker" });
    const recorded2 = branch2.transcript.find(
      (e): e is Extract<TranscriptEntry, { role: "notice" }> => e.role === "notice" && e.source === "worker"
    );
    assert.equal(recorded2!.text, exact, "しきい値ちょうどは退避しないこと（<= 判定）");
  });
});
