/**
 * 既存の Tool を「場所」に対応させる薄い層（ADR-0010 決定36e・task-0038）。
 *
 * `file.*` / `git.*` は「1つのルートを閉じ込めた道具」として書かれている
 * （`createFileTools(root)` / `createGitTools(repoRoot)`）。番頭が複数リポジトリを
 * 相手にするようになっても、**その中身は正しいまま**——変わるのは「どのルートか」だけ。
 *
 * そこで**ツール本体には手を入れず**、呼び出しごとに場所を解決してルートを差し替える。
 * `file-tools.ts` / `git-tools.ts` は1行も変わらない（P1：触る範囲を広げない）。
 *
 * D5: 判断は無い。場所の解決と受け渡しだけ。
 * I2: 場所が決まらない（複数あるのに省略された・未登録）ときは黙って既定を選ばず、
 *     `PlaceRegistry` が投げるエラーをそのまま返す。
 */

import type { NamespacedToolDefinition } from "./tool-registry.js";
import type { PlaceRegistry } from "./places.js";

/** 場所を指す引数の名前。番頭にも GUI にも同じ名前で見える。 */
export const PLACE_PARAM = "place";

/**
 * ルートを1つ受け取って Tool 群を作る関数を、**場所を引数で選べる Tool 群**に変える。
 *
 * @param places 場所の帳簿
 * @param build  ルートを渡すと Tool 群を返す関数（`createFileTools` 等をそのまま渡す）
 */
export function placeScopedTools(
  places: PlaceRegistry,
  build: (root: string) => NamespacedToolDefinition[]
): NamespacedToolDefinition[] {
  // 名前・説明・パラメータを取るためのひな型。ここで作ったものは実行には使わない
  const template = build(PLACEHOLDER_ROOT);

  return template.map((tool) => ({
    ...tool,
    parameters: withPlaceParam(tool.parameters),
    async execute(args: unknown, ctx) {
      const params = (args ?? {}) as Record<string, unknown>;
      const requested = typeof params[PLACE_PARAM] === "string" ? (params[PLACE_PARAM] as string) : undefined;
      // I2: 複数あるのに省略されたらここで止まる（黙って別の場所を触らない）
      const place = await places.resolve(requested);

      // そのルート向けに作り直して呼ぶ。組み立てるだけでI/Oは無いので毎回でよい
      const real = build(place.path).find((t) => t.name === tool.name);
      if (!real) throw new Error(`Tool "${tool.name}" disappeared when rebuilding for a place.`);
      const result = await real.execute(params, ctx);

      // どの場所の結果かを常に添える（決定36d）。UI はここを見て出所を示せる
      return {
        ...result,
        details: {
          ...(typeof result.details === "object" && result.details !== null ? result.details : {}),
          place: { id: place.id, label: place.label },
        },
      };
    },
  })) as NamespacedToolDefinition[];
}

/**
 * 存在しないルート。ひな型を作るためだけに使う。
 *
 * 実行には使わないので、ここを見に行く実装があれば**そちらが間違い**——
 * ツールの組み立て時にファイルを読んでいることになる。
 */
const PLACEHOLDER_ROOT = "/nonexistent/banto-place-template";

/**
 * パラメータのスキーマに `place` を足す。
 *
 * 実行時のスキーマは素の JSON Schema オブジェクトなので、そのまま組み替える。
 * typebox の型合成を使わないのは、ここで必要なのが「プロパティを1つ足す」だけで、
 * 型の上でも `place` は任意の文字列だから（D6：機構を増やさない）。
 */
function withPlaceParam(parameters: unknown): unknown {
  const raw = (parameters ?? {}) as {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return {
    ...raw,
    properties: {
      ...(raw.properties ?? {}),
      [PLACE_PARAM]: {
        type: "string",
        description:
          "どの場所（リポジトリ等）を見るか。登録されている場所の id。" +
          "場所が1つだけなら省略できる。複数あるときに省略すると、どこか聞き返される",
      },
    },
    // place は任意。省略時は場所が1つだけなら自動で決まる
    ...(raw.required ? { required: raw.required } : {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 実行時のスキーマは素の
    // JSON Schema。typebox の型を通さずに1プロパティ足すため、ここだけ型を外す (I4)
  } as any;
}

/**
 * 副作用のある Tool のパス引数を砦に通す（ADR-0010 決定36g）。
 *
 * **いま空いている穴を塞ぐためのもの。** `worker.delegate` の `worktreePath` は
 * 誰も検査しておらず、番頭が任意の絶対パスを指定すれば職人はそこを書き換える。
 * `file.*` には範囲チェックがあり `git.*` は cwd 固定なのに、ここだけ素通りだった。
 *
 * **引数は消さない。場所の外を指したときに弾く**——既存の Tool 契約を壊さないため
 * （提案は「引数を外す」案も挙げていたが、弾く方が変更が小さく、番頭が worktree を
 * 明示することの意味＝どこで働かせるかを言う、は保たれる）。
 */
export function guardPathArg(
  tool: NamespacedToolDefinition,
  places: PlaceRegistry,
  paramName: string
): NamespacedToolDefinition {
  return {
    ...tool,
    async execute(args: unknown, ctx) {
      const params = (args ?? {}) as Record<string, unknown>;
      const target = params[paramName];
      // **欠けていても弾く。** 省略されると職人はホストの cwd で動く——そこが登録された
      // 場所とは限らず、書き込みの道具を持った職人が砦の外で動くことになる。
      // 契約上も必須（`worker.delegate` のスキーマ）なので、通してよい抜け道ではない。
      if (typeof target !== "string" || target.trim().length === 0) {
        throw new Error(
          `${tool.name} には ${paramName}（作業させる場所の絶対パス）が要ります。` +
            "省略すると番頭の作業ディレクトリで動くことになり、登録された場所の外へ出ます。" +
            "place.list の path を渡してください"
        );
      }
      // I2: 登録された場所の外なら、ここで止める。黙って動かすと別のリポジトリが壊れる
      await places.requireInsideSomePlace(target, `${tool.name}.${paramName}`);
      return tool.execute(params, ctx);
    },
  } as NamespacedToolDefinition;
}
