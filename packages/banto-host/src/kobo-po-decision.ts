/**
 * 取次の札で PO が出した答えを、**PO の権限のまま工場へ届ける橋**（ADR-0023 決定113）。
 *
 * **困っていたこと**（imp-0034・dentaku task-0007 で実地に踏んだ）。`review: po` のタスクは
 * 決定57 により番頭が通せない。番頭は `inbox.post`（`canvasKind: "kobo.review"`）で PO に
 * 判断を仰ぎ、PO は札の選択肢を押して答える——**ところがその答えは工場へ一切流れなかった**。
 *
 *   - PO は札に「通す（マージへ）」と答えた
 *   - 工場の状態は `review-ready` のまま。イベントが1本も増えない
 *   - 番頭が `kobo.approve` を呼ぶと 500（「番頭は通せません」）
 *
 * **三すくみ**で、そのタスクは永久に動かない。
 *
 * **直し方は口を増やすことではない。** PO 専用の口は工場の HTTP 面に既にある
 * （`POST {koboUrl}/projects/:proj/tasks/:id/po-decision`）。足りなかったのは
 * **札の回答からそこへ至る結線**だけで、ここがそれ。
 *
 * **承認専用にしない**（PO要望 2026-08-15）。橋が運ぶのは「PO がどう答えたか」であって
 * 承認ではない——差し戻しも同じ橋を渡る。`kobo.amend` のように `by: "banto"` を直書き
 * している道具も、`decision` を1つ足せば同じ橋に乗せられる。**緩める向きの契約改訂
 * （task-0273）も同じ橋で届ける**——`kobo.amend` が `by: "po"` を渡せない以上、
 * PO の判断を工場の `po-decision`（`decision: "amend"`）へ届けて `amendTask(by: "po")`
 * に結ぶのは、この橋の役目である。
 *
 * **決定57 はどこで守られるか**：
 *
 *   - この Tool は `internalTools` に入る。`ModuleRegistry.tools()` は `module.tools` しか
 *     返さないので、**番頭（LLM）の在庫にも提示にも載らない**——モデルからは呼べない
 *   - 番頭に渡っている `kobo.approve` は今までどおり `by: "banto"` しか渡さず、
 *     `po` 段のタスクを断り続ける（`Daemon.approveTask`）
 *   - 押すのは PO。ホストは `InboxEffect` として**押されたときにだけ**呼ぶ
 *   - 誰の・どの札のどの回答で動いたかは `via` として工場の帳簿に残る
 *
 * D5: 判断は無い。通せるか・戻せるか・改訂できるかを決めるのは工場（レビュー段の判定・
 *     amendTask の by 判定を持つ）。
 * D6: node の fetch のみ。
 */

import { Type } from "typebox";
import { StringEnum, defineNamespacedTool, type NamespacedToolDefinition } from "@banto/core";
import type { TaskContractAmendment } from "@banto/daemon";
import type { Inbox, InboxEffect } from "./inbox.js";

/** 工場が出しているレビュー面の kind。この札だけが工場の判断へ結ばれる。 */
export const KOBO_REVIEW_CANVAS_KIND = "kobo.review";

/** 契約の改訂を PO に確認する面の kind（task-0273）。 */
export const KOBO_AMEND_CANVAS_KIND = "kobo.amend";

/** PO の判断を届ける口の論理名（番頭には渡さない）。 */
export const KOBO_PO_DECIDE_TOOL = "kobo.po_decide";

/** `originArg` に使う名前。工場の帳簿へ `via` として残る。 */
const VIA_ARG = "via";

/**
 * 橋が運べる判断。増やすときは工場の口（`po-decision`）と対で足す。
 * `amend` は**緩める向きの契約改訂を適用してよい**という PO の承認（task-0273）。
 */
export type KoboPoDecision = "approve" | "send_back" | "amend";

/** 札に添えられた面の指定から、判断を届ける先のタスクを読む。 */
function koboTarget(
  canvasKind: string | undefined,
  canvasParams: Record<string, unknown> | undefined
): { projectTag: string; taskId: string } | undefined {
  const projectTag = canvasParams?.["projectTag"];
  const taskId = canvasParams?.["taskId"];
  if (typeof projectTag !== "string" || !projectTag) return undefined;
  if (typeof taskId !== "string" || !taskId) return undefined;
  return { projectTag, taskId };
}

/**
 * `canvasParams` は `kobo.review` の面がそのまま受け取るもの（`projectTag` / `taskId`）。
 * **D3: 別に持たない**——札に既に載っている値を使い、番頭に同じことを二度書かせない。
 */
export function koboReviewTarget(
  canvasKind: string | undefined,
  canvasParams: Record<string, unknown> | undefined
): { projectTag: string; taskId: string } | undefined {
  if (canvasKind !== KOBO_REVIEW_CANVAS_KIND) return undefined;
  return koboTarget(canvasKind, canvasParams);
}

/** `kobo.amend` の面（task-0273）。レビューの面とは kind で分ける。 */
export function koboAmendTarget(
  canvasKind: string | undefined,
  canvasParams: Record<string, unknown> | undefined
): { projectTag: string; taskId: string } | undefined {
  if (canvasKind !== KOBO_AMEND_CANVAS_KIND) return undefined;
  return koboTarget(canvasKind, canvasParams);
}

/**
 * 「この選択肢が押されたら、工場へこう答える」を表す効果を作る。
 *
 * 番頭が書けるのは**どの選択肢がどの判断に当たるか**だけで、呼ぶ先はここが決める
 * ——`InboxEffect` をそのまま番頭に書かせると、札を経由して任意の内部の口を
 * 叩けることになる（決定73 が `inbox.post` に `effect` を出していない理由）。
 *
 * `decision: "amend"` のときは、契約の改訂（`changes`）と適用理由（`detail`）も運ぶ
 * （task-0273）。工場の `amendTask(by: "po")` は**引数で渡された改訂だけ**を適用し、
 * 緩める向きであっても PO の判断として通してよい。
 */
export function koboPoDecisionEffect(
  target: { projectTag: string; taskId: string },
  decision: KoboPoDecision,
  detail?: string,
  changes?: TaskContractAmendment
): InboxEffect {
  return {
    module: "kobo",
    tool: KOBO_PO_DECIDE_TOOL,
    args: {
      projectTag: target.projectTag,
      taskId: target.taskId,
      decision,
      // 差し戻しの理由は職人にそのまま渡る。承認の note / 改訂の理由も同じ場所に入る
      ...(detail ? { detail } : {}),
      // 改訂の承認は、何を・なぜ直すのか（契約の改訂）を共に運ぶ
      ...(decision === "amend" && changes ? { changes } : {}),
    },
    // 出どころ（`in-xxxxxxxx#approve`）は押された時にホストが埋める
    originArg: VIA_ARG,
  };
}

/**
 * 工場の PO 専用の口を叩くだけの口（番頭には渡さない）。
 *
 * `{koboUrl}` は `http://127.0.0.1:4500/api/kobo` の形。Tool の名前空間（`/tools/*`）の
 * **外**にある面なので、番頭ホストの中継（`createRemoteRelay`）はここを通す一方、
 * 写しの `execute` が呼ぶ `/tools/*` とは経路が分かれている。
 *
 * I2: 届かない・断られたことを「効いた」で包まない。理由をそのまま投げ、
 *     取次は札を畳まない（PO はもう一度押せる）。
 */
export function createKoboPoDecisionTool(
  koboUrl: string,
  fetchImpl: typeof fetch = fetch
): NamespacedToolDefinition {
  return defineNamespacedTool({
    name: KOBO_PO_DECIDE_TOOL,
    label: "Kobo: PO の判断を届ける",
    description:
      "PO が画面で押した判断（通す／差し戻す／契約の改訂を適用する）を工場の帳簿へ書く" +
      "（`by: \"po\"`）。**番頭には渡さない**——決定57 により、PO 必須のタスクを通せるのは" +
      " PO 本人の操作だけ。緩める向きの契約改訂も、PO の判断としてここで適用される（task-0273）。",
    parameters: Type.Object({
      projectTag: Type.String(),
      taskId: Type.String(),
      decision: StringEnum(["approve", "send_back", "amend"] as const),
      [VIA_ARG]: Type.String({ description: "どの札のどの回答から来た判断か" }),
      detail: Type.Optional(
        Type.String({
          description:
            "通すなら何を見て良しとしたか、戻すなら何が駄目でどう直すのか、" +
            "改訂ならなぜ直すのか",
        })
      ),
      changes: Type.Optional(
        Type.Object(
          {
            title: Type.Optional(Type.String()),
            body: Type.Optional(Type.String()),
            scope: Type.Optional(Type.Object({ paths: Type.Array(Type.String()) })),
            acceptance: Type.Optional(
              Type.Array(Type.Object({ id: Type.String(), text: Type.String(), verify: Type.Optional(Type.String()) }))
            ),
            environment: Type.Optional(Type.String()),
            model_tier: Type.Optional(StringEnum(["reasoning", "standard", "fast"])),
            review: Type.Optional(Type.Object({ policy: StringEnum(["auto", "banto", "po", "manual"]) })),
          },
          { description: "decision: \"amend\" のときに適用する契約の改訂" }
        )
      ),
    }),
    async execute(params) {
      const url =
        `${koboUrl.replace(/\/$/, "")}/projects/${encodeURIComponent(params.projectTag)}` +
        `/tasks/${encodeURIComponent(params.taskId)}/po-decision`;
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: params.decision,
          via: params[VIA_ARG],
          // 通すときは判断の記録（note）、戻すときは職人へ渡す指摘（reason）、
          // 改訂のときは適用理由（reason）と適用する中身（changes）
          ...(params.decision === "approve" && params.detail
            ? { note: params.detail }
            : params.decision === "amend"
              ? { reason: params.detail ?? "PO が改訂を承認", changes: params.changes }
              : params.detail
                ? { reason: params.detail }
                : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        state?: string;
      };
      if (!res.ok) {
        throw new Error(
          `工場が ${params.taskId} の判断を受け付けませんでした: ` +
            `${body.message ?? body.error ?? res.statusText}`
        );
      }
      const state =
        body.state ??
        (params.decision === "approve"
          ? "approved"
          : params.decision === "amend"
            ? "implementing"
            : "implementing");
      return {
        content: [
          {
            type: "text" as const,
            text:
              params.decision === "approve"
                ? `${params.projectTag}/${params.taskId} を PO として通しました` +
                  `（いまの状態: ${state}）。この後マージ前ゲートが回ります。`
                : params.decision === "amend"
                  ? `${params.projectTag}/${params.taskId} の契約改訂を PO として適用しました` +
                    `（いまの状態: ${state}）。基準が動いたので監査はやり直しです。`
                  : `${params.projectTag}/${params.taskId} を PO として差し戻しました` +
                    `（いまの状態: ${state}）。指摘は職人へ渡してあります。`,
          },
        ],
        details: { taskId: params.taskId, decision: params.decision, state },
      };
    },
  }) as NamespacedToolDefinition;
}

/**
 * タスクが終端（supersede / settle / abandon / close）に入ったとき、そのタスクに紐づく
 * 未解決の取次を**自動で古い札として畳む**（task-0273・穴2）。
 *
 * **黙って消さない。** `Inbox.resolveStale` が履歴に `stale:<marker>` として残すので、
 * あとから「どの札が、なぜ古くなったか」が追える。
 *
 * 対象は、`opens.canvas.params` に `projectTag` / `taskId` を持つ未解決の札（Kobo の
 * レビュー面・改訂面はどちらもここに載せる）。それ以外の札（別のタスク・会話にだけ
 * 紐づくもの）は触らない。`marker` は終端の状態名（`superseded` / `closed`）を渡す。
 *
 * 戻り値は畳んだ札の id 一覧（テストや動作確認に使う。D5: 判断は無い）。
 */
export function resolveStaleInboxForTask(
  inbox: Inbox,
  projectTag: string,
  taskId: string,
  marker: string
): string[] {
  const closed: string[] = [];
  for (const item of inbox.list()) {
    if (item.resolvedAt) continue;
    const params = item.opens?.canvas?.params;
    if (!params || params["projectTag"] !== projectTag || params["taskId"] !== taskId) continue;
    inbox.resolveStale(item.id, marker);
    closed.push(item.id);
  }
  return closed;
}

/** `kobo.list` が `details.tasks` に載せる、スイープに足る1行分の形。 */
export interface TerminalTaskRow {
  taskId: string;
  projectTag: string;
  status: string;
}

/**
 * 終端と見なして掃く状態（task-0276）。
 *
 * settle / abandon / close はいずれも工場では `status: "closed"` になるため、ここに列挙する
 * 2状態で「closed / superseded / settled」のすべてに届く。生きているタスク（queued /
 * gating / implementing / auditing / review-ready / merging / approved）はここに入らないので、
 * 判断待ちの札は巻き込まれない（a2）。
 */
const TERMINAL_STATES = ["closed", "superseded"] as const;

/**
 * 起動時スイープ: **仕組導入前に残った stale 取次をまとめて掃く**（task-0276）。
 *
 * task-0273（`resolveStaleInboxForTask`）は「今後タスクが終端遷移したイベント」が来たとき
 * にしか発火しない——task-0270 / task-0271 などはその仕組の導入前に閉じたので、紐づく
 * 取次（PO レビュー依頼・amend 依頼）が誰にも解決されずに残っていた。PO UI で
 * 「通す／差し戻す」を押しても、タスクが review-ready でないためエラーになる。
 *
 * ここは起動時に一度だけ、工場が終端としているタスクを**全部**挙げ、それぞれに紐づく
 * 未解決の取次を `resolveStaleInboxForTask`（`Inbox.resolveStale`）で「古い」として畳む。
 *
 * **黙って消さない**（I2）。解決の記録は取次の履歴に `stale:<状態>` として残るので、
 * あとから「どの札が、なぜ古くなったか」が追える（a3）。
 *
 * `listTerminalTasks` は呼び出し側（bin.ts）が `kobo.list`（`state` を指定）に結ぶ。
 * **引けなかったことを「掃けた」で包まない**——ログに残して起動は止めず、次に起動した
 * ときに掃き直す（I2）。
 *
 * 戻り値は畳んだ札の id 一覧（テストや動作確認に使う。D5: 判断は無い）。
 */
export async function sweepStaleInboxForTerminalTasks(
  inbox: Inbox,
  listTerminalTasks: (state: string) => Promise<TerminalTaskRow[]>,
  log: (message: string) => void = () => {}
): Promise<string[]> {
  const resolved: string[] = [];
  for (const state of TERMINAL_STATES) {
    let tasks: TerminalTaskRow[];
    try {
      tasks = await listTerminalTasks(state);
    } catch (err) {
      log(`[banto] ${state} タスクの残存取次スイープが引けませんでした: ${String(err)}`);
      continue;
    }
    for (const task of tasks) {
      // marker はタスクの現状（settled / abandoned は status: "closed"）——履歴に残る理由。
      // `status` を信用せず空なら state を代わりに使う（空行から掛け離れないように）
      resolved.push(
        ...resolveStaleInboxForTask(inbox, task.projectTag, task.taskId, task.status || state)
      );
    }
  }
  return resolved;
}
