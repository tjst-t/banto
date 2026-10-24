// **進める自動化が Factory に流す・止まった件に答える**（決定・2026-10-24、ユーザー。アーキ仕様 §4.3「判断役の一般化」の 3.・4.）。
//
// 番頭の `supervisor/factory.ts` の照らし合わせを、`canAdvanceProject` を軸に一般化したもの。新しい tool は作らない——同梱の Factory の
// `runFactory`・`answerFactory` を、AI の代理（`agent-proxy.ts`）が Module へ渡す手前でここに照らす（`advanceGate`）。
//
// - **効くのは、`canAdvanceProject` を持つ自動化の専用の Fork のターンから呼んだときだけ**。ほかの会話（人の会話・ふつうの自動化）の
//   呼び出しは照らさずにそのまま通す——今までの挙動を変えない。番頭の回は番頭の実装が照らす（並存）
// - `runFactory`：Factory は main へ取り込むので、任された行い（`delegateKinds`、無ければ Project の方針）に `merge` があるときだけ。
//   **全体の上限**（`automation.advance.limits.factoryConcurrent`、全部の進める自動化の合計）を、進める自動化の記録の `factory-started` に
//   ある実行の今の様子から数え、流す件数で超えるなら全部断る
// - `answerFactory`：その Project の進める自動化が流した実行（記録に `factory-started` がある）にだけ。`continue`・`retry` は `fix-tests`、
//   `accept` は `minor-design` を任されているとき（`delegateKinds` と同じ判断）。`drop` はいつも断る（人）。`instruction` は付けられない。
//   同じ件の同じ段には 2 回まで
// - 通ったものは記録に `factory-started`・`factory-answered`、断ったものは `refused` を残す

import type { ProjectThreadStore } from "../project-thread/store.js";
import type { SupervisorGateDecision, SupervisorGateInput } from "../relay/agent-proxy.js";
import { ADVANCE_FACTORY_TOOLS } from "../relay/read-only.js";
import { ACTION_TITLES, type SupervisorAction } from "../supervisor/policy.js";
import type { AdvanceAct } from "./fold.js";
import type { AutomationStore } from "./store.js";
import { advanceActsOf, advanceTurnOf, type AdvancePolicy, type AdvanceTurn } from "./advance.js";

/** 同じ件の同じ段に答えてよい回数（動かなければ人に回す） */
export const ADVANCE_FACTORY_ANSWERS_PER_STAGE = 2;

/** answerFactory の action と、任されていなければならない行い（drop は人） */
const ANSWER_NEEDS: Readonly<Record<string, SupervisorAction>> = {
  continue: "fix-tests",
  retry: "fix-tests",
  accept: "minor-design",
};

/** 数えから外れる状態（止まって答えを待つ・取り込んだ・やめた） */
const NOT_RUNNING = new Set(["stopped", "done", "dropped"]);

/** Factory の `listFactoryRuns` の1件のうち、ここで使うところ */
export interface AdvanceFactoryRunView {
  runId: string;
  items: Array<{ item: string; number?: number | null; status: string; stage?: string; stopped?: { stage: string; reason?: string } }>;
}

export interface AdvanceFactoryDeps {
  projectThread: Pick<ProjectThreadStore, "getThread">;
  automations: Pick<AutomationStore, "get" | "list" | "listAll" | "recordAdvanceAct">;
  /** その Project の方針（回のたびに引く） */
  policy(projectId: string): AdvancePolicy;
  /** その Project の Factory の実行の今の様子（同梱の Factory の `listFactoryRuns`）。Factory の無い Project は undefined。聞けなければ投げる */
  factoryRuns(projectId: string): Promise<AdvanceFactoryRunView[] | undefined>;
  now?: () => Date;
  log?: (message: string) => void;
}

export class AdvanceFactory {
  /** 照らし合わせを通って Module へ渡している途中の `runFactory` の件数（記録を書くまでの仮押さえ） */
  private reserved = 0;
  /** 数える〜仮押さえるを1本ずつにする（2つの自動化が同時に流して上限を越えないように） */
  private lock: Promise<void> = Promise.resolve();

  constructor(private readonly deps: AdvanceFactoryDeps) {}

  /** **AI の代理が Module へ渡す手前で引く口**（`AgentProxyOptions.advanceGate`）。進める自動化の回でなければ照らさずに通す */
  async gate(input: SupervisorGateInput): Promise<SupervisorGateDecision> {
    if (input.role !== "factory" || !ADVANCE_FACTORY_TOOLS.includes(input.tool)) return {};
    const turn = advanceTurnOf(this.deps, input.threadId, (projectId) => this.deps.policy(projectId));
    if (!turn) return {};
    if (turn.projectId !== input.projectId) return { refuse: "この会話の Project の Factory ではないので使えません（何も渡していません）。" };
    return input.tool === "runFactory" ? this.run(turn, input) : this.answer(turn, input);
  }

  /**
   * **全部の進める自動化が流して、いま走っている Factory の件の数**。記録の `factory-started` にある実行を、その Project の Factory の今の
   * 様子と照らす——止まった・取り込んだ・やめた件と、Factory が知らない実行は数えない。Factory に聞けない Project は、記録にある件を
   * 全部走っているものとして数える（数え漏らして上限を越えない側）
   */
  async runningCount(): Promise<number> {
    const started = new Map<string, Map<string, number>>();
    for (const act of advanceActsOf(this.deps.automations)) {
      if (act.kind !== "factory-started" || !act.runId) continue;
      const runs = started.get(act.projectId) ?? new Map<string, number>();
      runs.set(act.runId, act.items?.length ?? 0);
      started.set(act.projectId, runs);
    }
    const counts = await Promise.all(
      [...started].map(async ([projectId, runs]) => {
        let live: AdvanceFactoryRunView[] | undefined;
        try {
          live = await this.deps.factoryRuns(projectId);
        } catch (err) {
          this.log(`[host] Project ${projectId} の Factory に様子を聞けませんでした（進める自動化が流した件を全部走っているものとして数えます）: ${err instanceof Error ? err.message : String(err)}`);
          return [...runs.values()].reduce((sum, n) => sum + n, 0);
        }
        if (!live) return 0;
        let n = 0;
        for (const runId of runs.keys()) {
          const run = live.find((r) => r.runId === runId);
          if (run) n += run.items.filter((i) => !NOT_RUNNING.has(i.status)).length;
        }
        return n;
      }),
    );
    return counts.reduce((sum, n) => sum + n, 0);
  }

  // ---- 内側 ---------------------------------------------------------------------------------------------------

  private async run(turn: AdvanceTurn, input: SupervisorGateInput): Promise<SupervisorGateDecision> {
    const items = Array.isArray(input.args.items) ? input.args.items.map((x) => String(x)) : [];
    const refuse = async (why: string): Promise<SupervisorGateDecision> => {
      await this.record(turn, { kind: "refused", threadId: input.threadId, reason: why, ...(items.length > 0 ? { items } : {}) });
      return { refuse: `流せません：${why}（何も流していません）。` };
    };
    // Factory は main へ取り込むまで運ぶ——取り込みを任されていない自動化では流さない
    if (!turn.delegate.includes("merge")) {
      return refuse(`Factory は main へ取り込むので、「${ACTION_TITLES.merge}」を任されているときだけ流せます。人に回してください`);
    }
    // 項目が無いものは Factory が断る（数えに関わらない）
    if (items.length === 0) return {};
    const limit = Math.max(0, Math.floor(this.deps.policy(turn.projectId).limits.factoryConcurrent));

    let release!: () => void;
    const previous = this.lock;
    this.lock = new Promise<void>((resolve) => (release = resolve));
    await previous;
    let reservedHere = 0;
    let overLimit: string | undefined;
    try {
      const running = (await this.runningCount()) + this.reserved;
      if (running + items.length > limit) {
        const room = Math.max(0, limit - running);
        overLimit =
          `全部の進める自動化で同時に走らせる Factory の件は ${limit} 件までです（いま ${running} 件）。` +
          (room > 0 ? `あと ${room} 件なら流せます` : "どれかが終わる・止まるまで流せません");
      } else {
        this.reserved += items.length;
        reservedHere = items.length;
      }
    } finally {
      release();
    }
    if (overLimit !== undefined) return refuse(overLimit);

    return {
      after: async (result) => {
        if (result.isError) return;
        const started = parseStarted(result.text);
        if (!started) {
          this.log(`[host] 進める自動化の runFactory の返事から実行の id を読めませんでした（全体の上限の数えに入りません）: ${result.text.slice(0, 200)}`);
          return;
        }
        const reason = typeof input.args.reason === "string" && input.args.reason.trim() !== "" ? input.args.reason.trim() : "ready のタスクを流した";
        await this.record(turn, { kind: "factory-started", threadId: input.threadId, runId: started.runId, items: started.items, reason });
      },
      release: () => {
        this.reserved -= reservedHere;
      },
    };
  }

  private async answer(turn: AdvanceTurn, input: SupervisorGateInput): Promise<SupervisorGateDecision> {
    const runId = typeof input.args.runId === "string" ? input.args.runId : String(input.args.runId ?? "");
    const ref = String(input.args.item ?? "").replace(/^#/, "");
    const action = String(input.args.action ?? "");
    const refuse = async (why: string, extra: Partial<AdvanceAct> = {}): Promise<SupervisorGateDecision> => {
      await this.record(turn, {
        kind: "refused",
        threadId: input.threadId,
        reason: why,
        ...(runId !== "" ? { runId } : {}),
        ...(ref !== "" ? { item: ref } : {}),
        ...(action !== "" ? { action } : {}),
        ...extra,
      });
      return { refuse: `答えられません：${why}（Factory には何も渡していません）。` };
    };
    const acts = advanceActsOf(this.deps.automations, turn.projectId);
    // **進める自動化が流した件だけ**——流していない件に答えるのは、頼んだ会話か人
    if (!acts.some((a) => a.kind === "factory-started" && a.runId === runId)) {
      return refuse("この実行は進める自動化が流したものではありません。答えるのは頼んだ会話か人です——何もしないでください");
    }
    if (action === "drop") return refuse("やめる（drop）は人が決めます。人に回してください");
    const needs = ANSWER_NEEDS[action];
    if (!needs) return refuse(`action は continue・retry・accept のどれかです（「${action}」）`);
    if (!turn.delegate.includes(needs)) {
      return refuse(`${action} は「${ACTION_TITLES[needs]}」と同じ扱いですが、この自動化には任されていません。人に回してください`);
    }
    if (typeof input.args.instruction === "string" && input.args.instruction.trim() !== "") {
      return refuse("instruction は付けられません（止まった理由などの外の文を、実装役への指示に運ばないため）。instruction を外して答えてください");
    }
    const reason = typeof input.args.reason === "string" ? input.args.reason.trim() : "";
    if (reason === "") return refuse("理由（reason）が空です");

    let runs: AdvanceFactoryRunView[] | undefined;
    try {
      runs = await this.deps.factoryRuns(turn.projectId);
    } catch (err) {
      return refuse(`Factory に様子を聞けませんでした：${err instanceof Error ? err.message : String(err)}`);
    }
    const item = runs
      ?.find((r) => r.runId === runId)
      ?.items.find((i) => i.item === ref || (i.number !== undefined && i.number !== null && String(i.number) === ref));
    if (!item) return refuse(`実行 ${runId} に ${ref} がありません`);
    if (item.status !== "stopped") return refuse(`${item.item} は止まっていません（いま ${item.status}）`, { item: item.item });
    const stage = item.stopped?.stage ?? item.stage ?? "";
    const same = acts.filter((a) => a.kind === "factory-answered" && a.runId === runId && a.item === item.item && a.stage === stage).length;
    if (same >= ADVANCE_FACTORY_ANSWERS_PER_STAGE) {
      return refuse(`${item.item} の同じ段（${stage}）にはもう ${same} 回答えました。動かないので人に回してください`, { item: item.item, stage });
    }
    return {
      after: async (result) => {
        if (result.isError) return;
        await this.record(turn, { kind: "factory-answered", threadId: input.threadId, runId, item: item.item, stage, action, reason });
      },
    };
  }

  /** 進める自動化の記録に書く（その回を届けた自動化に）。書けなくても止めない——書き残す */
  private async record(turn: AdvanceTurn, act: Omit<AdvanceAct, "at">): Promise<void> {
    try {
      await this.deps.automations.recordAdvanceAct(turn.automation.id, { at: (this.deps.now?.() ?? new Date()).toISOString(), ...act });
    } catch (err) {
      this.log(`[host] 進める自動化の記録を書けませんでした（${act.kind}）: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private log(message: string): void {
    (this.deps.log ?? console.warn)(message);
  }
}

/** `runFactory` の返事から、実行の id と流した項目を読む（読めなければ undefined） */
function parseStarted(text: string): { runId: string; items: string[] } | undefined {
  try {
    const body = JSON.parse(text) as { runId?: unknown; started?: Array<{ item?: unknown }> };
    if (typeof body.runId !== "string") return undefined;
    return { runId: body.runId, items: (body.started ?? []).flatMap((s) => (typeof s.item === "string" ? [s.item] : [])) };
  } catch {
    return undefined;
  }
}
