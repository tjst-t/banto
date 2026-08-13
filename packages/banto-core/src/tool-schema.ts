/**
 * 道具のスキーマを**平らに**書くための小道具（ADR-0019 決定84-3）。
 *
 * `Type.Union([Type.Literal("a"), Type.Literal("b")])` は `anyOf` の入れ子になる。
 * 選択肢が文字列の並びでしかないところにその形を使うと、モデルからは
 * 「3つの部分スキーマのどれかを満たす値」に見えるうえ、`strict` を要求する側
 * （DeepSeek は「全プロパティ required・`additionalProperties: false`」を求める）が
 * 通らない。**同じ意味を `enum` 1つで書く。**
 *
 * `type: "string"` を明示するのは、`Type.Enum` が `{ enum: [...] }` だけを出すため。
 * 型を書かない `enum` を受け取れないプロバイダがある（JSON Schema としては妥当でも、
 * 道具定義の検証が厳しい側で落ちる）ので、こちら側で埋めておく。
 *
 * D5: 判断は無い。JSON Schema の書き方だけ。
 * D6: 依存は typebox のみ（既に契約が使っている）。
 */

import { Type, type TEnum, type TSchemaOptions } from "typebox";

/** `enum` で書いた文字列の選択肢。`Type.Union([Literal…])` の平らな版。 */
export type TStringEnum<T extends string> = TEnum<T[]>;

/**
 * 文字列の選択肢を `{ type: "string", enum: [...] }` として書く。
 *
 * 型は呼び出し側が並べたリテラルから取る——`StringEnum(["rework", "reverify"] as const)`
 * で `"rework" | "reverify"` になる。
 */
export function StringEnum<const T extends string>(
  values: readonly T[],
  options: TSchemaOptions = {}
): TStringEnum<T> {
  return Type.Enum([...values] as T[], { ...options, type: "string" });
}
