/**
 * 持ち込みのテーマ（spec-design §6.4）。
 *
 * **作り直さずにテーマを足せるようにする。** `<BANTO_DATA_DIR>/themes/` に
 * `themes.json`（台帳）と CSS を置くだけで、次に画面を開いたときから選べる。
 *
 * **持ち込みの家に許されるのはトークンの上書きだけ**（ADR-0012 決定54）。ただし
 * それを濾すのは画面側（D5：ホストは配るだけ、解釈は画面）。ここは置いてあるものを
 * そのまま渡し、画面が `:root` の変数以外を落とす。
 *
 * D5: 判断は無い。置いてあるものを読んで配るだけ。
 * I2: 台帳が壊れていたら黙って空にせず、理由をログに出して既定だけで動かす。
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** 台帳の1エントリ。web 側の ThemeFamily と同じ形（そのまま渡す）。 */
export interface UserThemeFamily {
  id: string;
  name: string;
  description: string;
  changes: string;
  /** この家の CSS（themes/ からの相対名）。 */
  css: string;
  /**
   * 当てにしているトークンの語彙の版（ADR-0012 決定55）。画面側の `THEME_CONTRACT` と
   * 合わない家は載らない。**ここでは中身を見ない**——版の意味を持つのは画面側なので。
   */
  contract?: number;
  variants: { light: string; dark: string };
  swatch: { light: [string, string, string]; dark: [string, string, string] };
}

export interface UserThemeManifest {
  families: UserThemeFamily[];
}

/** URL の前置き。CSS は `/api/themes/<name>.css` で取れる。 */
export const THEME_URL_BASE = "/api/themes/";

export class UserThemes {
  constructor(private readonly dir: string) {}

  /**
   * 置いてある台帳。**壊れていても落とさない**——テーマが読めないだけで
   * 画面が出ないのは割に合わない（既定の家は組み込みにある）。
   */
  manifest(): UserThemeManifest {
    const file = path.join(this.dir, "themes.json");
    if (!fs.existsSync(file)) return { families: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as UserThemeManifest;
      const families = (raw.families ?? []).filter((f) => this.valid(f));
      return { families };
    } catch (err) {
      console.error(`[themes] ${file} を読めません: ${String(err)}`);
      return { families: [] };
    }
  }

  /**
   * CSS を1つ返す。**名前は信頼しない**——ベース名だけに落として、
   * 置き場所の外へ出られないようにする（`..` や絶対パスを弾く）。
   */
  css(requested: string): string | undefined {
    const name = path.basename(requested);
    if (name.length === 0 || !name.endsWith(".css")) return undefined;
    const file = path.join(this.dir, name);
    if (!fs.existsSync(file)) return undefined;
    return fs.readFileSync(file, "utf8");
  }

  /** 足りないものがある家は載せない（画面で壊れるより、出ないほうがよい）。 */
  private valid(f: UserThemeFamily): boolean {
    const ok =
      typeof f?.id === "string" &&
      /^[a-z0-9-]+$/.test(f.id) &&
      typeof f.name === "string" &&
      typeof f.css === "string" &&
      typeof f.variants?.light === "string" &&
      typeof f.variants?.dark === "string";
    if (!ok) console.error(`[themes] 形が足りない家を飛ばしました: ${JSON.stringify(f?.id ?? f)}`);
    return ok;
  }
}
