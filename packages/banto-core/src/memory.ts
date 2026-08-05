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
/**
 * 記憶の種類（ADR-0010 決定31）。
 *
 * - `preference` 好み。変わってよい。文体・見せ方など「そうしてほしい」こと
 * - `habit` 習慣。変わってよい。手順やチェックのルーティン
 * - `fact` 事実。導出できず（D3）、変わらないことが期待される属性。名前・役割・許諾範囲など
 *
 * **事実を好みに混ぜない。** 「好み」の一覧に名前が並ぶと、番頭がそれを「変えてよいもの」
 * として扱いうる。事実の訂正は誤りの発見であって、好みの変化ではない（決定31a）。
 *
 * 注意（決定31b）：ここの `fact` は決定29(a) の `WorkerEventKind`（fact / claim）とは
 * **同音異義**。あちらは証拠の状態（観測された事実か自己申告か）、こちらは言明の種類。
 * 記憶における確からしさは `kind` ではなく出所が担う（決定28）——分類と確からしさを
 * 同じフィールドに載せない。
 */
export type MemoryKind = "preference" | "habit" | "fact";

/**
 * 記憶の出所（決定28）。
 *
 * - `explicit` PO が「覚えて」と言ったもの、または番頭が明示的に保存したもの
 * - `extracted` 会話の区切りで背後のLLMが抽出したもの
 *
 * **分類（`kind`）と確からしさ（`origin`）を同じフィールドに載せない**（決定31b）。
 * 注入の予算が足りないときに何から落とすかは、`kind` と `origin` の両方で決まる。
 */
export type MemoryOrigin = "explicit" | "extracted";

/**
 * 記憶の層（ADR-0003）。
 *
 * - `person` あなた（人）の記憶。全プロジェクト横断・共有
 * - `project` プロジェクトの記憶。各プロジェクトに閉じる・横断させない
 *
 * **ストアそのものを分けることで「横断させない」を機構で担保する**——同じファイルに
 * `scope` フィールドで同居させると、絞り込みを1箇所書き忘れた時点で混ざる。
 * 層の合成は呼び出し側（`ScopedMemory`）が行う。
 */
export type MemoryScope = "person" | "project";

/** 保存された1件の記憶。 */
export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  /** 記憶本体（1件1事実。散文で書く）。 */
  text: string;
  /** ISO-8601。書き込み時に付与される。 */
  createdAt: string;
  /**
   * 出所（決定28）。省略は `explicit` と同じに扱う——`memory.save` しか無かった頃の
   * 記憶が既にファイルにあり、それらは全て PO 由来だから（後方互換）。
   */
  origin?: MemoryOrigin;
  /**
   * この記憶が**世界で真になった時刻**（ISO-8601、任意）。
   *
   * `createdAt`（記録した時刻）とは別軸。「2026-08から番頭ホストは Node 22 前提」の
   * ように、いつから真かが意味を持つ事実で使う。両方を持たないと、記録が遅れただけの
   * 記憶と、後から真になった記憶を区別できない。
   */
  validFrom?: string;
  /** 関連するタスク・ADR等のID（任意）。 */
  refs?: string[];
  /** この記憶が置き換えた古い記憶のID（訂正の場合）。 */
  supersedes?: string;
  /**
   * この記録が「忘れた」ことを表すとき、忘れた記憶のID（決定28：削除は追記で表す）。
   *
   * `supersedes` と違い**置き換える中身が無い**。`forgets` を持つ記録自体は記憶として
   * 数えない——有効な記憶は読み出し時に導出する（D3）。
   */
  forgets?: string;
  /** 忘れた理由（`forgets` と対で使う。任意）。 */
  reason?: string;
}

/** save() への入力。id と createdAt はストアが採番する。 */
export interface MemoryInput {
  kind: MemoryKind;
  text: string;
  origin?: MemoryOrigin;
  validFrom?: string;
  refs?: string[];
  supersedes?: string;
}

/** list() の絞り込み条件。 */
export interface MemoryQuery {
  kind?: MemoryKind;
  origin?: MemoryOrigin;
  /**
   * true で superseded（訂正済み）・forgotten（忘れた）記憶も含める。既定は false。
   * 履歴を見たいとき以外は既定のままでよい。
   */
  includeSuperseded?: boolean;
}

/** search() の条件。 */
export interface MemorySearchQuery extends MemoryQuery {
  /**
   * 探す文字列。空白区切りの語をすべて含む記憶が返る（AND、大小文字を無視）。
   *
   * **形態素解析も索引も持たない**（D6）。記憶は1人ぶんで、部分一致の線形走査で
   * 十分に速い。日本語は分かち書きされないので、部分一致の方がむしろ素直に当たる。
   */
  text: string;
  /** 返す最大件数。既定 20。 */
  limit?: number;
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
  /**
   * 記憶を忘れる（決定28：削除は追記で表す）。
   *
   * ファイルからは消さない——「忘れた」ことを追記し、有効な記憶は読み出し時に導出する
   * （D3）。誤って忘れたときに何があったかを辿れる。
   */
  forget(id: string, reason?: string): MemoryRecord;
  /**
   * 本文の部分一致で記憶を探す（提案3.3：注入の予算から溢れたものを引く経路）。
   *
   * 予算があるかぎり記憶はプロンプトに載るので、これは**溢れた分と、忘れかけた古い分**を
   * 引くためにある。索引は持たない（D6）。
   */
  search(query: MemorySearchQuery): MemoryRecord[];
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
 * 追記の並びから、いま有効な記憶を導く（D3：active/superseded をファイルに持たない）。
 *
 * - `supersededIds` 誰かの `supersedes` に指されている＝訂正された
 * - `forgottenIds`  誰かの `forgets` に指されている＝忘れた
 * - `tombstones`    「忘れた」ことを表す記録そのもの（記憶として数えない）
 */
function derive(all: readonly MemoryRecord[]): {
  supersededIds: Set<string>;
  forgottenIds: Set<string>;
  tombstones: Set<string>;
} {
  const supersededIds = new Set<string>();
  const forgottenIds = new Set<string>();
  const tombstones = new Set<string>();
  for (const r of all) {
    if (typeof r.supersedes === "string") supersededIds.add(r.supersedes);
    if (typeof r.forgets === "string") {
      forgottenIds.add(r.forgets);
      tombstones.add(r.id);
    }
  }
  return { supersededIds, forgottenIds, tombstones };
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
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.validFrom ? { validFrom: input.validFrom } : {}),
      ...(input.refs ? { refs: input.refs } : {}),
      ...(input.supersedes ? { supersedes: input.supersedes } : {}),
    };
    this.append(record);
    return record;
  }

  get(id: string): MemoryRecord | undefined {
    return this.readAll().find((r) => r.id === id);
  }

  list(query: MemoryQuery = {}): MemoryRecord[] {
    const all = this.readAll();
    const { supersededIds, forgottenIds, tombstones } = derive(all);
    return all.filter((r) => {
      // 「忘れた」記録そのものは記憶ではない。中身が無いので出しても読めない
      if (tombstones.has(r.id)) return false;
      if (query.kind && r.kind !== query.kind) return false;
      // 省略は explicit と同じ扱い（後方互換。origin が無かった頃の記憶は全て PO 由来）
      if (query.origin && (r.origin ?? "explicit") !== query.origin) return false;
      if (!query.includeSuperseded && (supersededIds.has(r.id) || forgottenIds.has(r.id))) {
        return false;
      }
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

  forget(id: string, reason?: string): MemoryRecord {
    const target = this.get(id);
    // I2: 存在しない記憶を忘れようとしたら、黙って成功にせずエラーにする。
    if (!target) {
      throw new Error(`Cannot forget unknown memory "${id}".`);
    }
    // 墓標。kind と text は元の記憶から写す——ファイルだけを見て「何を忘れたか」が読める
    const record: MemoryRecord = {
      id: randomUUID(),
      kind: target.kind,
      text: target.text,
      createdAt: new Date().toISOString(),
      forgets: id,
      ...(reason ? { reason } : {}),
    };
    this.append(record);
    return record;
  }

  search(query: MemorySearchQuery): MemoryRecord[] {
    const terms = query.text
      .split(/\s+/u)
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0);
    const { text: _text, limit, ...rest } = query;
    const candidates = this.list(rest);
    // 語を指定しなければ絞り込まない（kind だけで引きたいときに使える）
    const hits =
      terms.length === 0
        ? candidates
        : candidates.filter((r) => {
            const haystack = r.text.toLowerCase();
            return terms.every((t) => haystack.includes(t));
          });
    // 新しいものから返す——古い記憶ほど、訂正されないまま残っている見込みが低い
    return hits.reverse().slice(0, limit ?? 20);
  }

  /** 同期追記。返った時点で永続化されている（event-log.ts と同じ方針）。 */
  private append(record: MemoryRecord): void {
    fs.appendFileSync(this.filePath, JSON.stringify(record) + "\n", "utf-8");
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

// ── 注入の予算（提案3.3）────────────────────────────────────────────────────

/**
 * システムプロンプトへ載せる記憶のトークン予算。
 *
 * **上限が無いと必ず壊れる。** 記憶は追記のみで増え続け、自動抽出（決定28）が入れば
 * 数百件規模になる。全件をシステムプロンプトへ焼き込む形は、そこで破綻する。
 */
export const DEFAULT_MEMORY_TOKEN_BUDGET = 1500;

/**
 * トークン数の見積り。**多めに出す**（予算を割るより、載せる数が減る方が安全）。
 *
 * pi は chars/4 を使うが、あれは英語向けで、日本語ではむしろ**少なく**見積もる。
 * 番頭の記憶は日本語なので chars/2 を使う。正確さは要らない——ここで要るのは
 * 「際限なく載せない」ことだけで、境界の1件がどちらに転んでも困らない。
 */
export function estimateMemoryTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

/** 予算で選び切れなかった分の内訳。プロンプトに「まだある」と書くために使う。 */
export interface MemoryBudgetResult {
  /** 予算に収まった記憶（優先順に並ぶ）。 */
  selected: MemoryRecord[];
  /** 予算から溢れた記憶。件数だけ使い、中身はプロンプトに載せない。 */
  omitted: MemoryRecord[];
}

/**
 * 予算に収まる記憶を選ぶ。
 *
 * 優先順位は **種別 → 出所 → 新しさ**:
 *
 * 1. `fact` > `preference` > `habit`（決定31d：事実が最も安定しているので先に読ませる）
 * 2. `explicit` > `extracted`（決定28：抽出は自動で有効にするが、PO が言ったことより弱い）
 * 3. 新しいものから
 *
 * **「最後に参照した時刻」は使わない。** 記憶はここで一括注入されるので、個別の記憶が
 * 「参照された」時刻は定義できない（全部が毎回使われる）。順序の根拠にならない値を
 * 保存しない（D3）。
 */
export function selectMemoriesForBudget(
  records: readonly MemoryRecord[],
  options: { tokenBudget?: number } = {}
): MemoryBudgetResult {
  const budget = options.tokenBudget ?? DEFAULT_MEMORY_TOKEN_BUDGET;
  const kindRank: Record<MemoryKind, number> = { fact: 0, preference: 1, habit: 2 };
  const ranked = [...records].sort((a, b) => {
    const byKind = kindRank[a.kind] - kindRank[b.kind];
    if (byKind !== 0) return byKind;
    const originRank = (r: MemoryRecord): number => ((r.origin ?? "explicit") === "explicit" ? 0 : 1);
    const byOrigin = originRank(a) - originRank(b);
    if (byOrigin !== 0) return byOrigin;
    return b.createdAt.localeCompare(a.createdAt);
  });

  const selected: MemoryRecord[] = [];
  const omitted: MemoryRecord[] = [];
  let spent = 0;
  for (const record of ranked) {
    const cost = estimateMemoryTokens(record.text);
    // 予算を割った後も走査を続ける——後ろに短い記憶があれば入れる。
    // 「1件でも溢れたら以降は全部落とす」にすると、長い1件が安い数件を巻き添えにする
    if (spent + cost > budget) {
      omitted.push(record);
      continue;
    }
    selected.push(record);
    spent += cost;
  }
  return { selected, omitted };
}

// ── 二層（ADR-0003）─────────────────────────────────────────────────────────

/**
 * 記憶の二層（ADR-0003）を合成する。
 *
 * - **人の記憶**は1つ。全プロジェクト横断で共有される
 * - **プロジェクトの記憶**は場所ごとに別のストア。**横断させない**
 *
 * 「横断させない」を絞り込みではなく**ストアの分離**で担保するのが要点——同じファイルに
 * `scope` を持たせて同居させると、`where` を1箇所書き忘れた時点で混ざる。ここでは
 * 混ぜようとしても混ざらない。
 *
 * D5: 判断は無い。どのストアを開くかの解決だけ。
 */
export class ScopedMemory {
  private readonly person: MemoryStore;
  private readonly openProject: (placeId: string) => MemoryStore;
  private readonly projects = new Map<string, MemoryStore>();

  /**
   * @param person      人の記憶のストア
   * @param openProject 場所ごとのストアを開く。**省略すると人の記憶だけの構成**になり、
   *                    プロジェクトの記憶を引こうとした時点でエラーになる（テスト・
   *                    場所を持たない構成向け。I2: 黙って人の記憶へ落とさない）
   */
  constructor(person: MemoryStore, openProject?: (placeId: string) => MemoryStore) {
    this.person = person;
    this.openProject =
      openProject ??
      ((placeId): MemoryStore => {
        throw new Error(
          `project memory is not configured (asked for "${placeId}"). ` +
            "Pass openProject to ScopedMemory to enable ADR-0003 layer 2."
        );
      });
  }

  /** 人の記憶。 */
  forPerson(): MemoryStore {
    return this.person;
  }

  /**
   * その場所の記憶。同じ場所には同じストアを返す（開き直すと追記の並びがずれる）。
   *
   * I2: 場所の識別子が空のまま呼ばれたら、人の記憶へ黙って落とさずエラーにする——
   *     プロジェクトの記憶が全プロジェクトへ漏れるのが、ADR-0003 が禁じたその事故。
   */
  forProject(placeId: string): MemoryStore {
    if (placeId.trim() === "") {
      throw new Error("project memory requires a place id (ADR-0003: 横断させない)");
    }
    const existing = this.projects.get(placeId);
    if (existing) return existing;
    const store = this.openProject(placeId);
    this.projects.set(placeId, store);
    return store;
  }

  /** `scope` から解決する。`project` には場所が要る。 */
  resolve(scope: MemoryScope, placeId?: string): MemoryStore {
    return scope === "person" ? this.forPerson() : this.forProject(placeId ?? "");
  }
}
