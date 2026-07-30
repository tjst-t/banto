/**
 * キャンバス — 番頭が出し入れする表示領域の状態とカタログ（ADR-0010 決定5・12・17）。
 *
 * カタログのエントリは決定17 のとおり「Tool契約（名前・JSON Schemaパラメータ・説明）を土台に、
 * キャンバス固有のフィールド（描画する React コンポーネントへの参照など）を拡張したもの」。
 *
 * D3: 状態の真実は Canvas が一箇所で持ち、UIは配信された状態を描くだけ（独自状態を持たない）。
 * D5: ここに判断は無い。何を開くかを決めるのは番頭で、Canvas は言われた通りに状態を変える。
 * D6: 依存は typebox の型のみ（スキーマはカタログエントリが持つ）。
 * I2: 未知の kind・未知のタブIDは黙って無視せずエラーにする。
 */

import type { TSchema } from "typebox";
import { randomUUID } from "node:crypto";

// ── GUIカタログ ──────────────────────────────────────────────────────────────

/**
 * カタログの1エントリ。番頭はこの一覧を見て「何が開けるか」を把握する（決定5 §5）。
 */
export interface CanvasViewSpec {
  /** 表示種別。Tool名と同じ名前空間規則（`<domain>.<name>`）に従う。例: `demo.hello` */
  kind: string;
  /** カタログ表示名 */
  title: string;
  /** 番頭がいつ開くべきかの説明。Tool契約の description に相当する */
  description: string;
  /** 開くときに渡すパラメータの形。Tool契約の parameters に相当する */
  parameters: TSchema;
  /**
   * 描画する React コンポーネントのエクスポート名（決定17・決定12）。
   * ホスト側は文字列として持つだけで、解決はUI側が行う——ホストが React に依存しないため。
   */
  component: string;
  /** カタログ表示用の分類（任意） */
  category?: string;
  /** カタログ表示用のアイコン（任意） */
  icon?: string;
}

export interface CanvasCatalog {
  /** エントリを登録する。kind の重複は例外（I2）。 */
  register(spec: CanvasViewSpec): void;
  /** 登録済みの全エントリ。 */
  list(): CanvasViewSpec[];
  /** kind で引く。 */
  get(kind: string): CanvasViewSpec | undefined;
}

export function createCanvasCatalog(specs: CanvasViewSpec[] = []): CanvasCatalog {
  const entries = new Map<string, CanvasViewSpec>();
  const catalog: CanvasCatalog = {
    register(spec) {
      if (entries.has(spec.kind)) {
        throw new Error(`Canvas view "${spec.kind}" is already registered.`);
      }
      entries.set(spec.kind, spec);
    },
    list: () => Array.from(entries.values()),
    get: (kind) => entries.get(kind),
  };
  for (const spec of specs) catalog.register(spec);
  return catalog;
}

// ── キャンバスの状態 ─────────────────────────────────────────────────────────

/** キャンバスに開かれている1つのタブ。 */
export interface CanvasTab {
  id: string;
  kind: string;
  title: string;
  params: Record<string, unknown>;
  /**
   * 内容の版。同じタブを別のパラメータで開き直すたびに増える。
   * UI はこれを描画のキーに含めて、再利用されたタブが前の状態を持ち越さないようにする
   * （タブIDだけをキーにすると、パラメータが変わっても中身が作り直されない）。
   */
  rev: number;
}

/** キャンバス全体の表示状態。UIはこれを描くだけ（D3）。 */
export interface CanvasSnapshot {
  tabs: CanvasTab[];
  activeTabId: string | undefined;
}

/**
 * キャンバスの表示状態。
 *
 * 決定2 のとおりスレッド1本につき1つ持つ想定で、現状は1ホスト＝1セッション＝1キャンバス。
 */
export class Canvas {
  private tabs: CanvasTab[] = [];
  private activeTabId: string | undefined;
  private readonly listeners = new Set<(snapshot: CanvasSnapshot) => void>();

  constructor(private readonly catalog: CanvasCatalog) {}

  /** 現在の表示状態のスナップショット。 */
  snapshot(): CanvasSnapshot {
    return { tabs: this.tabs.map((t) => ({ ...t })), activeTabId: this.activeTabId };
  }

  /** 状態が変わるたびに呼ばれる。戻り値で購読解除。 */
  subscribe(listener: (snapshot: CanvasSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * タブを開き、アクティブにする。
   *
   * **既定は同じ種別のタブを使い回す。** 「このファイルを開いて」と言われるたびにタブが
   * 増えるのは邪魔なため（PO フィードバック）。使い回す相手は、表示中のタブが同じ種別なら
   * それ、そうでなければその種別で最後に開いたタブ。別のタブで開きたいときは
   * `newTab: true` を渡す。
   *
   * I2: カタログに無い kind は黙って無視せずエラー（決定20のバリデーション方針）。
   */
  open(
    kind: string,
    params: Record<string, unknown> = {},
    title?: string,
    options: { newTab?: boolean } = {}
  ): CanvasTab {
    const spec = this.catalog.get(kind);
    if (!spec) {
      const known = this.catalog.list().map((s) => s.kind).join(", ");
      throw new Error(`Unknown canvas view "${kind}". Available: ${known || "(none)"}`);
    }

    if (!options.newTab) {
      const active = this.tabs.find((t) => t.id === this.activeTabId);
      const reusable =
        active?.kind === kind ? active : [...this.tabs].reverse().find((t) => t.kind === kind);
      if (reusable) {
        reusable.params = params;
        reusable.title = title ?? spec.title;
        reusable.rev += 1;
        this.activeTabId = reusable.id;
        this.notify();
        return { ...reusable };
      }
    }

    const tab: CanvasTab = { id: randomUUID(), kind, title: title ?? spec.title, params, rev: 0 };
    this.tabs.push(tab);
    this.activeTabId = tab.id;
    this.notify();
    return { ...tab };
  }

  /** タブを閉じる。閉じたのがアクティブなら直前のタブへ移る。 */
  close(tabId: string): void {
    const index = this.tabs.findIndex((t) => t.id === tabId);
    if (index === -1) throw new Error(`Unknown canvas tab "${tabId}".`);
    this.tabs.splice(index, 1);
    if (this.activeTabId === tabId) {
      this.activeTabId = this.tabs[Math.max(0, index - 1)]?.id;
    }
    this.notify();
  }

  /** 表示するタブを切り替える。 */
  switchTo(tabId: string): void {
    if (!this.tabs.some((t) => t.id === tabId)) {
      throw new Error(`Unknown canvas tab "${tabId}".`);
    }
    this.activeTabId = tabId;
    this.notify();
  }

  private notify(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
