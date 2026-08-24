import type { ComponentType } from 'react';

import { DirView } from './DirView';
import { FactoryRunView } from './FactoryRunView';
import { FactoryRunsView } from './FactoryRunsView';
import { FileView } from './FileView';

/**
 * **モジュールが持ち込む画面のうち、`in-page` のもの**（要件 C1・C14、決定20）。
 *
 * ここに在るということは、**banto の束ねに入っている**ということである。
 * だから第三者モジュールは、方針で禁じるまでもなく `in-page` を名乗れない
 * ——名乗っても実体がここに無い。**構造で決まっているので、規約が要らない。**
 *
 * `sandboxed` のものはここに来ない。iframe の中で走るので、
 * 束ねにも、このページの権限にも入らない。
 */
export interface ModuleViewProps {
  readonly uri: string;
  readonly text: string;
  readonly mimeType: string | null;
  /**
   * 同じ作業パネルの中で、別のURIへ移動する（PO指摘 2026-08-25）。
   * フォルダを辿るような面だけが使う——使わない面（`FileView`等）は無視してよい。
   */
  readonly onNavigate: (uri: string, name: string) => void;
}

/** `manifest.gui.entry` → 実体。**鍵は台帳の文字列そのもの**（規則3）。 */
const IN_PAGE: ReadonlyMap<string, ComponentType<ModuleViewProps>> = new Map([
  ['fs/FileView', FileView],
  ['fs/DirView', DirView],
  ['factory/RunsView', FactoryRunsView],
  ['factory/RunView', FactoryRunView],
]);

/**
 * その entry の面を返す。**無ければ null**——黙って別の面で描かない（規則2）。
 * 呼び手は「面が無い」ことを人に見せられる。
 */
export function inPageView(entry: string): ComponentType<ModuleViewProps> | null {
  return IN_PAGE.get(entry) ?? null;
}
