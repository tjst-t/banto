/**
 * 書き込み許可の要求と承認（ADR-0010 決定38c・e・task-0042）。
 *
 * 番頭は範囲の拡大を**要求できるだけ**で、決めるのは PO、書くのはホスト（決定38c）。
 * 職人が `worker.ask` で番頭に聞き番頭が答える（決定29b）のと同じ構図を1段上に適用したもの。
 *
 * **保存先はホストのデータ置き場**。リポジトリの中に置くと、番頭が宣言を書き換えて自分の
 * 権限を広げられる（決定38b）——`file.write` の砦はデータ置き場を絶対パスで守っているので、
 * ここに置く限り番頭は触れない（I1：ずるを不可能にする）。
 *
 * D3: 許可と要求は導出できない事実なので保存する。場所そのものは保存しない（提供元が返す）。
 * I2: 壊れた保存ファイルを黙って空として扱わない——許可が消えるより、起動が止まる方がよい。
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** 要求の状態。決まったものも消さずに残す（決定38e：何を許してきたかが見えること）。 */
export type PlaceGrantState = "pending" | "approved" | "denied";

export interface PlaceGrantRequest {
  id: string;
  /** どの場所か。`place.list` が返す id。 */
  placeId: string;
  /** 番頭が要求した範囲（glob）。 */
  patterns: string[];
  /** なぜ要りようか。決定38e のとおり、判断の実質は範囲そのものだが記録は残す。 */
  reason: string;
  requestedAt: string;
  state: PlaceGrantState;
  decidedAt?: string;
  /** 実際に許された範囲。PO が要求より狭めた場合、要求とは違う。 */
  grantedPatterns?: string[];
  /** 拒否したときの一言。番頭が次に何をすべきか分かるように。 */
  note?: string;
}

interface GrantsFile {
  version: 1;
  /** 場所 id → 許された範囲。 */
  grants: Record<string, string[]>;
  /**
   * **どの場所でも**許す範囲（決定74）。場所ごとの許可に重ねて効く。
   *
   * 「全部のリポジトリで `docs/**` は書いてよい」のような、場所ごとに決める意味の無い
   * 許可のため。無いと、番頭が新しいリポジトリに触るたびに同じ承認を繰り返すことになり、
   * **POが中身を読まずに押す習慣**がつく——それは決定38e が避けたかったことそのもの。
   */
  global: string[];
  requests: PlaceGrantRequest[];
}

const EMPTY: GrantsFile = { version: 1, grants: {}, global: [], requests: [] };

/**
 * 許可と要求の帳簿。
 *
 * `PlaceRegistry` に渡すと、提供元が返した場所へ**追加の書き込み範囲**として重ねられる。
 * これにより `ghq` が返す読み取り専用のリポジトリにも、後から許可を与えられる。
 */
export class PlaceGrantStore {
  private readonly filePath: string;
  private state: GrantsFile;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.state = this.read();
  }

  /** その場所に許されている範囲。`PlaceRegistry` がここを引く。 */
  writableFor(placeId: string): readonly string[] {
    return this.state.grants[placeId] ?? [];
  }

  /**
   * どの場所でも許されている範囲（決定74）。`PlaceRegistry` が全ての場所に重ねる。
   *
   * **場所ごとの許可と混ぜて返さない**——画面が「これは共通で許した分だ」と言えなくなる。
   * 混ざると、1つの場所から取り消したつもりが他の場所でも消えて驚くことになる。
   */
  globalWritable(): readonly string[] {
    return this.state.global;
  }

  /**
   * 共通の許可を差し替える（決定74）。**足すのではなく置き換える**——
   * 消す手段が無いと、広げすぎたときに戻せない（決定38e の `revoke` と同じ理由）。
   */
  setGlobal(patterns: readonly string[]): string[] {
    this.state.global = normalize(patterns);
    this.write();
    return [...this.state.global];
  }

  /** 許可の全体。GUI に「いま何を許しているか」を出すため（決定38e）。 */
  grants(): Record<string, string[]> {
    return Object.fromEntries(Object.entries(this.state.grants).map(([k, v]) => [k, [...v]]));
  }

  /** 要求の一覧。新しいものが先。 */
  requests(): PlaceGrantRequest[] {
    return [...this.state.requests].reverse();
  }

  /**
   * 番頭からの要求を記録する。**この時点では何も許されない。**
   *
   * 同じ場所・同じ範囲の保留中の要求があれば、それを返す（同じ頼みを積み増さない）。
   */
  request(placeId: string, patterns: readonly string[], reason: string): PlaceGrantRequest {
    const wanted = normalize(patterns);
    if (wanted.length === 0) throw new Error("要求する範囲が空です。");

    const existing = this.state.requests.find(
      (r) => r.state === "pending" && r.placeId === placeId && sameSet(r.patterns, wanted)
    );
    if (existing) return existing;

    const request: PlaceGrantRequest = {
      id: `req-${this.state.requests.length + 1}`,
      placeId,
      patterns: wanted,
      reason,
      requestedAt: new Date().toISOString(),
      state: "pending",
    };
    this.state.requests.push(request);
    this.write();
    return request;
  }

  /**
   * 許可する。PO が範囲を狭めて許すこともできる。
   *
   * I2: 未知の要求・既に決まった要求は黙って通さない。二重承認で範囲が意図せず広がる。
   */
  approve(requestId: string, patterns?: readonly string[]): PlaceGrantRequest {
    const request = this.requirePending(requestId);
    const granted = normalize(patterns ?? request.patterns);
    if (granted.length === 0) throw new Error("許可する範囲が空です。");

    const current = this.state.grants[request.placeId] ?? [];
    this.state.grants[request.placeId] = normalize([...current, ...granted]);
    request.state = "approved";
    request.decidedAt = new Date().toISOString();
    request.grantedPatterns = granted;
    this.write();
    return request;
  }

  /** 拒否する。記録は残す（同じ要求が繰り返されていることが見えるように）。 */
  deny(requestId: string, note?: string): PlaceGrantRequest {
    const request = this.requirePending(requestId);
    request.state = "denied";
    request.decidedAt = new Date().toISOString();
    if (note) request.note = note;
    this.write();
    return request;
  }

  /**
   * 既に与えた許可を取り消す。
   *
   * 決定38e は「じわじわ広がる」ことを機構では防げないとしたが、**戻せること**は要る——
   * 広げすぎたと気づいたときに設定ファイルを手で直すしかないのでは、見えても直せない。
   */
  revoke(placeId: string, pattern: string): void {
    const current = this.state.grants[placeId] ?? [];
    const remaining = current.filter((p) => p !== pattern);
    // I2: 無いものを消したことにしない。取り消したつもりで残っているのが一番危ない
    if (remaining.length === current.length) {
      throw new Error(`場所 "${placeId}" に "${pattern}" は許可されていません。`);
    }
    if (remaining.length === 0) delete this.state.grants[placeId];
    else this.state.grants[placeId] = remaining;
    this.write();
  }

  private requirePending(requestId: string): PlaceGrantRequest {
    const request = this.state.requests.find((r) => r.id === requestId);
    if (!request) throw new Error(`要求 "${requestId}" は存在しません。`);
    if (request.state !== "pending") {
      throw new Error(`要求 "${requestId}" は既に${request.state === "approved" ? "許可" : "拒否"}されています。`);
    }
    return request;
  }

  private read(): GrantsFile {
    if (!fs.existsSync(this.filePath)) return { ...EMPTY, grants: {}, global: [], requests: [] };
    const raw = fs.readFileSync(this.filePath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // I2: 壊れていたら空として扱わない。黙って全部の許可が消えるより止まる方がよい
      throw new Error(`${this.filePath} を読めません（許可の帳簿が壊れています）: ${String(err)}`);
    }
    const file = parsed as Partial<GrantsFile>;
    return {
      version: 1,
      grants: file.grants ?? {},
      // 共通の許可を知らない頃の帳簿は `global` を持たない。無いことは「何も共通で許していない」
      global: Array.isArray(file.global) ? file.global : [],
      requests: Array.isArray(file.requests) ? file.requests : [],
    };
  }

  private write(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, "utf-8");
  }
}

/** 重複を除いて順序を保つ。 */
function normalize(patterns: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (pattern.length === 0 || seen.has(pattern)) continue;
    seen.add(pattern);
    out.push(pattern);
  }
  return out;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}
