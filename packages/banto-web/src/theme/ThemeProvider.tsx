/**
 * テーマの状態をひとつに保つ（PO報告 2026-08-06）。
 *
 * `useTheme()` をそのまま2箇所（上段の明暗ボタンと設定の一覧）で呼ぶと、
 * **それぞれが別の状態を持つ**——設定で符牒を選んでも、上段のボタンは
 * 「和紙」のままの選択を握っていて、押した瞬間に和紙へ戻ってしまう。
 *
 * D3: 選択の真実は1つ。ここが唯一の持ち主で、他は読むだけ。
 */

import React, { createContext, useContext, useEffect, useState } from "react";
import { useTheme, type ThemeState } from "./useTheme.js";
import { loadUserFamilies } from "./userThemes.js";
import type { ThemeFamily } from "./themes.js";

const ThemeContext = createContext<ThemeState | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  // 持ち込みのテーマ（`<BANTO_DATA_DIR>/themes/`）。読めたら一覧に足す。
  // **読めなくても組み込みの家で動く**——テーマが1つ欠けて何も出ないのは割に合わない
  const [extra, setExtra] = useState<ThemeFamily[]>([]);
  useEffect(() => {
    void loadUserFamilies().then(setExtra);
  }, []);
  const value = useTheme(extra);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** いまのテーマの状態。Provider の外で呼んだら落とす（I2）。 */
export function useThemeState(): ThemeState {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("ThemeProvider の中で使ってください");
  return value;
}
