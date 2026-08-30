// Arm A — v3 そのもの（対照）。read(): Event[] を返し、fold は呼び出し側が自由にやる。
// 「状態が欲しい全員が全件 fold する」形を意図的に再現する。
import { promises as fsp } from 'node:fs';
import { readFrom, appendLine, zeroCursor } from './shared/jsonl.mjs';

export function foldCounter() {
  return { count: 0 };
}

export class StoreA {
  constructor(dir) {
    this.path = `${dir}/log.jsonl`;
    this.foldCalls = 0; // M1: 全件 fold 回数。テスト・ベンチから読む
  }

  async append(event) {
    return appendLine(this.path, event);
  }

  /** 全件を配列で返す。呼ぶたびにディスクを毎回最初から読む。 */
  async read() {
    const out = [];
    for await (const { event } of readFrom(this.path, zeroCursor())) out.push(event);
    return out;
  }

  /** state が欲しい呼び出し側は、自分で fold する。この関数を呼んだ回数を数える。 */
  async stateViaFullFold(foldFn) {
    this.foldCalls += 1;
    const events = await this.read();
    return foldFn(events);
  }

  async dropDerived() {
    // A には派生物が無い（全部その場で読み直す）ので何もしない。
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
