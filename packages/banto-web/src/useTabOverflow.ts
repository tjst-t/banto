/**
 * 収まらないタブを「▾」へ収納するための計測（プロトタイプ六次改訂の裁定）。
 *
 * **横スクロールは使わない。** 流れる帯は、端に隠れたタブが在ることも、いくつ在るかも
 * 見えない——指で探させることになる。収まらない分だけ ▾ にまとめ、**▾ は収まらない
 * ときだけ出す**。
 *
 * キャンバスのタブ（`App`）と、収納の要る帯で同じ計算をするので、ここに1つ置く。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface TabOverflowOptions {
  /** ▾ ボタンのぶんとして空けておく幅。 */
  reservePx?: number;
  /** タブ同士の間隔（CSS の gap と合わせる）。 */
  gapPx?: number;
  /** すべて収納する（狭い画面でタブ列そのものを出さないとき）。 */
  hideAll?: boolean;
  /**
   * 隠してはいけないタブ（いま見ているもの）。**見えている中身の名前が消えると、
   * 何を見ているのか分からなくなる**ので、溢れたら別のタブと入れ替える。
   */
  pinnedId?: string;
}

export interface TabOverflow {
  /** タブ列の器に付ける ref。中の要素は `data-tab-id` を持つこと。 */
  stripRef: React.RefObject<HTMLDivElement | null>;
  /** 収まらなかったタブのID。 */
  hiddenIds: Set<string>;
}

export function useTabOverflow(ids: string[], options: TabOverflowOptions = {}): TabOverflow {
  const { reservePx = 44, gapPx = 6, hideAll = false, pinnedId } = options;
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const stripRef = useRef<HTMLDivElement>(null);
  /**
   * タブ1つ分の幅。**隠す前に測った値を覚えておく**——隠したあとに測ると 0 になり、
   * 「隠したから入る、入るから出す」の往復になる。
   */
  const widths = useRef(new Map<string, number>());
  const key = ids.join("\x00");

  const measure = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    for (const el of strip.querySelectorAll<HTMLElement>("[data-tab-id]")) {
      const id = el.dataset["tabId"];
      if (id && el.offsetWidth > 0) widths.current.set(id, el.offsetWidth);
    }

    const list = key.length === 0 ? [] : key.split("\x00");
    if (hideAll) {
      setHiddenIds(list);
      return;
    }

    const fit = (available: number): string[] => {
      let used = 0;
      const hidden: string[] = [];
      for (const id of list) {
        const width = widths.current.get(id) ?? 0;
        const next = used + width + (used > 0 ? gapPx : 0);
        if (next > available) hidden.push(id);
        else used = next;
      }
      return hidden;
    };

    const full = strip.clientWidth;
    const first = fit(full);
    // ▾ を出すなら、その分だけ狭くなる。出すか出さないかで幅が変わるので2度測る
    const hidden = first.length === 0 ? [] : fit(full - reservePx);

    // 見ているタブが溢れたら、最後に残っていたタブと入れ替える
    if (pinnedId !== undefined && hidden.includes(pinnedId)) {
      const lastVisible = [...list].reverse().find((id) => !hidden.includes(id));
      if (lastVisible !== undefined) {
        setHiddenIds([...hidden.filter((id) => id !== pinnedId), lastVisible]);
        return;
      }
    }
    setHiddenIds(hidden);
  }, [key, hideAll, gapPx, reservePx, pinnedId]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(strip);
    return () => observer.disconnect();
  }, [measure]);

  return { stripRef, hiddenIds: new Set(hiddenIds) };
}
