/**
 * テーマの選択と適用（spec-design §6）。
 *
 * D3: 覚えるのは**選択だけ**（家と明暗の別）。「いま明か暗か」は端末の設定から
 * 導出できる値なので保存しない——設定が変わったときに古い結果が残るのを避ける。
 */

import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_CHOICE,
  FAMILIES,
  parseChoice,
  resolveTheme,
  serializeChoice,
  type ModeChoice,
  type ThemeChoice,
  type ThemeFamily,
  type ThemeMode,
} from "./themes.js";

const STORAGE_KEY = "banto.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function readChoice(): ThemeChoice {
  try {
    return parseChoice(localStorage.getItem(STORAGE_KEY));
  } catch {
    // ストレージが使えない環境（プライベートウィンドウ等）でも画面は出したい
    return DEFAULT_CHOICE;
  }
}

function systemPrefersDark(): boolean {
  return typeof matchMedia === "function" && matchMedia(DARK_QUERY).matches;
}

/**
 * 最初の描画より前に地を当てる。
 *
 * React が動くのを待つと、暗色を選んでいる人に**一瞬だけ明るい画面が閃く**。
 * `main.tsx` の先頭から呼び、body が出る前に属性を立てる。
 */
export function applyStoredTheme(): void {
  document.documentElement.setAttribute("data-theme", resolveTheme(readChoice(), systemPrefersDark()).id);
}

export interface ThemeState {
  /** POの選択（家と明暗の別）。設定の当たり判定に使う。 */
  choice: ThemeChoice;
  /** いま当たっている家。 */
  family: ThemeFamily;
  /** いま当たっている明暗。 */
  mode: ThemeMode;
  /** 選べる家の一覧。 */
  families: readonly ThemeFamily[];
  /** 家を選び直す。**明暗の別は持ち越す**——見た目を選んだだけで暗色が外れない。 */
  setFamily: (id: string) => void;
  /** 明暗を選び直す。`system` で端末に追従。**家は変わらない**。 */
  setMode: (mode: ModeChoice) => void;
  /** 明と暗を往復する。上段の1ボタン用。**いまの家の中で**切り替わる。 */
  toggle: () => void;
}

/**
 * @param extraFamilies 持ち込みの家（`/api/themes` から読んだもの）。
 *   組み込みの後ろに並ぶので、既定は変わらない。
 */
export function useTheme(extraFamilies: readonly ThemeFamily[] = []): ThemeState {
  const [choice, setChoiceState] = useState<ThemeChoice>(readChoice);
  const [prefersDark, setPrefersDark] = useState<boolean>(systemPrefersDark);

  // 端末側の切り替えに追従する（追従を選んでいる間だけ効く）
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(DARK_QUERY);
    const onChange = (e: MediaQueryListEvent): void => setPrefersDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const families = extraFamilies.length === 0 ? FAMILIES : [...FAMILIES, ...extraFamilies];
  const resolved = resolveTheme(choice, prefersDark, families);

  // 属性は**導出結果を書き写すだけ**。ここが唯一の適用点
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolved.id);
  }, [resolved.id]);

  const save = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    try {
      localStorage.setItem(STORAGE_KEY, serializeChoice(next));
    } catch {
      // 覚えられなくても、この画面が閉じるまでは選んだテーマで動く
    }
  }, []);

  // 家を替えても明暗は持ち越す（見た目を選んだだけで暗色が外れない）
  const setFamily = useCallback((id: string) => save({ ...choice, family: id }), [choice, save]);
  const setMode = useCallback((mode: ModeChoice) => save({ ...choice, mode }), [choice, save]);

  const toggle = useCallback(() => {
    // **いまの家の中で**往復する。端末追従中でも、押した瞬間に明示の選択へ移る
    // ——押したのに次の起動で戻る、が一番分かりにくい
    save({ ...choice, mode: resolved.mode === "dark" ? "light" : "dark" });
  }, [choice, resolved.mode, save]);

  return { choice, family: resolved.family, mode: resolved.mode, families, setFamily, setMode, toggle };
}
