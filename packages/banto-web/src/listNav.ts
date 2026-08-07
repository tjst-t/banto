/**
 * 絞って選ぶ一覧を、キーだけで動かして確定する（PO要望 2026-08-06）。
 *
 * モデル選択・⌘K・場所選び・キャンバスに開くもの——**どれも「絞る欄 ＋ 一覧 ＋ 確定」**
 * という同じ形をしているのに、上下と Enter で確定できるのは ⌘K だけだった。同じ形の
 * ものが場所ごとに違う触り心地をするのが一番覚えにくいので、ここに1つ置いて全部から使う。
 *
 * D5: ここに判断は無い。「いまどの行に当たっているか」だけを持つ。何が並んでいるか・
 *     選ばれたら何が起きるかは、呼ぶ側が決める。
 */

import { useEffect, useRef, useState } from "react";
import type React from "react";

export interface ListNav {
  /** いま当たっている行（並びの通し番号）。 */
  cursor: number;
  /** その行に当たっているか。見た目のクラス名は呼ぶ側が決める。 */
  isOn(index: number): boolean;
  /**
   * 一覧の器に付ける。当たっている行を見える範囲に保つために、ここから探す
   * （クラス名に依存させない——器ごとに行の名前が違う）。
   */
  listRef: React.RefObject<HTMLDivElement | null>;
  /** 絞り込みの入力欄の `onKeyDown` に渡す。 */
  onKeyDown(event: React.KeyboardEvent): void;
  /** 各行に展開する。当たりの印と、マウスとの同居を引き受ける。 */
  rowProps(index: number): {
    "data-on"?: "";
    onMouseMove(): void;
  };
}

export function useListNav<T>(
  items: readonly T[],
  {
    onChoose,
    resetKey,
  }: {
    onChoose(item: T, index: number): void;
    /**
     * これが変わったら先頭へ戻す（ふつうは絞り込みの文字列）。前の位置を覚えていると、
     * 1文字打つたびに関係のない行が当たったままになる。
     */
    resetKey?: unknown;
  }
): ListNav {
  const [raw, setRaw] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // 一覧が短くなったとき、当たりが外へ出たままにならないようにする（絞り込みの途中で起きる）
  const cursor = items.length === 0 ? 0 : Math.min(raw, items.length - 1);

  useEffect(() => setRaw(0), [resetKey]);

  // キーだけで端まで動ける必要があるので、当たっている行を見える範囲へ送る
  useEffect(() => {
    listRef.current?.querySelector("[data-on]")?.scrollIntoView({ block: "nearest" });
  }, [cursor, items.length]);

  const move = (event: React.KeyboardEvent, next: number): void => {
    event.preventDefault();
    setRaw(Math.max(0, Math.min(next, items.length - 1)));
  };

  return {
    cursor,
    isOn: (index) => index === cursor && items.length > 0,
    listRef,
    onKeyDown: (event) => {
      // IME の変換中は横取りしない。変換候補の上下も確定の Enter もここへ来るので、
      // 奪うと日本語が打てなくなる
      if (event.nativeEvent.isComposing) return;
      if (event.key === "ArrowDown") return move(event, cursor + 1);
      if (event.key === "ArrowUp") return move(event, cursor - 1);
      if (event.key === "Enter") {
        const item = items[cursor];
        if (item === undefined) return;
        event.preventDefault();
        onChoose(item, cursor);
      }
    },
    rowProps: (index) => ({
      ...(index === cursor ? { "data-on": "" as const } : {}),
      /* 当たりをマウスにも合わせる。**動いたときだけ**——入って来た位置に指を置いた
         ままキーで動かすと、止まっているマウスに毎回引き戻される */
      onMouseMove: () => setRaw(index),
    }),
  };
}
