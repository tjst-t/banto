/**
 * `worker.*` Tool — 番頭が職人へ実作業を委譲する口（ADR-0010 決定23・27c、D10）。
 *
 * D10（番頭は細かい仕事をしない）を機構として支える部分。番頭はここを通して調査・実装を
 * 職人へ渡し、自分の文脈は記憶と判断に使う。
 *
 * D5: 判断は無い。誰にどの仕事をさせるかを決めるのは番頭で、ここは受け渡しのみ。
 * I2: 起動失敗・不在の職人への操作は WorkerPool が例外にする。ここで握りつぶさない。
 *
 * D6: 契約の型は `@banto/core` の中立なもの（task-0025 で統合済み）。**pi は import しない**
 *     ——Worker Pool は pi をバイナリとしてしか使わないのに、Tool を定義するためだけに
 *     型依存が要る状態だった（imp-0003 の実害）。
 */

import { StringEnum, defineNamespacedTool, type NamespacedToolDefinition } from "@banto/core";
import { Type } from "typebox";
import { DEFAULT_PAGE_SIZE } from "./pool.js";
import type { WorkerPool } from "./pool.js";
import { formatBytes } from "./worker-cgroup.js";

/** 一覧・アタッチの上限。番頭の文脈を埋め尽くさないため。 */
const MAX_ATTACH_LINES = 200;
/** 1回に返すイベントの上限。同上。 */
const MAX_EVENTS = 100;

/**
 * 例に出す職人の識別子（ADR-0019 決定84-1）。
 *
 * **実物の形をそのまま出す。** `sessionId` は UUIDv7 で、短い別名は無い——
 * 「w-28」のような架空の形を例にすると、番頭がその形を作って渡してくる。
 */
const EXAMPLE_SESSION_ID = "019fbd87-1aba-74e8-a7bd-14f9dc8b2ede";

/**
 * 値の言語を明示する一行（ADR-0019 決定84-2）。
 *
 * arXiv:2601.05366 が挙げる最多の故障は `parameter value language mismatch`——
 * banto は PO が日本語・道具の I/F が英語という、その型そのもの。**識別子の欄に
 * 日本語を書かせない**ことを、例だけに頼らず言葉でも言う。
 */
const ID_HINT = "\nsessionId は英語の識別子（UUID）で埋める。";

export function createWorkerTools(pool: WorkerPool): NamespacedToolDefinition[] {
  const delegate = defineNamespacedTool({
    name: "worker.delegate",
    label: "Worker: Delegate",
    description:
      `職人に実作業（調査・実装・修正）を任せる。手を動かす仕事は自分でやらず渡す（D10）。\n例: {taskId: "task-0042", worktreePath: "/home/ubuntu/worktrees/banto/task-0042", instruction: "落ちる原因を調べて報告する"} → sessionId "${EXAMPLE_SESSION_ID}"\ninstruction 以外の値は英語（識別子・パス）で埋める。\n**渡したら手を離してターンを終える**（知らせは自動で届く。attach で待たない）。\n同時に走れる本数には上限がある。満杯のときは待たされず断られ、断りに「いま誰が走っているか」が載る——読んで畳む相手を選ぶ。`,
    parameters: Type.Object({
      taskId: Type.String(),
      origin: Type.Optional(Type.String()),
      worktreePath: Type.String(),
      instruction: Type.String({
        description: "職人は記憶を持たないので前提・目的・完了条件を書き切る"
      }),
      projectTag: Type.Optional(Type.String()),
      tools: Type.Optional(
        Type.Array(Type.String(), {
          description:
            '例: ["read","grep","find","ls"]。省略すると write/bash まで全部持つ' +
            "＝**調べるだけのつもりでも書き換えられる**"
        })
      ),
      network: Type.Optional(Type.Boolean()),
      modelTier: Type.Optional(
        StringEnum(["reasoning", "standard", "fast"] as const, {})
      ),
      // **綴りは残す。** 短くしても、選べる名前だけは削らない——無いランタイムを
      // 当てにいく呼び方が実際に出る（claude-agent-worker.spec.ts が押さえている）
      runtime: Type.Optional(Type.String({ description: "claude-code / pi（既定 pi）" })),
      model: Type.Optional(
        Type.String({ description: "opus / sonnet / haiku など（一覧は worker.models）" })
      )
    }),
    async execute(params) {
      const worker = await pool.delegate({
        taskId: params.taskId,
        worktreePath: params.worktreePath,
        instruction: params.instruction,
        ...(params.projectTag ? { projectTag: params.projectTag } : {}),
        ...(params.origin ? { origin: params.origin } : {}),
        ...(params.tools ? { tools: params.tools } : {}),
        ...(params.network !== undefined ? { network: params.network } : {}),
        ...(params.modelTier ? { modelTier: params.modelTier } : {}),
        ...(params.runtime ? { runtime: params.runtime } : {}),
        ...(params.model ? { model: params.model } : {}),
      });
      const model = worker.model ? `/${worker.model}` : "";
      return {
        content: [
          {
            type: "text" as const,
            text:
              `職人を起こしました: ${worker.taskId} ` +
              `[${worker.runtime}${model}] (sessionId: ${worker.sessionId}, pid: ${worker.pid})`,
          },
        ],
        details: worker,
      };
    },
  });

  const list = defineNamespacedTool({
    name: "worker.list",
    label: "Worker: List",
    description:
      "誰に何を任せているかの一覧（新しい順・生存確認つき）。畳んだ職人も既定で含む。\n例: {} → 全部／{includeClosed: false} → 稼働中だけ／{query: \"task-0042\"} → その仕事だけ\nquery は英語の識別子で埋める。",
    parameters: Type.Object({
      projectTag: Type.Optional(Type.String()),
      includeClosed: Type.Optional(Type.Boolean()),
      query: Type.Optional(
        Type.String()
      ),
      limit: Type.Optional(Type.Number()),
      offset: Type.Optional(Type.Number())
    }),
    async execute(params) {
      const result = pool.find({
        ...(params.projectTag ? { projectTag: params.projectTag } : {}),
        ...(params.includeClosed !== undefined ? { includeClosed: params.includeClosed } : {}),
        ...(params.query ? { query: params.query } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
        ...(params.offset !== undefined ? { offset: params.offset } : {}),
      });
      const workers = result.workers;
      const range =
        result.total === 0
          ? ""
          : `\n（全 ${result.total} 件中 ${result.offset + 1}〜${result.offset + workers.length} 件）`;
      const text =
        workers.length === 0
          ? params.query
            ? `「${params.query}」に当てはまる職人はいません`
            : "動いている職人はいません"
          : workers
              .map((w) => {
                const mark =
                  w.state === "waiting" ? "⏸" : w.state === "closed" ? "✓" : w.alive ? "●" : "○";
                const waiting = w.question ? ` 質問待ち: ${w.question}` : "";
                const closed = w.closeReason ? `(${w.closeReason})` : "";
                const runtime = `${w.runtime}${w.model ? `/${w.model}` : ""}`;
                /**
                 * 職人の下で実際に動いているプロセス（inc-0066）。ホストの pid だけでは
                 * OOM のダンプから職人を逆引きできなかった。走査中は何も出さない。
                 */
                const child = w.childProcesses
                  ? w.childProcesses.children.length > 0
                    ? ` child=${w.childProcesses.children.map((c) => `${c.comm}:${c.pid}`).join(",")}`
                    : " child=不明"
                  : "";
                /**
                 * 隔離と、袋から読んだ使い切りの記録（inc-0066 第2段）。
                 *
                 * **上限に当たって殺された職人は、ここで名指しされる。** これが無いと
                 * 番頭には「なぜか落ちた」としか見えず、2026-08-14 の事故が繰り返される。
                 */
                const isolation = w.isolation === "none" ? " 隔離なし" : "";
                const mem = w.memory
                  ? (w.memory.oomKilled
                      ? " ⚠上限で kill された"
                      : w.memory.hitLimit
                        ? " ⚠上限に張り付いた"
                        : "") +
                    (w.memory.peakBytes !== undefined ? ` peak=${formatBytes(w.memory.peakBytes)}` : "")
                  : "";
                return `${mark} ${w.taskId} [${w.projectTag}] ${w.state}${closed} ${runtime} pid=${w.pid}${child}${isolation}${mem} sessionId=${w.sessionId}${waiting}`;
              })
              .join("\n") +
            range +
            /**
             * 隔離できていないことを番頭の目に必ず入れる（3点セットの3つ目・PO 裁定）。
             * 「知らないうちに隔離なしで回っていた」を作らないための条件。
             */
            (pool.isolationStatus().mode === "none"
              ? `\n\n⚠ この工房は職人を隔離していません（cgroup 不可: ` +
                `${pool.isolationStatus().reason ?? "理由不明"}）。1本の暴走が機械全体を巻き込みます`
              : "");
      /**
       * いま何本走っていて上限が何本か（task-0216）。
       *
       * **一覧の末尾に必ず出す**——職人が1人も居ないときも出す。番頭が「あと何本頼めるか」を
       * 知るのに一覧以外の口を覚えなくてよいようにするため。断られてから知るのでは遅い。
       */
      const concurrency = pool.concurrency();
      const capacity =
        concurrency.limit > 0
          ? `\n\n同時に走っている職人: ${concurrency.running} / ${concurrency.limit} 本` +
            `（上限。工房の ${concurrency.env} で変える）` +
            (concurrency.running >= concurrency.limit
              ? "。**満杯です**——次を頼む前に、終わった職人を worker.close で畳んでください"
              : "")
          : `\n\n同時に走っている職人: ${concurrency.running} 本（上限なし）`;
      return {
        content: [{ type: "text" as const, text: text + capacity }],
        details: { ...result, concurrency },
      };
    },
  });

  const models = defineNamespacedTool({
    name: "worker.models",
    label: "Worker: Models",
    description:
      "職人に名指しできるモデルの一覧。worker.delegate の model にそのまま書ける名前が返る。\n例: {} → \"opus — Opus\"／\"opencode/deepseek-v4 — DeepSeek V4（fast）\"",
    parameters: Type.Object({}),
    async execute() {
      const found = pool.selectableModels();
      const text =
        found.length === 0
          ? "名指しできるモデルはありません（等級で頼んでください）"
          : found.map((m) => `${m.name} — ${m.label}${m.tier ? `（${m.tier}）` : ""}`).join("\n");
      return { content: [{ type: "text" as const, text }], details: { models: found } };
    },
  });

  const steer = defineNamespacedTool({
    name: "worker.steer",
    label: "Worker: Steer",
    description:
      `稼働中の職人に指示を渡す。**職人の質問に答えるのもこれ**（答えると待ちが解ける）。\n例: {sessionId: "${EXAMPLE_SESSION_ID}", message: "そのまま直してよい"} → 渡した旨${ID_HINT}`,
    parameters: Type.Object({
      sessionId: Type.String(),
      message: Type.String()
    }),
    async execute(params) {
      // I2: 不在・終了済みの職人への指示は WorkerPool が例外にする
      await pool.steer(params.sessionId, params.message);
      return {
        content: [{ type: "text" as const, text: `指示を渡しました: ${params.sessionId}` }],
        details: { sessionId: params.sessionId },
      };
    },
  });

  const close = defineNamespacedTool({
    name: "worker.close",
    label: "Worker: Close",
    description:
      `仕事が済んだ職人を畳む。記録は残り worker.wake で起こし直せる。\n例: {sessionId: "${EXAMPLE_SESSION_ID}"} → 畳んだ旨${ID_HINT}\n**報告が来ただけでは畳まない**（報告は主張であって完了の証明ではない）。`,
    parameters: Type.Object({ sessionId: Type.String() }),
    async execute(params) {
      await pool.close(params.sessionId, "done");
      return {
        content: [{ type: "text" as const, text: `畳みました: ${params.sessionId}` }],
        details: { sessionId: params.sessionId },
      };
    },
  });

  const wake = defineNamespacedTool({
    name: "worker.wake",
    label: "Worker: Wake",
    description:
      `畳んだ職人を起こし直す。**元の会話が復元される**ので前提を書き直さなくてよい。\n例: {sessionId: "${EXAMPLE_SESSION_ID}", instruction: "監査の指摘を直す"} → 起こした旨${ID_HINT}\n別の仕事なら worker.delegate。`,
    parameters: Type.Object({
      sessionId: Type.String(),
      instruction: Type.String()
    }),
    async execute(params) {
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

  const stop = defineNamespacedTool({
    name: "worker.stop",
    label: "Worker: Stop",
    description:
      `職人を強制的に止める（作業中でも止まる）。\n例: {sessionId: "${EXAMPLE_SESSION_ID}"} → 止めた旨。仕事が済んで畳むなら worker.close。${ID_HINT}`,
    parameters: Type.Object({ sessionId: Type.String() }),
    async execute(params) {
      await pool.stop(params.sessionId);
      return {
        content: [{ type: "text" as const, text: `止めました: ${params.sessionId}` }],
        details: { sessionId: params.sessionId },
      };
    },
  });

  const attach = defineNamespacedTool({
    name: "worker.attach",
    label: "Worker: Attach",
    description:
      `職人の出力の末尾を覗く（割り込まないので稼働中でも安全）。\n例: {sessionId: "${EXAMPLE_SESSION_ID}", tailLines: 50} → 末尾50行${ID_HINT}\n**完了を待つために繰り返し呼ばない**（機構が断る）。`,
    parameters: Type.Object({
      sessionId: Type.String(),
      tailLines: Type.Optional(Type.Number())
    }),
    async execute(params) {
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

  const events = defineNamespacedTool({
    name: "worker.events",
    label: "Worker: Events",
    description:
      "職人に起きたこと（起動・終了・報告・質問）を古い順に返す。\n例: {afterEventId: 120, limit: 20} → #121 以降の20件\nsessionId・origin は英語の識別子で埋める。\n**事実(fact)と職人の主張(claim)は分かれている**——「終わった」は完了の証明ではない。",
    parameters: Type.Object({
      afterEventId: Type.Optional(Type.Number()),
      sessionId: Type.Optional(Type.String()),
      origin: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number())
    }),
    async execute(params) {
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

  /**
   * 取り置きを**番頭が読める形にする**（work-keep）。
   *
   * ここが無いと、機構は成果を守れても番頭がそれを知る経路が無い——「在るのに誰も
   * 気づけない」は、実装が全部あるのに一度も発火しなかった触れる環境と同じ形の穴である。
   * `git branch --list` を番頭が打つことを期待する設計は、事実上「無い」のと同じ。
   */
  const keeps = defineNamespacedTool({
    name: "worker.keeps",
    label: "Worker: Keeps",
    description:
      "落ちた・無報告で終わった職人の**未コミットの成果**が、機構の取り置き枝に残っていないか調べる。\n" +
      "職人が消えたのに成果が要るとき・差し戻す前にここを見る。\n" +
      '例: {taskId: "task-0042"} → その仕事の取り置き／{} → 全部\n' +
      "taskId・projectTag・repoPath は英語の識別子（パス）で埋める。\n" +
      "**枝は職人が作ったものではなく機構が打ったもの**（打ち手は banto-keeper）。",
    parameters: Type.Object({
      taskId: Type.Optional(Type.String()),
      projectTag: Type.Optional(Type.String()),
      repoPath: Type.Optional(
        Type.String({
          description: "そのタスクのワークツリーが1つも残っていないときに、見に行く場所を名指しする",
        })
      ),
    }),
    async execute(params) {
      const found = pool.keeps({
        ...(params.taskId ? { taskId: params.taskId } : {}),
        ...(params.projectTag ? { projectTag: params.projectTag } : {}),
        ...(params.repoPath ? { repoPath: params.repoPath } : {}),
      });
      const text =
        found.length === 0
          ? params.taskId
            ? `「${params.taskId}」の取り置きはありません`
            : "取り置きはありません"
          : found
              .map((info) => {
                const count = info.keptCount === undefined ? "" : ` ${info.keptCount}枚`;
                return (
                  `${info.branch}\n` +
                  `  ${info.taskId} [${info.projectTag}] ${info.runtime}` +
                  `${count} 起動 ${info.startedAt} 最後 ${info.lastKeptAt}\n` +
                  `  中身を見る: git log -p ${info.branch}`
                );
              })
              .join("\n");
      return { content: [{ type: "text" as const, text }], details: { keeps: found } };
    },
  });

  return [delegate, list, models, steer, close, wake, stop, attach, events, keeps];
}


/**
 * 職人自身が使う Tool（決定29）。**番頭には渡さない**——番頭が自分に報告しても意味がない。
 *
 * 職人は別プロセスなので、これらは Worker Pool の HTTP 面越しに呼ばれる（決定27b・29e）。
 * 職人は自分の sessionId を知らないため、`projectTag` + `taskId`（起動時に環境変数で
 * 渡っている）で自分を名乗る。
 */
export function createWorkerReportTools(pool: WorkerPool): NamespacedToolDefinition[] {
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

  const report = defineNamespacedTool({
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
      auto: Type.Optional(
        Type.Boolean({
          description:
            "職人が自分で書いた報告ではなく、報告せず手を止めたのを安全弁が拾ったもの。" +
            "職人自身が指定するものではない（拡張が付ける）",
        })
      ),
    }),
    async execute(params) {
      const { sessionId } = resolve(params.projectTag, params.taskId);
      const event = pool.report(sessionId, params.summary, {
        ...(params.done !== undefined ? { done: params.done } : {}),
        // I1: 出所を偽らない。番頭には「職人が黙って終えた」ことが見えなければならない
        ...(params.auto ? { auto: true } : {}),
      });
      return {
        content: [{ type: "text" as const, text: `報告しました（#${event.id}）` }],
        details: { eventId: event.id },
      };
    },
  });

  /**
   * **喋り終わったことを伝える**（PO要望 2026-08-11）。
   *
   * 職人が呼ぶものではない——**ランタイム（拡張・ホスト）がターンの終わりに呼ぶ**。
   * これまで起動元が「終わった」を知る道は、明示の報告か安全弁の時間切れ（既定15分）
   * しか無かった。出力が終わった時点で分かることを、時間で待つ理由が無い。
   */
  const turnEnded = defineNamespacedTool({
    name: "worker.turn_ended",
    label: "Worker: Turn Ended",
    description:
      "**ランタイムが呼ぶ**：職人のターンが終わった（出力が止まった）ことを起動元へ伝える。" +
      "職人自身が呼ぶものではない。完了かどうかの判断はここではしない——起動元が決める。",
    parameters: Type.Object({
      ...identity,
      text: Type.Optional(
        Type.String({ description: "そのターンの最後の発話（報告が無いときの手がかり）" })
      ),
      reported: Type.Optional(
        Type.Boolean({ description: "そのターンで報告か質問をしたか" })
      ),
      waiting: Type.Optional(
        Type.Boolean({ description: "答え待ちで止まっているか（**終わったのではない**）" })
      ),
    }),
    async execute(params) {
      const { sessionId } = resolve(params.projectTag, params.taskId);
      const event = pool.turnEnded(sessionId, {
        ...(params.text !== undefined ? { text: params.text } : {}),
        ...(params.reported !== undefined ? { reported: params.reported } : {}),
        ...(params.waiting !== undefined ? { waiting: params.waiting } : {}),
      });
      return {
        content: [{ type: "text" as const, text: `ターンの終わりを伝えました（#${event.id}）` }],
        details: { eventId: event.id },
      };
    },
  });

  const ask = defineNamespacedTool({
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
    async execute(params) {
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

  return [report, ask, turnEnded];
}

/**
 * **モジュールだけが使う口**（ADR-0013 決定60・決定29e の延長）。番頭には渡さない。
 *
 * 職人は「起動元のドメイン Tool」と「Worker Pool の汎用 Tool」の両方を持ちうる
 * （Kobo の `report_phase` / `report_done` と `worker.report` は層が違う・決定29e）。
 * 起動元が自分の拡張を職人へ載せる経路がこれ。
 *
 * **なぜ番頭に渡さないか**：`driverOptions` は職人プロセスに**任意のコードを読み込ませられる**
 * （`extensionPaths`）。番頭は LLM なので、指示次第で任意のパスを渡しうる——`internalTools`
 * （決定29e と同じ枠）に置いて、機構として届かないようにする。呼ぶのは決定的コードである
 * モジュールだけ。
 */
export function createWorkerModuleTools(pool: WorkerPool): NamespacedToolDefinition[] {
  const delegateWithToolkit = defineNamespacedTool({
    name: "worker.delegate_toolkit",
    label: "Worker: Delegate (module)",
    description:
      "起動元（モジュール）が自分の道具立てを載せて職人を起こす。番頭は使わない。" +
      "`worker.delegate` との違いは driverOptions を渡せる点だけで、他は同じ。",
    parameters: Type.Object({
      taskId: Type.String({ description: "仕事の識別子。台帳とログに残る" }),
      origin: Type.Optional(Type.String({ description: "起動元＝報告の宛先" })),
      worktreePath: Type.String({ description: "作業させるディレクトリの絶対パス" }),
      instruction: Type.String({ description: "職人への指示" }),
      projectTag: Type.Optional(Type.String({ description: "利用者の名前空間" })),
      tools: Type.Optional(Type.Array(Type.String(), { description: "道具の許可リスト" })),
      network: Type.Optional(Type.Boolean({ description: "外を読む口を渡すか（既定 false）" })),
      modelTier: Type.Optional(
        Type.Union([Type.Literal("reasoning"), Type.Literal("standard"), Type.Literal("fast")], {
          description:
            "モデルの等級。**起動元はモデル名を知らない**（決定60a）——解決は Worker Pool が行う",
        })
      ),
      /**
       * モデルの名指し（`modelTier` より優先）。**PO裁定 2026-08-10 で開いた口**。
       *
       * 決定60a は「起動元はモデル名を知らず tier までしか渡さない」だったが、PO が
       * 「実装やレビューをどのモデルの職人にやらせるか、名前で決めたい」と裁定した。
       * 名前は `worker.models` が返すものを使う（工場の設定画面がそこから選ばせる）。
       *
       * **ランタイムは名前から決まる**ので、起動元は併記しない——`opus` なら Claude Code、
       * `provider/model` なら pi。2か所に書かせると、片方だけ直した指定が通ってしまう。
       */
      model: Type.Optional(
        Type.String({
          description:
            "モデルの名指し（`modelTier` より優先）。`worker.models` が返す名前を使う" +
            "（例: `opus` / `opencode-go/deepseek-v4-flash`）",
        })
      ),
      driverOptions: Type.Optional(
        Type.Object(
          {},
          {
            additionalProperties: true,
            description:
              "ドライバへ渡す不透明な設定（`extensionPaths`・その拡張が読む値）。" +
              "中身は解釈しない（spec-environment §2 の handle / config と同じ扱い）",
          }
        )
      ),
    }),
    async execute(params) {
      const worker = await pool.delegate({
        taskId: params.taskId,
        worktreePath: params.worktreePath,
        instruction: params.instruction,
        ...(params.projectTag ? { projectTag: params.projectTag } : {}),
        ...(params.origin ? { origin: params.origin } : {}),
        ...(params.tools ? { tools: params.tools } : {}),
        ...(params.network !== undefined ? { network: params.network } : {}),
        ...(params.modelTier ? { modelTier: params.modelTier } : {}),
        ...(params.model ? { model: params.model } : {}),
        ...(params.driverOptions
          ? { driverOptions: params.driverOptions as Record<string, unknown> }
          : {}),
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

  return [delegateWithToolkit];
}
