/**
 * 会話は**幹と枝**（ADR-0017 決定77。旧: 並列のスレッド＝ADR-0010 決定2）。
 *
 * - **幹はプロジェクトに1本で、永続。畳まない。** 会話のタブは作らない
 *   ——**幹がプロジェクトの単位そのもの**（PO裁定 2026-08-09）。プロジェクトの帳簿を
 *   別に持たない（D3）ので、幹が何本あるかがプロジェクトが何個あるかになる。
 *   画面のレールに並ぶのはこの幹（見本 `13-tsuzukima-kai.html` のプロジェクト列）
 * - **枝は「還す条件」を持って生まれる。** 何が決まれば幹に還るかを書けないものは
 *   枝にしない（幹で話す）——ここが Slack との分岐点そのもの
 * - **深さは1段。** 枝の中に枝を作らない。埋没は深さに対して指数的に効く
 * - **枝を畳むと結論1行が幹に還る。** 幹は追記のみ（D3）
 *
 * `docs/vision.md` の「番頭は分身する。関心事ごとにインスタンスへ分かれて並行し…
 * 割り込みが PO の文脈を壊さない」の機構は残る——分身の**単位が枝になった**だけ。
 * **スレッド1本につきキャンバス1つ**を持つ（決定2）ので、面を「どこから開いたか」は
 * その面がどちらのキャンバスに載っているかで表される（決定79）。
 *
 * 記憶は**スレッドを越えて共有される**。ここでは持たない——D11「番頭は記憶を持つ」は
 * スレッド単位ではなく番頭単位で、スレッドごとに記憶を作ると番頭が分裂する。
 *
 * D5: 判断は無い。会話の帳簿と、1本分の会話の器だけ。
 */

import type { Canvas } from "./canvas.js";
import type { HostSession } from "./server.js";
import type { NamespacedToolDefinition } from "./tool-registry.js";
import type { BranchOpener, ThreadView, TranscriptEntry } from "./protocol.js";
import type { ThreadStore } from "./thread-store.js";

/**
 * その会話が**何であるか**（PO報告 2026-08-10）。
 *
 * **番頭に渡す。** 帳場に居るのか、あるプロジェクトの幹に居るのか、どの幹の枝に居るのかは
 * 会話ごとに違い、話し方が変わる——実際、帳場を「banto 開発の幹」と取り違えていた。
 * `thread.list` で毎ターン確かめさせるのは高くつくので、器を作るときに一度渡す。
 *
 * ここに入るのは**後から変わらないもの**だけ。題は変わりうるので「開いたときの名前」
 * として扱う（`thread.rename` の結果は画面と帳簿が持つ・D3）。
 */
export interface ThreadIdentity {
  kind: "trunk" | "branch";
  /**
   * **記憶の区画**（PO裁定 2026-08-10）。幹なら自分、枝なら親の幹。
   *
   * 記憶が分かれる単位を場所（リポジトリ）から幹へ移した——複数のリポジトリにまたがる
   * 仕事も、まだリポジトリの無い相談も、幹1本として1つの区画を持てる。枝は親の幹と
   * 同じ区画（同じ仕事の中の往復なので、分ける意味がない）。
   */
  trunkId: string;
  /** 帳場（メインの幹）か。どの幹の話でもないものの受け皿。 */
  isMain: boolean;
  title: string;
  /** 枝の還す条件（あれば）。 */
  returnCondition?: string;
  /** 枝のとき、親の幹の名前。 */
  parentTitle?: string;
}

/** 1本分の器を組み立てる。呼ぶたびに**新しい対話ループとキャンバス**を作ること。 */
export type ThreadFactory = (
  threadId: string,
  /**
   * 復元するときに渡る、そのスレッドの pi セッションファイル（task-0036）。
   * これを開き直さないと、画面には会話が戻るのに**番頭は何も覚えていない**状態になる。
   */
  resumeFrom?: string,
  /**
   * この会話で使いたいモデル。**復元では保存されていたもの**、新規では省略（＝番頭の標準）。
   * 会話ごとにモデルを持つため、器を作る側がここを見て組み立てる。
   */
  model?: { provider: string; id: string },
  /** その会話が何であるか（帳場・幹・枝）。器を作る側がシステムプロンプトへ入れる。 */
  identity?: ThreadIdentity
) => Promise<{
  session: HostSession;
  canvas?: Canvas;
  /** この器が実際に使っているモデル。会話ごとに持ち、画面と索引へ出す。 */
  model?: { provider: string; id: string; vision: boolean; contextWindow?: number };
  /** このスレッドに登録した論理名のTool（wire名の逆引きに使う）。 */
  tools: NamespacedToolDefinition[];
  /** 直近のターンでプロバイダ側エラーがあれば返す。**スレッドごと**に別。 */
  getLastError?: () => string | undefined;
  /** この器が書き出している pi セッションファイル。次回の復元に使う（task-0036）。 */
  sessionFile?: string;
  /**
   * 復元されたセッションが「ツール結果で終わっていた」（＝ツール結果後の継続応答が
   * 生成されずに中断。imp-0016 主対策）とき、ターンを再開する処理。
   * **サーバが購読を張ってから**呼ばれる——配信が始まってから再開するため。
   */
  resumePendingTurn?: () => Promise<void>;
  /**
   * **いま章を畳む**（提案§3.2 の人側）。閾値に達していなくても畳む。
   *
   * 章立てが働いていない構成（要約に使えるモデルが無い）では渡らない——
   * その場合は「畳めません」と理由を出す（I2：黙って何も起きないのが一番困る）。
   *
   * **畳んだかどうかを返す。** まだ何も溜まっていない章は畳みようがなく、以前は
   * 黙って何も起きなかった（PO報告 2026-08-11）——押した側からは壊れて見える。
   */
  closeChapter?: () => Promise<boolean>;
  /**
   * 対話ループの後始末。スレッドを閉じるとき・ホストを終うときに呼ばれる。
   *
   * `HostSession`（server が要求する最小契約）には入れない——配信に要るものではなく、
   * 器を作った側が知っている後始末だから（ハーネスを差し替えても server は無変更・決定3）。
   */
  dispose?: () => void;
}>;

/** 幹の名前。**プロジェクトに1本で、畳まない**（決定77）。 */
const TRUNK_TITLE = "幹";

/**
 * 帳場（メインの幹）の名前。**店の帳場**——番頭が座っていて、どの用件もまずここへ来る。
 * 名前は付け直せる（`thread.rename`）。
 */
const MAIN_TITLE = "帳場";

/**
 * 会話を開くときの姿（ADR-0017 決定77）。
 *
 * **枝に親は書けない。** 親は常に幹（深さ1段）なので欄そのものを持たせない——
 * 型として書けないことが、深さ1段の1つ目の縛りになる。2つ目は実行時（`open` が
 * 枝からの枝を拒む）。
 *
 * **`returnCondition` と `reason` は必須の欄**——「書けないなら枝にしない」を
 * 呼び出し側の心がけではなく機構にする。
 */
export type ThreadSpec =
  | {
      kind: "trunk";
      title?: string;
      /**
       * **帳場**（メインの幹。PO裁定 2026-08-10）。店にただ1つ、消せない。
       *
       * どの幹の話でもないもの——宛先の決まらない知らせ、まだ幹になっていない相談——は
       * ここへ来る。**新しい幹はここから生まれる**ので、帳場が無いと店が始まらない。
       */
      main?: boolean;
    }
  | {
      kind: "branch";
      title: string;
      /** 還す条件。何が決まれば幹に還るか。 */
      returnCondition: string;
      /** 番頭の判断か、POの指示か。 */
      openedBy: BranchOpener;
      /** 開いた理由。札に必ず出す。 */
      reason: string;
    };

/**
 * 枝が滞留したと見なすまでの日数。
 *
 * **黙って止まった枝は機構の異常**として扱う（決定77・P6・ADR-0016）。忘れられた枝を
 * 人の記憶に頼らせないため、これを超えたら取次へ積む。
 */
export const BRANCH_STALE_DAYS = 3;

/**
 * 題の長さの上限。**切り詰めるだけで拒まない**——名前が長いのは会話を止める理由にならない。
 * タブは1行に収まる幅しか無く（`ThreadTabs`）、長い題は省略記号で消えて読めなくなる。
 */
export const MAX_THREAD_TITLE_LENGTH = 40;

/**
 * 題を整える。前後の空白と改行を落とし、長すぎるものは切り詰める。
 * 空になるものは題として使えない（I2: 黙って既定名に落とさず、呼び出し側でエラーにする）。
 */
export function normalizeThreadTitle(title: string): string | undefined {
  const flattened = title.replace(/\s+/gu, " ").trim();
  if (flattened === "") return undefined;
  return flattened.length > MAX_THREAD_TITLE_LENGTH
    ? flattened.slice(0, MAX_THREAD_TITLE_LENGTH)
    : flattened;
}

/**
 * 会話スレッド1本。
 *
 * トランスクリプトと知らせの鎖を**スレッドごとに持つ**のが要点——ここを共有すると、
 * 職人からの報告が関係ないスレッドの会話に現れる（決定35a）。
 */
export class Thread {
  readonly id: string;
  title: string;
  /** 幹か枝か（決定77）。生まれたあと変わらない。 */
  readonly kind: "trunk" | "branch";
  /**
   * **帳場**（メインの幹。PO裁定 2026-08-10）。店にただ1つで、終えない。
   * 宛先の決まらない知らせはここへ来る（`resolve(undefined)`）。
   */
  readonly isMain: boolean;
  /** 枝の親。**常に幹**（深さ1段）。幹には無い。 */
  readonly parentId: string | undefined;
  /** 還す条件。**枝には必ずある**——書けないものは枝にしない（決定77）。 */
  readonly returnCondition: string | undefined;
  /** 誰が開いたか（番頭の判断か、POの指示か）。 */
  readonly openedBy: BranchOpener | undefined;
  /** 開いた理由。札に出す。 */
  readonly openReason: string | undefined;
  /**
   * 畳んだときの結論（決定77）。**保留も結論の一種**として「保留：理由」で畳める。
   * 開き直すと消えない——幹に還した1行は記録なので、そのまま残る。
   */
  conclusion: string | undefined;
  /**
   * 畳んだスレッドは**消えない**（Worker Pool の決定30c と同じ発想）。
   * 一覧から外れるだけで、履歴として読めるし同じ会話のまま再開できる。
   */
  state: "open" | "closed" = "open";
  /** 開いた時刻。保存した会話を並べるのに要る（task-0036）。 */
  readonly createdAt: string = new Date().toISOString();
  /**
   * 最後に何かが記録された時刻。**滞留の検出に使う**（決定77）。
   *
   * D3: 記録から導出できるので保存しない——読み戻したときは開いた時刻から数え直す
   * （記録の1行1行に時刻が無いため。ここは「止まっている枝を見つける」用途で、
   * 正確な最終発話時刻が要る場面ではない）。
   */
  lastActivityAt: string = new Date().toISOString();
  closedAt: string | undefined;
  readonly session: HostSession;
  readonly canvas: Canvas | undefined;
  readonly toolNames: string[];
  /**
   * `threadId` 省略時の宛先か。**固定ではない**——開いている先頭が担う（PO要望
   * 2026-07-31：どの会話も畳めるようにした帰結）。帳簿が開閉のたびに付け替える。
   */
  isDefault = false;
  readonly getLastError: () => string | undefined;
  /** 番頭の文脈が書かれている pi セッションファイル（task-0036）。 */
  readonly sessionFile: string | undefined;
  /**
   * この会話で使っているモデル（PO裁定 2026-08-04）。
   *
   * **会話ごとに持つ**——話題ごとに向いたモデルが違うので、切り替えても他の会話は変わらない。
   * 索引に保存され、再起動しても同じモデルで再開する。
   */
  model: { provider: string; id: string; vision: boolean; contextWindow?: number } | undefined;
  /**
   * 復元された中断ターンを再開する処理（imp-0016 主対策）。
   * サーバ起動後に open スレッドだけ呼ばれる（畳んだスレッドは開き直すまで話さない）。
   */
  readonly resumePendingTurn: (() => Promise<void>) | undefined;
  /**
   * **いま章を畳む**（提案§3.2 の人側）。章立てが働いていない会話では `undefined`。
   * サーバはこれが無いことを「畳めない理由」としてそのまま PO に出す（I2）。
   */
  readonly closeChapter: (() => Promise<boolean>) | undefined;
  /** 会話の真実。接続時にまとめて配り、以後は差分イベントで追随させる（D3）。 */
  transcript: TranscriptEntry[] = [];
  /**
   * 知らせを1本ずつ順に流すための鎖。**スレッドごと**に持つ。
   * 職人が同時に複数報告してきても、そのスレッドのターンは1本ずつ進む。
   */
  notices: Promise<void> = Promise.resolve();
  /** 購読解除と後始末。閉じるときに呼ぶ。 */
  readonly disposers: Array<() => void> = [];
  /**
   * 記録が変わったときに呼ばれる（task-0036）。帳簿が保存に使う。
   *
   * **`record` の中から1箇所で拾う。** 呼び出し側は9箇所あり、増えもする——
   * そちらに保存を書くと、新しい経路を足した人が忘れる。
   */
  onRecord: (() => void) | undefined;

  constructor(params: {
    id: string;
    title: string;
    kind: "trunk" | "branch";
    isMain?: boolean;
    parentId?: string;
    returnCondition?: string;
    openedBy?: BranchOpener;
    openReason?: string;
    conclusion?: string;
    session: HostSession;
    canvas?: Canvas;
    tools: NamespacedToolDefinition[];
    getLastError?: () => string | undefined;
    sessionFile?: string;
    model?: { provider: string; id: string; vision: boolean; contextWindow?: number };
    resumePendingTurn?: () => Promise<void>;
    closeChapter?: () => Promise<boolean>;
    dispose?: () => void;
  }) {
    this.id = params.id;
    this.title = params.title;
    this.kind = params.kind;
    this.isMain = params.isMain === true;
    this.parentId = params.parentId;
    this.returnCondition = params.returnCondition;
    this.openedBy = params.openedBy;
    this.openReason = params.openReason;
    this.conclusion = params.conclusion;
    // I2: 枝に還す条件と親が無いのは帳簿の壊れ。黙って幹のように振る舞わせない
    if (params.kind === "branch" && (!params.parentId || !params.returnCondition)) {
      throw new Error(`枝 ${params.id} に親か還す条件がありません（決定77）`);
    }
    this.session = params.session;
    this.canvas = params.canvas;
    this.toolNames = params.tools.map((t) => t.name);
    this.getLastError = params.getLastError ?? ((): string | undefined => undefined);
    this.sessionFile = params.sessionFile;
    this.model = params.model;
    this.resumePendingTurn = params.resumePendingTurn;
    this.closeChapter = params.closeChapter;
    if (params.dispose) this.disposers.push(params.dispose);
  }

  view(): ThreadView {
    return {
      threadId: this.id,
      title: this.title,
      kind: this.kind,
      ...(this.isMain ? { isMain: true } : {}),
      ...(this.parentId ? { parentId: this.parentId } : {}),
      ...(this.returnCondition ? { returnCondition: this.returnCondition } : {}),
      ...(this.openedBy ? { openedBy: this.openedBy } : {}),
      ...(this.openReason ? { openReason: this.openReason } : {}),
      ...(this.conclusion ? { conclusion: this.conclusion } : {}),
      sessionId: this.session.sessionId,
      isDefault: this.isDefault,
      state: this.state,
      // D3: 忙しさの真実はここ。UI は自分の操作から推測しない
      streaming: this.session.isStreaming,
      ...(this.closedAt ? { closedAt: this.closedAt } : {}),
      ...(this.model ? { model: this.model } : {}),
      ...(this.preview() ? { preview: this.preview() } : {}),
    };
  }

  /**
   * 中身が分かる最初の発話の1行。履歴一覧がこれだけで描けるようにする
   * （全文は移った先で取りに来る）。
   */
  private preview(): string | undefined {
    const first = this.transcript.find(
      (e): e is typeof e & { text: string } =>
        (e.role === "po" || e.role === "banto") && "text" in e
    );
    if (!first) return undefined;
    const line = first.text.split("\n").find((l) => l.trim().length > 0);
    if (!line) return undefined;
    return line.length > 60 ? `${line.slice(0, 60)}…` : line;
  }

  /**
   * 履歴に1行足す。テキスト差分は直前の番頭発話へ連結し、Tool終了は対応する
   * 実行中の行を更新する——クライアント側の描画と同じ形に揃えておくことで、
   * 再接続時に history をそのまま描けば会話が復元される。
   */
  record(entry: TranscriptEntry): void {
    this.recordInner(entry);
    this.lastActivityAt = new Date().toISOString();
    this.onRecord?.();
  }

  private recordInner(entry: TranscriptEntry): void {
    const last = this.transcript[this.transcript.length - 1];
    if (entry.role === "banto" && last?.role === "banto") {
      this.transcript[this.transcript.length - 1] = { role: "banto", text: last.text + entry.text };
      return;
    }
    // 思考も差分で届く。**考えていた時間は後から来る**ので、既に入っていれば消さない
    if (entry.role === "reasoning" && last?.role === "reasoning") {
      const durationMs = entry.durationMs ?? last.durationMs;
      this.transcript[this.transcript.length - 1] = {
        role: "reasoning",
        text: last.text + entry.text,
        ...(durationMs !== undefined ? { durationMs } : {}),
      };
      return;
    }
    if (entry.role === "tool" && entry.state !== "running") {
      const index = this.transcript.findIndex(
        (e) => e.role === "tool" && e.name === entry.name && e.state === "running"
      );
      const running = index === -1 ? undefined : this.transcript[index];
      if (index !== -1) {
        // 引数は開始のときにしか来ない。終わりで上書きすると、開いても何を渡したか分からなくなる
        const input =
          entry.input ?? (running?.role === "tool" ? running.input : undefined);
        this.transcript[index] = { ...entry, ...(input !== undefined ? { input } : {}) };
        return;
      }
    }
    this.transcript.push(entry);
  }

  dispose(): void {
    for (const off of this.disposers) off();
    this.disposers.length = 0;
  }
}

/** スレッドの帳簿。開閉の通知だけを外へ出す。 */
/** 保存を間引く間隔。長くすると落ちたときの取りこぼしが増える。 */
const SAVE_DELAY_MS = 400;

export class ThreadRegistry {
  private readonly threads = new Map<string, Thread>();
  private readonly factory: ThreadFactory;
  private readonly listeners = new Set<(threads: Thread[]) => void>();
  private counter = 0;
  /** 会話の保存先（task-0036）。渡さないと再起動で消える（テストはそれでよい）。 */
  private readonly store: ThreadStore | undefined;
  private readonly pendingSaves = new Map<string, NodeJS.Timeout>();

  constructor(factory: ThreadFactory, store?: ThreadStore) {
    this.factory = factory;
    this.store = store;
    if (store) this.counter = store.counter();
  }

  /**
   * 保存されている会話を開き直す（task-0036）。
   *
   * **番頭の文脈も一緒に戻す**——記録（画面に見えていたもの）と pi のセッションファイル
   * （番頭が覚えている中身）は別物なので、両方を紐づけて復元する。片方だけだと
   * 「画面には会話があるのに番頭は覚えていない」か、その逆になる。
   *
   * I2: 1本の復元に失敗しても他は開く。ただし黙らせない——会話が1本消えたことに
   *     気づけないのが一番困る。
   */
  async restore(): Promise<void> {
    if (!this.store) return;
    const stored = this.store.threads();
    /**
     * 幹を先に読む——枝は親を指すので、順序が逆だと親が居ない。
     *
     * **古い索引（幹と枝より前）は、1本残らず幹として読み戻す**（PO裁定 2026-08-09）。
     * 幹がプロジェクトの単位なので、並んでいた会話はそれぞれ独立した話であって、
     * どれかの枝ではない——**還す条件を後から捏造しない**（決定77：書けないものは枝に
     * しない）。開いていた／畳んでいたはそのまま残す。
     */
    const ordered = [...stored].sort(
      (a, b) => (a.kind === "branch" ? 1 : 0) - (b.kind === "branch" ? 1 : 0)
    );
    for (const saved of ordered) {
      try {
        const savedKind = saved.kind ?? "trunk";
        const parts = await this.factory(saved.id, saved.sessionFile, saved.model, {
          kind: savedKind,
          isMain: saved.isMain === true,
          trunkId: savedKind === "trunk" ? saved.id : (saved.parentId ?? saved.id),
          title: saved.title,
          ...(saved.returnCondition ? { returnCondition: saved.returnCondition } : {}),
          ...(saved.parentId
            ? { parentTitle: this.threads.get(saved.parentId)?.title ?? saved.parentId }
            : {}),
        });
        // 古い索引には kind が無い。**1本残らず幹として読み戻す**（上の注記）。
        // 還す条件の無い枝は帳簿として成り立たない（決定77）——遡って書けない以上、
        // 枝にはしない
        const kind = savedKind;
        const thread = new Thread({
          id: saved.id,
          title: saved.title,
          kind,
          ...(saved.isMain ? { isMain: true } : {}),
          ...(kind === "branch"
            ? {
                ...(saved.parentId ? { parentId: saved.parentId } : {}),
                ...(saved.returnCondition ? { returnCondition: saved.returnCondition } : {}),
                ...(saved.openedBy ? { openedBy: saved.openedBy } : {}),
                ...(saved.openReason ? { openReason: saved.openReason } : {}),
              }
            : {}),
          ...(saved.conclusion ? { conclusion: saved.conclusion } : {}),
          session: parts.session,
          ...(parts.model ? { model: parts.model } : {}),
          ...(parts.canvas ? { canvas: parts.canvas } : {}),
          tools: parts.tools,
          ...(parts.getLastError ? { getLastError: parts.getLastError } : {}),
          ...(parts.sessionFile ? { sessionFile: parts.sessionFile } : {}),
          ...(parts.resumePendingTurn ? { resumePendingTurn: parts.resumePendingTurn } : {}),
      ...(parts.closeChapter ? { closeChapter: parts.closeChapter } : {}),
          ...(parts.closeChapter ? { closeChapter: parts.closeChapter } : {}),
          ...(parts.dispose ? { dispose: parts.dispose } : {}),
        });
        thread.transcript = this.store.transcript(saved.id);
        // 畳んでいたものは畳んだまま戻す（幹も枝も。履歴で読める）。**帳場は除く**
        if (saved.state === "closed" && !thread.isMain) {
          thread.state = "closed";
          if (saved.closedAt) thread.closedAt = saved.closedAt;
        }
        // 畳んでいた面も戻す（決定2：キャンバスはスレッドごと）
        if (thread.canvas && saved.state === "open") {
          for (const tab of saved.canvasTabs ?? []) {
            try {
              thread.canvas.open(tab.kind, tab.params, tab.title);
            } catch {
              // 提供元のモジュールが居なくなっていることはある。会話は開く
            }
          }
        }
        this.attach(thread);
        this.threads.set(saved.id, thread);
      } catch (err) {
        console.error(`[banto] 会話 ${saved.id} を開き直せませんでした: ${String(err)}`);
      }
    }
    this.refreshDefault();
    this.repairTrunkCards();
    this.emit();
  }

  /**
   * 幹に札の無い枝へ、札を立て直す（決定77 の不変条件）。
   *
   * > 開いている枝は、必ず ①幹の札 ②横断の通知 ③レールの点 のどれかに出ている。
   *
   * **読み戻したときだけ効く。** 新しく開いた枝は `open` が札を立てるので、ここを通るのは
   * 幹と枝より前の会話だけ——遡って立てられない以上、いま末尾に立てる。幹は追記のみ（D3）
   * なので、過去の位置には差し込まない。
   */
  private repairTrunkCards(): void {
    let repaired = 0;
    for (const trunk of this.trunks()) {
      const carded = new Set(
        trunk.transcript
          .filter((e): e is Extract<TranscriptEntry, { role: "branch" }> => e.role === "branch")
          .map((e) => e.branchId)
      );
      const missing = this.list({ state: "open", kind: "branch" }).filter(
        (b) => b.parentId === trunk.id && !carded.has(b.id)
      );
      if (missing.length === 0) continue;
      for (const branch of missing) trunk.record({ role: "branch", branchId: branch.id });
      repaired += missing.length;
      this.flush(trunk);
    }
    // I2: 黙って直さない。何本立て直したかはログに出す（次の起動で 0 になるはず）
    if (repaired > 0) {
      console.log(`[banto] 幹に札の無い枝 ${repaired} 本に札を立てました（決定77）`);
    }
  }

  /** 記録とキャンバスの変更を保存に繋ぐ。 */
  private attach(thread: Thread): void {
    if (!this.store) return;
    thread.onRecord = () => this.persist(thread);
    // 開いている面もスレッドの状態（決定2）。開き直したときに戻す
    if (thread.canvas) {
      thread.disposers.push(thread.canvas.subscribe(() => this.persistIndex(thread)));
    }
  }

  /**
   * 会話の記録を保存先へ書き戻す。
   *
   * **間引く。** 発話は1文字ずつ `record` に来るので、毎回書くとトークンごとに
   * ファイルを丸ごと書き直すことになる。少し遅れて1回だけ書く。
   */
  persist(thread: Thread): void {
    if (!this.store) return;
    if (this.pendingSaves.has(thread.id)) return;
    const timer = setTimeout(() => {
      this.pendingSaves.delete(thread.id);
      this.flush(thread);
    }, SAVE_DELAY_MS);
    timer.unref?.();
    this.pendingSaves.set(thread.id, timer);
  }

  /** 間引かずに今すぐ書く。畳むとき・終うときに使う（落ちる直前の取りこぼしを防ぐ）。 */
  flush(thread: Thread): void {
    if (!this.store) return;
    const pending = this.pendingSaves.get(thread.id);
    if (pending) {
      clearTimeout(pending);
      this.pendingSaves.delete(thread.id);
    }
    this.store.replace(thread.id, thread.transcript);
    this.persistIndex(thread);
  }

  /** 全スレッドを今すぐ書く。ホストを終うときに呼ぶ。 */
  flushAll(): void {
    for (const thread of this.threads.values()) this.flush(thread);
  }

  /** 索引（題・状態・セッションファイル・開いている面）を書き戻す。 */
  persistIndex(thread: Thread): void {
    if (!this.store) return;
    this.store.upsert({
      id: thread.id,
      title: thread.title,
      kind: thread.kind,
      ...(thread.isMain ? { isMain: true } : {}),
      ...(thread.parentId ? { parentId: thread.parentId } : {}),
      ...(thread.returnCondition ? { returnCondition: thread.returnCondition } : {}),
      ...(thread.openedBy ? { openedBy: thread.openedBy } : {}),
      ...(thread.openReason ? { openReason: thread.openReason } : {}),
      ...(thread.conclusion ? { conclusion: thread.conclusion } : {}),
      state: thread.state,
      createdAt: thread.createdAt,
      ...(thread.closedAt ? { closedAt: thread.closedAt } : {}),
      ...(thread.sessionFile ? { sessionFile: thread.sessionFile } : {}),
      ...(thread.model ? { model: { provider: thread.model.provider, id: thread.model.id } } : {}),
      ...(thread.canvas
        ? {
            canvasTabs: thread.canvas
              .snapshot()
              .tabs.map((t) => ({ kind: t.kind, params: t.params, ...(t.title ? { title: t.title } : {}) })),
          }
        : {}),
    });
  }

  /**
   * 幹を開く、または枝を生やす（ADR-0017 決定77）。
   * **既存の幹・枝には何も起きない**（決定2「目の前の話は壊れない」）。
   *
   * 深さ1段は**2つの縛り**で守る：
   * 1. **型** — `ThreadSpec` に親の欄が無い。親は常に幹なので書きようがない
   * 2. **実行時** — `from` が枝なら拒む。枝が別の枝を要するなら、畳んで幹へ還してから開き直す
   *
   * 枝を開くと**幹の末尾に札が1行積まれる**——「どこにも出ていない枝は作れない」
   * （決定77 の不変条件）を、心がけではなく機構にする。
   *
   * @param from 誰から開いたか（枝のとき必須）。枝からは開けない
   */
  async open(spec: ThreadSpec, from?: string): Promise<Thread> {
    /**
     * 枝の親になる幹。**「いま居る会話の幹」**を指す（PO裁定 2026-08-09）——
     * 幹が複数あるので「その幹」を決めずに枝は開けない。`from` を省いたら既定の幹。
     */
    if (spec.kind === "trunk" && spec.main === true && this.main()) {
      // I2: 帳場は店にただ1つ。2つ目を黙って作らない
      throw new Error("帳場は既にあります（店にただ1つ・PO裁定 2026-08-10）");
    }
    let parentTrunk: Thread | undefined;
    if (spec.kind === "branch") {
      const from_ = from === undefined ? undefined : this.threads.get(from);
      if (from !== undefined && !from_) throw new Error(`unknown thread: ${from}`);
      // 実行時の縛り。**深さ1段**（決定77）——埋没は深さに対して指数的に効く
      if (from_?.kind === "branch") {
        throw new Error(
          "枝の中に枝は開けません（深さは1段・決定77）。" +
            "この枝を畳んで幹へ還してから開き直してください"
        );
      }
      parentTrunk = from_ ?? this.trunk();
      if (!parentTrunk) throw new Error("幹がありません。先に幹を開いてください");
    }

    const id = `thread-${++this.counter}`;
    const wantedTitleEarly = normalizeThreadTitle(
      spec.kind === "trunk" ? (spec.title ?? "") : spec.title
    );
    const title =
      wantedTitleEarly ??
      (spec.kind === "trunk"
        ? spec.main === true
          ? MAIN_TITLE
          : TRUNK_TITLE
        : `枝 ${this.counter}`);
    const parts = await this.factory(id, undefined, undefined, {
      kind: spec.kind,
      isMain: spec.kind === "trunk" && spec.main === true,
      // 記憶の区画は幹。枝は親の幹と同じ区画を使う
      trunkId: spec.kind === "trunk" ? id : parentTrunk!.id,
      title,
      ...(spec.kind === "branch" ? { returnCondition: spec.returnCondition } : {}),
      ...(parentTrunk ? { parentTitle: parentTrunk.title } : {}),
    });
    const wantedTitle = normalizeThreadTitle(spec.kind === "trunk" ? (spec.title ?? "") : spec.title);
    const thread = new Thread({
      id,
      title,
      kind: spec.kind,
      ...(spec.kind === "trunk" && spec.main === true ? { isMain: true } : {}),
      ...(spec.kind === "branch"
        ? {
            parentId: parentTrunk!.id,
            returnCondition: spec.returnCondition,
            openedBy: spec.openedBy,
            openReason: spec.reason,
          }
        : {}),
      session: parts.session,
      ...(parts.model ? { model: parts.model } : {}),
      ...(parts.canvas ? { canvas: parts.canvas } : {}),
      tools: parts.tools,
      ...(parts.getLastError ? { getLastError: parts.getLastError } : {}),
      ...(parts.sessionFile ? { sessionFile: parts.sessionFile } : {}),
      ...(parts.resumePendingTurn ? { resumePendingTurn: parts.resumePendingTurn } : {}),
      ...(parts.closeChapter ? { closeChapter: parts.closeChapter } : {}),
      ...(parts.dispose ? { dispose: parts.dispose } : {}),
    });
    this.attach(thread);
    this.threads.set(id, thread);
    this.refreshDefault();
    this.persistIndex(thread);
    // 幹の札。**開いた1行**だけを幹に流す（枝の中身は流さない・決定77）
    if (thread.kind === "branch" && parentTrunk) {
      parentTrunk.record({ role: "branch", branchId: thread.id });
      this.onTrunkCard?.(parentTrunk, thread);
    }
    this.emit();
    return thread;
  }

  /**
   * **帳場**（メインの幹）。店にただ1つで、終えない（PO裁定 2026-08-10）。
   *
   * `threadId` 省略時の宛先はここ——**どの幹の話でもない知らせ**（孤児の検証環境・
   * 職人の報告で宛先が決まらないもの）が、たまたま先頭にあった幹へ流れ込むのを防ぐ。
   */
  main(): Thread | undefined {
    for (const thread of this.threads.values()) if (thread.isMain) return thread;
    return undefined;
  }

  /**
   * 既定の幹（`threadId` 省略時の宛先）。**帳場**が居ればそこ。
   * まだ無いときだけ開いている先頭で代用する（起動直後の一瞬）。
   */
  trunk(): Thread | undefined {
    return this.main() ?? this.list({ state: "open", kind: "trunk" })[0];
  }

  /**
   * 幹の一覧（＝プロジェクトの一覧。PO裁定 2026-08-09）。
   *
   * **プロジェクトの帳簿を別に持たない**（D3）——幹がプロジェクトの単位そのものなので、
   * ここが画面のレールに並ぶ列になる。畳んだ幹（読み戻した過去の会話）は履歴へ。
   */
  trunks(filter: { state?: "open" | "closed" } = {}): Thread[] {
    return this.list({ ...filter, kind: "trunk" });
  }

  /**
   * `threadId` 省略時の宛先は**常に幹**（決定77）。
   * 幹は畳まないので、宛先が無くなることはない。
   */
  private refreshDefault(): void {
    const trunk = this.trunk();
    for (const thread of this.threads.values()) thread.isDefault = thread === trunk;
  }

  /**
   * 枝を畳んで幹へ還す（決定77）。**消さない**——会話もキャンバスもそのまま残り、
   * 履歴として読めるし `reopen` で続きから話せる（決定30c と同じ扱い）。
   *
   * **幹の末尾に結論が1行積まれる。既存の行は書き換わらない**（幹は追記のみ・D3）。
   * 出口は「結論」であって「実装」ではない——incident を起票し task を積んだ時点で畳む。
   * **保留も結論の一種**として「保留：理由」で畳み、開き直せる。
   *
   * I2: 幹・未知のID・空の結論は黙って成功にせずエラーにする。
   */
  merge(threadId: string, conclusion: string, now = new Date()): Thread {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`unknown thread: ${threadId}`);
    if (thread.kind === "trunk") {
      throw new Error("幹は畳めません（幹は永続・決定77）");
    }
    const text = conclusion.replace(/\s+/gu, " ").trim();
    if (text === "") throw new Error("結論は空にできません（保留なら「保留：理由」と書く）");
    if (thread.state === "closed" && thread.conclusion === text) return thread; // 冪等
    thread.conclusion = text;
    thread.state = "closed";
    thread.closedAt = now.toISOString();
    /**
     * 還す先は**その枝の親**（PO報告 2026-08-11）。
     *
     * 既定の幹（＝帳場）へ還していたので、banto 開発の幹で開いた枝の結論が帳場に出た
     * ——札は親に立つ（`open`）のに結論は別の幹へ行くので、幹が読める帯にならない。
     * **札と結論は同じ幹に並ぶ**のが決定77の形。
     */
    const trunk = thread.parentId ? this.threads.get(thread.parentId) : undefined;
    // I2: 親を引けないのは帳簿の壊れ。黙って帳場へ落とすと、また別の幹に結論が紛れ込む
    if (!trunk) {
      console.error(
        `[banto] 枝 ${thread.id} の親（${thread.parentId ?? "なし"}）を引けず、結論を還せませんでした`
      );
    }
    if (trunk) {
      const entry = {
        role: "branch_result" as const,
        branchId: thread.id,
        title: thread.title,
        conclusion: text,
        at: thread.closedAt,
      };
      trunk.record(entry);
      this.onBranchResult?.(trunk, entry);
    }
    // 畳むときは間引かず今すぐ書く（畳んだ直後に落ちても会話が残るように）
    this.flush(thread);
    this.refreshDefault();
    this.emit();
    return thread;
  }

  /**
   * 幹を終う（PO裁定 2026-08-09）。**プロジェクトが終わったとき**の口。
   *
   * 枝を畳むのが「回収」なら、こちらは「店じまい」——還す先が無いので結論は取らない。
   * 代わりに**持って出る記憶**を番頭が選別する（`thread.close_trunk` の `carry`）。
   *
   * **開いている枝が1本でもあれば終えない。** 終えると枝は幹の札ごと履歴へ沈み、
   * レールの点からも消える——埋没しない不変条件（決定77）が、作るときではなく
   * 終うときに破れる。先に畳ませる。
   *
   * I2: 枝・未知のIDは黙って成功にしない。
   */
  closeTrunk(threadId: string, now = new Date()): Thread {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`unknown thread: ${threadId}`);
    if (thread.kind !== "trunk") {
      throw new Error("これは幹ではありません（枝は thread.merge で畳みます）");
    }
    // I2: 帳場を終えると、宛先の決まらない知らせの行き先が消える（PO裁定 2026-08-10）
    if (thread.isMain) {
      throw new Error(
        "帳場は終えません（店にただ1つの幹で、宛先の決まらない知らせがここへ来ます）"
      );
    }
    if (thread.state === "closed") return thread; // 冪等
    const open = this.list({ state: "open", kind: "branch" }).filter(
      (b) => b.parentId === thread.id
    );
    if (open.length > 0) {
      throw new Error(
        `この幹には開いている枝が ${open.length} 本あります（${open
          .map((b) => b.title)
          .join(" / ")}）。先に畳んで還してください——` +
          "幹を終うと、枝が札ごと履歴へ沈んで埋没します（決定77）"
      );
    }
    thread.state = "closed";
    thread.closedAt = now.toISOString();
    this.flush(thread);
    this.refreshDefault();
    this.emit();
    return thread;
  }

  /**
   * 幹の札が立ったときに呼ばれる（配信のため）。帳簿は配信を知らない（D5）ので、
   * サーバが差し込む。
   */
  onTrunkCard: ((trunk: Thread, branch: Thread) => void) | undefined;
  /** 結論が幹へ還ったときに呼ばれる。 */
  onBranchResult:
    | ((
        trunk: Thread,
        entry: { branchId: string; title: string; conclusion: string; at: string }
      ) => void)
    | undefined;

  /**
   * 埋没しない不変条件（決定77）を機械で確かめられる形にする。
   *
   * > 開いている枝は、必ず **①幹の札 ②横断の通知 ③レールの点** のどれかに出ている。
   * > **どこにも出ていない枝は作れない。**
   *
   * `spec-ui` §2 の「現れる場所のない操作は追加できない」と同じ形。ここは①と③を数え、
   * ②（取次）は呼び出し側が知っているので渡してもらう。
   *
   * @param hasNotice その枝について取次に一通が積まれているか
   */
  branchVisibility(hasNotice: (branchId: string) => boolean = () => false): Array<{
    branchId: string;
    title: string;
    /** ①幹の札（`branch` の行が親の幹にある） */
    trunkCard: boolean;
    /** ②横断の通知 */
    notice: boolean;
    /** ③レールの点（開いている枝は必ず一覧に出る） */
    rail: boolean;
    visible: boolean;
  }> {
    // **どの幹の札か**まで見る（幹は複数ある）。他の幹に立っていても、その枝は埋没する
    const carded = new Set<string>();
    for (const trunk of this.trunks()) {
      for (const e of trunk.transcript) {
        if (e.role === "branch") carded.add(`${trunk.id}\u0000${e.branchId}`);
      }
    }
    return this.list({ state: "open", kind: "branch" }).map((branch) => {
      const trunkCard = carded.has(`${branch.parentId ?? ""}\u0000${branch.id}`);
      const notice = hasNotice(branch.id);
      // 開いている枝は帳簿に載っている＝レールの点として必ず出る（画面はこの一覧を描く）
      const rail = true;
      return {
        branchId: branch.id,
        title: branch.title,
        trunkCard,
        notice,
        rail,
        visible: trunkCard || notice || rail,
      };
    });
  }

  /**
   * 黙って止まった枝（決定77・P6・ADR-0016）。
   *
   * **機構の異常として扱う**——忘れられた枝を人の記憶に頼らせない。呼び出し側が
   * これを取次へ積む。最後に何かが記録された時刻から数える。
   */
  staleBranches(options: { now?: Date; days?: number } = {}): Array<{
    thread: Thread;
    /** 何日止まっているか（切り捨て）。 */
    days: number;
  }> {
    const now = options.now ?? new Date();
    const limit = options.days ?? BRANCH_STALE_DAYS;
    const out: Array<{ thread: Thread; days: number }> = [];
    for (const thread of this.list({ state: "open", kind: "branch" })) {
      const since = Date.parse(thread.lastActivityAt);
      if (Number.isNaN(since)) continue;
      const days = Math.floor((now.getTime() - since) / 86_400_000);
      if (days >= limit) out.push({ thread, days });
    }
    return out;
  }

  /**
   * 会話に名前を付け直す（PO要望 2026-08-05）。
   *
   * **話が変われば題も変わる**——会話は最初に付けた名前のまま続くとは限らず、
   * 「会話 3」や、始めの話題のままの題が並ぶとタブから中身が分からなくなる。
   *
   * 畳んだ会話も改名できる。履歴に並ぶのは畳んだ会話で、そちらこそ名前で探すため。
   *
   * I2: 知らないIDと空の題はエラーにする。黙って既定名へ落とすと、番頭は名付けたつもりで
   *     画面には別の名前が出る。
   */
  rename(threadId: string, title: string): Thread {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`unknown thread: ${threadId}`);
    const normalized = normalizeThreadTitle(title);
    if (!normalized) throw new Error("title must not be empty");
    if (normalized === thread.title) return thread; // 冪等（保存も通知もしない）
    thread.title = normalized;
    // 題は索引にある。間引くと、名付けた直後に落ちたときだけ元の名前で戻る
    this.persistIndex(thread);
    this.emit();
    return thread;
  }

  /**
   * 畳んだ枝を開き直す。会話はそのまま残っているので続きから話せる。
   *
   * **幹へ還した1行は消さない**（幹は追記のみ・D3）。結論も残す——「保留：理由」で
   * 畳んだものを開き直したとき、何を保留したのかが読めなくなるため。
   */
  reopen(threadId: string): Thread {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`unknown thread: ${threadId}`);
    thread.state = "open";
    thread.closedAt = undefined;
    thread.lastActivityAt = new Date().toISOString();
    this.refreshDefault();
    this.persistIndex(thread);
    this.emit();
    return thread;
  }

  /**
   * 宛先を引く。畳んだスレッドも引ける——知らせを届けるため（決定35b）。
   * **`threadId` 省略時は幹**（決定77：幹は畳まないので宛先は必ずある）。
   * I2: 知らないIDを幹へ黙って落とさない——別の会話に発話が紛れ込む。
   */
  resolve(threadId?: string): Thread {
    if (threadId === undefined) {
      const trunk = this.trunk();
      // I2: 幹が無い状態を黙って埋めない。呼び出し側が空状態として扱う
      if (!trunk) throw new Error("no trunk");
      return trunk;
    }
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`unknown thread: ${threadId}`);
    return thread;
  }

  get(threadId: string): Thread | undefined {
    return this.threads.get(threadId);
  }

  /**
   * 会話の一覧。**畳んだ分も既定で含む**——閉じても記録は残る（決定30c）。
   * 開いている枝だけ見たいなら `{ state: "open", kind: "branch" }`。
   */
  list(filter: { state?: "open" | "closed"; kind?: "trunk" | "branch" } = {}): Thread[] {
    let all = [...this.threads.values()];
    if (filter.state) all = all.filter((t) => t.state === filter.state);
    if (filter.kind) all = all.filter((t) => t.kind === filter.kind);
    return all;
  }

  /** `threadId` 省略時の宛先＝幹。幹がまだ無ければ undefined（起動直後の一瞬）。 */
  get defaultThreadId(): string | undefined {
    return this.trunk()?.id;
  }

  /** 開閉・改名を購読する。戻り値で解除。 */
  subscribe(listener: (threads: Thread[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 増減・改名を知らせる（改名は `rename` が呼ぶ）。 */
  emit(): void {
    const snapshot = this.list();
    for (const listener of this.listeners) listener(snapshot);
  }

  dispose(): void {
    for (const thread of this.threads.values()) thread.dispose();
    this.threads.clear();
    this.listeners.clear();
  }
}

/**
 * 黙って止まった枝を見張り、見つけたら知らせる（決定77・P6）。
 *
 * **忘れられた枝を人の記憶に頼らせない。** 何を積むかはここでは決めない（D5）——
 * 呼び出し側が取次の一通に組み立てる。同じ枝を毎回積み直さないよう、一度知らせた枝は
 * 覚えておく（取次の側の合印と二重になるが、こちらは走査の無駄を省くため）。
 *
 * @returns 見張りを止める関数
 */
export function watchStaleBranches(
  threads: ThreadRegistry,
  options: {
    onStale(branch: Thread, days: number): void | Promise<void>;
    /** 見る間隔（ms）。既定 1 時間——日数で数えるものを毎分見ても何も変わらない。 */
    intervalMs?: number;
    days?: number;
    log?(message: string): void;
  }
): () => void {
  const told = new Set<string>();
  const log = options.log ?? ((m: string) => console.error(m));
  const tick = async (): Promise<void> => {
    try {
      const stale = threads.staleBranches(options.days !== undefined ? { days: options.days } : {});
      const alive = new Set(stale.map((s) => s.thread.id));
      // 動き出した枝は忘れる（また止まったら改めて知らせる）
      for (const id of [...told]) if (!alive.has(id)) told.delete(id);
      for (const { thread, days } of stale) {
        if (told.has(thread.id)) continue;
        told.add(thread.id);
        await options.onStale(thread, days);
      }
    } catch (err) {
      // I2: 見張りが黙って死なないようにする。次の tick で取り直す
      log(`[banto] 止まっている枝を見られませんでした: ${String(err)}`);
    }
  };
  const timer = setInterval(() => void tick(), options.intervalMs ?? 3_600_000);
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}
