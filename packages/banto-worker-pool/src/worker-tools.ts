/**
 * `worker.*` Tool — 番頭が職人へ実作業を委譲する口（ADR-0010 決定23・27c、D10）。
 *
 * D10（番頭は細かい仕事をしない）を機構として支える部分。番頭はここを通して調査・実装を
 * 職人へ渡し、自分の文脈は記憶と判断に使う。
 *
 * D5: 判断は無い。誰にどの仕事をさせるかを決めるのは番頭で、ここは受け渡しのみ。
 * I2: 起動失敗・不在の職人への操作は WorkerPool が例外にする。ここで握りつぶさない。
 *
 * 型について（imp-0003）：Tool契約の型が pi 依存の `ToolDefinition` になっているのは
 * 既知の不整合。ADR-0010 決定1 はランタイム中立を求めており、統合は task-0025 で行う。
 * ここでは既存のモジュールレジストリに合わせる——Worker Pool だけ別の形にすると
 * レジストリが2つの形を受ける必要が生じ、かえって悪くなるため。
 */

import { defineTool, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { WorkerPool } from "./pool.js";

/** 一覧・アタッチの上限。番頭の文脈を埋め尽くさないため。 */
const MAX_ATTACH_LINES = 200;
/** 1回に返すイベントの上限。同上。 */
const MAX_EVENTS = 100;

export function createWorkerTools(pool: WorkerPool): ToolDefinition[] {
  const delegate = defineTool({
    name: "worker.delegate",
    label: "Worker: Delegate",
    description:
      "職人（worker）を起こして実作業を任せる。調査・実装・修正など、手を動かす仕事は" +
      "自分でやらずここへ渡す（D10）。職人は記憶を持たないので、必要な文脈は instruction に" +
      "書き切ること。返り値の sessionId で以後の様子を見たり指示を足したりできる。",
    parameters: Type.Object({
      taskId: Type.String({ description: "仕事の識別子。台帳とログに残る（例: task-0042）" }),
      origin: Type.Optional(
        Type.String({ description: "起動元＝報告の宛先（省略時は Worker Pool の既定）" })
      ),
      worktreePath: Type.String({ description: "作業させるディレクトリの絶対パス" }),
      instruction: Type.String({
        description: "職人への指示。職人は記憶を持たないため、前提・目的・完了条件を書き切る",
      }),
      projectTag: Type.Optional(Type.String({ description: "利用者の名前空間（省略可）" })),
      tools: Type.Optional(
        Type.Array(Type.String(), { description: "職人に使わせるTool名（省略時はランタイムの既定）" })
      ),
      modelTier: Type.Optional(
        Type.Union([Type.Literal("reasoning"), Type.Literal("standard"), Type.Literal("fast")], {
          description: "モデルの等級。難しい仕事だけ reasoning にする（コスト）",
        })
      ),
    }),
    async execute(_toolCallId, params) {
      const worker = await pool.delegate({
        taskId: params.taskId,
        worktreePath: params.worktreePath,
        instruction: params.instruction,
        ...(params.projectTag ? { projectTag: params.projectTag } : {}),
        ...(params.origin ? { origin: params.origin } : {}),
        ...(params.tools ? { tools: params.tools } : {}),
        ...(params.modelTier ? { modelTier: params.modelTier } : {}),
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `職人を起こしました: ${worker.taskId} (sessionId: ${worker.sessionId}, pid: ${worker.pid})`,
          },
        ],
        details: worker,
      };
    },
  });

  const list = defineTool({
    name: "worker.list",
    label: "Worker: List",
    description:
      "職人の一覧を返す（生存確認つき）。誰に何を任せているか、さっき頼んだ仕事がどうなったかを" +
      "把握したいときに使う。**畳んだ職人も既定で含む**——閉じても記録は残る。",
    parameters: Type.Object({
      projectTag: Type.Optional(Type.String({ description: "名前空間で絞る（省略時は全部）" })),
      includeClosed: Type.Optional(
        Type.Boolean({ description: "畳んだ職人も含める（既定 true）。稼働中だけ見たいなら false" })
      ),
    }),
    async execute(_toolCallId, params) {
      const workers = pool.list({
        ...(params.projectTag ? { projectTag: params.projectTag } : {}),
        ...(params.includeClosed !== undefined ? { includeClosed: params.includeClosed } : {}),
      });
      const text =
        workers.length === 0
          ? "動いている職人はいません"
          : workers
              .map((w) => {
                const mark =
                  w.state === "waiting" ? "⏸" : w.state === "closed" ? "✓" : w.alive ? "●" : "○";
                const waiting = w.question ? ` 質問待ち: ${w.question}` : "";
                const closed = w.closeReason ? `(${w.closeReason})` : "";
                return `${mark} ${w.taskId} [${w.projectTag}] ${w.state}${closed} pid=${w.pid} sessionId=${w.sessionId}${waiting}`;
              })
              .join("\n");
      return { content: [{ type: "text" as const, text }], details: { workers } };
    },
  });

  const steer = defineTool({
    name: "worker.steer",
    label: "Worker: Steer",
    description:
      "稼働中の職人に追加の指示を渡す。方針を変えたいとき・足りない文脈を補うときに使う。" +
      "**職人からの質問に答えるのもこれ**（答えると職人は待ちを解いて動き出す）。",
    parameters: Type.Object({
      sessionId: Type.String({ description: "対象の職人（worker.list で確認できる）" }),
      message: Type.String({ description: "渡す指示" }),
    }),
    async execute(_toolCallId, params) {
      // I2: 不在・終了済みの職人への指示は WorkerPool が例外にする
      await pool.steer(params.sessionId, params.message);
      return {
        content: [{ type: "text" as const, text: `指示を渡しました: ${params.sessionId}` }],
        details: { sessionId: params.sessionId },
      };
    },
  });

  const close = defineTool({
    name: "worker.close",
    label: "Worker: Close",
    description:
      "仕事が済んだ職人を畳む。**成果を確かめて良いと判断したら、放置せず畳むこと**——" +
      "待機中の職人はプロセスとして残り続ける。報告が来ただけでは畳まない（報告は主張であって" +
      "完了の証明ではない）。畳んでも記録もセッションも残り、worker.wake で起こし直せる。",
    parameters: Type.Object({
      sessionId: Type.String({ description: "畳む職人" }),
    }),
    async execute(_toolCallId, params) {
      await pool.close(params.sessionId, "done");
      return {
        content: [{ type: "text" as const, text: `畳みました: ${params.sessionId}` }],
        details: { sessionId: params.sessionId },
      };
    },
  });

  const wake = defineTool({
    name: "worker.wake",
    label: "Worker: Wake",
    description:
      "畳んだ職人を起こし直す。**元の会話が復元される**ので、前に渡した前提を書き直さなくてよい。" +
      "同じ仕事の続きを頼むときに使う（まったく別の仕事なら worker.delegate）。",
    parameters: Type.Object({
      sessionId: Type.String({ description: "起こし直す職人（worker.list の履歴から選ぶ）" }),
      instruction: Type.String({ description: "続きとして渡す指示" }),
    }),
    async execute(_toolCallId, params) {
      const worker = await pool.wake(params.sessionId, params.instruction);
      return {
        content: [
          {
            type: "text" as const,
            text: `起こし直しました: ${worker.taskId} (sessionId: ${worker.sessionId}, pid: ${worker.pid})`,
          },
        ],
        details: worker,
      };
    },
  });

  const stop = defineTool({
    name: "worker.stop",
    label: "Worker: Stop",
    description:
      "職人を強制的に止める。作業中でも止まる。仕事が済んだので畳むときは worker.close を使う" +
      "——理由を分けておかないと、履歴が「なぜ終わったのか」に答えられない。",
    parameters: Type.Object({
      sessionId: Type.String({ description: "止める職人" }),
    }),
    async execute(_toolCallId, params) {
      await pool.stop(params.sessionId);
      return {
        content: [{ type: "text" as const, text: `止めました: ${params.sessionId}` }],
        details: { sessionId: params.sessionId },
      };
    },
  });

  const attach = defineTool({
    name: "worker.attach",
    label: "Worker: Attach",
    description:
      "職人の出力を覗く。プロセスに割り込まないので稼働中でも安全。" +
      "「いまどうなっているか」を確認したいときに使う（決定18のセッションビューアと同じ経路）。",
    parameters: Type.Object({
      sessionId: Type.String({ description: "覗く職人" }),
      tailLines: Type.Optional(
        Type.Number({ description: `末尾から何行返すか（既定 ${MAX_ATTACH_LINES}）` })
      ),
    }),
    async execute(_toolCallId, params) {
      const limit = Math.max(1, Math.min(params.tailLines ?? MAX_ATTACH_LINES, MAX_ATTACH_LINES));
      const { lines, truncated } = pool.attach(params.sessionId, limit);
      const notes = truncated ? [`… 末尾 ${limit} 行のみ表示`] : [];
      const text =
        lines.length === 0 ? "まだ出力がありません" : [...lines, ...notes].join("\n");
      return {
        content: [{ type: "text" as const, text }],
        details: { sessionId: params.sessionId, lines, truncated },
      };
    },
  });

  const events = defineTool({
    name: "worker.events",
    label: "Worker: Events",
    description:
      "職人に起きたことの記録を新しい順ではなく古い順に返す（起動・終了・報告・質問）。" +
      "**事実（kind=fact）と職人の主張（kind=claim）は分かれている**——" +
      "「終わったと言っている」は完了の証明ではないので、成果は自分で確かめること。" +
      "afterEventId を渡すと、その続きだけを取れる。",
    parameters: Type.Object({
      afterEventId: Type.Optional(
        Type.Number({ description: "このID より後だけを返す（省略時は最初から）" })
      ),
      sessionId: Type.Optional(Type.String({ description: "特定の職人に絞る" })),
      origin: Type.Optional(Type.String({ description: "起動元で絞る" })),
      limit: Type.Optional(Type.Number({ description: `最大件数（既定 ${MAX_EVENTS}）` })),
    }),
    async execute(_toolCallId, params) {
      const limit = Math.max(1, Math.min(params.limit ?? MAX_EVENTS, MAX_EVENTS));
      const found = pool.events(
        params.afterEventId ?? 0,
        {
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
          ...(params.origin ? { origin: params.origin } : {}),
        },
        limit
      );
      const text =
        found.length === 0
          ? "新しい出来事はありません"
          : found
              .map(
                (e) =>
                  `#${e.id} ${e.at} ${e.type}(${e.kind}) ${e.taskId} ${JSON.stringify(e.data)}`
              )
              .join("\n");
      return {
        content: [{ type: "text" as const, text }],
        details: { events: found, lastEventId: pool.lastEventId },
      };
    },
  });

  return [delegate, list, steer, close, wake, stop, attach, events];
}

/**
 * 職人自身が使う Tool（決定29）。**番頭には渡さない**——番頭が自分に報告しても意味がない。
 *
 * 職人は別プロセスなので、これらは Worker Pool の HTTP 面越しに呼ばれる（決定27b・29e）。
 * 職人は自分の sessionId を知らないため、`projectTag` + `taskId`（起動時に環境変数で
 * 渡っている）で自分を名乗る。
 */
export function createWorkerReportTools(pool: WorkerPool): ToolDefinition[] {
  /** 名乗りから職人を引く。I2: 見つからないなら黙って捨てず理由を返す。 */
  const resolve = (projectTag: string, taskId: string): { sessionId: string } => {
    const worker = pool.getByTask(projectTag, taskId);
    if (!worker) {
      throw new Error(
        `No worker registered for "${projectTag}/${taskId}". ` +
          "BANTO_PROJECT / BANTO_TASK_ID が起動時のものと一致しているか確認してください。"
      );
    }
    return { sessionId: worker.sessionId };
  };

  const identity = {
    projectTag: Type.String({ description: "自分の projectTag（環境変数 BANTO_PROJECT）" }),
    taskId: Type.String({ description: "自分の taskId（環境変数 BANTO_TASK_ID）" }),
  };

  const report = defineTool({
    name: "worker.report",
    label: "Worker: Report",
    description:
      "起動元へ報告する。作業が終わったとき・進み具合を伝えたいときに使う。" +
      "これは**完了の宣言ではなく検証へ回す合図**で、成果は起動元が確かめる。",
    parameters: Type.Object({
      ...identity,
      summary: Type.String({
        description: "何をしたか・確認した結果・残っている懸念を簡潔に",
      }),
      done: Type.Optional(
        Type.Boolean({ description: "自分としては作業を終えたつもりなら true" })
      ),
    }),
    async execute(_toolCallId, params) {
      const { sessionId } = resolve(params.projectTag, params.taskId);
      const event = pool.report(sessionId, params.summary, {
        ...(params.done !== undefined ? { done: params.done } : {}),
      });
      return {
        content: [{ type: "text" as const, text: `報告しました（#${event.id}）` }],
        details: { eventId: event.id },
      };
    },
  });

  const ask = defineTool({
    name: "worker.ask",
    label: "Worker: Ask",
    description:
      "起動元に質問する。指示に無い前提を推測して進めるより、ここで聞く。" +
      "呼んだあとは答えが来るまで待つ（答えは追加の指示として届く）。",
    parameters: Type.Object({
      ...identity,
      question: Type.String({ description: "聞きたいこと。判断に必要な背景も添える" }),
      blocking: Type.Optional(
        Type.Boolean({ description: "答えが無いと先へ進めないなら true（既定 true）" })
      ),
    }),
    async execute(_toolCallId, params) {
      const { sessionId } = resolve(params.projectTag, params.taskId);
      const event = pool.ask(sessionId, params.question, {
        blocking: params.blocking ?? true,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `質問を届けました（#${event.id}）。答えが届くまで待ってください。`,
          },
        ],
        details: { eventId: event.id },
      };
    },
  });

  return [report, ask];
}
