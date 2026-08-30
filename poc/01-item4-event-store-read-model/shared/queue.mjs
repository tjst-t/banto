// append を直列化するための最小のキュー。
//
// 実測で発覚した必要性（規則3 のプロパティ試験・並行 append で判明）：
// 直列化しないと (1) shared/jsonl.mjs の fd キャッシュが並行 open() でレースし
// fd がリークする、(2) this._cursor の読み取り→書き込みの間に他の append が
// 割り込みうる（今回は canonical 比較が通ったので実害は出なかったが、
// 実装として正しさを保証していない）。**Event Store の append は
// プロセス内で直列化する**という決定は、ここから出た。
export function makeSerialQueue() {
  let tail = Promise.resolve();
  return function enqueue(fn) {
    const result = tail.then(fn, fn);
    // 前の呼び出しが reject しても、キュー自体は継続できるようにする
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}
