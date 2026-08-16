/**
 * 会話をホストの再起動を越えて残す（task-0036・決定2）。
 *
 * **2つの別々のものを残す必要がある。**
 *
 * 1. **POに見えていた会話**（誰が何を言ったか・知らせ・Tool の実行）。再接続で `history` として
 *    描き直しているもの。これは導出できない事実なので、ここが持つ。
 * 2. **番頭の文脈**（LLM が覚えている中身）。こちらは pi のセッションファイルが持つ——
 *    `SessionManager.create()` で書き出し、`SessionManager.open()` で読み戻す。
 *
 * **どちらか片方だけでは足りない。** 1 だけだと画面には会話が戻るのに番頭は何も覚えて
 * おらず、2 だけだと番頭は覚えているのに画面が空になる。だから両方を紐づけて残す
 * ——スレッドの索引が pi のセッションファイルの場所を持つ。
 *
 * D3: 索引と記録は導出できない事実なので持つ。開いている／畳んだの別も同じ。
 * I2: 壊れた記録で黙って空から始めない——気づかないまま過去の会話を失うのが一番困る。
 * D6: node:fs / node:path と、原子的書き込みのヘルパ（@banto/core）のみ。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomicSync, nodeAtomicWriteOps, type AtomicWriteOps } from "@banto/core";
import type { TranscriptEntry } from "./protocol.js";

/** スレッド1本ぶんの索引。中身（発言）は別ファイル。 */
export interface StoredThread {
  id: string;
  title: string;
  /**
   * 幹か枝か（ADR-0017 決定77）。**古い索引には無い**——読み戻す側が先頭を幹として扱う。
   */
  kind?: "trunk" | "branch";
  /** 帳場（メインの幹）か。店にただ1つで、終えない（PO裁定 2026-08-10）。 */
  isMain?: boolean;
  /** 枝の親（常に幹）。 */
  parentId?: string;
  /** 還す条件。枝には必ずある（決定77）。 */
  returnCondition?: string;
  /** 誰が開いたか。 */
  openedBy?: "banto" | "po";
  /** 開いた理由。 */
  openReason?: string;
  /**
   * **用件の鍵**（T3）。機構が知らせのために開いた枝だけが持つ（職人の `sessionId`・
   * `projectTag/taskId`・`envId`）。ここが落ちると、再起動した直後の1通目が
   * 同じ用件の枝を見つけられず、同じ対象の枝が二重に立つ。
   */
  subjectKey?: string;
  /** 畳んだときの結論。 */
  conclusion?: string;
  /**
   * 畳んだときの詳細（決定108）。**幹には流れない**ので、ここが唯一の置き場
   * ——落とすと、再起動した瞬間に「開けば読める」が嘘になる。
   */
  conclusionDetail?: string;
  /**
   * 畳むときに書かれた**残作業の件数**（imp-0036）。中身は `conclusionDetail` の中。
   * ここが落ちると、再起動で未処理が消える＝直そうとしている事故そのものに戻る。
   */
  remainingCount?: number;
  /** 残作業に所在が付いた時刻（`thread.settle`）。 */
  settledAt?: string;
  /** 残作業の所在（起票 id・職人の sessionId・幹での委譲先）。 */
  settledWhere?: string;
  state: "open" | "closed";
  createdAt: string;
  closedAt?: string;
  /** pi のセッションファイル。**番頭の文脈はこちらが持つ**（会話の記録とは別物）。 */
  sessionFile?: string;
  /**
   * **バックエンド側の会話の札**（`BantoHarness.resumeToken()`・決定97・task-0104）。
   *
   * pi はセッションファイル（上）で戻るが、Agent SDK は自分の置き場に記録を持っていて
   * **セッションIDでしか指せない**。ここを残していなかったので、Claude で話していた
   * 会話は**再起動のたびに番頭だけが全部忘れた**——画面には記録が戻るので、POからは
   * 「番頭が急に前提を無視し始めた」に見える。
   */
  backendSessionId?: string;
  /** この会話で使っていたモデル。再起動しても同じモデルで再開する。 */
  model?: { backend?: string; provider: string; id: string };
  /** キャンバスに開いていたもの。畳んで開き直したときに元の面へ戻す。 */
  canvasTabs?: Array<{ kind: string; params: Record<string, unknown>; title?: string }>;
}

interface IndexFile {
  version: 1;
  /** 次に振る番号。再起動しても id が衝突しないように持つ。 */
  counter: number;
  threads: StoredThread[];
}

const EMPTY: IndexFile = { version: 1, counter: 0, threads: [] };

/**
 * **このプロセスが把握している記録の姿**（inc-0075・task-0164）。
 *
 * 中身は持たない——役（`role`）の並びと、最後に書いた／読んだときのファイルの姿だけ。
 * 縮小拒否に要るのはこの2つで、全文を抱えるとメモリが会話の長さぶん二重になる。
 */
interface KnownTranscript {
  /** 役の並び。件数（`roles.length`）が縮小拒否の基準になる。 */
  roles: string[];
  /** 最後にこのプロセスが書いた／読んだときのファイルの姿。合っていれば他は触っていない。 */
  stamp?: { size: number; mtimeMs: number };
}

/**
 * 書き戻しが不変条件を破っていれば、その理由を返す（破っていなければ `undefined`）。
 *
 * 不変条件は2つ:
 * - **縮まない**（a1）——件数が減る書き戻しは、古いメモリが新しい記録を潰しにきている
 * - **前方一致**（a5）——件数が同じか多くても、既にある行の役が食い違っていれば別物。
 *   33時間ぶんが消えた事故は、この検査1つで発生時点で止まっていた
 */
function shrinkReason(known: readonly string[], entries: readonly TranscriptEntry[]): string | undefined {
  if (entries.length < known.length) {
    return `${known.length} 本の記録が ${entries.length} 本に縮もうとしました`;
  }
  for (let i = 0; i < known.length; i++) {
    const incoming = entries[i]?.role;
    if (incoming === known[i]) continue;
    return (
      `${known.length} 本の記録の前方一致になっていません` +
      `（${i + 1} 行目: 記録は "${known[i]}" なのに書き戻しは "${String(incoming)}"）。` +
      `書き戻しは ${entries.length} 本`
    );
  }
  return undefined;
}

export class ThreadStore {
  private readonly dir: string;
  private readonly writeOps: AtomicWriteOps;
  private index: IndexFile;
  /** スレッドごとの「知っている姿」。縮む書き戻しを拒む基準（task-0164）。 */
  private readonly known = new Map<string, KnownTranscript>();

  /**
   * `writeOps` は**書き込みが途中で失敗したときに元のファイルが無傷か**を測るための口
   * （task-0161）。本番は既定の `nodeAtomicWriteOps` のまま——ここを渡すのは試験だけ。
   * 権限で失敗を作ると root で走る検証環境では再現しないので、口を通して失敗させる。
   */
  constructor(dir: string, writeOps: AtomicWriteOps = nodeAtomicWriteOps) {
    this.dir = dir;
    this.writeOps = writeOps;
    this.index = this.readIndex();
  }

  /** 索引ファイル。 */
  private get indexPath(): string {
    return path.join(this.dir, "index.json");
  }

  /** 会話の記録（1行1発言の JSONL）。 */
  private transcriptPath(threadId: string): string {
    return path.join(this.dir, `${threadId}.jsonl`);
  }

  /** 保存されているスレッド（開いている・畳んだの両方）。 */
  threads(): StoredThread[] {
    return this.index.threads.map((t) => ({ ...t }));
  }

  /** 次に振る番号。再起動を越えて続きから振る。 */
  counter(): number {
    return this.index.counter;
  }

  setCounter(value: number): void {
    if (value <= this.index.counter) return;
    this.index.counter = value;
    this.writeIndex();
  }

  /** スレッドの索引を足す・更新する。 */
  upsert(thread: StoredThread): void {
    const at = this.index.threads.findIndex((t) => t.id === thread.id);
    if (at === -1) this.index.threads.push(thread);
    else this.index.threads[at] = { ...this.index.threads[at], ...thread };
    const number = Number.parseInt(thread.id.replace(/^thread-/, ""), 10);
    if (Number.isFinite(number) && number > this.index.counter) this.index.counter = number;
    this.writeIndex();
  }

  /**
   * スレッドを保存先から消す（PO要望 2026-08-05：何も無いまま閉じた会話は残さない）。
   *
   * **索引・記録・番頭の文脈をまとめて消す。** 索引だけ消すと、記録の JSONL と pi の
   * セッションファイルが誰にも参照されないまま溜まり続ける。
   *
   * I2 の例外ではない: ファイルが既に無いのは失敗ではない（冪等）。消せなかったときは
   * 黙らず知らせるが、索引からは外す——参照が残っているほうが困る。
   */
  remove(threadId: string): void {
    const stored = this.index.threads.find((t) => t.id === threadId);
    this.index.threads = this.index.threads.filter((t) => t.id !== threadId);
    // 消した記録の姿は忘れる（task-0164）。残すと、同じ id が再び現れたときに
    // 存在しない過去の件数で書き戻しを拒んでしまう
    this.known.delete(threadId);
    this.writeIndex();
    for (const file of [this.transcriptPath(threadId), stored?.sessionFile]) {
      if (!file) continue;
      try {
        fs.rmSync(file, { force: true });
      } catch (err) {
        console.error(`[banto] ${file} を消せませんでした: ${String(err)}`);
      }
    }
  }

  /**
   * 発言を1行足す。
   *
   * **追記だけ**にしてあるのが要点——1発話ごとに全文を書き直すと、長い会話ほど重くなり、
   * 途中で落ちたときに壊れる範囲も広がる。
   */
  append(threadId: string, entry: TranscriptEntry): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.transcriptPath(threadId), `${JSON.stringify(entry)}\n`, "utf-8");
    const known = this.knownFor(threadId);
    this.remember(threadId, [...known.roles, entry.role]);
  }

  /**
   * 記録を丸ごと書き直す。
   *
   * `Thread.record` は直前の発言に連結したり実行中の行を更新したりする（画面と同じ形に
   * 揃えるため）。**追記だけでは表現できない更新**があるので、その場合はここで揃える。
   *
   * **縮む書き戻しは拒む**（inc-0075・task-0164）。詳細は `accepts()` を参照。
   */
  replace(threadId: string, entries: readonly TranscriptEntry[]): void {
    fs.mkdirSync(this.dir, { recursive: true });
    if (!this.accepts(threadId, entries)) return;
    const body = entries.map((e) => JSON.stringify(e)).join("\n");
    // 原子的に置き換える（task-0161）。全文置換の最中に殺されると数MBの会話が飛ぶ
    writeFileAtomicSync(
      this.transcriptPath(threadId),
      body.length > 0 ? `${body}\n` : "",
      this.writeOps
    );
    // 書けたあとに知っている姿を更新する（task-0164）。書けなかったときは基準を動かさない
    this.remember(
      threadId,
      entries.map((e) => e.role)
    );
  }

  /** 記録を読む。 */
  transcript(threadId: string): TranscriptEntry[] {
    const entries = this.readTranscript(threadId);
    // 読んだ内容が、このプロセスの知っている記録の姿になる（縮小拒否の基準・task-0164）
    this.remember(
      threadId,
      entries.map((e) => e.role)
    );
    return entries;
  }

  /**
   * 記録をファイルから読む（`known` を触らない素の読み）。
   *
   * 壊れた行は飛ばす。**飛ばした行のぶん、返る件数は実ファイルの行数より少ない**
   * ——だから縮小拒否の基準はここが返した件数（＝メモリに載った件数）であって、
   * 実ファイルの行数ではない（task-0164 a1）。
   */
  private readTranscript(threadId: string): TranscriptEntry[] {
    const file = this.transcriptPath(threadId);
    if (!fs.existsSync(file)) return [];
    const entries: TranscriptEntry[] = [];
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        entries.push(JSON.parse(trimmed) as TranscriptEntry);
      } catch {
        // I2 の例外ではない: 1行壊れても残りは読める。1行のために会話全部を失わない
        console.error(`[banto] ${threadId} の記録に読めない行があります（その行は飛ばします）`);
      }
    }
    return entries;
  }

  /**
   * **書き戻しを通してよいか**（inc-0075・task-0164）。
   *
   * 2026-08-16、幹の記録から33時間ぶんが消えた。`replace()` が無条件の全文上書きで、
   * **メモリが真実・ファイルはその写し**だったため、メモリに無いものは次の書き戻しで
   * ファイルからも消えた。原因（なぜ書き戻しが止まったか）は未確定だが、原因が何であれ
   * **縮む書き戻しを1回でも拒めば、被害は33時間ではなく0で止まっていた**。
   *
   * `Thread.record()` が記録に加える変更は次の3つだけで、どれも
   * **件数を減らさず、既にある行の「役」を変えない**（`threads.ts` の `recordInner` /
   * `settleInterrupted` / `repairTrunkCards` が全ての書き換え箇所）:
   *
   * - 末尾に足す（`push`）
   * - 末尾の発話・思考に文字を継ぎ足す（役は同じ）
   * - 走っている道具の行を結果で埋める（位置も役も同じ）
   *
   * つまり「**役の並びが前方一致で、件数が減らない**」がこの記録の不変条件である。
   * これを破る書き戻しは、古い（または別の）メモリで新しい記録を潰しにきた合図なので通さない。
   *
   * I2: 黙って拒まない。拒んだ内容は `<threadId>.jsonl.rejected-<ISO8601>` へ退避し、
   * 何本が何本になろうとしたかを `[banto]` 付きで出す（journal で追える）。
   */
  private accepts(threadId: string, entries: readonly TranscriptEntry[]): boolean {
    const known = this.refreshed(threadId);
    const reason = shrinkReason(known.roles, entries);
    if (reason === undefined) return true;
    const saved = this.quarantine(threadId, entries);
    console.error(
      `[banto] ${threadId} の記録が縮む書き戻しを拒みました（${reason}）。` +
        `書き戻そうとした内容は ${saved ?? "（退避できませんでした）"} に退避しました`
    );
    return false;
  }

  /**
   * このプロセスが知っている記録の姿。
   *
   * **他が書いていればディスクから取り直す。** 事故の形は「古いメモリが、新しく育った
   * ファイルを上書きし続ける」なので、自分の書いた姿とファイルの姿がずれていたら
   * ファイルのほうを真実として測る。毎回読み直すと長い会話で重いので、
   * 大きさと更新時刻が自分の書いたままなら読まない。
   */
  private refreshed(threadId: string): KnownTranscript {
    const known = this.knownFor(threadId);
    const stamp = this.stampOf(threadId);
    if (stamp === undefined) return known;
    if (known.stamp && stamp.size === known.stamp.size && stamp.mtimeMs === known.stamp.mtimeMs) {
      return known;
    }
    const onDisk = this.readTranscript(threadId);
    this.remember(
      threadId,
      onDisk.map((e) => e.role)
    );
    return this.knownFor(threadId);
  }

  private knownFor(threadId: string): KnownTranscript {
    let known = this.known.get(threadId);
    if (!known) {
      known = { roles: [] };
      this.known.set(threadId, known);
    }
    return known;
  }

  /**
   * 知っている姿を更新する。
   *
   * **短いほうへは下げない**——記録は減らないものなので、いちど知った件数は基準として
   * 持ち続ける。壊れた行を飛ばして読んだ回（実ファイルより少なく読めた回）に基準が
   * 下がると、そのぶん縮小を見逃す。
   */
  private remember(threadId: string, roles: readonly string[]): void {
    const known = this.knownFor(threadId);
    if (roles.length >= known.roles.length) known.roles = [...roles];
    known.stamp = this.stampOf(threadId);
  }

  private stampOf(threadId: string): { size: number; mtimeMs: number } | undefined {
    try {
      const stat = fs.statSync(this.transcriptPath(threadId));
      return { size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
      // ファイルがまだ無いのは失敗ではない（初回の書き戻し）
      return undefined;
    }
  }

  /**
   * 拒んだ書き戻しを別名で残す。復旧にも原因調査にも要る——捨てたら、拒んだこと自体は
   * 分かっても「何を書こうとしていたか」が永久に分からない。
   */
  private quarantine(threadId: string, entries: readonly TranscriptEntry[]): string | undefined {
    const body = entries.map((e) => JSON.stringify(e)).join("\n");
    const at = new Date().toISOString();
    for (let attempt = 0; attempt < 100; attempt++) {
      const file = `${this.transcriptPath(threadId)}.rejected-${at}${attempt === 0 ? "" : `-${attempt}`}`;
      if (fs.existsSync(file)) continue;
      try {
        fs.writeFileSync(file, body.length > 0 ? `${body}\n` : "", "utf-8");
        return file;
      } catch (err) {
        // I2: 退避できなかったことも黙らせない。ただし元の記録は守れている（書いていない）
        console.error(`[banto] ${file} へ退避できませんでした: ${String(err)}`);
        return undefined;
      }
    }
    return undefined;
  }

  private readIndex(): IndexFile {
    if (!fs.existsSync(this.indexPath)) return { ...EMPTY, threads: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.indexPath, "utf-8"));
    } catch (err) {
      // I2: 黙って空から始めない。過去の会話を失ったことに気づけなくなる
      throw new Error(`${this.indexPath} を読めません（会話の索引が壊れています）: ${String(err)}`);
    }
    const file = parsed as Partial<IndexFile>;
    return {
      version: 1,
      counter: typeof file.counter === "number" ? file.counter : 0,
      threads: Array.isArray(file.threads) ? file.threads : [],
    };
  }

  private writeIndex(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    // 索引が半端に書かれると readIndex() が throw してホストが起動しない（task-0161）
    writeFileAtomicSync(
      this.indexPath,
      `${JSON.stringify(this.index, null, 2)}\n`,
      this.writeOps
    );
  }
}
