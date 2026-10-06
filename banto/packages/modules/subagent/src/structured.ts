// **決まった形で返させる**（追加・2026-10-06、v4-modules.md §4.5「Subagent に足すもの」——Factory のレビューの判定）。
//
// Claude Code の Dynamic Workflows の `agent(…, { schema })` と同じ考え方：頼むときに JSON Schema を渡すと、最後の返答を
// その形の JSON にさせる。合わなければ**同じ会話のまま**理由を添えて直させ、上限を越えたら失敗にする（黙って文のまま返さない）。
// エージェント（Claude Code・OpenCode）には構造化出力の口が共通に無いので、指示と検査で行う。

import AjvModule from "ajv";

/** 直させる回数の上限（最初の返答を除く） */
export const STRUCTURED_RETRIES = 3;

type Validate = ((v: unknown) => boolean) & { errors?: Array<{ instancePath?: string; message?: string }> | null };

const Ajv = (AjvModule as unknown as { default?: typeof AjvModule }).default ?? AjvModule;

export interface CompiledSchema {
  schema: Record<string, unknown>;
  /** 合えば `undefined`、合わなければ理由 */
  check(value: unknown): string | undefined;
}

/** 渡された schema を読む。JSON Schema として読めなければ理由を投げる（エージェントを起こす前に断る） */
export function compileSchema(raw: unknown): CompiledSchema {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("schema は JSON Schema のオブジェクトで渡してください");
  }
  const schema = raw as Record<string, unknown>;
  let validate: Validate;
  try {
    validate = new (Ajv as unknown as new (o: object) => { compile(s: object): Validate })({ allErrors: true, strict: false }).compile(schema);
  } catch (err) {
    throw new Error(`schema が JSON Schema として読めません：${err instanceof Error ? err.message : String(err)}`);
  }
  return {
    schema,
    check(value) {
      if (validate(value)) return undefined;
      return (validate.errors ?? [])
        .slice(0, 5)
        .map((e) => `${e.instancePath || "(全体)"} ${e.message ?? "が合いません"}`)
        .join("；");
    },
  };
}

/** 最初の頼みに足す指示 */
export function schemaInstruction(schema: Record<string, unknown>): string {
  return (
    "\n\n---\n**最後の返答は、次の JSON Schema に合う JSON だけにしてください**（前置き・説明・コードブロックの印は付けない）。" +
    `\n\n${JSON.stringify(schema, null, 2)}`
  );
}

/** 合わなかったときに、同じ会話で直させる頼み */
export function fixPrompt(problem: string, schema: Record<string, unknown>): string {
  return (
    `さっきの最後の返答は、決まった形になっていませんでした：${problem}\n` +
    "仕事はやり直さず、結果を次の JSON Schema に合う JSON だけで返し直してください（前置き・説明・コードブロックの印は付けない）。" +
    `\n\n${JSON.stringify(schema, null, 2)}`
  );
}

/**
 * 返答から JSON を取り出す。全体が JSON ならそれ、無ければ ```json の囲み（最後のもの）、無ければ文の中の
 * 括弧の釣り合った `{…}`・`[…]` のうち読めた最後のもの。見つからなければ `undefined`
 */
export function extractJson(text: string): { value: unknown } | undefined {
  const trimmed = text.trim();
  const tryParse = (s: string): { value: unknown } | undefined => {
    try {
      return { value: JSON.parse(s) as unknown };
    } catch {
      return undefined;
    }
  };
  const whole = tryParse(trimmed);
  if (whole) return whole;
  const fences = [...trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n?```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const got = tryParse(fences[i]![1]!.trim());
    if (got) return got;
  }
  let found: { value: unknown } | undefined;
  for (let start = 0; start < trimmed.length; start++) {
    const open = trimmed[start];
    if (open !== "{" && open !== "[") continue;
    const end = matchingEnd(trimmed, start);
    if (end === undefined) continue;
    const got = tryParse(trimmed.slice(start, end + 1));
    if (got) {
      found = got;
      start = end; // 入れ子の中は見ない（外側を取る）
    }
  }
  return found;
}

/** `start` の括弧と釣り合う閉じ括弧の位置（文字列の中は数えない） */
function matchingEnd(s: string, start: number): number | undefined {
  const stack: string[] = [];
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") {
      if (stack.pop() !== c) return undefined;
      if (stack.length === 0) return i;
    }
  }
  return undefined;
}
