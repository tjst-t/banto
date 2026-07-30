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
      "いま動いている職人の一覧を返す（生存確認つき）。誰に何を任せているか把握したいときに使う。",
    parameters: Type.Object({
      projectTag: Type.Optional(Type.String({ description: "名前空間で絞る（省略時は全部）" })),
    }),
    async execute(_toolCallId, params) {
      const workers = pool.list(params.projectTag);
      const text =
        workers.length === 0
          ? "動いている職人はいません"
          : workers
              .map(
                (w) =>
                  `${w.alive ? "●" : "○"} ${w.taskId} [${w.projectTag}] pid=${w.pid} sessionId=${w.sessionId}`
              )
              .join("\n");
      return { content: [{ type: "text" as const, text }], details: { workers } };
    },
  });

  const steer = defineTool({
    name: "worker.steer",
    label: "Worker: Steer",
    description:
      "稼働中の職人に追加の指示を渡す。方針を変えたいとき・足りない文脈を補うときに使う。",
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

  const stop = defineTool({
    name: "worker.stop",
    label: "Worker: Stop",
    description: "職人を止める。既に終わっている場合も成功として扱う（冪等）。",
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

  return [delegate, list, steer, stop, attach];
}
