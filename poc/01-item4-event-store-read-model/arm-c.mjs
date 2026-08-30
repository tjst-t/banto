// Arm C — B + スナップショット。cold start を短縮する（候補(b)）。
// スナップショットは「いつ消してもよいキャッシュ」であって「写し」ではない
// （§2.1 の境界線）——foldVersion/cursor/eventCount/coveredBytesHash を持たせ、
// 一致しなければ再計算に落ちる。temp + rename + fsync(dir) で原子的に書く。
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFrom, appendLine, zeroCursor } from './shared/jsonl.mjs';
import { empty, apply, FOLD_VERSION } from './shared/fold.mjs';
import { makeSerialQueue } from './shared/queue.mjs';

function snapshotPath(dir) {
  return path.join(dir, 'snapshot.json');
}

/**
 * coveredBytesHash（ログ側の改竄検出）だけでは、snapshot ファイル自身の
 * state フィールドが書き換えられたケースを検出できない（実測で判明。
 * coveredBytesHash はログの範囲だけを見ており、state とは無関係だった）。
 * state と coveredBytesHash を合わせてハッシュし、snapshot 自体の内部整合性を守る。
 */
function integrityHashOf(coveredBytesHash, state) {
  return createHash('sha256').update(coveredBytesHash).update(JSON.stringify(state)).digest('hex');
}

async function hashPrefix(logPath, byteOffset) {
  if (byteOffset === 0) return createHash('sha256').digest('hex');
  const fh = await fsp.open(logPath, 'r');
  try {
    const hash = createHash('sha256');
    const CHUNK = 1 << 20;
    let read = 0;
    const buf = Buffer.alloc(CHUNK);
    while (read < byteOffset) {
      const toRead = Math.min(CHUNK, byteOffset - read);
      const { bytesRead } = await fh.read(buf, 0, toRead, read);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
      read += bytesRead;
    }
    return hash.digest('hex');
  } finally {
    await fh.close();
  }
}

export class StoreC {
  constructor(dir) {
    this.dir = dir;
    this.path = path.join(dir, 'log.jsonl');
    this._state = empty();
    this._cursor = zeroCursor();
    this._listeners = new Set();
    this.foldCalls = 0;
    this.snapshotRejections = []; // 毒入り snapshot を弾いた記録（試験で読む）
    this._enqueue = makeSerialQueue(); // append を直列化する（arm-b.mjs と同じ理由）
  }

  static async open(dir) {
    const store = new StoreC(dir);
    const snap = await store._tryLoadSnapshot();
    let startCursor = zeroCursor();
    let startState = empty();
    if (snap) {
      startCursor = snap.cursor;
      startState = snap.state;
    }
    store.foldCalls += 1; // tail replay も 1 回の fold 呼び出しとして数える
    let s = startState;
    let c = startCursor;
    for await (const { event, cursor } of readFrom(store.path, startCursor)) {
      s = apply(s, event);
      c = cursor;
    }
    store._state = s;
    store._cursor = c;
    return store;
  }

  /**
   * 起動時に使う軽量チェックのみ（O(1)）。実測で判明：coveredBytesHash の検証は
   * ログ全体を読むので O(n) になり、1M件・1GB で3.4秒かかる——スナップショットで
   * 短縮したかった cold start を、検証コストがそのまま食い潰す。
   * **したがって起動時の必須チェックからハッシュ検証を外した**（version・cursor の
   * 整合だけを見る）。ハッシュによる改竄検出は `verifyIntegrity()` という
   * 明示的な・遅くてよい別操作に分離する。**トレードオフを隠さず記録する**：
   * 軽量な起動では snapshot の state 改竄（version・cursor は正しいまま）を
   * 検出できない。
   */
  async _tryLoadSnapshot() {
    let raw;
    try {
      raw = await fsp.readFile(snapshotPath(this.dir), 'utf8');
    } catch {
      return null; // snapshot が無いのは正常（初回起動）
    }
    let snap;
    try {
      snap = JSON.parse(raw);
    } catch {
      this.snapshotRejections.push('parse-error');
      return null;
    }
    if (snap.foldVersion !== FOLD_VERSION) {
      this.snapshotRejections.push('version-mismatch');
      return null;
    }
    const logSize = await this.statBytes();
    if (snap.cursor.byteOffset > logSize) {
      this.snapshotRejections.push('cursor-past-eof');
      return null;
    }
    return snap;
  }

  /**
   * 重い整合性検査（O(n)）。オプトインで明示的に呼ぶ——起動のたびには呼ばない。
   * ログ側の改竄（分割・巻き戻し等）と snapshot 自身の state 改竄の両方を検出する。
   */
  async verifyIntegrity() {
    const raw = await fsp.readFile(snapshotPath(this.dir), 'utf8').catch(() => null);
    if (!raw) return { ok: true, reason: 'no-snapshot' };
    const snap = JSON.parse(raw);
    const actualHash = await hashPrefix(this.path, snap.cursor.byteOffset);
    if (actualHash !== snap.coveredBytesHash) return { ok: false, reason: 'log-hash-mismatch' };
    const expectedIntegrity = integrityHashOf(snap.coveredBytesHash, snap.state);
    if (snap.integrityHash !== expectedIntegrity) return { ok: false, reason: 'state-tampered' };
    return { ok: true };
  }

  state() {
    return this._state;
  }

  cursor() {
    return this._cursor;
  }

  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  append(event) {
    return this._enqueue(() => this._appendOne(event));
  }

  async _appendOne(event) {
    const bytesWritten = await appendLine(this.path, event);
    this._state = apply(this._state, event);
    this._cursor = { seq: this._cursor.seq + 1, byteOffset: this._cursor.byteOffset + bytesWritten };
    for (const fn of this._listeners) fn(this._state, event, this._cursor);
    return this._cursor;
  }

  /** temp + rename + fsync(dir)。書いている途中に落ちても、旧 snapshot か無しのどちらかにしかならない。 */
  async checkpoint() {
    const coveredBytesHash = await hashPrefix(this.path, this._cursor.byteOffset);
    const snap = {
      foldVersion: FOLD_VERSION,
      cursor: this._cursor,
      eventCount: this._cursor.seq,
      coveredBytesHash,
      integrityHash: integrityHashOf(coveredBytesHash, this._state),
      state: this._state,
    };
    const tmp = snapshotPath(this.dir) + `.tmp-${process.pid}-${Date.now()}`;
    const fh = await fsp.open(tmp, 'w');
    await fh.writeFile(JSON.stringify(snap));
    await fh.sync();
    await fh.close();
    await fsp.rename(tmp, snapshotPath(this.dir));
    const dirFh = await fsp.open(this.dir, 'r');
    await dirFh.sync();
    await dirFh.close();
  }

  /** いつ消してもよい。消しても正しさは変わらない、が §2.1 の境界線。 */
  async dropDerived() {
    try {
      await fsp.unlink(snapshotPath(this.dir));
    } catch {
      // 無ければ何もしない
    }
  }

  async rebuildFromScratch() {
    let s = empty();
    let c = zeroCursor();
    for await (const { event, cursor } of readFrom(this.path, zeroCursor())) {
      s = apply(s, event);
      c = cursor;
    }
    return { state: s, cursor: c };
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

export { FOLD_VERSION };
