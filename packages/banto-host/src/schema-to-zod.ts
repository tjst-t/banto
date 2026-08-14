/**
 * TypeBox（＝JSON Schema）→ zod（ADR-0020 決定91）。
 *
 * banto の道具契約は TypeBox でパラメータを書く（`banto-tool.ts`）。一方 Agent SDK の
 * `tool()` は **zod の raw shape** を要求し、実行時に自分で JSON Schema へ戻す
 * （`sdk.mjs` の `zodToJsonSchema`）。そのため一度 zod を経由する必要がある。
 *
 * **新しい依存は足さない**（D6）。`zod` は Agent SDK が自分の I/F で要求するもので、
 * ハーネスを載せる時点で入る。
 *
 * D5: 判断は無い。形を写すだけ。
 * I2: 知らない形は黙って落とさない——`z.unknown()` にして**通す**。落とすと引数が
 *     消えて、モデルには「その引数を渡す口が無い」ように見える（原因が分からなくなる）。
 */

import { z } from "zod";

/** JSON Schema の最小形（実物の100本で使われているものだけ）。 */
interface JsonSchemaNode {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  default?: unknown;
}

function describe<T extends z.ZodTypeAny>(schema: T, node: JsonSchemaNode): T {
  return node.description ? (schema.describe(node.description) as T) : schema;
}

/** 1つのノードを zod へ。 */
export function jsonSchemaToZod(node: JsonSchemaNode | undefined): z.ZodTypeAny {
  if (!node || typeof node !== "object") return z.unknown();

  // `const` は1値の列挙として扱う
  if (node.const !== undefined) return describe(z.literal(node.const as never), node);
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const values = node.enum.filter((v): v is string => typeof v === "string");
    // 文字列だけの列挙は enum、混ざっていれば union of literals
    const built =
      values.length === node.enum.length
        ? z.enum(values as [string, ...string[]])
        : z.union(node.enum.map((v) => z.literal(v as never)) as never);
    return describe(built, node);
  }

  const variants = node.anyOf ?? node.oneOf;
  if (variants && variants.length > 0) {
    // **`anyOf` は Optional の表現でも出る**（`[T, {type:"null"}]` 等）。素直に union にする
    const built =
      variants.length === 1
        ? jsonSchemaToZod(variants[0])
        : z.union(variants.map((v) => jsonSchemaToZod(v)) as never);
    return describe(built, node);
  }

  const type = Array.isArray(node.type) ? node.type[0] : node.type;
  switch (type) {
    case "string":
      return describe(z.string(), node);
    case "number":
    case "integer":
      return describe(z.number(), node);
    case "boolean":
      return describe(z.boolean(), node);
    case "null":
      return describe(z.null(), node);
    case "array":
      return describe(z.array(jsonSchemaToZod(node.items)), node);
    case "object":
      return describe(z.object(jsonSchemaToZodShape(node)), node);
    default:
      // I2: 知らない形でも引数の口は残す
      return describe(z.unknown(), node);
  }
}

/**
 * オブジェクトの JSON Schema → zod の raw shape（`tool()` が要求する形）。
 *
 * `required` に無いものは `.optional()`。**省略できる引数を必須にしない**
 * ——必須にすると、モデルが空文字などを埋めて意味が変わる。
 */
export function jsonSchemaToZodShape(
  node: JsonSchemaNode | undefined
): Record<string, z.ZodTypeAny> {
  const properties = node?.properties ?? {};
  const required = new Set(node?.required ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, child] of Object.entries(properties)) {
    const built = jsonSchemaToZod(child);
    shape[key] = required.has(key) ? built : built.optional();
  }
  return shape;
}
