/**
 * 番頭の記憶（第一層：好み・習慣）— ADR-0010 決定10。
 *
 * D11: 記憶を持つのは番頭だけ。職人は持たない（隠れ状態が無い＝再現可能・監査可能）。
 *      このモジュールは番頭核から使う。職人セッションの経路からは参照しない。
 *
 * 保存方式は追記のみの JSONL。Kobo のイベントログ（event-log.ts）と同じ発想で、
 * ファイルに書くのは「起きたこと」だけとし、いま有効な記憶（active / superseded）は
 * 読み出し時の再生で導く（D3: 導出できる値は保存しない）。
 *
 * 保存形式は MemoryStore インターフェースの背後に隠す。第三層（全文検索）着手時に
 * SQLite 実装へ差し替える想定で、そのとき呼び出し側は変更しない（task-0007 背景）。
 *
 * D6: 依存は node:fs / node:path / node:crypto のみ。
 * I2: 壊れた記憶ファイルは黙って無視せずエラーにする。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

// ── 記憶レコード ─────────────────────────────────────────────────────────────

/** 第一層が扱う記憶の種別。 */
export type MemoryKind = "preference" | "habit";

/** 保存された1件の記憶。 */
export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  /** 記憶本体（1件1事実。散文で書く）。 */
  text: string;
  /** ISO-8601。書き込み時に付与される。 */
  createdAt: string;
  /** 関連するタスク・ADR等のID（任意）。 */
  refs?: string[];
  /** この記憶が置き換えた古い記憶のID（訂正の場合）。 */
  supersedes?: string;
}

/** save() への入力。id と createdAt はストアが採番する。 */
export interface MemoryInput {
  kind: MemoryKind;
  text: string;
  refs?: string[];
  supersedes?: string;
}

/** list() の絞り込み条件。 */
export interface MemoryQuery {
  kind?: MemoryKind;
  /**
   * true で superseded（訂正済み）な記憶も含める。既定は false。
   * 履歴を見たいとき以外は既定のままでよい。
   */
  includeSuperseded?: boolean;
}

// ── ストアのインターフェース（保存形式に非依存）──────────────────────────────

/**
 * 記憶の保存層。呼び出し側はこの契約だけに依存し、ファイルにも SQL にも触らない。
 * 実装差し替え時の等価性は、このインターフェースに対して書かれた受け入れテストで担保する。
 */
export interface MemoryStore {
  /** 記憶を1件保存し、採番済みのレコードを返す。 */
  save(input: MemoryInput): MemoryRecord;
  /** IDで1件取得する。無ければ undefined。 */
  get(id: string): MemoryRecord | undefined;
  /** 条件に合う記憶を古い順に返す。既定では active なもののみ。 */
  list(query?: MemoryQuery): MemoryRecord[];
  /**
   * 既存の記憶を新しい内容で訂正する。古い記憶は superseded になり、
   * 既定の list() から外れる（履歴としては残る）。
   */
  supersede(id: string, replacement: Omit<MemoryInput, "supersedes">): MemoryRecord;
}

// ── JSONL 実装 ───────────────────────────────────────────────────────────────

/** 1行 = 1レコード。ファイルには追記しかしない。 */
function parseLine(line: string, lineNo: number, filePath: string): MemoryRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    // I2: 壊れた行を黙って読み飛ばすと記憶が静かに欠ける。エラーにして止める。
    throw new Error(`Corrupt memory record at ${filePath}:${lineNo}: ${String(err)}`);
  }
  const record = parsed as Partial<MemoryRecord>;
  if (typeof record.id !== "string" || typeof record.text !== "string" || typeof record.kind !== "string") {
    throw new Error(`Invalid memory record at ${filePath}:${lineNo}: missing id/kind/text`);
  }
  return record as MemoryRecord;
}

/**
 * 追記のみの JSONL による MemoryStore。
 *
 * ファイルは「書かれた記憶の並び」そのもので、active/superseded の別は持たない。
 * 有効な記憶は読み出しのたびに supersedes を辿って導出する（D3）。
 */
export class JsonlMemoryStore implements MemoryStore {
  private readonly filePath: string;

  /**
   * @param filePath 記憶を追記する JSONL のパス。親ディレクトリは必要なら作成される。
   */
  constructor(filePath: string) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  save(input: MemoryInput): MemoryRecord {
    const record: MemoryRecord = {
      id: randomUUID(),
      kind: input.kind,
      text: input.text,
      createdAt: new Date().toISOString(),
      ...(input.refs ? { refs: input.refs } : {}),
      ...(input.supersedes ? { supersedes: input.supersedes } : {}),
    };
    // 同期追記。返った時点で永続化されている（event-log.ts と同じ方針）。
    fs.appendFileSync(this.filePath, JSON.stringify(record) + "\n", "utf-8");
    return record;
  }

  get(id: string): MemoryRecord | undefined {
    return this.readAll().find((r) => r.id === id);
  }

  list(query: MemoryQuery = {}): MemoryRecord[] {
    const all = this.readAll();
    // 訂正された（= 誰かの supersedes に指されている）記憶のIDを集める。
    const supersededIds = new Set(
      all.map((r) => r.supersedes).filter((id): id is string => typeof id === "string")
    );
    return all.filter((r) => {
      if (query.kind && r.kind !== query.kind) return false;
      if (!query.includeSuperseded && supersededIds.has(r.id)) return false;
      return true;
    });
  }

  supersede(id: string, replacement: Omit<MemoryInput, "supersedes">): MemoryRecord {
    // I2: 存在しない記憶を訂正しようとしたら、静かに新規作成せずエラーにする。
    if (!this.get(id)) {
      throw new Error(`Cannot supersede unknown memory "${id}".`);
    }
    return this.save({ ...replacement, supersedes: id });
  }

  /** ファイル全体を書かれた順に読む。未作成なら空。 */
  private readAll(): MemoryRecord[] {
    if (!fs.existsSync(this.filePath)) return [];
    return fs
      .readFileSync(this.filePath, "utf-8")
      .split("\n")
      .map((line, i) => ({ line: line.trim(), lineNo: i + 1 }))
      .filter(({ line }) => line.length > 0)
      .map(({ line, lineNo }) => parseLine(line, lineNo, this.filePath));
  }
}
