// Project ごとの「AI への指示」（決定・2026-10-09、アーキ仕様 §2.3）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore } from "../project-thread/store.js";
import { GlobalMemoryStore } from "../global-memory/store.js";
import { InboxStore } from "../inbox/store.js";
import { PendingApprovalRegistry } from "../inbox/pending-approvals.js";
import type { runTurn } from "../runner/adapter.js";
import { runThreadTurn } from "./turn-runner.js";
import { PROJECT_INSTRUCTION_MAX_CHARS, projectInstructionOf, validateProjectInstruction } from "./project-instruction.js";

const HEADING = "# この Project 固有の指示";

test("指示は毎ターン引いて system prompt の末尾に入れる。空なら節を出さない", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-project-instruction-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const store = new ProjectThreadStore(dir, log);
    await store.load();
    const globalMemory = new GlobalMemoryStore(dir, log);
    await globalMemory.load();
    const inbox = new InboxStore(dir, log);
    await inbox.load();
    const project = await store.createProject("demo", dir);
    const threadId = (await store.createBaseThread(project.id)).id;

    const seen: Array<Parameters<typeof runTurn>[0]> = [];
    const fake = (async function* (opts: Parameters<typeof runTurn>[0]) {
      seen.push(opts);
      return { sessionId: `s-${seen.length}`, compactionCount: 0 } as never;
    }) as unknown as typeof runTurn;
    let instruction: string | undefined = "人へは日本語で書く。";
    const asked: string[] = [];
    const deps = {
      projectThread: store,
      globalMemory,
      inbox,
      pendingApprovals: new PendingApprovalRegistry(),
      runTurn: fake,
      projectInstruction: (projectId: string) => {
        asked.push(projectId);
        return instruction;
      },
    };

    for await (const _ of runThreadTurn(deps, { threadId, prompt: "やって", modules: [] })) void _;
    instruction = "英語で書く。";
    for await (const _ of runThreadTurn(deps, { threadId, prompt: "次", modules: [] })) void _;
    instruction = undefined;
    for await (const _ of runThreadTurn(deps, { threadId, prompt: "その次", modules: [] })) void _;

    assert.deepEqual(asked, [project.id, project.id, project.id], "毎ターン引く");
    const [first, second, third] = seen;
    assert.equal(first!.systemPrompt.at(-1), `${HEADING}\n\n人へは日本語で書く。`, "末尾に入る");
    assert.equal(second!.systemPrompt.at(-1), `${HEADING}\n\n英語で書く。`, "書き換えたら同じ Thread の次のターンから効く");
    assert.ok(!third!.systemPrompt.some((b) => b.includes(HEADING)), "無ければ節を出さない");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Project の層だけを読み、空白だけなら無しとみなす", () => {
  const values = new Map<string, string | number | boolean>([["p1|thread.instruction", "日本語で"], ["p2|thread.instruction", "  \n"]]);
  const config = { layerValue: (key: string, projectId?: string) => values.get(`${projectId}|${key}`) };
  assert.equal(projectInstructionOf(config, "p1"), "日本語で");
  assert.equal(projectInstructionOf(config, "p2"), undefined);
  assert.equal(projectInstructionOf(config, "p3"), undefined);
  assert.equal(projectInstructionOf(undefined, "p1"), undefined);
});

test("上限（8,000 字）までは通し、超えたら理由を返す。字はコードポイントで数える", () => {
  assert.equal(PROJECT_INSTRUCTION_MAX_CHARS, 8_000);
  assert.equal(validateProjectInstruction("あ".repeat(PROJECT_INSTRUCTION_MAX_CHARS)), undefined);
  assert.equal(validateProjectInstruction("𠮷".repeat(PROJECT_INSTRUCTION_MAX_CHARS)), undefined, "サロゲートペアを2字に数えない");
  assert.match(validateProjectInstruction("あ".repeat(PROJECT_INSTRUCTION_MAX_CHARS + 1)) ?? "", /8,000 字までです（8,001 字あります）/);
});
