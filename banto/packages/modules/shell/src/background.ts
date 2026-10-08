// **待たずに流したコマンド**（決定・2026-10-07、ユーザー。docs/specs/v4-modules.md §2.3「待たない形」、Backlog #224）。
//
// `runCommand` の `runInBackground: true` で流したコマンドを、Shell から切り離して動かし（`background-launcher.ts`）、
// 終わったら頼んだ Thread に返信用の札で届ける（アーキ仕様 §4.2）。状態は置き場のファイルだけが持つ
// （`background-files.ts`）——Shell を起こし直しても、同じファイルから同じ答えが出る。
//
// **札そのものはメモリにだけ持つ**（置き場には指紋）。起き直した Shell は札を知らない——host の問い
// （`resumeAfterRestart`）で渡されたものだけ、また見張って届ける。

import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { replyToFingerprint, type ResumeAnswer, type ResumeQuestionItem } from "@banto/module-contract";
import {
  EXIT_FILE,
  JOB_FILE,
  OUTPUT_FILE,
  STARTED_FILE,
  jobPath,
  readJsonIfExists,
  tailLines,
  wrapperAlive,
  writeJsonAtomic,
  type ExitRecord,
  type JobRecord,
  type StartedRecord,
} from "./background-files.js";
import type { BackgroundLauncher } from "./background-launcher.js";

/** 一覧に出す状態。`stopped` は cancelCommand 以外で止められた（人の `systemctl stop`・コンテナの停止）、`lost` は終わり方の記録が無い */
export type CommandStatus = "running" | "exited" | "timedOut" | "cancelled" | "stopped" | "lost";

export interface CommandView {
  commandId: string;
  command: string;
  label?: string;
  /** Project root からの相対（root なら "."） */
  cwd: string;
  startedAt: string;
  status: CommandStatus;
  exitCode?: number | null;
  signal?: string | null;
  endedAt?: string;
  outputFile: string;
}

export interface DeliverInput {
  replyTo: string;
  title: string;
  text: string;
  final?: boolean;
}

export interface BackgroundCommandsDeps {
  /** コマンドの置き場の親（`<Shell の Module の置き場>/commands`） */
  dir: string;
  /** 環境のファイルを置く所（コンテナの中の tmpfs）。**host のディスクにしない** */
  secretsDir: string;
  projectRoot: string;
  launcher: BackgroundLauncher;
  /** host の中継の `relayDeliverToThread` */
  deliver: (input: DeliverInput) => Promise<unknown>;
  /** 見張りの間隔（既定 2 秒）。**試験で短くするための穴** */
  pollMs?: number;
  /** 起動役が起きるのを待つ上限（既定 20 秒） */
  startWaitMs?: number;
  /** 終わったものを残す数（既定 20） */
  keepFinished?: number;
  /** 届けられなかったとき、次の見張りで届け直す回数（既定 5） */
  deliverRetries?: number;
}

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_START_WAIT_MS = 20_000;
const DEFAULT_KEEP_FINISHED = 20;
const DEFAULT_DELIVER_RETRIES = 5;
/**
 * 届けていないものを消してよくなるまでの時間（終わってから）。**届ける前の記録は消さない**——起き直した host に問われたら
 * 届けるのに要る。ただ、届ける約束が切れたもの（Shell だけが起こし直された等）はいつまでも問われないので、ここで区切る
 */
const UNDELIVERED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** 届けた印（Shell が書く）。古いものを消してよいかはこれで見る */
const DELIVERED_FILE = "delivered.json";
/** 起動役が書く前に死んだとき、ファイルの終わりから読む量 */
const READ_TAIL_BYTES = 64 * 1024;

export class BackgroundCommandError extends Error {}

interface Observed {
  record: JobRecord;
  status: CommandStatus;
  started?: StartedRecord;
  exit?: ExitRecord;
}

export class BackgroundCommands {
  /** 届ける約束をしたコマンド（id → 札）。**札はここにだけ**——ディスクには指紋 */
  private readonly watched = new Map<string, string>();
  private readonly delivering = new Set<string>();
  /** 届けられなかった回数（id → 回数）。上限までは見張りに残して次の見張りで届け直す */
  private readonly deliverFailures = new Map<string, number>();
  private timer?: NodeJS.Timeout;

  constructor(private readonly deps: BackgroundCommandsDeps) {}

  /**
   * 流す。返ったら起動役が起きている（起きなければ投げる——AI に「流した」と言ってから黙って失敗させない）。
   * `secretFiles` は呼び元が書き出したもの（終わったら起動役が消す）
   */
  async start(input: {
    command: string;
    /** AI が付けた呼び名（整える前）。1行に収め、`LABEL_MAX` 字で切って記録に残す */
    label?: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutSec?: number;
    secretFiles: string[];
    replyTo: string;
    requestedBy?: { projectId: string; threadId: string };
    requestedByModule?: { name: string; conn: string };
  }): Promise<CommandView> {
    const id = newCommandId();
    const dir = join(this.deps.dir, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const label = labelOf(input.label);
    const record: JobRecord = {
      id,
      command: input.command,
      ...(label ? { label } : {}),
      cwd: input.cwd,
      startedAt: new Date().toISOString(),
      ...(input.timeoutSec !== undefined ? { timeoutSec: input.timeoutSec } : {}),
      ...(input.secretFiles.length > 0 ? { secretFiles: input.secretFiles } : {}),
      replyToFingerprint: replyToFingerprint(input.replyTo),
      ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
      ...(input.requestedByModule ? { requestedByModule: input.requestedByModule } : {}),
      unit: `banto-shell-${id}`,
    };
    writeJsonAtomic(join(dir, JOB_FILE), record);

    // 環境（秘密を含む）は tmpfs に 0600 で置く。起動役が読んで消す——起こせなかったら、ここで消す。置き場（ユーザーの
    // 実行時の置き場）はユーザーの systemd が立ってから在る（実測・2026-10-07：新しいコンテナには /run/user/<uid> が無い）
    try {
      await this.deps.launcher.prepare();
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw new BackgroundCommandError(`コマンドを流す用意ができませんでした: ${err instanceof Error ? err.message : String(err)}`);
    }
    const envFile = join(this.deps.secretsDir, `${id}.env.json`);
    let launched = false;
    try {
      mkdirSync(this.deps.secretsDir, { recursive: true, mode: 0o700 });
      writeFileSync(envFile, JSON.stringify(input.env), { mode: 0o600 });
      await this.deps.launcher.start({ unit: record.unit, dir, envFile });
      launched = true;
      await this.waitStarted(id);
    } catch (err) {
      rmSync(envFile, { force: true });
      const reason = err instanceof Error ? err.message : String(err);
      // **起こすのを頼み終えたあとなら、単位を止めてから記録を消す**（訂正・2026-10-07、Fable のレビュー）。止めずに消すと、
      // 遅れて起きた起動役が記録も札も無いままコマンドを走らせ、一覧にも出ず止められない。止められなければ記録を残す
      // ——一覧に出て、流した Thread から止められる
      if (launched) {
        try {
          await this.deps.launcher.stop({ unit: record.unit });
        } catch (stopErr) {
          throw new BackgroundCommandError(
            `コマンドを流せませんでした（${reason}）。起動役を止められなかったので、動いているかもしれません——` +
              `listCommands に ${id} として出ています。止めるなら cancelCommand。止められなかった理由：` +
              (stopErr instanceof Error ? stopErr.message : String(stopErr)),
          );
        }
      }
      // 起動役が起きなかったもの・止めたものは記録ごと消す（一覧に「動いていない何か」を残さない）
      rmSync(dir, { recursive: true, force: true });
      // AI に理由ごと返す（MCP のエラーにして「何が起きたか分からない」にしない）
      throw err instanceof BackgroundCommandError ? err : new BackgroundCommandError(`コマンドを流せませんでした: ${reason}`);
    }
    this.watched.set(id, input.replyTo);
    this.ensureTimer();
    this.prune();
    return this.view(this.observe(id)!);
  }

  /**
   * 一覧（新しい順）。`owner` を渡せば、その Thread が流したものだけ。**動いているものは全部出し、終わったものだけ
   * `limit` 件で切る**（訂正・2026-10-07、Fable のレビュー——動いているものが件数の外に落ちると、止める口の id が分からない）
   */
  list(owner?: { projectId: string; threadId: string }, limit = DEFAULT_KEEP_FINISHED): CommandView[] {
    let finished = 0;
    return this.observeAll()
      .filter((o) => !owner || (o.record.requestedBy?.projectId === owner.projectId && o.record.requestedBy?.threadId === owner.threadId))
      .filter((o) => o.status === "running" || ++finished <= limit)
      .map((o) => this.view(o));
  }

  get(id: string): Observed | undefined {
    return this.observe(id);
  }

  /** このコマンドの終わりを届ける約束を持っているか（Shell だけが起こし直されたあとは、問われるまで持たない） */
  willDeliver(id: string): boolean {
    return this.watched.has(id);
  }

  /**
   * 止める。止めると頼んだ時刻を先に書く（起動役が「止められた」と書いたとき、cancelCommand か外からかを分ける）。
   * 返ったら止まっている。届けるのは見張り（すぐ見に行く）
   */
  async cancel(id: string): Promise<CommandView> {
    const found = this.observe(id);
    if (!found) throw new BackgroundCommandError(`コマンド "${id}" はありません`);
    if (found.status !== "running") throw new BackgroundCommandError(`そのコマンドはもう動いていません（状態：${found.status}）`);
    writeJsonAtomic(jobPath(this.deps.dir, id, JOB_FILE), { ...found.record, cancelRequestedAt: new Date().toISOString() });
    await this.deps.launcher.stop({ unit: found.record.unit, ...(found.started ? { pid: found.started.pid } : {}) });
    // 起動役が終わり方を書くまで待つ（systemd の stop は単位が止まってから返るが、試験の起こし方は待たない）
    for (let waited = 0; waited < 15_000; waited += 100) {
      const now = this.observe(id);
      if (now && now.status !== "running") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await this.check(id);
    return this.view(this.observe(id)!);
  }

  /**
   * **起き直した host の問いに答える**（アーキ仕様 §2.5「2.」）。札の指紋が合う記録があり、頼んだ相手が合えば「続ける」
   * ——動いていれば見張りを続け、終わっていればすぐ届ける。記録が無い・相手が違うものは「続けない」。
   * **問われなかった記録のコマンドは止めない**（一覧に出て、止める口で止められる）
   */
  answerResume(items: ResumeQuestionItem[], aborted: () => boolean): ResumeAnswer[] {
    const records = this.observeAll();
    const answers = items.map((item): ResumeAnswer => {
      const no = (reason: string): ResumeAnswer => ({ replyTo: item.replyTo, resume: false, reason });
      const found = records.find((o) => o.record.replyToFingerprint === replyToFingerprint(item.replyTo));
      if (!found) return no("待たずに流したコマンドの記録がありません");
      const { record } = found;
      const mismatch = item.thread
        ? !record.requestedBy
          ? "記録は Module が中継で流したコマンドですが、Thread のものとして問われました"
          : record.requestedBy.threadId !== item.thread.threadId || record.requestedBy.projectId !== item.thread.projectId
            ? "記録の流した Thread（Project）と、問われた Thread が違います"
            : undefined
        : record.requestedBy
          ? "記録は Thread から流したコマンドですが、Module のものとして問われました"
          : undefined;
      if (mismatch) return no(mismatch);
      this.watched.set(record.id, item.replyTo);
      return { replyTo: item.replyTo, resume: true };
    });
    // 答えを返してから見に行く（host は答えを待っている）。**host が問いを取り消したら届けない**——期限を過ぎた問いで、
    // host はもう「途中で終わりました」を届けている
    setImmediate(() => {
      if (aborted()) {
        for (const a of answers) {
          if (!a.resume) continue;
          const id = [...this.watched].find(([, r]) => r === a.replyTo)?.[0];
          if (id) this.watched.delete(id);
        }
        console.error("[shell] host が問いを取り消したので、続けると答えたコマンドを届けません");
        return;
      }
      this.ensureTimer();
      void this.tick();
    });
    return answers;
  }

  /** 見張りを止める（試験で Shell を捨てるとき）。コマンドは止めない */
  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.deps.pollMs ?? DEFAULT_POLL_MS);
    // 見張りだけで Shell を生かし続けない（stdio が閉じれば Shell は終わってよい——コマンドは systemd が持つ）
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    for (const id of [...this.watched.keys()]) await this.check(id);
    if (this.watched.size === 0) this.close();
  }

  /** 終わっていれば届ける（1回だけ）。届けられなければ記録に残したまま見張りを外す——起き直した host に問われたら届け直す */
  private async check(id: string): Promise<void> {
    const replyTo = this.watched.get(id);
    if (!replyTo || this.delivering.has(id)) return;
    let found: Observed | undefined;
    try {
      found = this.observe(id);
    } catch (err) {
      console.error(`[shell] コマンド ${id} の記録が読めません:`, err);
      this.watched.delete(id);
      return;
    }
    if (!found) {
      console.error(`[shell] コマンド ${id} の記録が消えました（届けられません）`);
      this.watched.delete(id);
      return;
    }
    if (found.status === "running") return;
    this.delivering.add(id);
    try {
      // 起動役が消せずに終わったもの（強制的に止められた等）の secretFiles は、ここで消す
      for (const path of found.record.secretFiles ?? []) rmSync(path, { force: true });
      const { title, text } = this.report(found);
      await this.deps.deliver({ replyTo, title, text, final: true });
      this.watched.delete(id);
      this.deliverFailures.delete(id);
      // 届けた印——古いものを消してよいかはこれで見る（届ける前の記録は消さない）
      try {
        writeJsonAtomic(jobPath(this.deps.dir, id, DELIVERED_FILE), { at: new Date().toISOString() });
      } catch (err) {
        console.error(`[shell] コマンド ${id} に届けた印を書けませんでした:`, err);
      }
    } catch (err) {
      // **中継の一時的な失敗で諦めない**（訂正・2026-10-07、Fable のレビュー）。上限までは見張りに残し、次の見張りで届け直す。
      // 越えたら外す——記録は残るので、起き直した host に問われたら届ける
      const failures = (this.deliverFailures.get(id) ?? 0) + 1;
      const limit = this.deps.deliverRetries ?? DEFAULT_DELIVER_RETRIES;
      if (failures >= limit) {
        console.error(`[shell] コマンド ${id} の結果を ${failures} 回届けられませんでした（諦めます。起き直した host に問われたら届け直します）:`, err);
        this.watched.delete(id);
        this.deliverFailures.delete(id);
      } else {
        console.error(`[shell] コマンド ${id} の結果を届けられませんでした（${failures} 回目。次の見張りで届け直します）:`, err);
        this.deliverFailures.set(id, failures);
      }
    } finally {
      this.delivering.delete(id);
    }
  }

  /** 届ける題と本文。**終了コードを先頭に**（長い本文を先頭から切られても成否は残る） */
  report(o: Observed): { title: string; text: string } {
    // 呼び名があれば呼び名、無ければコマンドの頭（追加・2026-10-08、ユーザー要望——コマンドの文字そのままでは何の仕事か読みにくい）
    const head = o.record.label ?? oneLine(o.record.command, 40);
    const exit = o.exit;
    const title =
      o.status === "exited"
        ? exit?.code === 0
          ? `コマンドが終わりました：${head}`
          : `コマンドが失敗しました（${exit?.code === null ? `信号 ${exit.signal ?? "不明"}` : `終了コード ${exit?.code}`}）：${head}`
        : o.status === "timedOut"
          ? `コマンドが時間切れで止まりました：${head}`
          : o.status === "cancelled"
            ? exit?.timedOut
              ? `コマンドを止めました（その前に時間切れになっていました）：${head}`
              : `コマンドを止めました：${head}`
            : o.status === "stopped"
              ? `コマンドが外から止められました：${head}`
              : `コマンドが途中で終わりました：${head}`;
    const tail = exit ? exit.tail : this.readTail(o.record.id);
    const notes: string[] = [];
    if (o.status === "lost") {
      notes.push("終わり方の記録がありません（コンテナが起こし直された・強制的に止められた等）。出力は outputFile に途中まで残っています。");
    }
    if (o.status === "cancelled" && !exit) notes.push("止めると頼んだあと、終わり方を書く前に強制的に止まりました。");
    if (o.status === "cancelled" && exit?.timedOut) {
      notes.push(`timeout（${o.record.timeoutSec} 秒）で止めている途中（猶予の間）に cancelCommand で止めました。`);
    }
    if (o.status === "stopped") notes.push("cancelCommand ではなく外から止められました（人の systemctl stop・コンテナの停止など）。");
    if (exit?.capped) notes.push(`出力が 64 MiB を越えたので、越えた分は outputFile に書いていません（tail は本当の終わり）。全体は ${exit.outputBytes} バイト。`);
    if (exit?.error) notes.push(exit.error);
    const body = {
      exitCode: exit ? exit.code : null,
      ...(exit?.signal ? { signal: exit.signal } : {}),
      status: o.status,
      ...(exit?.timedOut ? { timedOut: true } : {}),
      commandId: o.record.id,
      ...(o.record.label ? { label: o.record.label } : {}),
      command: o.record.command,
      cwd: this.relCwd(o.record.cwd),
      startedAt: o.record.startedAt,
      ...(exit ? { endedAt: exit.at } : {}),
      outputFile: jobPath(this.deps.dir, o.record.id, OUTPUT_FILE),
      tail,
      ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
    };
    return { title, text: JSON.stringify(body) };
  }

  private view(o: Observed): CommandView {
    return {
      commandId: o.record.id,
      ...(o.record.label ? { label: o.record.label } : {}),
      command: o.record.command,
      cwd: this.relCwd(o.record.cwd),
      startedAt: o.record.startedAt,
      status: o.status,
      ...(o.exit ? { exitCode: o.exit.code, ...(o.exit.signal ? { signal: o.exit.signal } : {}), endedAt: o.exit.at } : {}),
      outputFile: jobPath(this.deps.dir, o.record.id, OUTPUT_FILE),
    };
  }

  private relCwd(cwd: string): string {
    return relative(this.deps.projectRoot, cwd) || ".";
  }

  /** 1件の状態をファイルから決める。記録が無ければ undefined */
  private observe(id: string): Observed | undefined {
    if (!/^[A-Za-z0-9-]+$/.test(id)) return undefined;
    const record = readJsonIfExists<JobRecord>(jobPath(this.deps.dir, id, JOB_FILE));
    if (!record) return undefined;
    const exit = readJsonIfExists<ExitRecord>(jobPath(this.deps.dir, id, EXIT_FILE));
    const started = readJsonIfExists<StartedRecord>(jobPath(this.deps.dir, id, STARTED_FILE));
    const status = statusOf(record, started, exit, () => (started ? wrapperAlive(started) : false));
    // 居ないと見た直後に起動役が書き終えたかもしれない——もう一度だけ見る
    if (status === "lost") {
      const late = readJsonIfExists<ExitRecord>(jobPath(this.deps.dir, id, EXIT_FILE));
      if (late) return { record, started, exit: late, status: statusOf(record, started, late, () => false) };
    }
    return { record, ...(started ? { started } : {}), ...(exit ? { exit } : {}), status };
  }

  /** 全部（新しい順）。読めない1件は飛ばしてログに残す——ほかの記録は使える */
  private observeAll(): Observed[] {
    let ids: string[];
    try {
      ids = readdirSync(this.deps.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: Observed[] = [];
    for (const id of ids) {
      try {
        const o = this.observe(id);
        if (o) out.push(o);
      } catch (err) {
        console.error(`[shell] コマンド ${id} の記録が読めません（飛ばします）:`, err);
      }
    }
    return out.sort((a, b) => (a.record.startedAt < b.record.startedAt ? 1 : a.record.startedAt > b.record.startedAt ? -1 : 0));
  }

  private async waitStarted(id: string): Promise<void> {
    const limit = this.deps.startWaitMs ?? DEFAULT_START_WAIT_MS;
    for (let waited = 0; waited <= limit; waited += 50) {
      const exit = readJsonIfExists<ExitRecord>(jobPath(this.deps.dir, id, EXIT_FILE));
      if (exit?.error && readJsonIfExists(jobPath(this.deps.dir, id, STARTED_FILE)) === undefined) {
        throw new BackgroundCommandError(`コマンドを流せませんでした: ${exit.error}`);
      }
      if (readJsonIfExists(jobPath(this.deps.dir, id, STARTED_FILE)) !== undefined) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    // 期限の際に起きたものは起きたとみなす（止めて消すのは、本当に起きていないものだけ）
    if (readJsonIfExists(jobPath(this.deps.dir, id, STARTED_FILE)) !== undefined) return;
    throw new BackgroundCommandError(`コマンドの起動役が ${Math.round(limit / 1000)} 秒たっても起きませんでした`);
  }

  /** 起動役が書く前に死んだとき：ファイルの終わりから末尾を作る */
  private readTail(id: string): string {
    let fd: number | undefined;
    try {
      fd = openSync(jobPath(this.deps.dir, id, OUTPUT_FILE), "r");
      const size = fstatSync(fd).size;
      const length = Math.min(size, READ_TAIL_BYTES);
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, size - length);
      return tailLines(buf.toString("utf8"), size > length);
    } catch {
      return "";
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /**
   * 終わったものは新しい `keepFinished` 件だけ残す。動いているもの・届ける約束をしたもの・**まだ届けていないもの**は消さない
   * （訂正・2026-10-07、Fable のレビュー——届ける前に消すと、起き直した host に問われても届けられない）。届けていないものも、
   * 終わってから `UNDELIVERED_KEEP_MS` たてば消してよい（もう問われない）
   */
  private prune(): void {
    const keep = this.deps.keepFinished ?? DEFAULT_KEEP_FINISHED;
    const now = Date.now();
    const finished = this.observeAll().filter((o) => {
      if (o.status === "running" || this.watched.has(o.record.id)) return false;
      if (existsSync(jobPath(this.deps.dir, o.record.id, DELIVERED_FILE))) return true;
      const endedAt = Date.parse(o.exit?.at ?? o.started?.at ?? o.record.startedAt);
      return Number.isFinite(endedAt) && now - endedAt > UNDELIVERED_KEEP_MS;
    });
    for (const o of finished.slice(keep)) {
      try {
        rmSync(join(this.deps.dir, o.record.id), { recursive: true, force: true });
      } catch (err) {
        console.error(`[shell] 古いコマンド ${o.record.id} の置き場を消せませんでした:`, err);
      }
    }
  }
}

function statusOf(record: JobRecord, started: StartedRecord | undefined, exit: ExitRecord | undefined, alive: () => boolean): CommandStatus {
  if (exit) {
    if (record.cancelRequestedAt && exit.stopRequested) return "cancelled";
    if (exit.timedOut) return "timedOut";
    if (exit.stopRequested) return "stopped";
    return "exited";
  }
  if (started && alive()) return "running";
  return record.cancelRequestedAt ? "cancelled" : "lost";
}

/** 名前の並びが起きた順になる形（一覧の並べ替えにも使える）。systemd の単位の名前に使える字だけ */
function newCommandId(): string {
  const at = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  return `${at}-${randomBytes(3).toString("hex")}`;
}

/** 呼び名の長さの上限（字）。カードの題（`fillCardText`）が畳むのと同じ長さ */
export const LABEL_MAX = 80;

/** 呼び名を1行に収めて `LABEL_MAX` 字で切る。空白だけなら無いのと同じ（カードの題もコマンドに戻る） */
export function labelOf(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const line = oneLine(raw, LABEL_MAX);
  return line === "" ? undefined : line;
}

function oneLine(s: string, max: number): string {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
