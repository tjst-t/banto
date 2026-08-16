/**
 * 起票（バックログ） — Kobo に積む**前段**の器（prop-0003 採用案C）。
 *
 * **Kobo は「決まった仕事」の器、番頭は「まだ決まっていないこと」の器。** ここに入るのは
 * 改善案・不具合・提案で、プロジェクトも段取りもまだ決まっていない。決まったものだけが
 * `kobo.enqueue` で Kobo の帳簿へ渡る。
 *
 * これが要るのは、いまの起票（`work/inbox/**` の md）が**記録ですらなくメモ**だから
 * ——読むコードがどこにも無いので壊れても誰も困らず、実際に割れている（2026-08-16 調査）：
 * `status` が10種に分裂、id の衝突が3組、決着済みの31%はどの task になったか辿れない。
 * 狙いは4つ：**書いたら残る／重複しない／どこへ行ったか辿れる／機械が読める**。
 *
 * D3: 状態の真実は Store が一箇所で持つ。滞留日数・件数は `createdAt` から導出できるので持たない。
 * I2: 知らない状態語・知らない id は黙って通さず例外にする（10種に割れた原因はここが無かったこと）。
 */

/**
 * 起票の状態。**この4値だけ**。
 *
 * - `open` — まだ何も決まっていない（既定）
 * - `tasked` — task になった（どの task かは {@link BacklogEntry.tasks}）
 * - `dropped` — やらないと決めた（**消さない**。判断の記録として残す）
 * - `done` — 片付いた
 *
 * 既存 md の10種（open/resolved/inbox/backlog/done/fixed/landed/closed/tasked/in-progress/accepted）は
 * 区別する規則が誰にも書けなかったので、移行ではここへ潰す（prop-0003 §5・情報が落ちるのは承知の上）。
 */
export type BacklogStatus = "open" | "tasked" | "dropped" | "done";

/** 状態の4値。検査と、面の絞り込みの並び順に使う。 */
export const BACKLOG_STATUSES: readonly BacklogStatus[] = ["open", "tasked", "dropped", "done"];

/** 起票の種別。`work/inbox/{improvement,incident,proposal}` の3つと同じ。 */
export type BacklogKind = "improvement" | "incident" | "proposal";

/** 種別の3値。 */
export const BACKLOG_KINDS: readonly BacklogKind[] = ["improvement", "incident", "proposal"];

/**
 * **どの task になったか**（追跡不能31%の根治）。
 *
 * `refs` とは**別の欄**にする。いまの追跡不能は「`refs` が関連 id の自由なメモでもあり、
 * どの task になったかの欄でもある」ことが原因で、書式も
 * `task-0102-banto-live` / `dentaku/task-0020` / `dentaku-task-0020` の3通りが混在している。
 * task の id はプロジェクトごとの名前空間（spec-multi-project §2）なので、
 * **projectTag と組でないと一意にならない**。
 */
export interface BacklogTaskRef {
  projectTag: string;
  taskId: string;
}

/**
 * 外部（GitHub Issues 等）での姿。**投影先であって正ではない。**
 *
 * ローカル id 主権を守るための別欄——外部の番号を `id` に入れると、`originRef` も md も
 * 番頭の記憶も provider 依存になり、バックエンドを切り替えた瞬間に過去の参照が全部死ぬ。
 */
export interface BacklogExternal {
  /** `github` など。 */
  provider: string;
  /** 外での id（GitHub なら Issue 番号）。 */
  id: string;
  url?: string;
  /** 最後に外へ送れた（または外から取り込んだ）時刻。ループ防止に `updatedAt` と比べる。 */
  syncedAt?: string;
}

/** 外への送信の状態。**送信の失敗は起票の失敗ではない**ので、起票とは別に持つ。 */
export type BacklogSyncState = "none" | "pending" | "synced" | "failed";

/** 一件の起票。 */
export interface BacklogEntry {
  /**
   * `bl-0001`。**ローカル主権**——外部の番号は絶対にここへ入れず {@link BacklogEntry.external} へ持つ。
   * 採番は Store が持つ（起票を採番するコードが存在しなかったことが、id 衝突3組の原因）。
   */
  id: string;
  kind: BacklogKind;
  title: string;
  /** 本文。短いものはここに置く。 */
  body?: string;
  /** 長い本文・移行してきた md の在り処（リポジトリ相対）。 */
  bodyPath?: string;
  status: BacklogStatus;
  /**
   * 出所。**自由文字列のまま持つ（潰さない）。**
   *
   * spec は system/po/agent の3値を想定していたが、実データは約半分が自由文。
   * ここで3値へ丸めると書いた人の文脈が消えるだけで、誰も得をしない。
   */
  origin?: string;
  /** どのプロジェクトの話か。**決まっていないことが多い**ので省略可（決まらないものは外へ出さない）。 */
  projectTag?: string;
  /** 関連 id の自由なメモ（従来の `refs:` をそのまま受ける）。**`tasks` と混ぜない。** */
  refs?: string[];
  /** どの task になったか。 */
  tasks?: BacklogTaskRef[];
  external?: BacklogExternal;
  /**
   * 冪等キー（クライアント側の一意キー）。
   *
   * 同じキーで二度 `file` を呼んでも起票は1件のまま。外への送信が落ちて再送するときにも、
   * これがあるので二重に立たない。
   */
  clientKey: string;
  syncState?: BacklogSyncState;
  syncError?: string;
  /** ISO8601。 */
  createdAt: string;
  updatedAt: string;
}

/**
 * 新規起票の入力。`createdAt` / `updatedAt` は Store が埋める。
 *
 * **`id` を渡す口はここに無い（型に存在させていない）。** 呼ぶ側——番頭も職人も——は
 * 採番に手を出せない。これは書き忘れではなく、この型そのものが保証である。
 *
 * 理由は事故（2026-08-16、同じ日に id 衝突が6組）。直近の1件はこういう形だった：
 * 番頭が main のチェックアウトへ**未追跡のまま** `imp-0070` を置く → 別ワークツリーの職人からは
 * その未追跡ファイルが見えないので同じ番号が空きに見える → ファイル名の実体は別なので
 * **git の衝突にならず枝は緑のまま通る**。つまり「注意して採番する」でも
 * 「その場のファイルを走査して空き番号を探す」でも止まらない
 * ——**見る場所によって答えが変わる形**が壊れているのであって、注意力の問題ではない。
 *
 * id を名指しできるのは**取り込み経路だけ**（{@link BacklogStore.pull} と、既存 md の移行）。
 * そこは {@link BacklogAdoptInput} という別の口で受け、既存 id と衝突すれば例外にする。
 */
export interface BacklogFileInput {
  kind: BacklogKind;
  title: string;
  body?: string;
  bodyPath?: string;
  /** 省略したら `open`。 */
  status?: BacklogStatus;
  origin?: string;
  projectTag?: string;
  refs?: string[];
  tasks?: BacklogTaskRef[];
  external?: BacklogExternal;
  /**
   * 冪等キー。**省略したら Store が振る**（毎回別の起票として立つ）。
   * 「同じ用件を二度積みたくない」と呼び手が言えるときにだけ付ける。
   */
  clientKey?: string;
  syncState?: BacklogSyncState;
  syncError?: string;
}

/** 書き換えられる欄だけ。`id` / `clientKey` / `createdAt` は変えられない。 */
export interface BacklogPatch {
  title?: string;
  body?: string;
  bodyPath?: string;
  status?: BacklogStatus;
  origin?: string;
  projectTag?: string;
  refs?: string[];
  tasks?: BacklogTaskRef[];
  external?: BacklogExternal;
  syncState?: BacklogSyncState;
  syncError?: string;
}

/** 絞り込み。**導出できる値（滞留日数など）では絞らない**——呼び手が `createdAt` から出す（D3）。 */
export interface BacklogQuery {
  status?: BacklogStatus;
  kind?: BacklogKind;
  projectTag?: string;
}

/**
 * この Store に何ができるか。
 *
 * `pull` / `push` を**呼ぶ前に**ここで確かめる。メソッドが生えているかどうかで判断しないこと
 * ——実装は「持たないことを言葉で断る」ために口だけ生やしていることがある。
 */
export interface BacklogCapabilities {
  /** 外から取り込めるか。ファイル実装は `false`。 */
  pull: boolean;
  /** 外へ送れるか。ファイル実装は `false`。 */
  push: boolean;
}

/** `pull` の結果。取り込んだ件数と、次に渡す `since`。 */
export interface BacklogPullResult {
  /** 取り込み（新規または更新）された起票。 */
  entries: BacklogEntry[];
  /** 次の `pull` に渡す時刻（ISO8601）。 */
  since?: string;
}

/**
 * **取り込み専用**の入力——id を名指しできる唯一の口。
 *
 * 使うのは2つの経路だけ：外で立った Issue を取り込む {@link BacklogStore.pull} と、
 * 既存 `work/inbox/**` の md の移行（prop-0003 段取り3）。どちらも
 * 「**すでに番号が振られているものを台帳へ載せ直す**」であって、新規の採番ではない。
 *
 * 実装が守ること：**既存 id と衝突したら例外**。黙って上書きも、黙って採番し直しもしない
 * （どちらも「書いたのに消える／別物になる」を生む。それが今回の事故の共通項だった）。
 */
export interface BacklogAdoptInput extends BacklogFileInput {
  /** `bl-NNNN`。既に決まっている番号。 */
  id: string;
  /** 分かっているなら元の時刻を持ち込む（移行で「いつ書かれたか」を失わないため）。 */
  createdAt?: string;
  updatedAt?: string;
  /** 取り込みは再実行されうるので、合印は呼び手が決める（省略したら id から作る）。 */
  clientKey?: string;
}

/**
 * 起票の置き場（Seam）。
 *
 * ## 契約（差し替えても崩してはいけない線）
 *
 * > **読みはローカル索引から即答する（ネットワークを待たない）／
 * > 書きはローカルに確定してから外へ送る（外への送信の失敗は起票の失敗ではない）**
 *
 * 差し替えの形は2通りあり、性質がまるで違う（prop-0003 §3）：
 *
 * - (i) Store をそのまま差し替える（GitHub 実装では `list` が API を叩く）
 *   → **番頭の道具呼びがネットワークで失敗しうる**。「気づいた瞬間に1行で置ける」という
 *   この機構の肝が、レート制限とタイムアウトの下に置かれる
 * - (ii) **ローカルが常に真実、外部は投影先**（ファイル実装＋同期アダプタ）
 *
 * **採るのは (ii)。** 上の契約を守る限り、GitHub 実装も必然的に「キャッシュ＋非同期送信」の
 * 形になり、後から足しても設計が崩れない。
 *
 * ## 双方向（人が外でも書き・読む）を見込んで決まっていること
 *
 * `pull` を最初から口に置いてあるのは、PO の狙いが「人が GitHub 側でも書いたり読んだりする」
 * ＝双方向だから。双方向が要ることで、いまの形に織り込んである決まりが4つある：
 *
 * 1. **id 発行のきっかけが2つになる**（`file` と `pull`）。外で作られた Issue は取り込み時に
 *    ローカル id（`bl-NNNN`）を振り、外の番号は `external` に持つ。**ローカル id 主権は維持**
 * 2. **競合は欄ごとに所有者を決める**——表題・本文は「最後に編集した側」（機械が人の文を潰さない）、
 *    状態（4値）と `tasks` は **banto が正**（task 化の事実は Kobo 側にしかない）、
 *    コメントは外（**ローカルには概念を作らない**）
 * 3. **削除は無い**。GitHub の Issue は消せないので、`dropped` は closed＋ラベルへ投影する
 * 4. **状態語彙の変換表は Store 実装側に置く**。GitHub は open/closed しか持たないので
 *    `tasked` / `dropped` はラベル（`banto:tasked`）へ落ちるが、**banto 本体は4値のまま何も知らない**
 *
 * ループ防止は `external.syncedAt` と `updatedAt` の比較＋ `clientKey` で行う
 * （push した変更が pull で戻って再 push されるのを止める）。
 *
 * **実装が1つしかないうちに汎用化しないこと。** GitHub 実装は別枠で、ここに書いてあるのは
 * 「後から足しても移行が要らない」ために最初の形へ入れておく分だけ。
 */
export interface BacklogStore {
  /**
   * 新規起票。**冪等**——同じ `clientKey` で二度呼んでも起票は1件のまま、返る id も同じ。
   *
   * ローカルに確定してから返る。外への送信はこの後（失敗しても起票は成立している）。
   *
   * **採番は Store の専権。** {@link BacklogFileInput} に `id` の口は無く、
   * 実行時に紛れ込ませても通らない（型を迂回されても採番は奪えない）。
   */
  file(input: BacklogFileInput): Promise<BacklogEntry>;

  get(id: string): Promise<BacklogEntry | undefined>;

  /** **ローカル索引から即答する。** ネットワークを待たせないこと。 */
  list(query?: BacklogQuery): Promise<BacklogEntry[]>;

  /** 知らない id は黙って捨てず例外にする（I2）。 */
  update(id: string, patch: BacklogPatch): Promise<BacklogEntry>;

  capabilities(): BacklogCapabilities;

  /**
   * 外から取り込む。**capability**——`capabilities().pull` が `true` のときだけ呼ぶ。
   * 取り込んだものにはローカル id を振り、外の番号は `external` に持つ。
   */
  pull?(since?: string): Promise<BacklogPullResult>;

  /**
   * **取り込み**——id が既に決まっているものを台帳へ載せる（`pull` の実装と、既存 md の移行が使う）。
   *
   * これが `file` と別の口になっているのは、**id を名指しできる経路をここ1つに閉じ込める**ため。
   * 既存 id と衝突したら例外（{@link BacklogAdoptInput}）。
   */
  adopt?(input: BacklogAdoptInput): Promise<BacklogEntry>;
}

/** 状態として通せる値か。**通らないものは黙って捨てず投げる**（I2）。 */
export function assertBacklogStatus(value: unknown, where: string): BacklogStatus {
  if (typeof value === "string" && (BACKLOG_STATUSES as readonly string[]).includes(value)) {
    return value as BacklogStatus;
  }
  throw new Error(
    `${where}: "${String(value)}" は起票の状態ではありません（${BACKLOG_STATUSES.join(" / ")} のどれか）。`
  );
}

/** 種別として通せる値か。 */
export function assertBacklogKind(value: unknown, where: string): BacklogKind {
  if (typeof value === "string" && (BACKLOG_KINDS as readonly string[]).includes(value)) {
    return value as BacklogKind;
  }
  throw new Error(
    `${where}: "${String(value)}" は起票の種別ではありません（${BACKLOG_KINDS.join(" / ")} のどれか）。`
  );
}

/** 番号から `bl-NNNN`（4桁ゼロ埋め、超えたら伸びる）を作る。採番の綴りはここ1箇所。 */
export function formatBacklogId(n: number): string {
  return `bl-${String(n).padStart(4, "0")}`;
}

/** `bl-NNNN` の綴りか。取り込みで持ち込まれる id を検める（I2：知らない綴りを黙って通さない）。 */
export function assertBacklogId(value: unknown, where: string): string {
  if (typeof value === "string" && backlogNumberOf(value) !== null && /^bl-\d{4,}$/.test(value)) {
    return value;
  }
  throw new Error(`${where}: "${String(value)}" は起票の id ではありません（bl-0001 の形）。`);
}

/** `bl-NNNN` の NNNN だけを取る。合わないものは数えない。 */
export function backlogNumberOf(name: string): number | null {
  const m = /^bl-(\d{4,})/.exec(name);
  if (!m || !m[1]) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}
