/**
 * テーマの台帳（spec-design §6）。
 *
 * **テーマは「家」で、明暗はその中の別。** 和紙の明と和紙の暗は別のテーマではなく、
 * 同じ家の裏表——だから明暗ボタンを押しても家は変わらない（PO報告 2026-08-06：
 * 符牒を選んだあと明暗を切り替えると和紙に戻ってしまっていた）。
 *
 * 家を足すのは、この配列に1エントリと `tokens.css` に**2ブロック（明・暗）**だけ。
 * 面の CSS には一切触らない——テーマが上書きできるのはトークンだけで、
 * 色・書体・字の段・余白・角・高さ・行間のすべてが変数になっている。
 *
 * D3: ここは「何が選べるか」の定義だけを持つ。いま何が当たっているかは持たない。
 */

/**
 * 持ち込みの家が当てにしている**トークンの語彙の版**（ADR-0012 決定55）。
 *
 * 持ち込みの家は変数の名前だけを当てにする（決定54：セレクタは書けない）。だから
 * **変数の名前を消した・付け替えたときにだけ上げる**——値を変えただけでは上げない。
 * 台帳（`themes.json`）の `contract` がこれと合わない家は載せず、理由をログに出す。
 *
 * 版を上げたら `docs/notes/how-to-make-a-theme.md` の表も直すこと。
 */
export const THEME_CONTRACT = 1;

/** 地の明暗。 */
export type ThemeMode = "light" | "dark";

/** POの明暗の選び方。`system` は端末の設定に追従する。 */
export type ModeChoice = ThemeMode | "system";

export interface ThemeFamily {
  /** 家の識別子（保存値に入る）。 */
  id: string;
  /** 設定に出す名前。 */
  name: string;
  /** 何を狙った意匠かを一行で。 */
  description: string;
  /** 何が変わるか。家の違いが色だけでないことを、選ぶ前に伝える。 */
  changes: string;
  /** `<html data-theme>` に入る値。明暗それぞれ。 */
  variants: Record<ThemeMode, string>;
  /** 設定の見本札に出す色（地／朱／藍）。 */
  swatch: Record<ThemeMode, [string, string, string]>;
}

/**
 * 選べる家。**並び順がそのまま設定の並び順**になる。先頭が既定（原典）。
 */
export const FAMILIES: readonly ThemeFamily[] = [
  {
    id: "washi",
    name: "和紙",
    description: "原典。和紙の地に藍と朱。番頭の言葉は明朝",
    changes: "色と書体",
    variants: { light: "washi-light", dark: "washi-dark" },
    swatch: {
      light: ["#EFEBE1", "#B03A26", "#1E3A5F"],
      dark: ["#14161A", "#E4674F", "#8FB0D9"],
    },
  },
  {
    id: "fucho",
    name: "符牒",
    description: "全部を等幅にして詰めたもの。行が機械的に揃い、一覧を目で舐めて読める",
    changes: "色・書体・字の段・余白・角・行間",
    variants: { light: "fucho-light", dark: "fucho-dark" },
    swatch: {
      light: ["#F5F4F0", "#C1341C", "#1B4B8F"],
      dark: ["#121316", "#E0644C", "#7FA8DC"],
    },
  },
];

export const DEFAULT_FAMILY = FAMILIES[0].id;
export const DEFAULT_MODE: ModeChoice = "system";

/** POの選択。**家と明暗を別々に覚える**——明暗を切り替えても家が変わらないため。 */
export interface ThemeChoice {
  family: string;
  mode: ModeChoice;
}

export const DEFAULT_CHOICE: ThemeChoice = { family: DEFAULT_FAMILY, mode: DEFAULT_MODE };

export function familyById(id: string, families: readonly ThemeFamily[] = FAMILIES): ThemeFamily | undefined {
  return families.find((f) => f.id === id);
}

/**
 * 選択と端末の状態から、実際に当てるテーマを決める。
 *
 * **導出できる値は保存しない**（D3）。保存するのは選択だけで、端末の設定が変われば
 * ここを通り直して結果が変わる。知らない家が保存されていたら既定へ落とす
 * ——家を削ったときに、二度と直せない画面にしないため。
 */
export function resolveTheme(
  choice: ThemeChoice,
  systemPrefersDark: boolean,
  families: readonly ThemeFamily[] = FAMILIES
): { family: ThemeFamily; mode: ThemeMode; id: string } {
  const family = familyById(choice.family, families) ?? FAMILIES[0];
  const mode: ThemeMode = choice.mode === "system" ? (systemPrefersDark ? "dark" : "light") : choice.mode;
  return { family, mode, id: family.variants[mode] };
}

/** 保存の形（`<家>:<明暗>`）。1行なので、壊れていたら既定へ落とせる。 */
export function serializeChoice(choice: ThemeChoice): string {
  return `${choice.family}:${choice.mode}`;
}

export function parseChoice(raw: string | null): ThemeChoice {
  if (!raw) return DEFAULT_CHOICE;
  const [family, mode] = raw.split(":");
  // **持ち込みの家はまだ読めていない**ので、ここでは名前をそのまま通す。
  // 実際に当てるときに見つからなければ既定へ落ちる（resolveTheme）
  return {
    family: family && /^[a-z0-9-]+$/.test(family) ? family : DEFAULT_FAMILY,
    mode: mode === "light" || mode === "dark" || mode === "system" ? mode : DEFAULT_MODE,
  };
}
