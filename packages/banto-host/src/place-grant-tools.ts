/**
 * 書き込み許可の要求と承認の Tool（ADR-0010 決定38c・e・task-0042）。
 *
 * **番頭に渡すのは要求だけ。** 承認・拒否・取り消しは `internalTools`——GUI から HTTP では
 * 呼べるが、番頭の Tool 一覧には出ない（決定29e と同じ枠）。これにより「番頭が自分で承認する」
 * ことが機構的に不可能になる（I1：ずるを不可能にする。約束させるのではなく）。
 *
 * 新しい機構は足していない。職人が `worker.ask` で番頭に聞き番頭が答える（決定29b）のと
 * 同じ構図を、1段上に適用しただけ。
 */

import { Type } from "typebox";
import { defineNamespacedTool, type NamespacedToolDefinition } from "./tool-registry.js";
import type { PlaceRegistry } from "./places.js";
import type { PlaceGrantStore } from "./place-grants.js";

/** キャンバスGUI の kind。番頭が `canvas.open` で出せる（a5）。 */
export const PLACE_PERMISSIONS_VIEW_KIND = "place.permissions";

/** 番頭へ渡す Tool。要求できるだけで、決められない。 */
export function createPlaceRequestTools(
  places: PlaceRegistry,
  grants: PlaceGrantStore
): NamespacedToolDefinition[] {
  const request = defineNamespacedTool({
    name: "place.request_write",
    label: "Place: Request Write",
    description:
      "ある場所に書き込む許可をPOに求める。**これは頼むだけで、許可は与えられない**——" +
      "決めるのはPOで、許可されるまで file.write は失敗し続ける。" +
      "書こうとして断られたときや、これから書く必要が分かったときに使う。" +
      "範囲は必要な分だけ狭く求めること（docs/** など）。" +
      "頼んだら canvas.open で place.permissions を開くと、POがその場で許可できる。",
    parameters: Type.Object({
      place: Type.String({ description: "対象の場所 id（place.list で分かる）" }),
      patterns: Type.Array(Type.String(), {
        description: "書きたい範囲（場所のルートからの glob。例: docs/**, work/tasks/*.md）",
        minItems: 1,
      }),
      reason: Type.String({ description: "何のために書くのかを一言で" }),
    }),
    async execute(params) {
      // I2: 知らない場所への要求は受け付けない。承認しても効かない許可が帳簿に残る
      const place = await places.require(params.place);
      const record = grants.request(place.id, params.patterns, params.reason);

      const already = place.writable ?? [];
      return {
        content: [
          {
            type: "text" as const,
            text:
              `${place.label} への書き込みを頼みました（${record.id}）: ${record.patterns.join(", ")}\n` +
              `**まだ書けません。** POが許可するまで file.write は失敗します。\n` +
              (already.length > 0 ? `現在の許可: ${already.join(", ")}` : "現在は読み取り専用です。"),
          },
        ],
        details: { request: record, place: { id: place.id, label: place.label }, current: [...already] },
      };
    },
  });

  return [request];
}

/**
 * GUI から呼ぶ口（番頭には渡さない）。
 *
 * 一覧も内部側に置く。番頭が現在の許可を知る手段は `place.list`（場所ごとの `writable`）で
 * 足りており、**保留中の要求は PO に見せるためのもの**だから——番頭に見せると、
 * 自分の要求が処理待ちであることを根拠に催促する余地を作るだけで、判断材料は増えない。
 */
export function createPlaceGrantAdminTools(grants: PlaceGrantStore): NamespacedToolDefinition[] {
  const list = defineNamespacedTool({
    name: "place.list_requests",
    label: "Place: List Requests",
    description: "書き込み許可の保留中の要求と、いま与えている許可の一覧（GUI用）。",
    parameters: Type.Object({}),
    async execute() {
      const requests = grants.requests();
      const pending = requests.filter((r) => r.state === "pending");
      const current = grants.grants();
      return {
        content: [
          {
            type: "text" as const,
            text: `保留 ${pending.length} 件 / 許可済みの場所 ${Object.keys(current).length} 件`,
          },
        ],
        details: { requests, pending, grants: current },
      };
    },
  });

  const approve = defineNamespacedTool({
    name: "place.approve_write",
    label: "Place: Approve Write",
    description: "書き込み許可の要求を承認する（GUI用）。範囲を狭めて許すこともできる。",
    parameters: Type.Object({
      requestId: Type.String({ description: "承認する要求の id" }),
      patterns: Type.Optional(
        Type.Array(Type.String(), { description: "実際に許す範囲。省略すると要求どおり" })
      ),
    }),
    async execute(params) {
      const record = grants.approve(params.requestId, params.patterns);
      return {
        content: [
          {
            type: "text" as const,
            text: `${record.placeId} に許可しました: ${(record.grantedPatterns ?? []).join(", ")}`,
          },
        ],
        details: { request: record, grants: grants.grants() },
      };
    },
  });

  const deny = defineNamespacedTool({
    name: "place.deny_write",
    label: "Place: Deny Write",
    description: "書き込み許可の要求を断る（GUI用）。",
    parameters: Type.Object({
      requestId: Type.String({ description: "断る要求の id" }),
      note: Type.Optional(Type.String({ description: "番頭へ伝える一言" })),
    }),
    async execute(params) {
      const record = grants.deny(params.requestId, params.note);
      return {
        content: [{ type: "text" as const, text: `${record.placeId} への要求を断りました。` }],
        details: { request: record, grants: grants.grants() },
      };
    },
  });

  const revoke = defineNamespacedTool({
    name: "place.revoke_write",
    label: "Place: Revoke Write",
    description:
      "既に与えた書き込み許可を取り消す（GUI用）。広げすぎたと気づいたときに戻せるようにするため。",
    parameters: Type.Object({
      place: Type.String({ description: "対象の場所 id" }),
      pattern: Type.String({ description: "取り消す範囲（許可の一覧に出ているものと同じ文字列）" }),
    }),
    async execute(params) {
      grants.revoke(params.place, params.pattern);
      return {
        content: [{ type: "text" as const, text: `${params.place} の "${params.pattern}" を取り消しました。` }],
        details: { grants: grants.grants() },
      };
    },
  });

  return [list, approve, deny, revoke];
}
