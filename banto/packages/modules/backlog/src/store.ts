// 一覧を読み書きする店（§4.4「置き場——専用のブランチ」「書き込みは必ず Module の tool を通し、Module が1件ずつ順に書く」）。
//
// 正本は**コードとつながらない専用のブランチ**（既定 `backlog`、親を持たない orphan。中は tasks.json 1つ）。
// - **作業ツリーも index も使わない**（`git.ts`）。main・worktree・どのブランチを checkout していても、正本は1つ
// - **1件の変更ごとに1コミット**。親は読んだときのコミット、ref は compare-and-swap で動かす——先を越されたら読み直して
//   操作をやり直す（数回まで）。プロセスの中でも書く操作を1本の列に並べる（同じ Project の複数の Thread が同時に触る）
// - **毎回読み直す**：別の手元から送られたもの・人が git で直したものがあるので、覚えておいた中身を土台にしない
// - **origin と行き来する**：書く前と画面を開いたときに取ってくる（毎回の読み直しではやらない）。origin が手元より先
//   （fast-forward できる）なら取り込む。両方に新しいコミットがあれば（食い違い）書かずに理由を言う。書いたら送る
//   ——**送れなくても書き込みは止めない**。まだ送っていないこと・送れなかった理由を、読むたびに知らせる
// - 形が違う中身（古い tasks.json など）は**読まず・書かず**、理由と変換の手段を言う

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  countAll,
  countBetween,
  commitTasks,
  hasOrigin,
  isAncestor,
  readTasksBlob,
  repositoryProblem,
  resolveRef,
  swapRef,
  TASKS_FILE,
} from "./git.js";
import {
  BACKLOG_FORMAT,
  BacklogError,
  emptyDocument,
  parseDocument,
  serializeDocument,
  validateDocument,
  type BacklogDocument,
  type Change,
} from "./model.js";
import type { BranchRemote, SyncOutcome } from "./remote.js";

/** 古い形を変換するスクリプト（このパッケージの scripts/）。案内に出す */
export const CONVERTER_PATH = fileURLToPath(new URL("../scripts/convert-tasks-json.mjs", import.meta.url));
/** 作業ツリーの tasks.json をブランチへ移すスクリプト。案内に出す */
export const MOVER_PATH = fileURLToPath(new URL("../scripts/move-to-branch.mjs", import.meta.url));

/** 作業ツリーに一覧のファイルが残っていないかを見る場所（ブランチへ移す前の既定の場所） */
export const WORKING_TREE_CANDIDATES = ["docs/tasks.json"] as const;

/** 先を越されたときに、読み直してやり直す回数 */
export const SWAP_ATTEMPTS = 5;

/** origin との様子（ref から導く。覚えているのは最後に送った・取ってきたときの失敗の理由だけ） */
export interface SyncState {
  /** origin が無い（送る先が無い——「まだ送っていない」とは言わない） */
  origin: boolean;
  /** 手元にあって origin（最後に取ってきた時点）に無いコミットの数。origin にブランチがまだ無ければ手元の全部 */
  ahead: number;
  /** origin にあって手元に無いコミットの数 */
  behind: number;
  /** 両方に新しいコミットがある——書かない */
  diverged: boolean;
  /** 最後に送ったときの失敗の理由（送れたら消える） */
  pushError?: string;
  /** 最後に取ってきたときの失敗の理由（取ってこれたら消える） */
  fetchError?: string;
}

/** 作業ツリーに残っている一覧（ブランチがまだ無いときに、移す道を案内する） */
export interface Leftover {
  path: string;
  command: string;
}

export type Snapshot =
  | { state: "missing"; branch: string; version: string; sync: SyncState; leftover?: Leftover; notRepository?: string }
  | { state: "refused"; branch: string; version: string; sync: SyncState; head: string; legacy: boolean; reason: string }
  | { state: "ok"; branch: string; version: string; sync: SyncState; head: string; doc: BacklogDocument; problems: string[] };

export interface StoreDeps {
  /** Project の根（絶対パス）。git のリポジトリ（の中） */
  root: string;
  /** いまのブランチ名。設定で変わるので毎回聞く */
  branch: () => string;
  /** 送る・取ってくる口。無ければ送らない（origin が無いのと同じ扱い） */
  remote?: BranchRemote;
}

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** 古い形を変換するコマンド（ブランチから書き出してから。書き出す先は人が決める） */
export function conversionCommand(branch: string): string {
  return `git show ${branch}:${TASKS_FILE} > old-tasks.json && node ${CONVERTER_PATH} old-tasks.json <書き出す先>`;
}

/** 人と AI に見せる「変換のしかた」 */
export function conversionHint(branch: string): string {
  return `変換するには：${conversionCommand(branch)}（中身を確かめてから、move-to-branch.mjs でブランチへ移し直します）`;
}

/** 作業ツリーの一覧をブランチへ移すコマンド */
export function moveCommand(root: string, file: string, branch: string): string {
  return `node ${MOVER_PATH} --repo ${root} --file ${file} --branch ${branch} --push`;
}

/** 書き込みの結果 */
export interface MutateResult<T> {
  result: T;
  doc: BacklogDocument;
  branch: string;
  /** ブランチをこの書き込みで作った（orphan のコミット） */
  created: boolean;
  commit: string;
  /** 送った結果（origin が無ければ undefined） */
  push?: SyncOutcome;
}

export class BacklogStore {
  private queue: Promise<unknown> = Promise.resolve();
  private pushQueue: Promise<unknown> = Promise.resolve();
  private lastPushError?: string;
  private lastFetchError?: string;

  constructor(private readonly deps: StoreDeps) {}

  private get root(): string {
    return this.deps.root;
  }

  /**
   * いまの一覧を読む。**書く列には並ばない**（読むだけなので待たせない）。origin が先へ進んでいれば
   * （最後に取ってきた時点で）取り込む——ref を compare-and-swap で進めるだけなので、書く操作とぶつかっても壊れない
   */
  async read(): Promise<Snapshot> {
    const branch = this.deps.branch();
    const notRepository = await repositoryProblem(this.root);
    if (notRepository) {
      const sync: SyncState = { origin: false, ahead: 0, behind: 0, diverged: false };
      return { state: "missing", branch, version: shortHash(`not-repo:${notRepository}`), sync, notRepository };
    }
    await this.adoptOrigin(branch);
    const head = await resolveRef(this.root, `refs/heads/${branch}`);
    const sync = await this.syncState(branch, head);
    const version = shortHash(JSON.stringify([head ?? "missing", sync]));
    if (!head) {
      const leftover = await this.leftover(branch);
      return { state: "missing", branch, version, sync, ...(leftover ? { leftover } : {}) };
    }
    const text = await readTasksBlob(this.root, head);
    if (text === undefined) {
      return { state: "refused", branch, version, sync, head, legacy: false, reason: `ブランチ ${branch} に ${TASKS_FILE} がありません` };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      return { state: "refused", branch, version, sync, head, legacy: false, reason: `JSON として読めません（${err instanceof Error ? err.message : String(err)}）` };
    }
    const parsed = parseDocument(raw);
    if (!parsed.ok) return { state: "refused", branch, version, sync, head, legacy: parsed.legacy, reason: parsed.reason };
    return { state: "ok", branch, version, sync, head, doc: parsed.doc, problems: validateDocument(parsed.doc) };
  }

  /** origin から取ってくる（画面を開いたとき・書く前）。失敗は覚えて知らせるだけ */
  async refresh(callId?: string): Promise<void> {
    const branch = this.deps.branch();
    if (!this.deps.remote || (await repositoryProblem(this.root)) || !(await hasOrigin(this.root))) return;
    const r = await this.deps.remote.fetch(branch, callId);
    this.lastFetchError = r.ok ? undefined : r.message;
  }

  /**
   * 1件の変更。**列に並び、取ってきて・読み直してから変え、検証してからコミットを積み、送る。**
   * ブランチが無ければ空の文書から始めて orphan のコミットを作る。読めない形なら書かない（壊さない）
   */
  mutate<T>(change: (doc: BacklogDocument) => Change<T>, message: (result: T) => string, callId?: string): Promise<MutateResult<T>> {
    const run = this.queue.then(() => this.mutateNow(change, message, callId));
    // 失敗しても列は止めない（次の操作は次の操作）
    this.queue = run.catch(() => undefined);
    return run.then(async (written) => {
      // **送るのは列の外**——送っている間も次の書き込みは進める。送る操作どうしは別の列で1本ずつ
      const push = await this.push(written.branch, callId);
      return { ...written, ...(push ? { push } : {}) };
    });
  }

  private async mutateNow<T>(
    change: (doc: BacklogDocument) => Change<T>,
    message: (result: T) => string,
    callId: string | undefined,
  ): Promise<Omit<MutateResult<T>, "push">> {
    const notRepository = await repositoryProblem(this.root);
    if (notRepository) throw new BacklogError(`${notRepository}。書き込みません`);
    await this.refresh(callId);
    let lastWhy = "";
    for (let attempt = 0; attempt < SWAP_ATTEMPTS; attempt += 1) {
      const snapshot = await this.read();
      const branch = snapshot.branch;
      if (snapshot.sync.diverged) {
        throw new BacklogError(
          `手元と origin の ${branch} が分かれています（手元だけに ${snapshot.sync.ahead} 件・origin だけに ${snapshot.sync.behind} 件のコミット）。` +
            `書き込みません——どちらかに揃えてから（例：手元を origin に合わせるなら git update-ref refs/heads/${branch} refs/remotes/origin/${branch}）`,
        );
      }
      if (snapshot.state === "refused") {
        throw new BacklogError(
          `ブランチ ${branch} の ${TASKS_FILE} は読めない形なので、書き込みません：${snapshot.reason}` +
            (snapshot.legacy ? `。${conversionHint(branch)}` : ""),
        );
      }
      // 土台は**読んだ中身のコミット**——ref を読み直さない（読み直すと、中身と親が食い違いうる）
      const head = snapshot.state === "ok" ? snapshot.head : undefined;
      const before = snapshot.state === "ok" ? snapshot.doc : emptyDocument();
      const known = new Set(snapshot.state === "ok" ? snapshot.problems : []);
      const next = change(before);
      // **この変更で増える問題だけ**を断る理由にする——手で直したものに前からある問題で、
      // 関係のない操作まで止めないため（前からある問題は読むたびに知らせている）
      const added = validateDocument(next.doc).filter((p) => !known.has(p));
      if (added.length > 0) throw new BacklogError(`変えられません：${added.join("／")}`);
      const summary = message(next.result);
      const commit = await commitTasks(this.root, serializeDocument(next.doc), head, summary);
      const swapped = await swapRef(this.root, `refs/heads/${branch}`, commit, head, summary);
      if (swapped.swapped) return { result: next.result, doc: next.doc, branch, created: head === undefined, commit };
      // 先を越された——読み直して、同じ操作をやり直す（作ったコミットは ref から辿れないまま、git が後で片づける）
      lastWhy = swapped.why;
    }
    throw new BacklogError(`ほかの書き込みに ${SWAP_ATTEMPTS} 回続けて先を越されたので、書けませんでした（${lastWhy}）`);
  }

  /** 送る。送る操作どうしは1本ずつ（送るのはその時点の ref——先に並んだ書き込みの分もまとめて送られる） */
  private push(branch: string, callId?: string): Promise<SyncOutcome | undefined> {
    const run = this.pushQueue.then(async (): Promise<SyncOutcome | undefined> => {
      if (!this.deps.remote || !(await hasOrigin(this.root))) return undefined;
      const r = await this.deps.remote.push(branch, callId);
      this.lastPushError = r.ok ? undefined : r.message;
      return r;
    });
    this.pushQueue = run.catch(() => undefined);
    return run.catch((err) => {
      // 送る途中で投げた（git が無い等）——書き込みは済んでいるので、失敗として知らせる
      this.lastPushError = (err as Error).message;
      return { ok: false, via: "git", message: this.lastPushError };
    });
  }

  /**
   * origin（最後に取ってきた時点）が手元より先で、fast-forward できるなら手元を進める。手元にブランチが無く origin に
   * あれば、それを手元のブランチにする（別の手元から送られた一覧を使い始める）。食い違いには触らない
   */
  private async adoptOrigin(branch: string): Promise<void> {
    const tracking = await resolveRef(this.root, `refs/remotes/origin/${branch}`);
    if (!tracking) return;
    const head = await resolveRef(this.root, `refs/heads/${branch}`);
    if (head === tracking) return;
    if (head && !(await isAncestor(this.root, head, tracking))) return;
    // 先を越されても構わない（その書き込みが読み直す）
    await swapRef(this.root, `refs/heads/${branch}`, tracking, head, `backlog: origin/${branch} を取り込む`);
  }

  private async syncState(branch: string, head: string | undefined): Promise<SyncState> {
    const origin = await hasOrigin(this.root);
    const errors = {
      ...(this.lastPushError !== undefined ? { pushError: this.lastPushError } : {}),
      ...(this.lastFetchError !== undefined ? { fetchError: this.lastFetchError } : {}),
    };
    if (!origin) return { origin, ahead: 0, behind: 0, diverged: false };
    const tracking = await resolveRef(this.root, `refs/remotes/origin/${branch}`);
    if (!head) return { origin, ahead: 0, behind: 0, diverged: false, ...errors };
    if (!tracking) return { origin, ahead: await countAll(this.root, head), behind: 0, diverged: false, ...errors };
    const ahead = await countBetween(this.root, tracking, head);
    const behind = await countBetween(this.root, head, tracking);
    return { origin, ahead, behind, diverged: ahead > 0 && behind > 0, ...errors };
  }

  /** ブランチがまだ無いとき、作業ツリーに一覧のファイルが残っていれば、移す道を案内する（自動では移さない） */
  private async leftover(branch: string): Promise<Leftover | undefined> {
    for (const rel of WORKING_TREE_CANDIDATES) {
      let text: string;
      try {
        text = await readFile(join(this.root, rel), "utf8");
      } catch {
        continue;
      }
      // 移せる形（banto-backlog/1）のものだけ案内する。古い形なら変換が先
      if (!text.includes(BACKLOG_FORMAT)) continue;
      return { path: rel, command: moveCommand(this.root, rel, branch) };
    }
    return undefined;
  }
}
