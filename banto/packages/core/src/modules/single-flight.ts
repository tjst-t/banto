// 同じ鍵の処理が同時に走らないようにする（決定・2026-09-06）。
//
// **名前のある機構**（single-flight / request coalescing）なので、自分で
// 考えずに既知の形を使う（規則12）。
//
// なぜ要るか：Module の起動は「もう起動済みか」を見てから実際に起動するまでに
// **await が挟まる**。その間に同じ Module へのもう1本が同じ判定を通ると、
// 二重に起動する。Vault のように起動時に鍵を作る Module では、
// 二重起動が `identity.txt: file exists` として現れた（実測・2026-09-06、
// E2E が3回に1回落ちた原因）。
//
// 待ちを延ばして誤魔化さない（規則6）——**同時に来たものは同じ1本を待つ**。
export class SingleFlight<T> {
  private readonly inFlight = new Map<string, Promise<T>>();

  async run(key: string, factory: () => Promise<T>): Promise<T> {
    const running = this.inFlight.get(key);
    if (running) return running;
    // factory() は同期的に呼ぶ——ここに await を挟むと、防ごうとしている隙が戻る
    const promise = factory().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }
}
