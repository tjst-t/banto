// **走行中のターンの、生きた1本の通り道**（`turn-stream-reattach`、決定・2026-09-10）。
//
// もともとは「ターンの外から起きた判断待ちを、走行中のターンの画面へ流す」ための
// 細い口だった（docs/specs/v4-frontend.md「Module 間中継の承認」——中継ゲートは
// turn-runner の generator から呼ばれていないので、両者を繋ぐ必要があった）。
//
// ここに**そのターンが出したイベントを覚える**役目を足した。理由は実測：
// **走行中にリロードすると、出力どころか「走っている」ことすら画面から消える**
// ——ターンのイベント列は `POST /api/threads/:id/messages` の応答の中にしか無く、
// 接続が切れたら戻る先が無かった。覚えておけば、`GET /api/threads/:id/stream` で
// **最初から流し直して、続きもそのまま**渡せる。
//
// **記録の真実は Event Store のまま**（規則3）。ここが持つのは「いま走っている
// ターンの、まだ記録に落ちていない途中経過」だけで、終われば捨てる。

import type { TurnStreamEvent } from "./turn-runner.js";

interface LiveTurn {
  /** そのターンがこれまでに出したイベント（再接続したときに流し直す）。 */
  events: TurnStreamEvent[];
  startedAt: string;
}

/**
 * **向きの違う2本を、混ぜない**（実装時に踏んだ、2026-09-10）。
 *
 *  - `side`：ターンの**外から中へ**（中継ゲートの判断待ち → 走行中のターン）
 *  - `stream`：ターンの**中から外へ**（ターンが出したもの → あとから繋いだ画面）
 *
 * 1本にまとめたら、ターンが出したイベントが**自分自身の side に戻ってきて**
 * 無限に回った（試験が終わらなくなって気づいた）。向きが違うものは別の口にする。
 */
export class TurnEventBus {
  private readonly sideListeners = new Map<string, Set<(event: TurnStreamEvent) => void>>();
  private readonly streamListeners = new Map<string, Set<(event: TurnStreamEvent) => void>>();
  private readonly live = new Map<string, LiveTurn>();
  private readonly beginListeners = new Map<string, Set<() => void>>();

  private static add(
    map: Map<string, Set<(event: TurnStreamEvent) => void>>,
    threadId: string,
    listener: (event: TurnStreamEvent) => void,
  ): () => void {
    let set = map.get(threadId);
    if (!set) {
      set = new Set();
      map.set(threadId, set);
    }
    set.add(listener);
    return () => {
      const current = map.get(threadId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) map.delete(threadId);
    };
  }

  /** ターンの**外から中へ**（走行中のターンが聞く）。 */
  subscribeSide(threadId: string, listener: (event: TurnStreamEvent) => void): () => void {
    return TurnEventBus.add(this.sideListeners, threadId, listener);
  }

  /** ターンの**中から外へ**（あとから繋いだ画面が聞く）。 */
  subscribeStream(threadId: string, listener: (event: TurnStreamEvent) => void): () => void {
    return TurnEventBus.add(this.streamListeners, threadId, listener);
  }

  /** 聞いている人がいなければ何もしない——判断待ちは受信箱に残っている。 */
  publish(threadId: string, event: TurnStreamEvent): void {
    for (const listener of this.sideListeners.get(threadId) ?? []) listener(event);
  }

  /** ターンが始まった。**前の途中経過は捨てる**（残すのは走行中の1本だけ）。 */
  begin(threadId: string, startedAt: string): void {
    this.live.set(threadId, { events: [], startedAt });
    const waiting = this.beginListeners.get(threadId);
    this.beginListeners.delete(threadId);
    for (const listener of waiting ?? []) listener();
  }

  /**
   * **走り始めた時刻を、記録に残した始まり（`turn.started` の ts）にそろえる**（追加・2026-10-05）。`begin` は
   * 始まりを書くより前に呼ぶ（それより前に断ったターンも流し直せるように）ので、時刻はあとから直す
   */
  setStartedAt(threadId: string, startedAt: string): void {
    const turn = this.live.get(threadId);
    if (turn) turn.startedAt = startedAt;
  }

  /**
   * **そのターンが走り始めたら、一度だけ知らせる**（追加・2026-09-26）。順番の鍵を取ってから走り始めるまでには
   * Module を起こす等で数秒かかる——その間に繋ぎ直しに来た画面を「走っていない」と帰さないために待つ。
   * 返り値を呼ぶと、聞くのをやめる
   */
  whenBegun(threadId: string, listener: () => void): () => void {
    let set = this.beginListeners.get(threadId);
    if (!set) {
      set = new Set();
      this.beginListeners.set(threadId, set);
    }
    set.add(listener);
    return () => {
      const current = this.beginListeners.get(threadId);
      current?.delete(listener);
      if (current?.size === 0) this.beginListeners.delete(threadId);
    };
  }

  /** そのターンが出したイベントを覚え、**あとから繋いだ画面**にも渡す。 */
  record(threadId: string, event: TurnStreamEvent): void {
    this.live.get(threadId)?.events.push(event);
    for (const listener of this.streamListeners.get(threadId) ?? []) listener(event);
  }

  /** ターンが終わった。**途中経過は捨てる**——ここから先の真実は Event Store。 */
  end(threadId: string): void {
    this.live.delete(threadId);
  }

  /** 走行中なら、それまでに出たイベント。走っていなければ undefined。 */
  snapshot(threadId: string): { events: TurnStreamEvent[]; startedAt: string } | undefined {
    const turn = this.live.get(threadId);
    if (!turn) return undefined;
    return { events: [...turn.events], startedAt: turn.startedAt };
  }

  isRunning(threadId: string): boolean {
    return this.live.has(threadId);
  }
}
