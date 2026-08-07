/**
 * 符牒（キーの札）— 案5「符牒」の署名（spec-design §8）。
 *
 * **押せるものに符牒が浮き、その1文字で押せる。** 覚えなくても、出せば見える
 * ——キー操作の一番の壁は「何が割り当たっているか分からない」ことなので、
 * 一覧を別の場所に用意するのではなく、押せるものの上に直接出す。
 *
 * 出し方は2つある。
 *
 * 1. **`f` を押す**（推奨）。素の1文字なので、**どのブラウザも横取りしない**。
 *    出しっぱなしになり、符牒を押すか Esc で消える。
 * 2. **⌥ を押している間**。手を止めずに覗ける代わりに、
 *    **ブラウザによっては止められない**——Alt はブラウザ自身の操作（メニュー）で、
 *    ページの `preventDefault` が効かないものがある（Vivaldi で確認・PO報告 2026-08-06）。
 *    Chrome / Firefox / Safari では止まる。
 *
 * つまり `f` が本筋で、⌥ は効く環境での近道。**どちらでも同じものが出る**。
 *
 * 割り当ては `data-key` 属性で宣言する。**押す側が自分の符牒を持つ**ので、
 * ここに割り当て表を作らない——ボタンが増えたときに表を直し忘れることがない。
 *
 * `event.code` で見るのは、macOS の ⌥＋英字が別の文字（å ç ∂ …）になるため。
 * 刻印どおりの位置で当てる。
 */

import { useEffect, useState } from "react";

/** 符牒を出すキー（素の1文字。ブラウザが持っていない）。 */
const OPEN_KEY = "KeyF";

/** いま文字を打っているか。入力欄の中では符牒を横取りしない。 */
function isTyping(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable
  );
}

/** `event.code` を符牒の1文字へ。知らないキーは undefined（何も起きない）。 */
function keyOf(code: string): string | undefined {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase();
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  return undefined;
}

/** その符牒が振られている、いま押せるもの。 */
function targetOf(key: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-key="${key}"]:not([disabled]):not([hidden])`);
}

/**
 * 符牒の層。出ている間 `true` を返し、`<html>` に `is-alt` を立てる
 * （見せ方は CSS の仕事・D5）。
 */
export function useKeyHints(): boolean {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    // 出し方は2つあるが、**出ている状態はひとつ**。どちらで出しても同じものが見える
    let byAlt = false;
    let latched = false;

    const apply = (): void => {
      const on = byAlt || latched;
      setShown(on);
      document.documentElement.classList.toggle("is-alt", on);
    };
    const clear = (): void => {
      byAlt = false;
      latched = false;
      apply();
    };

    const onDown = (e: KeyboardEvent): void => {
      // ── 消す ────────────────────────────────────────────────────────
      if (e.key === "Escape" && latched && !e.isComposing) {
        e.preventDefault();
        clear();
        return;
      }

      // ── ⌥ を押している間 ────────────────────────────────────────────
      if (e.key === "Alt") {
        // Windows / Linux のブラウザは Alt 単独でメニューを開く。止められるものは止める。
        // **Vivaldi のようにブラウザ側で握っているものは止まらない**——だから `f` を用意した
        e.preventDefault();
        byAlt = true;
        apply();
        return;
      }

      if (isTyping()) return;

      // ── `f` で出す／もう一度 `f` で消す（素の1文字。どのブラウザも横取りしない）──
      //
      // **出したキーで消せる**（PO要望 2026-08-06）。覗いてやめるとき、Esc や画面のどこかを
      // 押す必要があると、指を置き直すことになる。`f` は符牒の入口なので、**どのボタンにも
      // 振らない**（振ると、出した直後に自分が押されて消える）
      if (e.code === OPEN_KEY && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        latched = !latched;
        apply();
        return;
      }

      // ── 符牒を押す ──────────────────────────────────────────────────
      // ⌥ を押しながらか、出しっぱなしの間だけ効く。素のキーが常に横取りされない
      if (!byAlt && !latched) return;
      if (e.ctrlKey || e.metaKey) return;
      const key = keyOf(e.code);
      if (!key) return;
      const target = targetOf(key);
      if (!target) return;
      e.preventDefault();
      clear();
      // 入力の器に振ってあるときは、器を押して中の入力へ移る（click が focus を呼ぶ）
      target.click();
      // ボタン以外（器）に振ってあるときのために、中に入力があれば移しておく
      if (!(target instanceof HTMLButtonElement) && !(target instanceof HTMLAnchorElement)) {
        target.querySelector<HTMLElement>("textarea, input, select")?.focus();
      }
      /**
       * 続けて別の符牒を打つ（`data-key-then`）。会話を開いたら番頭への入力へ移る、
       * のような「押したあと必ずここへ行く」を宣言で書けるようにする（PO要望 2026-08-06）
       * ——キーで会話へ飛んだのに、話しかけるのにマウスへ持ち替えるのでは近道にならない。
       *
       * **次の描き直しを待ってから探す**。面が入れ替わる符牒（会話を開く等）では、
       * 行き先がまだ描かれていない。
       */
      const then = target.getAttribute("data-key-then");
      if (then) requestAnimationFrame(() => targetOf(then)?.click());
    };

    const onUp = (e: KeyboardEvent): void => {
      if (e.key === "Alt") {
        // Chrome はメニューを **keyup** で開く。こちらも止める
        e.preventDefault();
        byAlt = false;
        apply();
        return;
      }
      if (!e.altKey && byAlt) {
        byAlt = false;
        apply();
      }
    };
    // 窓から離れたとき・どこかを押したときは畳む（出しっぱなしで残らないように）
    const onBlur = (): void => clear();
    const onPointer = (): void => {
      if (latched) clear();
    };

    document.addEventListener("keydown", onDown);
    document.addEventListener("keyup", onUp);
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("keydown", onDown);
      document.removeEventListener("keyup", onUp);
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("blur", onBlur);
      document.documentElement.classList.remove("is-alt");
    };
  }, []);

  return shown;
}
