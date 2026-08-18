/**
 * 幹・枝の**定期監視（watchdog）**（task-0278・prop-2026-08-18-thread-watchdog-and-auto-fold）。
 *
 * ## 何を解くか
 *
 * banto は幹・枝を「知らせ（イベント駆動）」でしか起こさない。イベントの出所
 * （職人・Kobo・環境プール）が消えると誰も起こさず、枝が永久に待つ。また還す条件が
 * 満たされた枝が開いたまま残る。既知の欠陥 imp-0059（返らないターンに見張りが無い）も
 * ここで塞ぐ。
 *
 * このモジュールは**時間で定期的に**幹・枝の状態を見て、
 *
 *  - 詰まっている枝を**事実だけ添えて起こす（nudge）**
 *  - 鍵が終端に達した T3 の用件の枝を**事実由来の結論で畳む（自動畳み）**
 *
 * ## 事実ベースのみ（推測で起こさない）
 *
 * 検知に使うのは**帳簿（threads）と、呼び出し側が渡す事実**だけ。閾値を当てずっぽうに
 * 置くのを避け、**測れないものは判定しない**（I2: 計測できない＝「詰まっている」と
 * 混同しない）:
 *
 * 1. **待ち先が消えている**——`facts().aliveWorkerSessions` が渡っていて、かつ
 *    `worker:*` の鍵を待つ枝の session がそれに無い。
 * 2. **ターンが返らない**——`watchTurnStart` から `watchTurnEnd` が無いまま
 *    `turnStallMs` を超えた（imp-0059 の穴）。nudge は詰まった枝へ届き、台帳の列は
 *    走行中のターンの後ろに並ぶ——正常な長考を殺さない（止めない・促すだけ）。
 * 3. **待ち先が終端に達した**——`facts().terminalKeys` に、開いた T3 用件の枝の鍵が
 *    ある。このときだけ**自動畳み**する（結論は事実から一意に導ける）。
 * 4. **長期間無活動**——`inactivityMs` を超えて `lastActivityAt` が動いていない開いた枝。
 *    既定は無効（`0`）。既存 `watchStaleBranches`（取次へ上げる）と二重にしないため、
 *    このモジュールでは**枝自身を nudge で起こす**。
 *
 * ## 自動畳みの範囲（勝手に畳まない）
 *
 * 畳む対象は **T3 の用件の枝（`subjectKey` を持つ・機構が知らせのために開いたもの）で、
 * 鍵が終端に達したもの**だけ。結論は事実（`terminalKeys` に添えた1行）から導く——
 * 自由文の還す条件には使わない。
 *
 * 対象外（畳まない）:
 *  - **手開きの議論枝（`subjectKey` が無い・`thread.open`）**——還す条件が自由文で
 *    機械評価できない。nudge はする（`inactivityMs` が設定されていれば）。
 *  - **走行中（ターンが回っている）の枝**——ターンが答えを返す前に畳まない。
 *    走行中 = `harness.isStreaming` か、`watchTurnStart` から `watchTurnEnd` が無い枝。
 *  - **未処理（remaining）を抱えた枝**——所在（`settledWhere`）が決まるまで畳まない
 *    （`thread.merge` の規律）。このときは nudge で促す。
 *
 * ## nudge の連打を防ぐ（a7）
 *
 * 1回 nudge した枝は履歴に残し、`nudgeCooldownMs` の間は同じ枝へ nudge しない。
 *
 * ## 冪等（a1）
 *
 * `tick()` は何度走っても同じ結果——既に畳んだ枝は `state` を見て避け、nudge は
 * 履歴で抑える。tick に副作用（setInterval の追加等）は無い。
 *
 * D5: ここは検知と行為の**繋ぎ**に徹する。畳みの規律（remaining の検査・走行中の
 * 拒否）は `ThreadRegistry.fold` が持っており、このモジュールは事前に省いてから呼ぶ。
 */

import type { Thread } from "./threads.js";
import type { ThreadRegistry } from "./threads.js";

/**
 * 検知に使う**事実**。呼び出し側（bin.ts・試験）が帳簿の外から渡す。
 *
 * 「渡っていない＝測れない」は「正常」と同じ扱いにする——計測できないときは検知しない
 * （I2: 測れない＝詰まっている、と混同しない）。
 */
export interface ThreadWatchdogFacts {
  /**
   * 生きている worker session の id。**無し（undefined）＝worker 帳簿を引けない**——
   * このときは待ち先消失の検知をしない。
   */
  aliveWorkerSessions?: ReadonlySet<string>;
  /**
   * 終端に達した用件の鍵（`subjectKey` の形 `worker:sess-3` / `kobo:task-0151` /
   * `env:env-12`）→ **その事実**（人間が読める1行。自動畳みの結論に使う）。
   */
  terminalKeys?: ReadonlyMap<string, string>;
}

/**
 * 同一枝への nudge を間隔を空けて行うための履歴（a7）。
 *
 * 記録の真実は**実行時のこの Map**。`tick()` が何回走っても、cooldown 内なら
 * もう一度 nudge しない。枝が動き出せば（開いたままでも）いつか cooldown が明けて
 * 再評価される——永久に黙ることはない。
 */
export interface WatchdogNudgeHistory {
  /** 最後に nudge した時刻（ms）。 */
  at: number;
}

/**
 * 待ち先が消えた枝への nudge 文。**事実だけ**（PO サマリは出さない・PO 裁定）。
 */
export function workerGoneMessage(sessionId: string, label: string): string {
  return (
    `［見張り（watchdog）］あなたの待ち先（worker ${sessionId}＝${label}）は ` +
    "worker 帳簿から消えました。職人が消えて報告は来ません。この枝をどうするか判断してください。"
  );
}

/**
 * ターンが返らない枝への nudge 文。imp-0059 の穴を塞ぐ。**止めない・促すだけ**——
 * 走っている側のターンはそのまま進め、これが届くのはその後の番（台帳の列の後ろ）。
 */
export function turnStallMessage(threadId: string, minutes: number): string {
  return (
    `［見張り（watchdog）］${threadId} のターンが ${minutes} 分以上返っていません。` +
    "プロセスは生きているのに会話が黙っている可能性があります。続きを進めてください。"
  );
}

/** 未処理を抱えた終端の枝への nudge 文（a6・所在が決まるまで畳まない）。 */
export function unsettledRemainingFoldMessage(label: string): string {
  return (
    `［見張り（watchdog）］${label} は終端に達したため、この用件の枝は役目を終えています。` +
    "この枝には未処理（remaining）が残っています——`thread.settle` で**所在**を決めてから畳んでください。"
  );
}

/** 長期間無活動の枝への nudge 文。手開きの議論枝もこれで起こす（a5・nudge のみ）。 */
export function inactivityMessage(threadId: string, hours: number): string {
  return (
    `［見張り（watchdog）］${threadId} が ${hours} 時間以上なにも記録されていません。` +
    "還す条件（または畳む判断）を確認して、結論を1行で幹へ還してください。"
  );
}

/**
 * 待ち先（worker）の鍵。`worker:sess-3` の形をしているか。
 */
export function isWorkerSubjectKey(subjectKey: string): boolean {
  return subjectKey.startsWith("worker:");
}

/**
 * 検知して都合1回だけ起こす/畳む、**tick 1回分**の結果。
 *
 * 純粋な検知はこれを作るところまで。実際の nudge / fold は副作用なので `tick()` が
 * 行い、この返り値は試験から副作用なしに観測するための窓でもある。
 */
export interface WatchdogTickOutcome {
  /** 事実を添えて nudge した枝。 */
  nudged: Array<{ threadId: string; message: string }>;
  /** 事実由来の結論で自動で畳んだ枝。 */
  folded: Array<{ threadId: string; conclusion: string }>;
  /** cooldown 中で nudge を送らなかった枝（連打を避けた事実）。 */
  suppressed: string[];
}

export interface ThreadWatchdogOptions {
  threads: ThreadRegistry;
  /** 検知した枝を起こす口。**既存の server.nudge を渡す**（決定107・再利用）。 */
  nudge: (threadId: string, text: string) => Promise<void>;
  /**
   * 自動畳みで呼ぶ口。**`ThreadRegistry.fold` を渡す**——規律（走行中・未処理・親）は
   * 帳簿が持つ（D5）。このモジュールは事前に省いて呼ぶ。
   */
  fold: (branchId: string, trunkId: string, conclusion: string) => void;
  /** 事実を引く。**毎 tick 呼ばれる**（最新の帳簿を見る）。 */
  facts: () => ThreadWatchdogFacts;
  /** 時刻。既定 `Date.now`。試験から差し替えて時間を進める。 */
  now?: () => number;
  /** ログ。既定はコンソールへ。 */
  log?: (message: string) => void;
  /** ターンが返らないと見なすまでのミリ秒。既定 15 分（imp-0059）。 */
  turnStallMs?: number;
  /**
   * 長期間無活動の検知（ミリ秒）。`0` 以下で無効（既定）——既存 `watchStaleBranches`
   * が取次への衛生を持つため、二重にしない。
   */
  inactivityMs?: number;
  /** 同一枝へ nudge を連打しないための間隔。既定 10 分（tick 周期と同じ）。 */
  nudgeCooldownMs?: number;
  /** 周期（ミリ秒）。既定 10 分。起動時にも1回走る（a1）。 */
  intervalMs?: number;
}

/** 既定の周期（task の間隔 10 分・PO 裁定 2026-08-18）。 */
export const DEFAULT_WATCHDOG_INTERVAL_MS = 10 * 60_000;
/** ターンが返らないと見なす時間（例: 15 分・imp-0059）。 */
export const DEFAULT_TURN_STALL_MS = 15 * 60_000;
/** nudge を空ける間隔（同一枝への連打を防ぐ）。tick 周期と同じ 10 分。 */
export const DEFAULT_NUDGE_COOLDOWN_MS = 10 * 60_000;

/**
 * 幹・枝の定期監視。
 *
 * `start()` が**起動時に1回 `tick()` を走らせ**、その後 `intervalMs` ごとに繰り返す
 * （a1）。単体では `tick()` を直接呼んで閾値・事実を制御して検証する（試験の形）。
 */
export class ThreadWatchdog {
  private readonly threads: ThreadRegistry;
  private readonly nudge: (threadId: string, text: string) => Promise<void>;
  private readonly fold: (branchId: string, trunkId: string, conclusion: string) => void;
  private readonly facts: () => ThreadWatchdogFacts;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly turnStallMs: number;
  private readonly inactivityMs: number;
  private readonly nudgeCooldownMs: number;
  private readonly intervalMs: number;
  /**
   * ターンの見張り（imp-0059）。`watchTurnStart` から無いまま `watchTurnEnd` が
   * 呼ばれていない枝を知る。**1枝につき1ターン**が前提（会話の列は直列）。
   */
  private readonly turnStartedAt = new Map<string, number>();
  /** nudge の履歴（a7・連打を防ぐ）。 */
  private readonly nudgedAt = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: ThreadWatchdogOptions) {
    this.threads = options.threads;
    this.nudge = options.nudge;
    this.fold = options.fold;
    this.facts = options.facts;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((m) => console.error(`[banto] watchdog: ${m}`));
    this.turnStallMs = options.turnStallMs ?? DEFAULT_TURN_STALL_MS;
    this.inactivityMs = options.inactivityMs ?? 0;
    this.nudgeCooldownMs = options.nudgeCooldownMs ?? DEFAULT_NUDGE_COOLDOWN_MS;
    this.intervalMs = options.intervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;
  }

  /**
   * ターンの開始を記録する（imp-0059 の見張り）。サーバがターンを始めたときに呼ぶ。
   */
  watchTurnStart(threadId: string): void {
    this.turnStartedAt.set(threadId, this.now());
  }

  /** ターンが終わった（返った）ことを記録する。 */
  watchTurnEnd(threadId: string): void {
    this.turnStartedAt.delete(threadId);
  }

  /**
   * その枝が**いま走行中**か（自動畳みを避ける・走行中の枝は畳まない）。
   *
   * 走行中 = ターンが `watchTurnStart` から返っていない、または `isStreaming`
   * （ハーネスがトークンを吐いている）。どちらか見えれば走行中として扱う。
   */
  isRunning(thread: Thread): boolean {
    return this.turnStartedAt.has(thread.id) || thread.harness.isStreaming;
  }

  /**
   * 周期監視を始める。**起動時に1回 `tick()` を走らせて**から `intervalMs` ごとに
   * 繰り返す（a1）。timer は unref——この見張りだけがプロセスを生かし続けない。
   *
   * @returns 止める口。
   */
  start(): () => void {
    void this.tick().catch((err) => this.log(`起動時の tick で転びました: ${String(err)}`));
    this.timer = setInterval(() => {
      void this.tick().catch((err) => this.log(`tick で転びました: ${String(err)}`));
    }, this.intervalMs);
    this.timer.unref?.();
    return () => {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    };
  }

  /**
   * 1回の監視。**冪等**（a1）——何度走らせても同じ結果で、既に起こした・畳んだものを
   * 二重に起こさない・畳まない。副作用（nudge / fold）はここのみ。
   */
  async tick(): Promise<WatchdogTickOutcome> {
    const outcome: WatchdogTickOutcome = { nudged: [], folded: [], suppressed: [] };
    const facts = this.facts();
    const now = this.now();
    const nudged = new Set<string>();
    const openBranches = this.threads
      .list({ state: "open", kind: "branch" })
      .filter((t) => !t.isMain);

    const nudgeOnce = async (
      threadId: string,
      message: string
    ): Promise<void> => {
      if (nudged.has(threadId)) return;
      const last = this.nudgedAt.get(threadId);
      if (last !== undefined && now - last < this.nudgeCooldownMs) {
        outcome.suppressed.push(threadId);
        return;
      }
      nudged.add(threadId);
      this.nudgedAt.set(threadId, now);
      outcome.nudged.push({ threadId, message });
      await this.nudge(threadId, message);
    };

    for (const branch of openBranches) {
      // 1. 待ち先（worker session）が帳簿から消えている（a2）
      if (
        branch.subjectKey &&
        isWorkerSubjectKey(branch.subjectKey) &&
        facts.aliveWorkerSessions !== undefined
      ) {
        const sessionId = branch.subjectKey.slice("worker:".length);
        if (!facts.aliveWorkerSessions.has(sessionId)) {
          await nudgeOnce(branch.id, workerGoneMessage(sessionId, branch.title));
        }
      }

      // 2. ターンが返らない（imp-0059・a3）
      const started = this.turnStartedAt.get(branch.id);
      if (started !== undefined && now - started >= this.turnStallMs) {
        await nudgeOnce(
          branch.id,
          turnStallMessage(branch.id, Math.floor(this.turnStallMs / 60_000))
        );
      }

      // 3/4. 鍵が終端に達した用件の枝（自動畳み a4・a5・a6）、長期間無活動（nudge）
      const terminalLabel =
        branch.subjectKey !== undefined ? facts.terminalKeys?.get(branch.subjectKey) : undefined;
      const inactivityMs =
        this.inactivityMs > 0 && !branch.hasUnsettledRemaining
          ? (() => {
              const since = Date.parse(branch.lastActivityAt);
              return Number.isNaN(since) ? undefined : now - since;
            })()
          : undefined;

      if (terminalLabel !== undefined) {
        // T3 の用件の枝で、鍵が終端に達したもの。
        // 未処理を抱えていれば所在が決まるまで畳まない（a6・nudge のみ）
        if (branch.hasUnsettledRemaining) {
          await nudgeOnce(branch.id, unsettledRemainingFoldMessage(branch.title));
        } else if (this.isRunning(branch)) {
          // 走行中の枝は畳まない。ターンが終われば次回の tick が畳む
          await nudgeOnce(
            branch.id,
            `［見張り（watchdog）］${branch.title} は終端に達しています。このターンが終わったら畳んでください。`
          );
        } else if (branch.parentId) {
          const conclusion = `${terminalLabel}。この用件の枝は役目を終えた`;
          this.fold(branch.id, branch.parentId, conclusion);
          outcome.folded.push({ threadId: branch.id, conclusion });
        } else {
          // I2: 親を引けない枝は黙って畳まず、促す（越しては行けない境）
          await nudgeOnce(
            branch.id,
            `［見張り（watchdog）］${branch.title} は終端に達していますが、親の幹を引けませんでした。畳んでください。`
          );
        }
      } else if (inactivityMs !== undefined && inactivityMs >= this.inactivityMs) {
        // 長期間無活動の開いた枝。手開きの議論枝（subjectKey 無し）もここで起こす（a5）
        await nudgeOnce(
          branch.id,
          inactivityMessage(branch.id, Math.floor(this.inactivityMs / 3_600_000))
        );
      }
    }

    return outcome;
  }
}
