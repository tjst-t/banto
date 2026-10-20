// **判断待ちのカードに添える欄**（追加・2026-10-20、v4-frontend.md §6.47「AI の start_mission は会話の承認のカードで聞く」）。
//
// 判断待ちの `choices`（ボタンだけ）では欄を持てないので、Elicitation の form と同じ形（JSON Schema の `requestedSchema`）で
// 欄を受け取り、数の欄だけを描く。許すボタンを押すと、欄の値を答えに載せる（host の `updatedInput`）

export interface FormField {
  name: string;
  title: string;
  /** `integer` は小数を断る */
  type: "integer" | "number";
  minimum?: number;
  maximum?: number;
  default?: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `requestedSchema` から数の欄を読む。読めない欄は出さない（無ければ空） */
export function formFieldsOf(schema: unknown): FormField[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  return Object.entries(schema.properties).flatMap(([name, raw]): FormField[] => {
    if (!isRecord(raw) || (raw.type !== "integer" && raw.type !== "number")) return [];
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const minimum = num(raw.minimum);
    const maximum = num(raw.maximum);
    const def = num(raw.default);
    return [
      {
        name,
        title: typeof raw.title === "string" ? raw.title : name,
        type: raw.type,
        ...(minimum !== undefined ? { minimum } : {}),
        ...(maximum !== undefined ? { maximum } : {}),
        ...(def !== undefined ? { default: def } : {}),
      },
    ];
  });
}

/** 欄の文字を値にする。決まりに合わなければ理由（画面に出す） */
export function parseFieldValue(field: FormField, text: string): { value: number } | { problem: string } {
  const trimmed = text.trim();
  const value = Number(trimmed);
  if (trimmed === "" || !Number.isFinite(value)) return { problem: `${field.title}は数で入れてください` };
  if (field.type === "integer" && !Number.isInteger(value)) return { problem: `${field.title}は整数で入れてください` };
  if (field.minimum !== undefined && value < field.minimum) return { problem: `${field.title}は ${field.minimum} 以上にしてください` };
  if (field.maximum !== undefined && value > field.maximum) return { problem: `${field.title}は ${field.maximum} 以下にしてください` };
  return { value };
}
