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

/** 動いている状態（工程の途中にあるもの）。 */
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

/**
 * 既定で見せる状態＝**まだ誰かが見る必要があるもの**（prop-0001 第1段）。
 *
 * **「終わった」と「止まっている」は違う。** `failed` は終端だが、放っておいてよい
 * ものではない——実際に loamium の task-0004 / 0005 はマージ前ゲートで failed に
 * なったまま、誰の既定の視界にも入っていなかった。終端だからと既定から外すと、
 * **落ちたタスクが一番忘れられやすい**という逆の結果になる。
 *
 * 既定から外すのは「片が付いたもの」だけ：`merged` / `closed` / `superseded` /
 * `evaluating`。見たいときは `state: "all"` か状態名で指定する。
 *
 * D5：この線引きは判断なので Kobo が持つ。GUI/CLI は同じ既定を見るだけ
 * ——Surface ごとに違う既定を持つと、番頭と PO が違うものを見ることになる。
 */
const DEFAULT_LIST_STATES = new Set([...ACTIVE_STATES, "failed"]);

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
      "state で絞れる（例: ready / in-review）。**既定はまだ見る必要があるものだけ**" +
      "（動いているもの＋failed）。片が付いたもの（merged / closed / superseded）は " +
      "state: \"all\" か状態名で指定したときだけ出る。",
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

      const matched = projects
        .flatMap((projectTag) => daemon.getTasksByProject(projectTag))
        .filter((task) => {
          if (params.state === "all") return true;
          if (params.state) return task.status === params.state;
          return DEFAULT_LIST_STATES.has(task.status);
        });
      // I2: **切ったことを黙らせない**（task-0068 と同じ形）。終わったタスクは
      // 積み上がる一方（保持期間による削除は未実装）なので、いずれ必ずここに当たる
      const total = matched.length;
      const rows = matched
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
            : "見る必要のあるタスクはありません（片が付いたものは state: \"all\" で出ます）"
          : [
              ...rows.map((r) => `${r.status.padEnd(12)} ${r.taskId} ${r.title}`),
              ...(total > rows.length
                ? [`… 全 ${total} 件のうち ${rows.length} 件（limit を上げれば ${MAX_ROWS} 件まで）`]
                : []),
            ].join("\n");
      return {
        content: [{ type: "text" as const, text }],
        details: { tasks: rows, total, truncated: total > rows.length },
      };
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
          // 担当の職人へ飛べるように（PO要望 2026-08-07）。**画面が組み立てない**
          // ——どのセッションが誰かを知っているのは帳簿だけ
          ...("sessionId" in e && typeof e.sessionId === "string"
            ? { sessionId: e.sessionId }
            : {}),
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
                    : e.type === "task_contract_amended"
                      // **版が読めないと「何に対して監査したか」が答えられない**（task-0082）
                      ? `契約を改訂（${e.amendedBy}）: ${e.changes.join(" / ")}` +
                        (e.auditInvalidated ? "【監査は無効】" : "【監査は有効のまま】")
                      : e.type === "merge_gate_evaluated"
                      // **なぜ落ちたかが読めないと直せない**（task-0081）。
                      // ここが空文字だったので、経緯を見ても番号すら出なかった
                      ? e.passed
                        ? "通過"
                        : `不通過: ${(e.reasons ?? []).join(", ")}`
                      : "",
        }));

      // **レビューの段は Kobo が決める**（決定57・66）。番頭ホストに判定させると、
      // 判定表（プロジェクトの meta/config.yaml）を読めない側が推測することになり、
      // PO 直行のタスクを「あなたが通してよい」と見せてしまう
      const stage = daemon.reviewStageOf(project.id, found);
      // **落ちているなら、なぜ落ちたかまで出す**（task-0081）。
      // 「verify_failed:a4(exit=1)」だけでは直しようがない——番号から先は
      // 検証のログにしか無い。番頭はこれを読んでから reopen を決める
      const failure = found.status === "failed" ? daemon.failureDetail(project.id, params.taskId) : undefined;

      // 決定59: 判断が要るものは**触れる状態**で差し出す。生きている公開URLだけを出す
      const envUrl = daemon.reviewEnvUrl(project.id, params.taskId);
      const scope = (found["scope"] as { paths?: string[] } | undefined)?.paths ?? [];
      const text = [
        `${params.taskId} [${found.status}] ${String(found["title"] ?? "")}`,
        `レビュー: ${stage}${stage === "po" ? "（PO の判断が要る）" : stage === "auto" ? "（人も番頭も見ない）" : "（あなたが一次受け）"}`,
        ...(envUrl ? [`触れる場所: ${envUrl}`] : []),
        scope.length > 0 ? `スコープ: ${scope.join(", ")}` : "",
        "",
        ...history.map((h) => `${h.at} ${h.type}${h.detail ? ` — ${h.detail}` : ""}`),
        ...(failure
          ? [
              "",
              "── なぜ落ちたか ──",
              ...(failure.reason ? [failure.reason] : []),
              ...failure.gateReasons.map((r) => `・${r}`),
              ...failure.logs.flatMap((l) => [``, `[${l.acId}] ${l.dir}`, l.tail]),
              "",
              failure.reopenCount > 0
                ? `※ このタスクは既に ${failure.reopenCount} 回 戻している。` +
                  "同じところで落ち続けているなら、直し方ではなく前提を疑うこと（P6）"
                : "直せるなら kobo.reopen（中身なら rework / 検証環境なら reverify）、" +
                  "どうしようもなければ kobo.abandon で畳む",
            ]
          : []),
      ]
        .filter((line) => line !== "")
        .join("\n");
      return {
        content: [{ type: "text" as const, text }],
        details: {
          task: found,
          reviewStage: stage,
          ...(envUrl ? { envUrl } : {}),
          history,
          ...(failure ? { failure } : {}),
        },
      };
    },
  });

  const registerProject = defineNamespacedTool({
    name: "kobo.register_project",
    label: "Kobo: Register Project",
    description:
      "リポジトリを工場に受け持たせる（統治単位の登録）。**最初に1回だけ**——以後そのリポジトリの" +
      "仕事は積む→ゲート→職人→監査→レビュー→マージの流れに乗る。" +
      "**id は後から変えられない**（帳簿のイベントが全部この名前で残る）ので、短く安定した名前にすること。" +
      "載せる前の確認事項と最初の1本の通し方は SKILL kobo-onboarding にある。",
    parameters: Type.Object({
      projectTag: Type.String({
        description: "統治単位の名前（短く・安定したもの。例: loamium）。後から変えられない",
      }),
      repoPath: Type.String({ description: "リポジトリの絶対パス（登録された場所の中であること）" }),
    }),
    async execute(params) {
      const known = daemon.listProjects().find((p) => p.id === params.projectTag);
      // I2: 既にあるものを黙って上書きしない（置き場所だけ差し替わると帳簿と実体がずれる）
      if (known) {
        if (path.resolve(known.repoPath) === path.resolve(params.repoPath)) {
          return {
            content: [
              { type: "text" as const, text: `${params.projectTag} は既に受け持っています（${known.repoPath}）` },
            ],
            details: { projectTag: known.id, repoPath: known.repoPath, alreadyRegistered: true },
          };
        }
        throw new Error(
          `${params.projectTag} は既に別の場所で登録されています（${known.repoPath}）。` +
            "id は後から変えられません——別の名前を使ってください"
        );
      }
      // I2: 無い場所を受け持たせない。watcher が黙って何も見つけない状態になる
      if (!fs.existsSync(path.join(params.repoPath, ".git"))) {
        throw new Error(
          `${params.repoPath} は Git リポジトリに見えません（.git がありません）。` +
            "工場はブランチを切ってマージするので、Git リポジトリであることが要ります"
        );
      }
      // **検証環境が無いリポジトリは受け持たない**（task-0076・PO裁定 2026-08-07）。
      //
      // Kobo は検証をホストで走らせない（task-0075）ので、プロファイルが無いリポジトリは
      // **最初のマージで必ず落ちる**。登録できてしまうと、そこまで気づけない
      // ——受け持った時点で言う方が、10タスク積んだあとに言うより親切。
      //
      // **確かめるのは検証環境に聞いて**。Kobo がプロファイルの定義を自分で読むと、
      // 同じ定義に2つの解釈ができる（「Kobo は使えると言うのに立たない」・決定60a）
      const wanted = daemon.projectConfigAt(params.repoPath).verify.profile;
      let profiles: { usable: Array<{ name: string }>; rejected: Array<{ name: string; reason: string }> };
      try {
        profiles = await daemon.environmentProfilesAt(params.repoPath);
      } catch (err) {
        // I2: 確かめられなかったことを「確かめた」にしない
        throw new Error(
          `検証環境へ届かないので、${params.projectTag} の検証プロファイルを確かめられません` +
            `（${err instanceof Error ? err.message : String(err)}）。` +
            "banto-environment-pool が起動しているか確かめてください"
        );
      }
      if (!profiles.usable.some((p) => p.name === wanted)) {
        const rejected = profiles.rejected.find((r) => r.name === wanted);
        const others = profiles.usable.map((p) => p.name).join(", ");
        throw new Error(
          `${params.repoPath} に検証プロファイル "${wanted}" がありません。` +
            (rejected ? `（あるが使えない: ${rejected.reason}）` : "") +
            (others ? `\n使えるもの: ${others}` : "") +
            "\n**Kobo は検証をホストで走らせません**（決定：environment pool 必須）。" +
            "meta/environments.yaml にプロファイルを1つ書いてください——" +
            "名前を変えるなら meta/config.yaml の verify.profile も。書き方は SKILL environment-profiles。"
        );
      }

      const entry = daemon.registerProject(params.projectTag, params.repoPath);
      return {
        content: [
          {
            type: "text" as const,
            text:
              `受け持ちました: ${entry.id}（${entry.repoPath}）。\n` +
              "次は work/tasks/ にタスク定義を書いて kobo.enqueue で積みます（SKILL kobo-onboarding）。",
          },
        ],
        details: { projectTag: entry.id, repoPath: entry.repoPath, alreadyRegistered: false },
      };
    },
  });

  const projects = defineNamespacedTool({
    name: "kobo.projects",
    label: "Kobo: Projects",
    description:
      "工場が受け持っているプロジェクト（統治単位）の一覧。タスクを積む前に、" +
      "そのリポジトリが登録されているかを確かめるのに使う。" +
      "載っていなければ kobo.register_project で受け持たせる。",
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

  /**
   * 落ちたタスクを**同じタスクのまま**動かし直す（task-0081・PO 要望 2026-08-08）。
   *
   * **切り直させないための道具**。落ちるたびに新しいタスクを立てると、同じ依頼が
   * task-0004 → task-0005 → … と増え、経緯が分断される（実機でそうなった）。
   */
  const reopen = defineNamespacedTool({
    name: "kobo.reopen",
    label: "Kobo: Reopen",
    description:
      "落ちたタスクを**同じタスクのまま**動かし直す。**タスクを切り直さない**" +
      "——新しく積み直すと経緯が分断され、何度目の挑戦か分からなくなる。" +
      "**先に kobo.task で「なぜ落ちたか」を読むこと。** 落ちた理由で戻す先が変わる：" +
      "中身の問題（スコープ違反・本当にテストが落ちる）なら rework（職人が直す）、" +
      "検証環境の問題（環境が立たない・道具が無い）なら reverify（中身は触らずゲートを回し直す）。" +
      "どうしようもないものは kobo.abandon で畳む。",
    parameters: Type.Object({
      projectTag: Type.String({ description: "どのプロジェクトか" }),
      taskId: Type.String({ description: "戻すタスクの id" }),
      mode: Type.Union([Type.Literal("rework"), Type.Literal("reverify")], {
        description:
          "rework=中身から直す（職人を起こす）/ reverify=中身は触らずマージ前ゲートを回し直す",
      }),
      reason: Type.String({
        description: "**何が悪くて、どう直すのか**。職人にそのまま渡り、帳簿にも残る",
      }),
      origin: Type.Optional(
        Type.String({
          description:
            "知らせの宛先（スレッド）。**番頭は書かない**——束ねる層が固定する（決定58）",
        })
      ),
    }),
    async execute(params) {
      requireProject(params.projectTag);
      const r = await daemon.reopenTask(params.projectTag, params.taskId, {
        mode: params.mode,
        reason: params.reason,
        by: "banto",
        // 宛先の無いタスク（ファイルから取り込んだもの）は、ここで初めて宛先が付く
        ...(params.origin ? { origin: params.origin } : {}),
      });
      // I2: 戻せなかったことを成功に見せない
      if (!r.ok) throw new Error(r.reason);
      return {
        content: [
          {
            type: "text" as const,
            text:
              `${params.taskId} を ${r.to} へ戻しました（${params.mode}）。` +
              (params.mode === "rework"
                ? "職人を起こしています——落ちた理由と指示は渡してあります"
                : "マージ前ゲートをもう一度回します（中身は触っていません）"),
          },
        ],
        details: { taskId: params.taskId, projectTag: params.projectTag, to: r.to, mode: params.mode },
      };
    },
  });

  /**
   * どうしようもないものを、**落ちたまま畳む**（task-0081・PO 要望 2026-08-08）。
   */
  const abandon = defineNamespacedTool({
    name: "kobo.abandon",
    label: "Kobo: Abandon",
    description:
      "落ちたタスクを**畳む**（諦める）。直せる見込みが無いときだけ。" +
      "**記録は消えない**——経緯には落ちたことも畳んだ理由も残る。" +
      "畳むと既定の一覧から外れるので、「まだ見る必要がある」ふりをしなくなる。" +
      "直せるなら先に kobo.reopen を考えること。",
    parameters: Type.Object({
      projectTag: Type.String({ description: "どのプロジェクトか" }),
      taskId: Type.String({ description: "畳むタスクの id" }),
      reason: Type.String({ description: "**なぜ諦めるのか**。帳簿に残る" }),
    }),
    async execute(params) {
      requireProject(params.projectTag);
      const r = daemon.abandonTask(params.projectTag, params.taskId, {
        reason: params.reason,
        by: "banto",
      });
      if (!r.ok) throw new Error(r.reason);
      return {
        content: [
          { type: "text" as const, text: `${params.taskId} を畳みました（落ちたまま・理由は帳簿に残ります）` },
        ],
        details: { taskId: params.taskId, projectTag: params.projectTag, status: "closed" },
      };
    },
  });

  /**
   * 契約を改訂する（task-0082・**決定64 の改訂**・PO 裁定 2026-08-08）。
   */
  const amend = defineNamespacedTool({
    name: "kobo.amend",
    label: "Kobo: Amend",
    description:
      "積んだあとの契約を**訂正する**。定義ファイルを直してから呼ぶ——**呼ばないと反映されない**" +
      "（watcher は取り込み済みのファイルを読み飛ばす）。" +
      "**いちばん効くのは検証コマンドの訂正**：受け入れ基準そのものは正しいのに `verify` の" +
      "書き方だけ間違っていた、という場合、基準は動いていないので**監査はやり直しになりません**。" +
      "基準（`acceptance[].text`）やスコープを変えると監査は無効になり implementing へ戻ります。" +
      "**緩める方向（スコープにパスを足す・基準を変える・条件を消す）は PO の判断**なので、" +
      "あなたには通せません——取次へ上げてください。**意味としては狭いスコープでも、" +
      "いまの一覧に無い文字列を足すなら PO 扱い**です（glob の広い／狭いは文字列では解けないので、" +
      "厳しすぎる側に倒しています）。",
    parameters: Type.Object({
      projectTag: Type.String({ description: "どのプロジェクトか" }),
      taskId: Type.String({ description: "訂正するタスクの id" }),
      reason: Type.String({
        description: "**なぜ訂正するのか**。帳簿に残り、あとから「何に対して監査したか」を辿る材料になる",
      }),
    }),
    async execute(params) {
      requireProject(params.projectTag);
      const r = daemon.amendTask(params.projectTag, params.taskId, {
        reason: params.reason,
        by: "banto",
      });
      // I2: 通せなかったことを成功に見せない
      if (!r.ok) throw new Error(r.reason);
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `${params.taskId} の契約を改訂しました:`,
              ...r.changes.map((c) => `・${c}`),
              r.auditInvalidated
                ? "**基準が変わったので監査はやり直し**です（implementing へ戻しました）"
                : "基準は変わっていないので**監査はそのまま有効**です（マージ前ゲートで新しい検証が走ります）",
            ].join("\n"),
          },
        ],
        details: {
          taskId: params.taskId,
          projectTag: params.projectTag,
          changes: r.changes,
          auditInvalidated: r.auditInvalidated,
        },
      };
    },
  });

  return [
    enqueue, list, task, projects, events, approve, supersede, registerProject,
    reopen, abandon, amend,
  ];
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
