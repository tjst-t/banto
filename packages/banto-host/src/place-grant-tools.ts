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
import type { Inbox } from "./inbox.js";

/** 書き込み許可を出す設定の区画（決定75）。取次の一通がここへ導く。 */
export const PLACE_SETTINGS_SECTION = "places";

/** 広すぎる範囲。積む札にそのまま出す（決定38e：押す前に見えるようにする）。 */
const BROAD = new Set(["**", "**/*", "*"]);

export interface PlaceRequestToolOptions {
  /**
   * 取次（決定73）。渡すと、番頭の要求がそのままPOの判断待ちとして積まれる。
   *
   * **これが無いと、頼んだことに PO が気づけない。** 以前は要求が帳簿に載るだけで、
   * 番頭が `canvas.open` で許可の面を出さない限り画面に何も出なかった——
   * 「判断を求めるものは全部ここに集まる」（決定58）から外れていた唯一の口だった。
   */
  inbox?: Inbox;
}

/** 番頭へ渡す Tool。要求できるだけで、決められない。 */
export function createPlaceRequestTools(
  places: PlaceRegistry,
  grants: PlaceGrantStore,
  options: PlaceRequestToolOptions = {}
): NamespacedToolDefinition[] {
  const request = defineNamespacedTool({
    name: "place.request_write",
    label: "Place: Request Write",
    description:
      "ある場所に書き込む許可をPOに求める。**これは頼むだけで、許可は与えられない**——" +
      "決めるのはPOで、許可されるまで file.write は失敗し続ける。" +
      "書こうとして断られたときや、これから書く必要が分かったときに使う。" +
      "範囲は必要な分だけ狭く求めること（docs/** など）。" +
      "頼むと**取次に判断待ちとして積まれ、POはその場のボタンで許せる**——" +
      "面を開かせる必要はない。答えが出たらこちらへ知らせが入るので、それまで待つこと。",
    parameters: Type.Object({
      place: Type.String({ description: "対象の場所 id（place.list で分かる）" }),
      patterns: Type.Array(Type.String(), {
        description: "書きたい範囲（場所のルートからの glob。例: docs/**, work/tasks/*.md）",
        minItems: 1,
      }),
      reason: Type.String({ description: "何のために書くのかを一言で" }),
      threadId: Type.Optional(
        Type.String({
          description: "（ホストが埋める。書かないこと）判断待ちを届ける会話",
        })
      ),
    }),
    async execute(params) {
      // I2: 知らない場所への要求は受け付けない。承認しても効かない許可が帳簿に残る
      const place = await places.require(params.place);
      const record = grants.request(place.id, params.patterns, params.reason);

      const already = place.writable ?? [];
      const posted = options.inbox
        ? options.inbox.post({
            // 同じ要求で札を積み増さない。帳簿側の重複排除（同じ場所・同じ範囲なら
            // 同じ id が返る）とここが噛み合って、頼み直しても札は1枚のまま
            key: `place-grant:${record.id}`,
            source: { id: "place", label: "書き込み許可" },
            kind: "番頭では決められない",
            rule: "D1",
            title: `${place.label} の ${record.patterns.join(", ")} に書かせてほしい`,
            why: record.reason,
            what:
              already.length > 0
                ? `いま許しているのは ${already.join(", ")} です。要求はこの外側にあります。`
                : `${place.label}（${place.path}）は読み取り専用です。`,
            ask: record.patterns.some((p) => BROAD.has(p))
              ? "**この範囲はその場所の全体に及びます**（.git/ と Banto のデータ置き場を除く）。この範囲で許しますか。"
              : "この範囲で書くことを許しますか。範囲を狭めたいときは設定から決められます。",
            actions: [
              {
                id: "approve",
                label: "この範囲で許す",
                tone: "call",
                // 決定73: 押されたらホストが承認の口を呼ぶ。番頭は自分では呼べないまま
                effect: {
                  module: "workspace",
                  tool: "place.approve_write",
                  args: { requestId: record.id },
                },
              },
              {
                id: "deny",
                label: "断る",
                tone: "quiet",
                effect: {
                  module: "workspace",
                  tool: "place.deny_write",
                  args: { requestId: record.id },
                },
              },
            ],
            opens: {
              ...(params.threadId ? { threadId: params.threadId } : {}),
              // 範囲を狭める・共通の許可にする、はボタンでは表せない。設定へ逃がす
              settings: { section: PLACE_SETTINGS_SECTION },
            },
          })
        : undefined;

      return {
        content: [
          {
            type: "text" as const,
            text:
              `${place.label} への書き込みを頼みました（${record.id}）: ${record.patterns.join(", ")}\n` +
              `**まだ書けません。** POが許可するまで file.write は失敗します。\n` +
              (posted
                ? "取次に判断待ちとして積みました。**答えが出るまでこの件は進めないでください**——" +
                  "決まったら知らせが入ります。\n"
                : "") +
              (already.length > 0 ? `現在の許可: ${already.join(", ")}` : "現在は読み取り専用です。"),
          },
        ],
        details: {
          request: record,
          place: { id: place.id, label: place.label },
          current: [...already],
          ...(posted ? { inboxId: posted.id } : {}),
        },
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
export function createPlaceGrantAdminTools(
  grants: PlaceGrantStore,
  places?: PlaceRegistry
): NamespacedToolDefinition[] {
  const list = defineNamespacedTool({
    name: "place.list_requests",
    label: "Place: List Requests",
    description:
      "書き込み許可の保留中の要求・いま与えている許可・全場所共通の許可、" +
      "および登録されている場所の一覧（GUI用）。設定画面はここ1つから描く。",
    parameters: Type.Object({}),
    async execute() {
      const requests = grants.requests();
      const pending = requests.filter((r) => r.state === "pending");
      const current = grants.grants();
      const global = [...grants.globalWritable()];
      // 場所の一覧も同じ口から返す。**画面が2つの口を突き合わせずに済むように**
      // ——「いま何が書けるか」は場所の実効値で、承認の帳簿だけでは言えない
      const registered = places
        ? (await places.list()).map((p) => ({
            id: p.id,
            label: p.label,
            path: p.path,
            writable: [...(p.writable ?? [])],
          }))
        : [];
      return {
        content: [
          {
            type: "text" as const,
            text:
              `保留 ${pending.length} 件 / 許可済みの場所 ${Object.keys(current).length} 件` +
              (global.length > 0 ? ` / 共通の許可 ${global.join(", ")}` : ""),
          },
        ],
        details: { requests, pending, grants: current, global, places: registered },
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

  const setGlobal = defineNamespacedTool({
    name: "place.set_global_write",
    label: "Place: Set Global Write",
    description:
      "**登録された全ての場所**で書ける範囲を差し替える（GUI用・決定74）。" +
      "「どのリポジトリでも docs/** は書いてよい」のような、場所ごとに決める意味の無い許可のため。" +
      "足すのではなく置き換えるので、空の配列を渡すと共通の許可は無くなる。",
    parameters: Type.Object({
      patterns: Type.Array(Type.String(), {
        description: "全場所で許す範囲（glob）。空にすると共通の許可を無くす",
      }),
    }),
    async execute(params) {
      const next = grants.setGlobal(params.patterns);
      return {
        content: [
          {
            type: "text" as const,
            text:
              next.length === 0
                ? "全場所共通の許可を無くしました。"
                : `全場所共通で許す範囲: ${next.join(", ")}`,
          },
        ],
        details: { global: next },
      };
    },
  });

  return [list, approve, deny, revoke, setGlobal];
}
