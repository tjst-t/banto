/**
 * 会話スレッド＝番頭の分身（ADR-0010 決定2・task-0035）。
 *
 * `docs/vision.md` の「番頭は分身する。関心事ごとにインスタンスへ分かれて並行し…
 * 割り込みが PO の文脈を壊さない」の機構。**スレッド1本につきキャンバス1つ**を持つ
 * ——あるスレッドで GUI を開いても、別スレッドの表示は変わらない（決定2）。
 *
 * 記憶は**スレッドを越えて共有される**。ここでは持たない——D11「番頭は記憶を持つ」は
 * スレッド単位ではなく番頭単位で、スレッドごとに記憶を作ると番頭が分裂する。
 *
 * D5: 判断は無い。スレッドの帳簿と、1本分の会話の器だけ。
 *     「いつ分身するか」はここに書かない（epic-0006 のスコープ外）。
 */

import type { Canvas } from "./canvas.js";
import type { HostSession } from "./server.js";
import type { NamespacedToolDefinition } from "./tool-registry.js";
import type { ThreadView, TranscriptEntry } from "./protocol.js";

/** 1本分の器を組み立てる。呼ぶたびに**新しい対話ループとキャンバス**を作ること。 */
export type ThreadFactory = (threadId: string) => Promise<{
  session: HostSession;
  canvas?: Canvas;
  /** このスレッドに登録した論理名のTool（wire名の逆引きに使う）。 */
  tools: NamespacedToolDefinition[];
  /** 直近のターンでプロバイダ側エラーがあれば返す。**スレッドごと**に別。 */
  getLastError?: () => string | undefined;
  /** このスレッドの会話履歴を捨てる（new_session）。記憶とキャンバスは触らない。 */
  clearHistory?: () => void;
  /**
   * 対話ループの後始末。スレッドを閉じるとき・ホストを終うときに呼ばれる。
   *
   * `HostSession`（server が要求する最小契約）には入れない——配信に要るものではなく、
   * 器を作った側が知っている後始末だから（ハーネスを差し替えても server は無変更・決定3）。
   */
  dispose?: () => void;
}>;

/** 既定スレッドの名前。閉じられない。 */
const DEFAULT_TITLE = "はじめの会話";

/**
 * 会話スレッド1本。
 *
 * トランスクリプトと知らせの鎖を**スレッドごとに持つ**のが要点——ここを共有すると、
 * 職人からの報告が関係ないスレッドの会話に現れる（決定35a）。
 */
export class Thread {
  readonly id: string;
  title: string;
  /**
   * 畳んだスレッドは**消えない**（Worker Pool の決定30c と同じ発想）。
   * 一覧から外れるだけで、履歴として読めるし同じ会話のまま再開できる。
   */
  state: "open" | "closed" = "open";
  closedAt: string | undefined;
  readonly session: HostSession;
  readonly canvas: Canvas | undefined;
  readonly toolNames: string[];
  /**
   * `threadId` 省略時の宛先か。**固定ではない**——開いている先頭が担う（PO要望
   * 2026-07-31：どの会話も畳めるようにした帰結）。帳簿が開閉のたびに付け替える。
   */
  isDefault = false;
  readonly getLastError: () => string | undefined;
  readonly clearHistory: () => void;
  /** 会話の真実。接続時にまとめて配り、以後は差分イベントで追随させる（D3）。 */
  transcript: TranscriptEntry[] = [];
  /**
   * 知らせを1本ずつ順に流すための鎖。**スレッドごと**に持つ。
   * 職人が同時に複数報告してきても、そのスレッドのターンは1本ずつ進む。
   */
  notices: Promise<void> = Promise.resolve();
  /** 購読解除と後始末。閉じるときに呼ぶ。 */
  readonly disposers: Array<() => void> = [];

  constructor(params: {
    id: string;
    title: string;
    session: HostSession;
    canvas?: Canvas;
    tools: NamespacedToolDefinition[];
    getLastError?: () => string | undefined;
    clearHistory?: () => void;
    dispose?: () => void;
  }) {
    this.id = params.id;
    this.title = params.title;
    this.session = params.session;
    this.canvas = params.canvas;
    this.toolNames = params.tools.map((t) => t.name);
    this.getLastError = params.getLastError ?? ((): string | undefined => undefined);
    this.clearHistory = params.clearHistory ?? ((): void => undefined);
    if (params.dispose) this.disposers.push(params.dispose);
  }

  view(): ThreadView {
    return {
      threadId: this.id,
      title: this.title,
      sessionId: this.session.sessionId,
      isDefault: this.isDefault,
      state: this.state,
      ...(this.closedAt ? { closedAt: this.closedAt } : {}),
    };
  }

  /**
   * 履歴に1行足す。テキスト差分は直前の番頭発話へ連結し、Tool終了は対応する
   * 実行中の行を更新する——クライアント側の描画と同じ形に揃えておくことで、
   * 再接続時に history をそのまま描けば会話が復元される。
   */
  record(entry: TranscriptEntry): void {
    const last = this.transcript[this.transcript.length - 1];
    if (entry.role === "banto" && last?.role === "banto") {
      this.transcript[this.transcript.length - 1] = { role: "banto", text: last.text + entry.text };
      return;
    }
    if (entry.role === "tool" && entry.state !== "running") {
      const index = this.transcript.findIndex(
        (e) => e.role === "tool" && e.name === entry.name && e.state === "running"
      );
      if (index !== -1) {
        this.transcript[index] = entry;
        return;
      }
    }
    this.transcript.push(entry);
  }

  /** 会話を捨ててやり直す。キャンバスと記憶は触らない。 */
  clear(): void {
    this.clearHistory();
    this.transcript = [];
  }

  dispose(): void {
    for (const off of this.disposers) off();
    this.disposers.length = 0;
  }
}

/** スレッドの帳簿。開閉の通知だけを外へ出す。 */
export class ThreadRegistry {
  private readonly threads = new Map<string, Thread>();
  private readonly factory: ThreadFactory;
  private readonly listeners = new Set<(threads: Thread[]) => void>();
  private counter = 0;

  constructor(factory: ThreadFactory) {
    this.factory = factory;
  }

  /**
   * 新しいスレッドを開く。**既存のスレッドには何も起きない**（決定2）。
   *
   * 最初の1本が既定スレッドになる——`threadId` を省略したメッセージの宛先で、
   * 閉じられない（宛先が無くなると、スレッドを知らないクライアントが話せなくなる）。
   */
  async open(title?: string): Promise<Thread> {
    const id = `thread-${++this.counter}`;
    const first = this.threads.size === 0;
    const parts = await this.factory(id);
    const thread = new Thread({
      id,
      title: title ?? (first ? DEFAULT_TITLE : `会話 ${this.counter}`),
      session: parts.session,
      ...(parts.canvas ? { canvas: parts.canvas } : {}),
      tools: parts.tools,
      ...(parts.getLastError ? { getLastError: parts.getLastError } : {}),
      ...(parts.clearHistory ? { clearHistory: parts.clearHistory } : {}),
      ...(parts.dispose ? { dispose: parts.dispose } : {}),
    });
    this.threads.set(id, thread);
    this.refreshDefault();
    this.emit();
    return thread;
  }

  /**
   * 既定スレッド（`threadId` 省略時の宛先）を開いている先頭に付け替える。
   *
   * どれか1本を「閉じられない特別な会話」にすると、PO はいちばん最初の会話を
   * 片付けられない。代わりに宛先を動的にする——**全部畳んだら宛先は無くなる**が、
   * それは空状態として扱う（プロトタイプにも空状態がある）。
   */
  private refreshDefault(): void {
    const open = this.list({ state: "open" });
    for (const thread of this.threads.values()) thread.isDefault = false;
    if (open[0]) open[0].isDefault = true;
  }

  /**
   * スレッドを畳む。**消さない**——会話もキャンバスもそのまま残り、履歴として読めるし
   * `reopen` で同じ会話の続きから話せる（決定30c と同じ扱い）。
   *
   * 購読も解除しない。再開したときに配信が死んでいると、戻ったのに何も流れてこない。
   *
   * **どの会話も畳める**（PO要望 2026-07-31）。畳んだ結果 `threadId` 省略の宛先が
   * 無くなることはありうる——それは空状態として扱い、隠さない。
   *
   * I2: 未知のIDは黙って成功にせずエラーにする。
   */
  close(threadId: string, now = new Date()): void {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`unknown thread: ${threadId}`);
    if (thread.state === "closed") return; // 冪等
    thread.state = "closed";
    thread.closedAt = now.toISOString();
    this.refreshDefault();
    this.emit();
  }

  /** 畳んだスレッドを開き直す。会話はそのまま残っているので続きから話せる。 */
  reopen(threadId: string): Thread {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`unknown thread: ${threadId}`);
    thread.state = "open";
    thread.closedAt = undefined;
    this.refreshDefault();
    this.emit();
    return thread;
  }

  /**
   * 宛先を引く。畳んだスレッドも引ける——知らせを届けるため（決定35b）。
   * `threadId` 省略時は既定スレッド（スレッドを知らないクライアント）。
   * I2: 知らないIDを既定へ黙って落とさない——別の会話に発話が紛れ込む。
   */
  resolve(threadId?: string): Thread {
    if (threadId === undefined) {
      const fallback = this.list({ state: "open" })[0];
      // I2: 全部畳まれている状態を黙って作らない。呼び出し側が空状態として扱う
      if (!fallback) throw new Error("no open thread");
      return fallback;
    }
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`unknown thread: ${threadId}`);
    return thread;
  }

  get(threadId: string): Thread | undefined {
    return this.threads.get(threadId);
  }

  /**
   * スレッドの一覧。**畳んだ分も既定で含む**——閉じても記録は残る（決定30c）。
   * 開いているものだけ見たいなら `{ state: "open" }`。
   */
  list(filter: { state?: "open" | "closed" } = {}): Thread[] {
    const all = [...this.threads.values()];
    return filter.state ? all.filter((t) => t.state === filter.state) : all;
  }

  /** `threadId` 省略時の宛先。開いている会話が無ければ undefined（空状態）。 */
  get defaultThreadId(): string | undefined {
    return this.list({ state: "open" })[0]?.id;
  }

  /** 開閉・改名を購読する。戻り値で解除。 */
  subscribe(listener: (threads: Thread[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 名前が変わったことを知らせる（改名は Thread.title を直接書き換える）。 */
  emit(): void {
    const snapshot = this.list();
    for (const listener of this.listeners) listener(snapshot);
  }

  dispose(): void {
    for (const thread of this.threads.values()) thread.dispose();
    this.threads.clear();
    this.listeners.clear();
  }
}
