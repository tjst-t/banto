// tasks.json を読み書きする店（§4.4「書き込みは必ず Module の tool を通し、Module が1件ずつ順に書く」）。
//
// - **1件ずつ順に**：このプロセスの中で、書く操作を1本の列に並べる（同じ Project の複数の Thread が同時に触る）
// - **毎回読み直す**：人が手で直す・git pull で変わるので、覚えておいた中身を土台にしない
// - **一時ファイル → rename**：書いている途中で落ちても、読む側が半端な JSON を見ない
// - 形が違うファイル（古い tasks.json など）は**読まず・書かず**、理由と変換の手段を言う

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BacklogError,
  emptyDocument,
  parseDocument,
  serializeDocument,
  validateDocument,
  type BacklogDocument,
  type Change,
} from "./model.js";

/** 古い形を変換するスクリプト（このパッケージの scripts/）。案内に出す */
export const CONVERTER_PATH = fileURLToPath(new URL("../scripts/convert-tasks-json.mjs", import.meta.url));

export type Snapshot =
  | { state: "missing"; path: string; version: string }
  | { state: "refused"; path: string; version: string; legacy: boolean; reason: string }
  | { state: "ok"; path: string; version: string; doc: BacklogDocument; problems: string[] };

export interface StoreDeps {
  /** Project の根（絶対パス） */
  root: string;
  /** いまの tasks.json の場所（根からの相対）。設定で変わるので毎回聞く */
  tasksPath: () => string;
}

function versionOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** 古い形を変換するコマンド（書き出す先は人が決める） */
export function conversionCommand(relPath: string): string {
  return `node ${CONVERTER_PATH} ${relPath} <書き出す先>`;
}

/** 人と AI に見せる「変換のしかた」 */
export function conversionHint(relPath: string): string {
  return `変換するには：${conversionCommand(relPath)}（中身を確かめてから置き換えます）`;
}

export class BacklogStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: StoreDeps) {}

  private absolute(rel: string): string {
    return join(this.deps.root, rel);
  }

  /** いまのファイルを読む。**書く列には並ばない**（読むだけなので待たせない。書く途中は rename で切り替わる） */
  async read(): Promise<Snapshot> {
    const path = this.deps.tasksPath();
    let text: string;
    try {
      text = await readFile(this.absolute(path), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing", path, version: "missing" };
      throw new BacklogError(`${path} を読めません：${err instanceof Error ? err.message : String(err)}`);
    }
    const version = versionOf(text);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      return {
        state: "refused",
        path,
        version,
        legacy: false,
        reason: `JSON として読めません（${err instanceof Error ? err.message : String(err)}）`,
      };
    }
    const parsed = parseDocument(raw);
    if (!parsed.ok) return { state: "refused", path, version, legacy: parsed.legacy, reason: parsed.reason };
    return { state: "ok", path, version, doc: parsed.doc, problems: validateDocument(parsed.doc) };
  }

  /**
   * 1件の変更。**列に並び、読み直してから変え、検証してから書く。**
   * ファイルが無ければ空の文書から始めて作る。読めない形なら書かない（壊さない）
   */
  mutate<T>(change: (doc: BacklogDocument) => Change<T>): Promise<{ result: T; doc: BacklogDocument; path: string; created: boolean }> {
    const run = this.queue.then(() => this.mutateNow(change));
    // 失敗しても列は止めない（次の操作は次の操作）
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async mutateNow<T>(
    change: (doc: BacklogDocument) => Change<T>,
  ): Promise<{ result: T; doc: BacklogDocument; path: string; created: boolean }> {
    const snapshot = await this.read();
    if (snapshot.state === "refused") {
      throw new BacklogError(
        `${snapshot.path} は読めない形なので、書き込みません：${snapshot.reason}` +
          (snapshot.legacy ? `。${conversionHint(snapshot.path)}` : ""),
      );
    }
    const before = snapshot.state === "ok" ? snapshot.doc : emptyDocument();
    const known = new Set(snapshot.state === "ok" ? snapshot.problems : []);
    const next = change(before);
    // **この変更で増える問題だけ**を断る理由にする——手で直したファイルに前からある問題で、
    // 関係のない操作まで止めないため（前からある問題は読むたびに知らせている）
    const added = validateDocument(next.doc).filter((p) => !known.has(p));
    if (added.length > 0) throw new BacklogError(`変えられません：${added.join("／")}`);
    await this.writeAtomic(snapshot.path, serializeDocument(next.doc));
    return { result: next.result, doc: next.doc, path: snapshot.path, created: snapshot.state === "missing" };
  }

  private async writeAtomic(rel: string, text: string): Promise<void> {
    const target = this.absolute(rel);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      await writeFile(tmp, text, "utf8");
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }
}
