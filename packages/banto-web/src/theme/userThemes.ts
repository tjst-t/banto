/**
 * 持ち込みのテーマを読み込む（spec-design §6.3・ADR-0012 決定54）。
 *
 * ホストが `<BANTO_DATA_DIR>/themes/` に置かれたものを配る。ここはそれを受けて
 * 家の一覧に足す——ただし**そのまま挿さない**。
 *
 * ## 持ち込みの家は「トークンだけ」（決定54）
 *
 * 組み込みの家は面のクラス名を名指しできる（ADR-0012 決定51「形の層」）が、
 * **持ち込みの家にはそれを許さない。** 理由は1つで、**こちらの試験が効かないから**——
 * 面を組み替えたときに崩れたことに気づけるのは、リポジトリの中にある家だけ
 * （`tests/theme-shape.spec.ts`）。外の人が書いた家は黙って壊れ、書いた人にも
 * こちらにも分からない。世の中のテーマ機構が同じ理由でセレクタから離れている
 * （`docs/notes/theme-system-comparison.md`）。
 *
 * だから受け取った CSS は**通す前に濾す**：`:root` に変数を置く規則だけを残し、
 * それ以外は落とす。落としたものは黙らない（I2）。
 *
 * ## 契約の版（決定55）
 *
 * 持ち込みの家が当てにしているのは**トークンの名前**なので、名前を変えたら壊れる。
 * 台帳に `contract` を書いてもらい、こちらの `THEME_CONTRACT` と合う家だけを載せる。
 * 合わないものは載せずに理由を出す——半分だけ効いた家を出すほうが困る（I2）。
 *
 * I2: 読めなかったことは黙らない（ログに出す）。ただし画面は組み込みの家で動かす
 *     ——テーマが1つ読めないだけで何も出ないのは割に合わない。
 */

import { THEME_CONTRACT, type ThemeFamily } from "./themes.js";

const MANIFEST_URL = "/api/themes";
const CSS_URL_BASE = "/api/themes/";

interface ManifestFamily extends ThemeFamily {
  /** この家の CSS（themes/ からの相対名）。 */
  css: string;
  /** 当てにしているトークンの版（`THEME_CONTRACT`）。 */
  contract?: number;
}

/** 変数以外で書いてよいもの。**地の明暗の申告だけ**は変数にできない。 */
const ALLOWED_PLAIN = new Set(["color-scheme"]);

/** `:root` か `:root[data-theme="…"]` だけ。子孫セレクタは通さない。 */
const ROOT_ONLY = /^\s*:root(\[data-theme(=|\^=|\$=|\*=|\|=)"[^"]*"\])?\s*$/;

/** 既に挿した CSS。二度挿さない（開き直しても増えない）。 */
const inserted = new Set<string>();

/** 落としたものを人に読める形で。何を直せばよいかが分かるように出す。 */
function label(rule: CSSRule): string {
  return rule instanceof CSSStyleRule ? rule.selectorText : `@${rule.constructor.name}`;
}

/** その規則は「`:root` に変数を置くだけ」か。 */
function isTokenOnly(rule: CSSRule): rule is CSSStyleRule {
  if (!(rule instanceof CSSStyleRule)) return false;
  if (!rule.selectorText.split(",").every((sel) => ROOT_ONLY.test(sel))) return false;
  for (let i = 0; i < rule.style.length; i++) {
    const prop = rule.style.item(i);
    if (!prop.startsWith("--") && !ALLOWED_PLAIN.has(prop)) return false;
  }
  return true;
}

/**
 * 受け取った CSS から、変数を置く規則だけを取り出す。
 *
 * **ブラウザ自身の構文解析を使う**（自前で CSS を正規表現で切らない——コメントや
 * 入れ子で必ず取りこぼす）。`media="not all"` で挿すので、**濾す前の CSS が一瞬でも
 * 効くことはない**。
 */
export function sanitizeThemeCss(css: string): { css: string; dropped: string[] } {
  const probe = document.createElement("style");
  probe.media = "not all";
  probe.textContent = css;
  document.head.appendChild(probe);
  const kept: string[] = [];
  const dropped: string[] = [];
  try {
    for (const rule of Array.from(probe.sheet?.cssRules ?? [])) {
      if (isTokenOnly(rule)) kept.push(rule.cssText);
      else dropped.push(label(rule));
    }
  } finally {
    probe.remove();
  }
  return { css: kept.join("\n"), dropped };
}

async function insert(name: string): Promise<void> {
  if (inserted.has(name)) return;
  inserted.add(name);
  const res = await fetch(CSS_URL_BASE + encodeURIComponent(name));
  if (!res.ok) {
    console.error(`[themes] ${name} を読めません: ${res.status}`);
    return;
  }
  const { css, dropped } = sanitizeThemeCss(await res.text());
  if (dropped.length > 0) {
    // I2: 黙って落とさない。持ち込みの家に許されるのは変数だけ（決定54）
    console.error(
      `[themes] ${name}: 変数の上書き以外は使えません。落とした規則: ${dropped.join(", ")}` +
        "（持ち込みの家は :root に変数を置くところまでです）"
    );
  }
  const style = document.createElement("style");
  style.dataset["bantoTheme"] = name;
  style.textContent = css;
  document.head.appendChild(style);
}

/**
 * 置いてある家を読む。**組み込みと同じ形**で返すので、呼ぶ側は区別しなくてよい。
 * ホストが取次を持たない構成（テストなど）では空で返る。
 */
export async function loadUserFamilies(): Promise<ThemeFamily[]> {
  try {
    const res = await fetch(MANIFEST_URL);
    if (!res.ok) return [];
    const manifest = (await res.json()) as { families?: ManifestFamily[] };
    const families: ThemeFamily[] = [];
    for (const family of manifest.families ?? []) {
      // 決定55：当てにしているトークンの版が合わない家は載せない
      if (family.contract !== THEME_CONTRACT) {
        console.error(
          `[themes] ${family.id}: 契約の版が違います` +
            `（この画面は ${THEME_CONTRACT}、台帳は ${String(family.contract ?? "無し")}）。` +
            "themes.json に \"contract\": " + THEME_CONTRACT + " を書き、変数の名前を確かめてください"
        );
        continue;
      }
      await insert(family.css);
      // css / contract の欄は画面では使わないので落とす（家の形を組み込みと揃える）
      const { css: _css, contract: _contract, ...rest } = family;
      families.push(rest);
    }
    return families;
  } catch (err) {
    console.error("[themes] 持ち込みのテーマを読めません:", err);
    return [];
  }
}
