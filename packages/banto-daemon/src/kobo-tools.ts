/**
 * `kobo.*` Tool — 番頭が Kobo（工場）に仕事を積み、様子を読む口（ADR-0013 決定58、task-0064）。
 *
 * **Kobo は工場、番頭は差配**（決定56）。番頭は積む・読む・進める（承認）ができ、
 * **飛ばせない**（決定62c）——ゲートを飛ばす／帳簿を書き換える／監査を省く道具はここに無い。
 *
 * D5: 判断は無い。積むかどうかを決めるのは番頭で、ここは受け渡しと読み取りだけ。
 * D3: 状態は Kobo のイベントログから導く。ここに写しを持たない。
 * I2: 到達できない・積めない・見つからないを、黙って空の成功にしない。
 *
 * **定義はファイル**（D4）。`kobo.enqueue` は「このファイルを積め」と言う口で、契約
 * （`scope.paths`・受け入れ基準）はファイルに書かれたものが取り込み時点で固まる（決定62c）。
 * 番頭が任意の内容を API で流し込む形にしないのは、**PO が読める形の定義を必ず残す**ため。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import { defineNamespacedTool, validateTaskFrontmatter } from "@banto/core";
import type { NamespacedToolDefinition } from "@banto/core";
import type { Daemon } from "./daemon.js";
import { taskPayload } from "./task-watcher.js";

/** 一覧・経緯で1度に返す上限。番頭の文脈を埋め尽くさないため。 */
const MAX_ROWS = 100;

/** タスク定義ファイルの置き場（プロジェクトのリポジトリからの相対）。 */
const TASKS_DIR = path.join("work", "tasks");

/** 状態の並び（一覧の見出しに使う）。 */
const ACTIVE_STATES = new Set([
  "queued",
  "ready",
  "planning",
  "implementing",
  "auditing",
  "review-ready",
  "in-review",
  "approved",
  "merging",
  "paused",
]);

export function createKoboTools(daemon: Daemon): NamespacedToolDefinition[] {
  /** プロジェクトを引く。I2: 知らないプロジェクトは、知っているものを添えて止まる。 */
  const requireProject = (projectTag: string): { id: string; repoPath: string } => {
    const project = daemon.listProjects().find((p) => p.id === projectTag);
    if (!project) {
      const known = daemon.listProjects().map((p) => p.id).join(", ");
      throw new Error(
        `Kobo は "${projectTag}" というプロジェクトを知りません。既知: ${known || "(なし)"}`
      );
    }
    return { id: project.id, repoPath: project.repoPath };
  };

  const enqueue = defineNamespacedTool({
    name: "kobo.enqueue",
    label: "Kobo: Enqueue",
    description:
      "タスク定義ファイルを工場へ積む。積まれたタスクは依存ゲートを通り、職人が自動で着手し、" +
      "監査を経てマージまで運ばれる——**以後あなたが手を動かす必要は無い**。" +
      "**コードを変える仕事はここへ積むこと**（自分で書かない・D10・決定62a）。" +
      "先に work/tasks/task-NNNN.md を書き、status: queued にしてからこれを呼ぶ。" +
      "レビュー待ちや完了は、積んだこの会話へ返ってくる。",
    parameters: Type.Object({
      projectTag: Type.String({ description: "どのプロジェクトか（kobo.projects で確認できる）" }),
      taskId: Type.String({ description: "積むタスクの id（例: task-0042）。ファイル名と一致させる" }),
      origin: Type.Optional(
        Type.String({
          description:
            "積んだ元＝返す宛先（省略時は宛先なし）。**番頭は書かない**" +
            "——Tool を束ねる層がこの会話に固定する（決定35a と同じ形）",
        })
      ),
      originRef: Type.Optional(
        Type.String({
          description:
            "**なぜこれを積むのか**——元になった PO の指示や経緯を1〜2行で。" +
            "工場は経緯を知らないので、これが無いと判断を求める札に「起きたこと」しか書けない（D8）",
        })
      ),
    }),
    async execute(params) {
      const project = requireProject(params.projectTag);
      const result = daemon.enqueueTaskFile(project.id, params.taskId, {
        // 決定58: 宛先は**積んだスレッド**。番頭は自分の origin を書かない（束ねる層が固定する）
        ...(params.origin ? { origin: params.origin } : {}),
        ...(params.originRef ? { originRef: params.originRef } : {}),
      });
      if (!result.ok) {
        // I2: 積めなかったことを成功に見せない。理由をそのまま返す
        throw new Error(`${params.taskId} を積めませんでした: ${result.reason}`);
      }
      const task = daemon.getTask(project.id, params.taskId);
      return {
        content: [
          {
            type: "text" as const,
            text:
              `積みました: ${params.taskId}（いまの状態: ${task?.status ?? "?"}）。\n` +
              "ゲートを通ると職人が着手します。様子は kobo.task で読めます。",
          },
        ],
        details: { taskId: params.taskId, projectTag: project.id, status: task?.status },
      };
    },
  });

  const list = defineNamespacedTool({
    name: "kobo.list",
    label: "Kobo: List",
    description:
      "工場のタスク一覧。いま何が動いていて、何が待っていて、何が終わったかが分かる。" +
      "**状態は工場の帳簿が真実**で、タスクファイルの status は意図でしかない（決定62e）。" +
      "state で絞れる（例: ready / in-review）。既定は動いているものだけ。",
    parameters: Type.Object({
      projectTag: Type.Optional(Type.String({ description: "プロジェクトで絞る（省略時は全部）" })),
      state: Type.Optional(
        Type.String({ description: "状態で絞る（例: ready・in-review・failed）。all で全部" })
      ),
      limit: Type.Optional(Type.Number({ description: `最大件数（既定 ${MAX_ROWS}）` })),
    }),
    async execute(params) {
      const limit = Math.max(1, Math.min(params.limit ?? MAX_ROWS, MAX_ROWS));
      const projects = params.projectTag
        ? [requireProject(params.projectTag).id]
        : daemon.listProjects().map((p) => p.id);

      const rows = projects
        .flatMap((projectTag) => daemon.getTasksByProject(projectTag))
        .filter((task) => {
          if (params.state === "all") return true;
          if (params.state) return task.status === params.state;
          return ACTIVE_STATES.has(task.status);
        })
        .slice(0, limit)
        .map((task) => ({
          taskId: task.id,
          projectTag: task.projectTag,
          status: task.status,
          title: String(task["title"] ?? ""),
        }));

      const text =
        rows.length === 0
          ? params.state
            ? `状態 "${params.state}" のタスクはありません`
            : "動いているタスクはありません"
          : rows.map((r) => `${r.status.padEnd(12)} ${r.taskId} ${r.title}`).join("\n");
      return { content: [{ type: "text" as const, text }], details: { tasks: rows } };
    },
  });

  const task = defineNamespacedTool({
    name: "kobo.task",
    label: "Kobo: Task",
    description:
      "1つのタスクの**いまと経緯**。状態・契約（スコープ・受け入れ基準）と、" +
      "何が起きてきたか（着手・監査の判定・マージ）が順に読める。" +
      "止まっているタスクの理由を知りたいときはこれ。",
    parameters: Type.Object({
      projectTag: Type.String({ description: "どのプロジェクトか" }),
      taskId: Type.String({ description: "読むタスクの id" }),
      limit: Type.Optional(Type.Number({ description: `経緯の最大件数（既定 ${MAX_ROWS}）` })),
    }),
    async execute(params) {
      const project = requireProject(params.projectTag);
      const found = daemon.getTask(project.id, params.taskId);
      // I2: 無いものを空で返さない（積み忘れと取り違えを混同しない）
      if (!found) {
        throw new Error(
          `${params.taskId} は ${project.id} の工場にありません（まだ積まれていない可能性があります）`
        );
      }
      const limit = Math.max(1, Math.min(params.limit ?? MAX_ROWS, MAX_ROWS));
      const history = daemon
        .getTaskEvents(project.id, params.taskId)
        .slice(-limit)
        .map((e) => ({
          type: e.type,
          at: e.timestamp,
          detail:
            e.type === "state_transitioned"
              ? `${e.from} → ${e.to}${e.reason ? `（${e.reason}）` : ""}`
              : e.type === "audit_verdict"
                ? `${e.verdict}${e.findings.length > 0 ? `: ${e.findings.join(" / ")}` : ""}`
                : e.type === "task_failed"
                  ? e.reason
                  : e.type === "gate_evaluated"
                    ? e.passed
                      ? "通過"
                      : `待ち: ${e.blockedBy.join(", ")}`
                    : "",
        }));

      // **レビューの段は Kobo が決める**（決定57・66）。番頭ホストに判定させると、
      // 判定表（プロジェクトの meta/config.yaml）を読めない側が推測することになり、
      // PO 直行のタスクを「あなたが通してよい」と見せてしまう
      const stage = daemon.reviewStageOf(project.id, found);
      const scope = (found["scope"] as { paths?: string[] } | undefined)?.paths ?? [];
      const text = [
        `${params.taskId} [${found.status}] ${String(found["title"] ?? "")}`,
        `レビュー: ${stage}${stage === "po" ? "（PO の判断が要る）" : stage === "auto" ? "（人も番頭も見ない）" : "（あなたが一次受け）"}`,
        scope.length > 0 ? `スコープ: ${scope.join(", ")}` : "",
        "",
        ...history.map((h) => `${h.at} ${h.type}${h.detail ? ` — ${h.detail}` : ""}`),
      ]
        .filter((line) => line !== "")
        .join("\n");
      return {
        content: [{ type: "text" as const, text }],
        details: { task: found, reviewStage: stage, history },
      };
    },
  });

  const projects = defineNamespacedTool({
    name: "kobo.projects",
    label: "Kobo: Projects",
    description:
      "工場が受け持っているプロジェクト（統治単位）の一覧。タスクを積む前に、" +
      "そのリポジトリが登録されているかを確かめるのに使う。",
    parameters: Type.Object({}),
    async execute() {
      const rows = daemon.listProjects();
      const text =
        rows.length === 0
          ? "登録されているプロジェクトはありません"
          : rows.map((p) => `${p.id} — ${p.repoPath}`).join("\n");
      return { content: [{ type: "text" as const, text }], details: { projects: rows } };
    },
  });

  const events = defineNamespacedTool({
    name: "kobo.events",
    label: "Kobo: Events",
    description:
      "工場に起きたことを古い順に返す。`afterEventId` を渡すと続きだけを取れる。" +
      "会話には要点だけが届くので、細かく追いたいときにこれを使う。",
    parameters: Type.Object({
      afterEventId: Type.Optional(
        Type.Number({ description: "このID より後だけを返す（省略時は最初から）" })
      ),
      projectTag: Type.Optional(Type.String({ description: "プロジェクトで絞る" })),
      origin: Type.Optional(
        Type.String({ description: "積んだ元（スレッド）で絞る。番頭ホストが自分宛を拾うのに使う" })
      ),
      limit: Type.Optional(Type.Number({ description: `最大件数（既定 ${MAX_ROWS}）` })),
    }),
    async execute(params) {
      const limit = Math.max(1, Math.min(params.limit ?? MAX_ROWS, MAX_ROWS));
      const found = daemon.readEvents({
        afterEventId: params.afterEventId ?? 0,
        ...(params.projectTag ? { projectTag: params.projectTag } : {}),
        ...(params.origin ? { origin: params.origin } : {}),
        limit,
      });
      const text =
        found.length === 0
          ? "新しい出来事はありません"
          : found
              .map(
                (e) =>
                  `#${e.eventId} ${e.timestamp} ${e.type}` +
                  ("taskId" in e ? ` ${String(e.taskId)}` : "")
              )
              .join("\n");
      // 宛先（積んだスレッド）を**添えて**返す。イベントそのものには入れない——
      // origin はタスクの持ち物で、イベントの意味ではないから（決定58）。
      // これが無いと、番頭ホストは1件ごとに「これは誰宛か」を聞き直すことになる
      const origins: Record<string, string> = {};
      for (const event of found) {
        if (!("taskId" in event)) continue;
        const key = `${event.projectTag}/${String(event.taskId)}`;
        if (origins[key]) continue;
        const origin = daemon.originOfTask(event.projectTag, String(event.taskId));
        if (origin) origins[key] = origin;
      }
      return {
        content: [{ type: "text" as const, text }],
        details: { events: found, origins, lastEventId: daemon.lastEventId },
      };
    },
  });


  const approve = defineNamespacedTool({
    name: "kobo.approve",
    label: "Kobo: Approve",
    description:
      "レビュー待ちのタスクを通す。通すとマージキューへ入る——ただし**関所は飛ばない**：" +
      "この後にマージ前ゲート（スコープ違反の検査と検証コマンド）が回り、あなたに飛ばす手段は無い" +
      "（決定57）。**あなたのレビューは2つの機械的検査の上に乗る判断**であって、検査の代わりではない。" +
      "PO の判断が要ると機械的に判定されたタスクは、ここでは通せない——取次へ上げること。",
    parameters: Type.Object({
      projectTag: Type.String({ description: "どのプロジェクトか" }),
      taskId: Type.String({ description: "通すタスクの id" }),
      note: Type.Optional(Type.String({ description: "何を見て良しとしたか（帳簿に残る）" })),
    }),
    async execute(params) {
      const project = requireProject(params.projectTag);
      const result = daemon.approveTask(project.id, params.taskId, {
        by: "banto",
        ...(params.note ? { note: params.note } : {}),
      });
      // I2: 通せなかったことを成功に見せない
      if (!result.ok) throw new Error(`${params.taskId} を通せませんでした: ${result.reason}`);
      return {
        content: [
          {
            type: "text" as const,
            text:
              `通しました: ${params.taskId}。マージキューへ入り、この後マージ前ゲート` +
              "（スコープ違反の検査と検証コマンド）が回ります。",
          },
        ],
        details: { taskId: params.taskId, status: result.status },
      };
    },
  });

  const supersede = defineNamespacedTool({
    name: "kobo.supersede",
    label: "Kobo: Supersede",
    description:
      "積んだタスクを**置き換える**（決定64）。取り込み済みタスクの契約は凍結されていて、" +
      "定義ファイルを直しても変わらない——訂正するときは新しいタスクを積み、元をこれで畳む。" +
      "「監査は何に対して行われたのか」が答えられなくなるので、契約を後から書き換えない。",
    parameters: Type.Object({
      projectTag: Type.String({ description: "どのプロジェクトか" }),
      taskId: Type.String({ description: "置き換えられる（古い）タスクの id" }),
      by: Type.String({ description: "置き換える新しいタスクの id（先に積んでおくこと）" }),
    }),
    async execute(params) {
      const project = requireProject(params.projectTag);
      const result = daemon.transition(project.id, params.taskId, "superseded", params.by);
      if (!result.ok) {
        throw new Error(`${params.taskId} を置き換えられませんでした: ${result.reason}`);
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `${params.taskId} を ${params.by} で置き換えました（職人と検証環境は畳まれます）。`,
          },
        ],
        details: { taskId: params.taskId, supersededBy: params.by },
      };
    },
  });

  return [enqueue, list, task, projects, events, approve, supersede];
}

/**
 * タスク定義ファイルの場所（プロジェクトのリポジトリの中）。
 *
 * **番頭からパスを受け取らない**（決定36g の砦が要らない形）。受けるのは id だけで、
 * 置き場所は規約（`work/tasks/`）で決まる——任意のパスを読ませない。
 */
export function taskFilePath(repoPath: string, taskId: string): string {
  return path.join(repoPath, TASKS_DIR, `${taskId}.md`);
}

/** 積むときの検査つき読み取り。I2: 読めない・形が違う・意図が draft を、それぞれの理由で返す。 */
export function readTaskDefinition(
  repoPath: string,
  taskId: string
): { ok: true; content: string; frontmatter: ReturnType<typeof validateTaskFrontmatter> } | { ok: false; reason: string } {
  // id は規約（task-NNNN）に限る。パス片を混ぜられないようにする
  if (!/^task-\d{4,}$/.test(taskId)) {
    return { ok: false, reason: `id の形が違います（task-NNNN が要ります）: "${taskId}"` };
  }
  const filePath = taskFilePath(repoPath, taskId);
  if (!fs.existsSync(filePath)) {
    return {
      ok: false,
      reason: `定義ファイルがありません: ${path.join(TASKS_DIR, `${taskId}.md`)}（先に書いてください）`,
    };
  }
  const content = fs.readFileSync(filePath, "utf-8");
  const frontmatter = validateTaskFrontmatter(content);
  if (!frontmatter.ok) {
    return { ok: false, reason: `定義ファイルの形が違います: ${frontmatter.reason}` };
  }
  return { ok: true, content, frontmatter };
}

export { taskPayload };
