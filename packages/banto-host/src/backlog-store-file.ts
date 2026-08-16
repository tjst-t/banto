/**
 * 起票の置き場・ファイル実装（prop-0003 段取り1）。
 *
 * **真実は `<dataDir>/backlog.jsonl`**（追記だけのイベントログ。取次の `inbox.jsonl` の隣）。
 * 起動時に読み直して今の姿を作る——導出できる状態をファイルに持たないため（D3）。
 * 形は `packages/banto-host/src/inbox.ts` に倣っている。
 *
 * **記録として md をリポジトリへ書き出す**（Kobo が `work/tasks/task-NNNN.md` を書くのと同じ形）。
 * これは**保険であって正ではない**——`/var/lib/banto` が飛んだときの逆は無いが、md を消しても
 * jsonl から {@link FileBacklogStore.regenerateMarkdown} で戻せる。書き出し先は
 * コンストラクタで受ける（**既定を決め打ちしない**。試験は tmpdir を渡す）。
 *
 * 契約（読みは即答・書きはローカル確定が先）は {@link BacklogStore} の doc を見ること。
 * この実装は外を持たないので `capabilities()` は両方 `false` を返す。
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  assertBacklogId,
  assertBacklogKind,
  assertBacklogStatus,
  backlogNumberOf,
  formatBacklogId,
  type BacklogAdoptInput,
  type BacklogCapabilities,
  type BacklogEntry,
  type BacklogFileInput,
  type BacklogPatch,
  type BacklogPullResult,
  type BacklogQuery,
  type BacklogStore,
} from "./backlog.js";

/** 追記される1行。**積んだ／書き換えた**の2種だけ。 */
interface LogLine {
  v: 1;
  at: string;
  file?: BacklogEntry;
  update?: { id: string; patch: BacklogPatch; at: string };
}

export interface FileBacklogStoreOptions {
  /** 真実の置き場。`<dataDir>/backlog.jsonl` を渡す。 */
  logFile: string;
  /**
   * md の書き出し先ディレクトリ（リポジトリの `work/backlog` を想定）。
   * **省略したら md を書かない**——既定を決め打ちしないのは、書き出し先がホストの
   * 都合ではなく「どのリポジトリに残すか」の話だから。
   */
  markdownDir?: string;
}

/**
 * `bl-NNNN.md` の名前。jsonl の1件と md の1ファイルが1対1に対応する。
 */
export function backlogMarkdownFileName(id: string): string {
  return `${id}.md`;
}

/**
 * `undefined` の入った鍵を落とす。
 *
 * 明示的に `{ title: undefined }` を渡されたときに、既にある値を undefined で潰さないため
 * ——「触れなかった」と「空にした」を書き換えの入口で混ぜない。
 */
function defined(patch: BacklogPatch): BacklogPatch {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key] = value;
  }
  return out as BacklogPatch;
}

/** frontmatter の1行に載せられる形にする。**改行を入れない**（1行1値で読むため）。 */
function scalar(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

/** `["a", "b"]`。値の中の `"` は落とす（frontmatter が割れるより読めなくなるほうがまし）。 */
function inlineArray(values: readonly string[]): string {
  return `[${values.map((v) => `"${scalar(v).replace(/"/g, "")}"`).join(", ")}]`;
}

/**
 * 一件を md にする。frontmatter に id/kind/status/createdAt/updatedAt/tasks/external、本文が続く。
 *
 * **読み戻すためのものではない**（正は jsonl）。git で読める道を残すための記録。
 */
export function renderBacklogMarkdown(entry: BacklogEntry): string {
  const lines: string[] = ["---", `id: ${entry.id}`, "type: backlog", `kind: ${entry.kind}`];
  lines.push(`title: ${scalar(entry.title)}`);
  lines.push(`status: ${entry.status}`);
  if (entry.origin !== undefined) lines.push(`origin: ${scalar(entry.origin)}`);
  if (entry.projectTag !== undefined) lines.push(`projectTag: ${scalar(entry.projectTag)}`);
  if (entry.refs !== undefined && entry.refs.length > 0) lines.push(`refs: ${inlineArray(entry.refs)}`);
  if (entry.tasks !== undefined && entry.tasks.length > 0) {
    // どの task になったか。`projectTag/taskId` の1通りだけに揃える（3通り混在が追跡不能の元）
    lines.push(`tasks: ${inlineArray(entry.tasks.map((t) => `${t.projectTag}/${t.taskId}`))}`);
  }
  if (entry.external !== undefined) {
    lines.push(`external: ${scalar(`${entry.external.provider}#${entry.external.id}`)}`);
    if (entry.external.url !== undefined) lines.push(`external_url: ${scalar(entry.external.url)}`);
    if (entry.external.syncedAt !== undefined) lines.push(`external_synced_at: ${entry.external.syncedAt}`);
  }
  if (entry.bodyPath !== undefined) lines.push(`bodyPath: ${scalar(entry.bodyPath)}`);
  lines.push(`createdAt: ${entry.createdAt}`);
  lines.push(`updatedAt: ${entry.updatedAt}`);
  // この md を書いたのは Store であって人ではない、と読み手に分かるようにしておく
  lines.push("written_by: banto-backlog");
  lines.push("---", "");
  lines.push(`# ${scalar(entry.title)}`, "");
  if (entry.body !== undefined && entry.body.length > 0) lines.push(entry.body, "");
  if (entry.bodyPath !== undefined) lines.push(`本文: ${entry.bodyPath}`, "");
  return lines.join("\n");
}

/**
 * ファイル実装。
 *
 * ## 採番（この実装の肝）
 *
 * **根拠は jsonl だけ。** 読み直した jsonl に載っている番号の最大値 +1 を出す。
 *
 * `packages/banto-daemon/src/task-record.ts` の `nextTaskNumber` は
 * 「ファイル名の最大値と帳簿の最大値の両方」を見るが、**ファイル名を見る側は真似しない**
 * ——それがまさに 2026-08-16 の id 衝突6組の原因だった。git の作業ツリーは
 * コミット済み・未追跡・どのワークツリーかで見え方が変わるので、
 * **ディレクトリを走査して空き番号を探す形は、見る場所によって答えが変わる**。
 * 走査で採番しないことで、md を1枚残らず消しても・別の場所から開いても、次の番号は変わらない。
 *
 * その代わり番号は**単調に増える**（{@link FileBacklogStore.maxNumber}）。
 * 一度出した番号は、たとえその起票が jsonl から消えても再利用しない。
 *
 * ## 並行
 *
 * 書き（`file` / `update` / `adopt`）は {@link FileBacklogStore.serialize} で直列化する。
 * 追記は1行を `appendFileSync` の1回で書くので、行が途中で混ざらない。
 */
export class FileBacklogStore implements BacklogStore {
  private readonly entries = new Map<string, BacklogEntry>();
  private readonly byClientKey = new Map<string, string>();
  private readonly logFile: string;
  private readonly markdownDir: string | undefined;
  /** これまでに出した／取り込んだ番号の最大値。**戻らない**。 */
  private maxNumber = 0;
  /** 書きの直列化。前の書きが終わるまで次を始めない。 */
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(options: FileBacklogStoreOptions) {
    this.logFile = options.logFile;
    this.markdownDir = options.markdownDir;
    this.replay();
  }

  async file(input: BacklogFileInput): Promise<BacklogEntry> {
    return this.serialize(() => this.fileNow(input));
  }

  private fileNow(input: BacklogFileInput): BacklogEntry {
    // 採番は Store の専権。型に `id` は無いが、実行時に紛れ込ませてくる経路（道具の JSON 入力・
    // 移行スクリプト）があるので、ここで断る。黙って無視すると呼び手は「効いた」と思い込む（I2）
    if (Object.prototype.hasOwnProperty.call(input, "id")) {
      throw new Error(
        "起票の id は呼ぶ側では決められません（採番は Store の専権）。" +
          "すでに番号が決まっているものを載せるなら adopt を使ってください。"
      );
    }

    // 冪等: 同じ合印が既にあるなら**新規に採番せず**それを返す
    if (input.clientKey !== undefined) {
      const existingId = this.byClientKey.get(input.clientKey);
      if (existingId !== undefined) {
        const existing = this.entries.get(existingId);
        if (existing) return existing;
      }
    }

    const kind = assertBacklogKind(input.kind, "起票の種別");
    const status = assertBacklogStatus(input.status ?? "open", "起票の状態");
    if (typeof input.title !== "string" || input.title.trim().length === 0) {
      // I2: 表題の無い起票は後から誰も読めない。黙って立てない
      throw new Error("起票には表題が要ります。");
    }

    const at = new Date().toISOString();
    const entry: BacklogEntry = {
      id: this.nextId(),
      kind,
      title: input.title,
      status,
      clientKey: input.clientKey ?? `auto-${randomUUID()}`,
      createdAt: at,
      updatedAt: at,
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.bodyPath !== undefined ? { bodyPath: input.bodyPath } : {}),
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
      ...(input.projectTag !== undefined ? { projectTag: input.projectTag } : {}),
      ...(input.refs !== undefined ? { refs: input.refs } : {}),
      ...(input.tasks !== undefined ? { tasks: input.tasks } : {}),
      ...(input.external !== undefined ? { external: input.external } : {}),
      ...(input.syncState !== undefined ? { syncState: input.syncState } : {}),
      ...(input.syncError !== undefined ? { syncError: input.syncError } : {}),
    };

    // 順番が肝：**ローカル（jsonl）に確定してから**索引に載せ、md を書く。
    // jsonl に載らなかったものは起票として成立していない
    this.append({ v: 1, at, file: entry });
    this.remember(entry);
    this.writeMarkdown(entry);
    return entry;
  }

  /**
   * すでに番号が決まっているものを載せる（`pull` の実装・既存 md の移行が使う唯一の口）。
   *
   * **既存 id と衝突したら例外**——黙って上書きも、黙って採番し直しもしない。
   */
  async adopt(input: BacklogAdoptInput): Promise<BacklogEntry> {
    return this.serialize(() => this.adoptNow(input));
  }

  private adoptNow(input: BacklogAdoptInput): BacklogEntry {
    const id = assertBacklogId(input.id, "取り込む起票の id");
    if (this.entries.has(id)) {
      throw new Error(`起票 "${id}" は既にあります（取り込みでは上書きしません）。`);
    }
    const kind = assertBacklogKind(input.kind, "起票の種別");
    const status = assertBacklogStatus(input.status ?? "open", "起票の状態");
    if (typeof input.title !== "string" || input.title.trim().length === 0) {
      throw new Error("起票には表題が要ります。");
    }
    const clientKey = input.clientKey ?? `adopted-${id}`;
    const existingByKey = this.byClientKey.get(clientKey);
    if (existingByKey !== undefined) {
      throw new Error(`合印 "${clientKey}" は既に ${existingByKey} が使っています。`);
    }

    const at = new Date().toISOString();
    const entry: BacklogEntry = {
      id,
      kind,
      title: input.title,
      status,
      clientKey,
      createdAt: input.createdAt ?? at,
      updatedAt: input.updatedAt ?? input.createdAt ?? at,
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.bodyPath !== undefined ? { bodyPath: input.bodyPath } : {}),
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
      ...(input.projectTag !== undefined ? { projectTag: input.projectTag } : {}),
      ...(input.refs !== undefined ? { refs: input.refs } : {}),
      ...(input.tasks !== undefined ? { tasks: input.tasks } : {}),
      ...(input.external !== undefined ? { external: input.external } : {}),
      ...(input.syncState !== undefined ? { syncState: input.syncState } : {}),
      ...(input.syncError !== undefined ? { syncError: input.syncError } : {}),
    };

    this.append({ v: 1, at, file: entry });
    this.remember(entry);
    this.writeMarkdown(entry);
    return entry;
  }

  async get(id: string): Promise<BacklogEntry | undefined> {
    return this.entries.get(id);
  }

  /** ローカル索引から即答する（契約）。並びは id の昇順＝立った順。 */
  async list(query?: BacklogQuery): Promise<BacklogEntry[]> {
    // 知らない語で絞り込まれたら、0件を返さず投げる（「0件だった」と区別がつかない）
    if (query?.status !== undefined) assertBacklogStatus(query.status, "絞り込みの状態");
    if (query?.kind !== undefined) assertBacklogKind(query.kind, "絞り込みの種別");
    return [...this.entries.values()]
      .filter((e) => {
        if (query?.status !== undefined && e.status !== query.status) return false;
        if (query?.kind !== undefined && e.kind !== query.kind) return false;
        if (query?.projectTag !== undefined && e.projectTag !== query.projectTag) return false;
        return true;
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async update(id: string, patch: BacklogPatch): Promise<BacklogEntry> {
    return this.serialize(() => this.updateNow(id, patch));
  }

  private updateNow(id: string, patch: BacklogPatch): BacklogEntry {
    const current = this.entries.get(id);
    // I2: 知らない id を黙って捨てない。呼んだ側は書けたつもりでいる
    if (!current) throw new Error(`起票に "${id}" はありません。`);
    // 書き換えでも id は動かせない（採番の権威を迂回する裏口を作らない）
    for (const locked of ["id", "clientKey", "createdAt"]) {
      if (Object.prototype.hasOwnProperty.call(patch, locked)) {
        throw new Error(`起票の ${locked} は書き換えられません。`);
      }
    }
    if (patch.status !== undefined) assertBacklogStatus(patch.status, "起票の状態");

    const at = new Date().toISOString();
    const changes = defined(patch);
    const next: BacklogEntry = { ...current, ...changes, updatedAt: at };
    this.append({ v: 1, at, update: { id, patch: changes, at } });
    this.entries.set(id, next);
    this.writeMarkdown(next);
    return next;
  }

  /** ファイル実装は外を持たない。 */
  capabilities(): BacklogCapabilities {
    return { pull: false, push: false };
  }

  /**
   * この実装は `pull` を持たない。
   *
   * 口だけ生やしてあるのは、**呼ばれたときに黙って undefined を返したり
   * `TypeError` で落ちたりせず、言葉で断るため**（I2）。呼ぶ前に
   * `capabilities().pull` を見ること。
   */
  async pull(_since?: string): Promise<BacklogPullResult> {
    throw new Error(
      "この Store は pull を持ちません（ファイル実装。capabilities().pull が false）。" +
        "外から取り込むには pull を持つ Store 実装へ差し替えてください。"
    );
  }

  /**
   * jsonl から md を全件書き直す。**md を消しても戻せる**ことが要点
   * （md は保険であって正ではない）。書けた件数を返す。
   */
  regenerateMarkdown(): number {
    if (this.markdownDir === undefined) return 0;
    let written = 0;
    for (const entry of this.entries.values()) {
      this.writeMarkdown(entry);
      written += 1;
    }
    return written;
  }

  /**
   * 次の `bl-NNNN`。
   *
   * **見るのは jsonl から起こした最大値だけ。** md の置き場は**見ない**——
   * ディレクトリ走査は「どこから見たか」で答えが変わるので、採番の根拠にしてはいけない
   * （クラスの doc を見ること）。md を丸ごと消しても、ここの答えは変わらない。
   */
  private nextId(): string {
    this.maxNumber += 1;
    return formatBacklogId(this.maxNumber);
  }

  /** 索引に載せる。**採番の最大値はここでだけ動く**（戻らない）。 */
  private remember(entry: BacklogEntry): void {
    this.entries.set(entry.id, entry);
    this.byClientKey.set(entry.clientKey, entry.id);
    const n = backlogNumberOf(entry.id);
    if (n !== null && n > this.maxNumber) this.maxNumber = n;
  }

  /**
   * 書きを直列化する。同時に呼ばれても、前の書きが jsonl に載りきってから次が採番する。
   *
   * いまの書きは中で待たない（同期）ので実害は出ないが、**採番と追記が
   * 「読んで・足して・書く」の一続きである**ことをここで固定しておく。
   */
  private serialize<T>(work: () => T): Promise<T> {
    const run = this.writeQueue.then(work, work);
    // 前の書きが投げても列は止めない（次の呼び手まで巻き添えにしない）
    this.writeQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** 追記。**書けなければ投げる**——jsonl が真実なので、載らなかったら起票は成立していない（I2）。 */
  private append(line: LogLine): void {
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      // 前回の追記の途中で落ちて改行の無い切れ端が残っていたら、行を継ぎ足して
      // 1行に混ぜてしまわないよう先に改行で切る（壊れた1行は replay が捨てる）
      if (this.endsMidLine()) fs.appendFileSync(this.logFile, "\n", "utf8");
      fs.appendFileSync(this.logFile, JSON.stringify(line) + "\n", "utf8");
    } catch (err) {
      throw new Error(`起票を記録できません（${this.logFile}）: ${String(err)}`);
    }
  }

  /** 末尾が改行で終わっていない＝前回の追記が途中で切れている。 */
  private endsMidLine(): boolean {
    let size: number;
    try {
      size = fs.statSync(this.logFile).size;
    } catch {
      return false; // まだ無い
    }
    if (size === 0) return false;
    const fd = fs.openSync(this.logFile, "r");
    try {
      const tail = Buffer.alloc(1);
      fs.readSync(fd, tail, 0, 1, size - 1);
      return tail[0] !== 0x0a;
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * md を書く。**書けなくても起票は成立している**（md は保険）ので投げないが、黙りもしない。
   * jsonl（真実）が書けなかったときと扱いを分けているのはこのため。
   */
  private writeMarkdown(entry: BacklogEntry): void {
    if (this.markdownDir === undefined) return;
    const filePath = path.join(this.markdownDir, backlogMarkdownFileName(entry.id));
    try {
      fs.mkdirSync(this.markdownDir, { recursive: true });
      fs.writeFileSync(filePath, renderBacklogMarkdown(entry), "utf8");
    } catch (err) {
      console.error(`[backlog] md を書けません（${filePath}）: ${String(err)}`);
    }
  }

  /** 起動時の読み直し。**壊れた1行で全部を捨てない。ただし黙らない**（inbox.ts と同じ扱い）。 */
  private replay(): void {
    if (!fs.existsSync(this.logFile)) return;
    let lineNo = 0;
    for (const raw of fs.readFileSync(this.logFile, "utf8").split("\n")) {
      lineNo += 1;
      if (raw.trim().length === 0) continue;
      try {
        const line = JSON.parse(raw) as LogLine;
        if (line.file) this.remember(line.file);
        if (line.update) {
          const current = this.entries.get(line.update.id);
          if (current) {
            this.entries.set(current.id, { ...current, ...line.update.patch, updatedAt: line.update.at });
          }
        }
      } catch (err) {
        console.error(`[backlog] ${this.logFile}:${lineNo} を読めません: ${String(err)}`);
      }
    }
  }
}
