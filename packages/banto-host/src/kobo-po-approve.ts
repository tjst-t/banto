/**
 * 取次の札で PO が出した「マージしてよい」を、Kobo の承認まで届かせる（ADR-0023 決定113）。
 *
 * **困っていたこと**（imp-0034）。`review.policy: po` のタスクは決定57 により番頭が通せない。
 * 番頭は `inbox.post`（`canvasKind: "kobo.review"`）で PO に判断を仰ぎ、PO は札の選択肢を
 * 押して「マージしてよい」と答える——**ところがその答えは Kobo の帳簿へ一切流れなかった**。
 * PO はレビュー面をもう一度開いて承認ボタンを押す二度手間を踏んでいた。
 *
 * **直し方は口を増やすことではない。** PO 専用の承認口は Kobo の HTTP 面に既にある
 * （`POST {koboUrl}/projects/:proj/tasks/:id/approve`）。足りなかったのは
 * **札の回答からそこへ至る結線**だけで、ここがそれ。
 *
 * **決定57 はどこで守られるか**（ADR-0023 決定113）：
 *
 *   - この Tool は `internalTools` に入る。`ModuleRegistry.tools()` は `module.tools` しか
 *     返さないので、**番頭（LLM）の在庫にも提示にも載らない**——モデルからは呼べない
 *   - 番頭に渡っている `kobo.approve` は今までどおり `by: "banto"` しか渡さず、
 *     `po` 段のタスクを断り続ける（`Daemon.approveTask`）
 *   - 押すのは PO。ホストは `InboxEffect` として**押されたときにだけ**呼ぶ
 *   - 誰の・どの札のどの回答で通ったかは `via` として Kobo の帳簿に残る
 *
 * D5: 判断は無い。承認できるかを決めるのは `Daemon.approveTask`（レビュー段の判定を持つ）。
 * D6: node の fetch のみ。
 */

import { Type } from "typebox";
import { defineNamespacedTool, type NamespacedToolDefinition } from "@banto/core";
import type { InboxEffect } from "./inbox.js";

/** Kobo が出しているレビュー面の kind。この札だけが承認へ結ばれる。 */
export const KOBO_REVIEW_CANVAS_KIND = "kobo.review";

/** PO 承認を効かせる口の論理名（番頭には渡さない）。 */
export const KOBO_PO_APPROVE_TOOL = "kobo.po_approve";

/** `originArg` に使う名前。Kobo の帳簿へ `task_approved.via` として残る。 */
const VIA_ARG = "via";

/**
 * 札に添えられた面の指定から、承認先のタスクを読む。
 *
 * `canvasParams` は `kobo.review` の面がそのまま受け取るもの（`projectTag` / `taskId`）。
 * **D3: 別に持たない**——札に既に載っている値を使い、番頭に同じことを二度書かせない。
 */
export function koboReviewTarget(
  canvasKind: string | undefined,
  canvasParams: Record<string, unknown> | undefined
): { projectTag: string; taskId: string } | undefined {
  if (canvasKind !== KOBO_REVIEW_CANVAS_KIND) return undefined;
  const projectTag = canvasParams?.["projectTag"];
  const taskId = canvasParams?.["taskId"];
  if (typeof projectTag !== "string" || !projectTag) return undefined;
  if (typeof taskId !== "string" || !taskId) return undefined;
  return { projectTag, taskId };
}

/**
 * 「この選択肢が押されたら Kobo で通す」を表す効果を作る。
 *
 * 番頭が書けるのは**どの選択肢が承認に当たるか**だけで、呼ぶ先はここが決める
 * ——`InboxEffect` をそのまま番頭に書かせると、札を経由して任意の内部の口を
 * 叩けることになる（決定73 が `inbox.post` に `effect` を出していない理由）。
 */
export function koboApproveEffect(target: {
  projectTag: string;
  taskId: string;
}): InboxEffect {
  return {
    module: "kobo",
    tool: KOBO_PO_APPROVE_TOOL,
    args: { projectTag: target.projectTag, taskId: target.taskId },
    // 出どころ（`in-xxxxxxxx#approve`）は押された時にホストが埋める
    originArg: VIA_ARG,
  };
}

/**
 * Kobo の PO 専用の承認口を叩くだけの口（番頭には渡さない）。
 *
 * `{koboUrl}` は `http://127.0.0.1:4500/api/kobo` の形。Tool の名前空間（`/tools/*`）の
 * **外**にある面なので、番頭ホストの中継（`createRemoteRelay`）はここを通す一方、
 * 写しの `execute` が呼ぶ `/tools/*` とは経路が分かれている。
 *
 * I2: 届かない・断られたことを「効いた」で包まない。理由をそのまま投げ、
 *     取次は札を畳まない（PO はもう一度押せる）。
 */
export function createKoboPoApproveTool(
  koboUrl: string,
  fetchImpl: typeof fetch = fetch
): NamespacedToolDefinition {
  return defineNamespacedTool({
    name: KOBO_PO_APPROVE_TOOL,
    label: "Kobo: PO として通す",
    description:
      "PO が画面で押した「通してよい」を Kobo の帳簿へ書く（`approvedBy: \"po\"`）。" +
      "**番頭には渡さない**——決定57 により、PO 必須のタスクを通せるのは PO 本人の操作だけ。",
    parameters: Type.Object({
      projectTag: Type.String(),
      taskId: Type.String(),
      [VIA_ARG]: Type.String({ description: "どの札のどの回答から来た承認か" }),
      note: Type.Optional(Type.String()),
    }),
    async execute(params) {
      const url =
        `${koboUrl.replace(/\/$/, "")}/projects/${encodeURIComponent(params.projectTag)}` +
        `/tasks/${encodeURIComponent(params.taskId)}/approve`;
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          via: params[VIA_ARG],
          ...(params.note ? { note: params.note } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        state?: string;
      };
      if (!res.ok) {
        throw new Error(
          `工場が ${params.taskId} を通しませんでした: ${body.message ?? body.error ?? res.statusText}`
        );
      }
      return {
        content: [
          {
            type: "text" as const,
            text:
              `${params.projectTag}/${params.taskId} を PO として通しました` +
              `（いまの状態: ${body.state ?? "approved"}）。この後マージ前ゲートが回ります。`,
          },
        ],
        details: { taskId: params.taskId, state: body.state ?? "approved" },
      };
    },
  }) as NamespacedToolDefinition;
}
