// **Module が名乗るカードの文**（`dev.banto/card`、v4-frontend.md §6.2「会話にはカードだけを置く tool」）を埋める。
// 会話のカード（`inline-module-view.tsx`）とバックグラウンドの一覧（`background-work.tsx`）が使う。画面は workspace のパッケージに依存していないので、
// `@banto/module-contract` の `fillCardText` を写して持つ（変えるなら両方）。

/**
 * カードの文の `{引数名}` を、その呼び出しの引数で置き換える。**1行に収める**（改行は空白に）、長ければ畳む。
 * 引数に無い名前はそのまま残す（黙って消すと、Module の書き間違いに気づけない）。`{a|b}` は代わりの指定で、
 * 左から順に使える最初の引数（空白だけの文字列は飛ばす）。**`@banto/module-contract` の `fillCardText` の写し**——変えるなら両方
 */
export function fillCardText(template: string | undefined, args?: Record<string, unknown>): string | undefined {
  if (!template) return undefined;
  const filled = template
    .replace(/\{([A-Za-z0-9_]+(?:\|[A-Za-z0-9_]+)*)\}/g, (whole, names: string) => {
      const choices = names.split("|");
      for (const name of choices) {
        const v = args?.[name];
        if (typeof v === "number" || typeof v === "boolean") return String(v);
        // 名前が1つなら空の文字列もそのまま埋める（前からの振る舞い）。代わりがあるときは空白だけの文字列を飛ばす
        if (typeof v === "string" && (choices.length === 1 || v.trim() !== "")) return v;
      }
      return whole;
    })
    .replace(/\s+/g, " ")
    .trim();
  if (filled === "") return undefined;
  return filled.length > 80 ? `${filled.slice(0, 80)}…` : filled;
}

/**
 * 説明が題と同じ文なら出さない（追加・2026-10-08）。Shell の待たない形は題が「呼び名、無ければコマンド」、説明が
 * コマンドなので、呼び名を付けなかったときは同じ文が2行並ぶ
 */
export function distinctDescription(title: string | undefined, description: string | undefined): string | undefined {
  return description !== undefined && description !== title ? description : undefined;
}
