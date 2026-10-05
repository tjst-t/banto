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
// ターンの途中経過」だけで、終われば捨てる。AI の発言は書き終えるごとに記録にも入る
// （改訂・2026-10-05、アーキ仕様 §2.5）ので、流し直す分と記録は重なる——境界は
// そのターンの始まりの seq（`startedSeq`）で、画面がそれより後ろの AI の記録を外す。

import type { TurnStreamEvent } from "./turn-runner.js";

interface LiveTurn {
  /** そのターンがこれまでに出したイベント（再接続したときに流し直す）。 */
  events: TurnStreamEvent[];
  startedAt: string;
  /**
   * そのターンの `turn.started` の seq（追加・2026-10-05）。**流し直しと記録の境界**——AI の発言は書き終えるごとに
   * これより後ろの記録に入るので、流し直す画面は記録からその分を外す（2回出さない）。始まりを書くまでは無い
   */
  startedSeq?: number;
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
  private readonly startListeners = new Map<string, Set<() => void>>();

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
   * **ターンの始まりを記録した**（追加・2026-10-05）。走り始めた時刻を記録に残した始まり（`turn.started` の ts）に
   * そろえ、始まりの seq（流し直しと記録の境界）を覚える。`begin` は始まりを書くより前に呼ぶ（それより前に断った
   * ターンも流し直せるように）ので、あとから足す
   */
  markStarted(threadId: string, startedAt: string, startedSeq: number): void {
    const turn = this.live.get(threadId);
    if (!turn) return;
    turn.startedAt = startedAt;
    turn.startedSeq = startedSeq;
    this.notifyStarted(threadId);
  }

  /**
   * **流し直しの境界が決まったら、一度だけ知らせる**（追加・2026-10-05）。始まりを記録した・始まりを書く前に何か
   * 流した（断った・止めた——このターンは記録に AI の発言を書かない）・終わった、のどれか。返り値を呼ぶと聞くのをやめる
   */
  whenStarted(threadId: string, listener: () => void): () => void {
    const turn = this.live.get(threadId);
    if (!turn || turn.startedSeq !== undefined || turn.events.length > 0) {
      listener();
      return () => undefined;
    }
    let set = this.startListeners.get(threadId);
    if (!set) {
      set = new Set();
      this.startListeners.set(threadId, set);
    }
    set.add(listener);
    return () => {
      const current = this.startListeners.get(threadId);
      current?.delete(listener);
      if (current?.size === 0) this.startListeners.delete(threadId);
    };
  }

  private notifyStarted(threadId: string): void {
    const waiting = this.startListeners.get(threadId);
    this.startListeners.delete(threadId);
    for (const listener of waiting ?? []) listener();
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
    this.notifyStarted(threadId);
  }

  /** ターンが終わった。**途中経過は捨てる**——ここから先の真実は Event Store。 */
  end(threadId: string): void {
    this.live.delete(threadId);
    this.notifyStarted(threadId);
  }

  /** 走行中なら、それまでに出たイベント。走っていなければ undefined。 */
  snapshot(threadId: string): { events: TurnStreamEvent[]; startedAt: string; startedSeq?: number } | undefined {
    const turn = this.live.get(threadId);
    if (!turn) return undefined;
    return {
      events: [...turn.events],
      startedAt: turn.startedAt,
      ...(turn.startedSeq !== undefined ? { startedSeq: turn.startedSeq } : {}),
    };
  }

  isRunning(threadId: string): boolean {
    return this.live.has(threadId);
  }
}
