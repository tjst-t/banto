// Arm B — state() + 追記時の増分適用。購読者に配るのは「更新後の State」
// （イベントだけを配ると、購読側で fold し直す形が戻り、v3 の失敗が購読経路から再発する）。
import { promises as fsp } from 'node:fs';
import { readFrom, appendLine, zeroCursor } from './shared/jsonl.mjs';
import { empty, apply, FOLD_VERSION } from './shared/fold.mjs';
import { makeSerialQueue } from './shared/queue.mjs';

export class StoreB {
  constructor(dir) {
    this.path = `${dir}/log.jsonl`;
    this._state = empty();
    this._cursor = zeroCursor();
    this._listeners = new Set();
    this.foldCalls = 0; // open() のたびに 1 回だけ増える想定（M1 の対照）
    this._enqueue = makeSerialQueue(); // append を直列化する（実測で必要性が判明。下記 append 参照）
  }

  /** cold start: ログ全体を1回だけ fold してから使える状態にする。 */
  static async open(dir) {
    const store = new StoreB(dir);
    store.foldCalls += 1;
    for await (const { event, cursor } of readFrom(store.path, zeroCursor())) {
      store._state = apply(store._state, event);
      store._cursor = cursor;
    }
    return store;
  }

  state() {
    return this._state; // O(1)。呼び出し側はこれを直接書き換えない前提（pure apply を信頼する）
  }

  cursor() {
    return this._cursor;
  }

  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /**
   * 直列化する（実測 2026-08-30）：並行に呼ぶと fd キャッシュ（shared/jsonl.mjs）が
   * レースし fd がリークする。直列化すればキューの中は常に1本なので、
   * 追記も cursor 更新も安全になる。
   */
  append(event) {
    return this._enqueue(() => this._appendOne(event));
  }

  async _appendOne(event) {
    const bytesWritten = await appendLine(this.path, event); // fsync 済みで解決する
    this._state = apply(this._state, event);
    this._cursor = { seq: this._cursor.seq + 1, byteOffset: this._cursor.byteOffset + bytesWritten };
    for (const fn of this._listeners) fn(this._state, event, this._cursor);
    return this._cursor;
  }

  /** 規則3 の試験対象：ここで作った state が、ログだけからの再計算と一致するはず。 */
  async rebuildFromScratch() {
    let s = empty();
    let c = zeroCursor();
    for await (const { event, cursor } of readFrom(this.path, zeroCursor())) {
      s = apply(s, event);
      c = cursor;
    }
    return { state: s, cursor: c };
  }

  async dropDerived() {
    // B には永続的な派生物が無い（メモリだけ）。rebuildFromScratch で代用する。
  }

  async statBytes() {
    try {
      const st = await fsp.stat(this.path);
      return st.size;
    } catch {
      return 0;
    }
  }
}

export { FOLD_VERSION };
