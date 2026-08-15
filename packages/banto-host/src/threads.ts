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
import type { BantoHarness, HarnessEvent } from "@banto/core";
import type { NamespacedToolDefinition } from "./tool-registry.js";
import type {
  BranchNoteKind,
  BranchOpener,
  ThreadView,
  TranscriptEntry,
} from "./protocol.js";
import type { ThreadStore } from "./thread-store.js";
import type { PostInput } from "./inbox.js";

/** 枝から幹へ立てる札1枚（決定107）。記録なので凍る。 */
export type BranchNote = Extract<TranscriptEntry, { role: "branch_note" }>;

/**
 * **章を畳んでいる最中かを訊く口**（imp-0052）。実装は `ChapterKeeper`。
 *
 * ここに置くのは、サーバが `ChapterKeeper` そのものを知らないため（D5：サーバは
 * 章立ての中身を持たない。畳んでいるかどうかだけ訊ければ、待たせる判断はできる）。
 */
export interface ChapterGate {
  /** いま畳んでいるか。 */
  isClosing(): boolean;
  /** 畳み終わるまで待つ。畳んでいなければ即座に返る。 */
  whenSettled(): Promise<void>;
}

/**
 * その会話が属する幹（幹なら自分、枝なら親）。
 *
 * **記憶が分かれる単位と同じ**（ADR-0003 追補・`ThreadIdentity.trunkId`）。幹をまたいで
 * 中身を読ませないための判定にも使う（決定105）——読めてしまうと、幹を分けた意味が消える。
 */
export function trunkIdOf(thread: Thread): string {
  return thread.kind === "trunk" ? thread.id : (thread.parentId ?? thread.id);
}

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
  /**
   * この会話のモデル。**`backend` は provider の上位の階層**（ADR-0020・PO裁定 2026-08-13）
   * ——`opus` は pi 経由でも Agent SDK 経由でも選べるので、名前からは決まらない。
   */
  model?: { backend?: string; provider: string; id: string },
  /** その会話が何であるか（帳場・幹・枝）。器を作る側がシステムプロンプトへ入れる。 */
  identity?: ThreadIdentity,
  /**
   * **バックエンド側の会話の札**（決定97・task-0104）。復元のときだけ渡る。
   *
   * pi の `resumeFrom`（セッションファイル）と役は同じだが、**別のバックエンドのもの**
   * なので別に持つ——同じ会話が pi と Agent SDK を往復するので、片方を捨てると
   * 戻ったときに文脈が無い。
   */
  resumeBackendSession?: string
) => Promise<{
  /** 会話を回すハーネス（ADR-0020 決定89）。pi でも Agent SDK でもよい。 */
  harness: BantoHarness;
  canvas?: Canvas;
  /** この器が実際に使っているモデル。会話ごとに持ち、画面と索引へ出す。 */
  model?: { backend?: string; provider: string; id: string; vision: boolean; contextWindow?: number };
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
   *
   * @returns 再開したなら true。**失われたターンの回収（`lost-turn.ts`）と二重に
   *   起こさない**ために要る——ここで再開した会話は、そちらでは拾わない。
   */
  resumePendingTurn?: () => Promise<boolean>;
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
   * **畳んでいる最中かを訊く口**（imp-0052）。章立てが働いていない会話では渡らない。
   *
   * サーバはこれを見て、畳んでいる間に届いた発話を**待たせて**から流す
   * ——これから捨てるセッションに答えさせると、途中で切られる。
   */
  chapterGate?: ChapterGate;
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
      /**
       * **用件の鍵**（T3）。知らせが指す対象——職人の `sessionId`・`projectTag/taskId`・
       * `envId`——を1本の枝に結びつける。同じ鍵の知らせは同じ枝へ入る。
       *
       * 番頭が手で開く枝には無い（`thread.open` は渡さない）。機構が知らせのために
       * 開いた枝だけが持つ。**題では引かない**——改名で壊れるため（PO 指示 2026-08-15）。
       */
      subjectKey?: string;
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
   * **用件の鍵**（T3）。この枝がどの対象（職人の `sessionId`・`projectTag/taskId`・
   * `envId`）の知らせを捌く場かを指す。**索引に保存され、再起動しても残る**
   * ——ここが消えると、再起動後の1通目が同じ用件の枝を見つけられず、新しい枝が立つ。
   *
   * 鍵の割り出せない知らせ（system の再起動通知など）の枝には**無い**：続きが来ても
   * 同じ枝に結びつけようが無い＝その1件で終わる用件だから（PO 指示 2026-08-15）。
   */
  readonly subjectKey: string | undefined;
  /**
   * 畳んだときの結論（決定77）。**保留も結論の一種**として「保留：理由」で畳める。
   * 開き直すと消えない——幹に還した1行は記録なので、そのまま残る。
   */
  conclusion: string | undefined;
  /**
   * 畳んだときの**詳細**（決定108・PO指示 2026-08-13）。何を調べ・何を決め・何が残ったか。
   *
   * **幹には流さない。** 幹に積まれるのは `conclusion` の1行だけで、こちらは枝に残り
   * `thread.read` で開いたときにだけ読める——詳細を幹へ流すと、決定77 が守っていた
   * 「幹は端から端まで読める帯」がその場で壊れる。**一覧は短く、詳細は開けば読める。**
   */
  conclusionDetail: string | undefined;
  /**
   * 畳むときに書かれた**残作業の件数**（imp-0036）。
   *
   * 中身は `conclusionDetail` の「## 残ったこと」に潰れて入っている。ここに持つのは
   * **件数だけ**——幹へ出すのは「未処理がある」という事実と件数までで、中身は
   * `thread.read` で読む（決定108 の縛りは動かさない）。
   *
   * なぜ要るか：`remaining` に書いた仕事が誰にも渡らないまま消える事故が起きた
   * （2026-08-15・thread-86）。畳んだ枝は `thread.list` の既定から外れるので、
   * **残作業を抱えた枝と、きれいに片付いた枝が一覧で区別できなかった**。
   */
  remainingCount = 0;
  /** 残作業に所在が付いた時刻（`thread.settle`）。付くまで一覧から消えない。 */
  settledAt: string | undefined;
  /** 残作業の**所在**——起票 id・職人の sessionId・幹での委譲先。 */
  settledWhere: string | undefined;
  /**
   * **未処理を抱えたまま畳んだ枝か。** 一覧に出し続けるかの判定はここ1つ（D3）。
   */
  get hasUnsettledRemaining(): boolean {
    return this.remainingCount > 0 && this.settledAt === undefined;
  }
  /**
   * 畳んだスレッドは**消えない**（Worker Pool の決定30c と同じ発想）。
   * 一覧から外れるだけで、履歴として読めるし同じ会話のまま再開できる。
   */
  state: "open" | "closed" = "open";
  /**
   * 開いた時刻。保存した会話を並べるのに要る（task-0036）。
   *
   * **読み戻しでは索引の値をそのまま入れる**（`restore` が `params.createdAt` を渡す）。
   * ここを既定値のままにしていた頃は、再起動のたびに「開いた時刻」が振り直されていた
   * ——不具合を調べているとき、実際には再起動の**前**に開かれた会話が「再起動の後に
   * 開かれた」と読め、原因の切り分けを誤らせた（inc: thread-104）。
   */
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
  /**
   * 会話を回しているハーネス。**差し替えられる**（ADR-0020 決定88・PO要望 2026-08-13）
   * ——モデルを会話の途中で変えられるのと同じく、バックエンドも変えられる。
   * 差し替えは `replaceHarness` を通すこと（購読を張り直す必要があるため）。
   */
  harness: BantoHarness;
  /** ハーネスの購読を外す口。差し替えのときに張り直す。 */
  private harnessDisposer: (() => void) | undefined;
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
   * ハーネスの出来事を購読する。**差し替えのときに張り直せるよう、ここ1箇所に集める**
   * ——`disposers` に混ぜると、ハーネスの購読だけを外せない。
   */
  listen(handler: (event: HarnessEvent) => void): void {
    this.harnessDisposer?.();
    this.harnessDisposer = this.harness.subscribe(handler);
  }

  /**
   * **会話の途中でバックエンドを差し替える**（PO要望 2026-08-13）。
   *
   * モデルを変えられるのと同じ感覚で変えられるべきなので、再起動は要らない形にする。
   * 古い購読を外して新しいハーネスへ張り直す——ここを忘れると、画面には何も流れて
   * こないのに番頭は動いている、という一番分かりにくい壊れ方をする。
   *
   * **文脈は引き継がない。** バックエンドが変わると生きているセッションも変わるので、
   * 引き継ぐなら呼び出し側が種（`startChapter`）で渡すこと（決定93）。
   */
  replaceHarness(next: BantoHarness, handler: (event: HarnessEvent) => void): void {
    this.harnessDisposer?.();
    this.harnessDisposer = undefined;
    this.harness = next;
    this.listen(handler);
  }
  /**
   * この会話で使っているモデル（PO裁定 2026-08-04）。
   *
   * **会話ごとに持つ**——話題ごとに向いたモデルが違うので、切り替えても他の会話は変わらない。
   * 索引に保存され、再起動しても同じモデルで再開する。
   */
  model: { backend?: string; provider: string; id: string; vision: boolean; contextWindow?: number } | undefined;
  /**
   * 復元された中断ターンを再開する処理（imp-0016 主対策）。
   * サーバ起動後に open スレッドだけ呼ばれる（畳んだスレッドは開き直すまで話さない）。
   */
  readonly resumePendingTurn: (() => Promise<boolean>) | undefined;
  /**
   * **いま章を畳む**（提案§3.2 の人側）。章立てが働いていない会話では `undefined`。
   * サーバはこれが無いことを「畳めない理由」としてそのまま PO に出す（I2）。
   */
  readonly closeChapter: (() => Promise<boolean>) | undefined;
  /** 畳んでいる最中かを訊く口（imp-0052）。章立てが働いていない会話では `undefined`。 */
  readonly chapterGate: ChapterGate | undefined;
  /** 会話の真実。接続時にまとめて配り、以後は差分イベントで追随させる（D3）。 */
  transcript: TranscriptEntry[] = [];
  /**
   * 知らせを1本ずつ順に流すための鎖。**スレッドごと**に持つ。
   * 職人が同時に複数報告してきても、そのスレッドのターンは1本ずつ進む。
   */
  notices: Promise<void> = Promise.resolve();
  /**
   * **PO が場を取っている間、知らせの列は待つ**（imp-0048・提案 §4 案I）。
   *
   * 中断は「番頭を黙らせて、こちらが話す」ためのもの。だが `abort` は列に触らないので、
   * 止めた次の瞬間に残りの知らせが走り出し、**話そうとした隙がそのまま埋まっていた**。
   * PO の発話は列に並ばず直に入る（`promptEvenWhileBusy`）ので、優先させるには
   * **知らせ側を待たせる**しかない。
   *
   * 未解決の間だけ知らせが止まる。既定は解決済み＝いつもどおり流れる。
   */
  poFloor: Promise<void> = Promise.resolve();
  private floorRelease: (() => void) | undefined;
  private floorTimer: ReturnType<typeof setTimeout> | undefined;
  /** いま取られている場の札。**引き受けた者だけが返せる**ようにするために持つ。 */
  private floorToken = 0;
  private floorClaimed = false;
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
    subjectKey?: string;
    conclusion?: string;
    conclusionDetail?: string;
    remainingCount?: number;
    settledAt?: string;
    settledWhere?: string;
    /**
     * 開いた時刻。**読み戻すときは索引に入っている値をそのまま渡す**——渡さないと
     * 既定値（いまの時刻）が入り、再起動のたびに「開いた時刻」が振り直される。
     */
    createdAt?: string;
    harness: BantoHarness;
    canvas?: Canvas;
    tools: NamespacedToolDefinition[];
    getLastError?: () => string | undefined;
    sessionFile?: string;
    model?: { backend?: string; provider: string; id: string; vision: boolean; contextWindow?: number };
    resumePendingTurn?: () => Promise<boolean>;
    closeChapter?: () => Promise<boolean>;
    chapterGate?: ChapterGate;
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
    this.subjectKey = params.subjectKey;
    this.conclusion = params.conclusion;
    this.conclusionDetail = params.conclusionDetail;
    this.remainingCount = params.remainingCount ?? 0;
    this.settledAt = params.settledAt;
    this.settledWhere = params.settledWhere;
    // 読み戻しなら索引の値。新規なら既定値（いまの時刻）のまま
    if (params.createdAt) this.createdAt = params.createdAt;
    // I2: 枝に還す条件と親が無いのは帳簿の壊れ。黙って幹のように振る舞わせない
    if (params.kind === "branch" && (!params.parentId || !params.returnCondition)) {
      throw new Error(`枝 ${params.id} に親か還す条件がありません（決定77）`);
    }
    this.harness = params.harness;
    this.canvas = params.canvas;
    this.toolNames = params.tools.map((t) => t.name);
    this.getLastError = params.getLastError ?? ((): string | undefined => undefined);
    this.sessionFile = params.sessionFile;
    this.model = params.model;
    this.resumePendingTurn = params.resumePendingTurn;
    this.closeChapter = params.closeChapter;
    this.chapterGate = params.chapterGate;
    if (params.dispose) this.disposers.push(params.dispose);
  }

  /**
   * **PO に場を渡す**（imp-0048）。渡している間、知らせの列は `poFloor` で待つ。
   *
   * **待たせっぱなしにはしない**——`holdMs` を過ぎたら自分で返す。PO が中断だけして
   * 席を立ったとき、知らせが永久に止まると職人の報告が届かなくなる（I2：消さない）。
   * 二重に取らない：中断してから話す流れでは、中断で取った場をその発話が返す。
   */
  takeFloorForPo(holdMs: number): void {
    if (this.floorRelease) return;
    const token = ++this.floorToken;
    this.floorClaimed = false;
    this.poFloor = new Promise<void>((resolve) => {
      this.floorRelease = resolve;
    });
    this.floorTimer = setTimeout(() => this.releaseFloor(token), holdMs);
    // 場を待つだけのタイマーでプロセスを生かし続けない
    this.floorTimer.unref?.();
  }

  /**
   * **いま取られている場を引き受ける**（imp-0048）。返ってきた札で `releaseFloor` する。
   *
   * 札で縛るのは、**中断で止まったターンの後始末に返させない**ため。中断は走っている
   * ターンを終わらせるので、そのターンを持っていた発話の `finally` がそのまま走る
   * ——札が無いと、取ったばかりの場をその場で返してしまい、知らせが走り出す。
   *
   * @returns 引き受けた札。場が取られていない／もう誰かが引き受けているなら `undefined`
   */
  claimFloor(): number | undefined {
    if (!this.floorRelease || this.floorClaimed) return undefined;
    this.floorClaimed = true;
    return this.floorToken;
  }

  /** 引き受けた場を返す（PO のターンが終わった・待ち時間が過ぎた）。札が古ければ何もしない。 */
  releaseFloor(token: number): void {
    if (token !== this.floorToken || !this.floorRelease) return;
    if (this.floorTimer) {
      clearTimeout(this.floorTimer);
      this.floorTimer = undefined;
    }
    const release = this.floorRelease;
    this.floorRelease = undefined;
    this.floorClaimed = false;
    release?.();
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
      // 一覧には出さない（幅を食う）。**あることだけ**を出して、開けば読める形にする（決定108）
      ...(this.conclusionDetail ? { hasConclusionDetail: true } : {}),
      // 未処理も同じ扱い——**件数だけ**出す。中身は thread.read（imp-0036）
      ...(this.hasUnsettledRemaining ? { unsettledRemaining: this.remainingCount } : {}),
      ...(this.settledWhere ? { settledWhere: this.settledWhere } : {}),
      sessionId: this.harness.sessionId,
      isDefault: this.isDefault,
      state: this.state,
      // D3: 忙しさの真実はここ。UI は自分の操作から推測しない
      streaming: this.harness.isStreaming,
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
    this.harnessDisposer?.();
    this.harnessDisposer = undefined;
    /**
     * **ハーネス自身も畳む**（決定97・task-0104）。購読を外すだけでは足りない
     * ——Agent SDK は子プロセスを抱えており、放すだけでは終わらない。
     * I2: 畳めなかったことを握りつぶさない（会話は閉じるので throw はしない）。
     */
    void Promise.resolve(this.harness.dispose?.()).catch((err: unknown) => {
      console.error(`[banto] ${this.id} のハーネスを畳めませんでした: ${String(err)}`);
    });
    for (const off of this.disposers) off();
    this.disposers.length = 0;
  }
}

/** スレッドの帳簿。開閉の通知だけを外へ出す。 */
/** 保存を間引く間隔。長くすると落ちたときの取りこぼしが増える。 */
const SAVE_DELAY_MS = 400;

/** ホスト自身を落とす道具。**これだけは中断が意図されたもの**なので `ok` に確定させる。 */
const RESTART_TOOL_NAME = "system.restart";

/** 結果の分からない道具に書く理由。I2: 成功と書かない。 */
const INTERRUPTED_TOOL_REASON = "ホストの再起動で中断されました。";

/**
 * 再起動を呼んだ会話へ入れる知らせ。番頭はこれを読んで自分から続きを話す。
 *
 * 記録するのは読み戻し、ターンを回すのは起動側（`nudge`）——**同じ一言**でなければ
 * 記録と番頭が聞いた話がずれるので、文言はここに1つだけ置く。
 */
export const RESTART_RESUME_NOTICE = "再起動が完了しました。中断した続きを進めてください。";

/**
 * 取次へ積む口（`Inbox` の一部だけ）。
 *
 * 帳簿は取次の全部を知らなくてよい——**積める**ことだけが要る。
 */
export interface InboxPoster {
  post(input: PostInput): unknown;
}

/**
 * 再起動を取次へ1件出す（PO要望 2026-08-15）。
 *
 * **PO がどの会話を開いているかは分からない。** 呼び出し元の会話へ入れる知らせだけでは、
 * その会話を見ていなければ再起動に気づけない。取次はレールに常に出ているので確実に目に入る。
 *
 * - `notice: true`（ADR-0022 決定109・110）。**判断ではなく報告**なので、判断待ちの数に
 *   入れない——報告で `pendingCount` を膨らませると、判断待ちの数が意味を失う
 * - 差出人は**機構**として名乗る（imp-0026: ホストの知らせが PO の発言に化けた）
 * - 選択肢は「了解」の1つだけ。判断を迫る文言にしない
 */
function postRestartReport(
  inbox: InboxPoster,
  interrupted: ReadonlyArray<{ thread: Thread; restarted: boolean }>,
  failedTotal: number
): void {
  const caller = interrupted.find((e) => e.restarted);
  const failedNote =
    failedTotal > 0 ? `中断した道具 ${failedTotal} 件は failed として記録しました。` : "";
  const target = caller ?? interrupted[0]!;
  const what = caller
    ? `banto を再起動しました。` +
      `呼び出し元は会話「${caller.thread.title}」（${caller.thread.id}）です。${failedNote}`
    : // `system.restart` が無いのに running が残っていた＝番頭が意図せず落ちた
      `banto が予期せず終了し、再起動しました。` +
      `中断した道具 ${failedTotal} 件は failed として記録しました` +
      `（会話「${interrupted[0]!.thread.title}」${interrupted.length > 1 ? "ほか" : ""}）。`;
  inbox.post({
    source: { id: "system", label: "banto ホスト" },
    kind: caller ? "再起動しました" : "予期せず終了しました",
    notice: true,
    title: caller ? "banto を再起動しました" : "banto が予期せず終了し、再起動しました",
    what,
    ask: "確認したら押してください",
    actions: [{ id: "ack", label: "了解", tone: "plain" }],
    opens: { threadId: target.thread.id },
  });
}

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
  async restore(inbox?: InboxPoster): Promise<string[]> {
    if (!this.store) return [];
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
        const parts = await this.factory(
          saved.id,
          saved.sessionFile,
          saved.model,
          {
            kind: savedKind,
            isMain: saved.isMain === true,
            trunkId: savedKind === "trunk" ? saved.id : (saved.parentId ?? saved.id),
            title: saved.title,
            ...(saved.returnCondition ? { returnCondition: saved.returnCondition } : {}),
            ...(saved.parentId
              ? { parentTitle: this.threads.get(saved.parentId)?.title ?? saved.parentId }
              : {}),
          },
          // 決定97: Agent SDK 側の文脈はこの札でしか戻せない（pi の sessionFile と両立）
          saved.backendSessionId
        );
        // 古い索引には kind が無い。**1本残らず幹として読み戻す**（上の注記）。
        // 還す条件の無い枝は帳簿として成り立たない（決定77）——遡って書けない以上、
        // 枝にはしない
        const kind = savedKind;
        const thread = new Thread({
          id: saved.id,
          title: saved.title,
          kind,
          // **開いた時刻は索引の値をそのまま戻す**。渡さないと既定値（いまの時刻）が
          // 入り、再起動のたびに振り直される＝「いつ開いたか」が事実でなくなる
          ...(saved.createdAt ? { createdAt: saved.createdAt } : {}),
          ...(saved.isMain ? { isMain: true } : {}),
          ...(kind === "branch"
            ? {
                ...(saved.parentId ? { parentId: saved.parentId } : {}),
                ...(saved.returnCondition ? { returnCondition: saved.returnCondition } : {}),
                ...(saved.openedBy ? { openedBy: saved.openedBy } : {}),
                ...(saved.openReason ? { openReason: saved.openReason } : {}),
                // T3: 用件の鍵も読み戻す。**再起動をまたいで同じ枝へ集める**のが要点
                ...(saved.subjectKey ? { subjectKey: saved.subjectKey } : {}),
              }
            : {}),
          ...(saved.conclusion ? { conclusion: saved.conclusion } : {}),
          // 決定108: 詳細も読み戻す。畳んだ枝を開いて読めるのが要点なので、
          // 再起動で消えると「開けば読める」が成り立たなくなる
          ...(saved.conclusionDetail ? { conclusionDetail: saved.conclusionDetail } : {}),
          // imp-0036: 未処理も読み戻す。**片付くまで消えない**のが要点なので、
          // 再起動で降りてしまうと、いちばん忘れやすい形に戻る
          ...(saved.remainingCount ? { remainingCount: saved.remainingCount } : {}),
          ...(saved.settledAt ? { settledAt: saved.settledAt } : {}),
          ...(saved.settledWhere ? { settledWhere: saved.settledWhere } : {}),
          harness: parts.harness,
          ...(parts.model ? { model: parts.model } : {}),
          ...(parts.canvas ? { canvas: parts.canvas } : {}),
          tools: parts.tools,
          ...(parts.getLastError ? { getLastError: parts.getLastError } : {}),
          ...(parts.sessionFile ? { sessionFile: parts.sessionFile } : {}),
          ...(parts.resumePendingTurn ? { resumePendingTurn: parts.resumePendingTurn } : {}),
      ...(parts.closeChapter ? { closeChapter: parts.closeChapter } : {}),
      ...(parts.chapterGate ? { chapterGate: parts.chapterGate } : {}),
          ...(parts.closeChapter ? { closeChapter: parts.closeChapter } : {}),
      ...(parts.chapterGate ? { chapterGate: parts.chapterGate } : {}),
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
    const resume = this.settleInterrupted(inbox);
    this.refreshDefault();
    this.repairTrunkCards();
    this.emit();
    return resume;
  }

  /**
   * **落ちる前に走っていた道具を、起動時に確定させる**（imp-0037 原因1）。
   *
   * `tool_start` は履歴へ `state:"running"` で入り、`tool_end` が来て初めて `ok`/`failed`
   * になる。ところが `system.restart` はその `tool_end` を書く前にプロセスを落としていた
   * ため、履歴に `running` が**永久に**残っていた。突き合わせは後から結果が届いたときに
   * しか動かないので、ここで残りを確定させる。
   *
   * - 一般の道具は `failed`。**黙って `ok` にしない**（I2: 結果が分からないなら分からない
   *   ほうへ倒す。半端に成功と書くと、番頭が「やった」前提で続きを組み立てる）
   * - `system.restart` だけは `ok`。これは**意図した中断**で、いま起動しているのがその結果
   *
   * 呼び出し元の会話には「続きを進めてください」を1件入れ、**取次にも報告を1件**出す
   * （PO要望 2026-08-15）——PO がどの会話を開いているかは分からないので、レールに常に
   * 出ている取次に置かないと再起動に気づけない。
   *
   * @returns ターンを回す宛先（＝再起動を呼んだ会話）。知らせを記録するのはここ、
   *          ターンを回すのはサーバの役目（決定107 の `nudge` と同じ分担）
   */
  private settleInterrupted(inbox?: InboxPoster): string[] {
    const interrupted: Array<{ thread: Thread; restarted: boolean; failed: number }> = [];
    for (const thread of this.threads.values()) {
      let restarted = false;
      let failed = 0;
      thread.transcript = thread.transcript.map((entry) => {
        if (entry.role !== "tool" || entry.state !== "running") return entry;
        if (entry.name === RESTART_TOOL_NAME) {
          restarted = true;
          return { ...entry, state: "ok" as const, output: "再起動しました。" };
        }
        failed++;
        return { ...entry, state: "failed" as const, output: INTERRUPTED_TOOL_REASON };
      });
      if (restarted || failed > 0) interrupted.push({ thread, restarted, failed });
    }
    // 何も残っていない＝普通の起動。**毎回知らせを出さない**（出せばすぐ読み飛ばされる）
    if (interrupted.length === 0) return [];

    const resume: string[] = [];
    for (const { thread, restarted } of interrupted) {
      if (!restarted) continue;
      thread.record({ role: "notice", source: "system", text: RESTART_RESUME_NOTICE });
      resume.push(thread.id);
    }

    const failedTotal = interrupted.reduce((sum, e) => sum + e.failed, 0);
    if (inbox) {
      try {
        postRestartReport(inbox, interrupted, failedTotal);
      } catch (err) {
        // I2: 取次へ出せなかったことを黙らせない。会話の読み戻しは止めない
        console.error(`[banto] 再起動の報告を取次へ出せませんでした: ${String(err)}`);
      }
    }

    // 書き換えた記録と足した知らせを、間引かずに今すぐ書き戻す（次の起動で running へ戻さない）
    for (const { thread } of interrupted) this.flush(thread);
    console.log(
      `[banto] 中断されたまま残っていた道具を確定させました（会話 ${interrupted.length} 本・failed ${failedTotal} 件）`
    );
    return resume;
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
      /**
       * **用件の鍵**（T3）。落とすと、再起動したあとの1通目が同じ用件の枝を見つけられず、
       * 同じ職人・同じタスクの枝が二重に立つ——用件ごとに1本という前提がその場で崩れる。
       */
      ...(thread.subjectKey ? { subjectKey: thread.subjectKey } : {}),
      ...(thread.conclusion ? { conclusion: thread.conclusion } : {}),
      ...(thread.conclusionDetail ? { conclusionDetail: thread.conclusionDetail } : {}),
      /**
       * 未処理の件数と所在（imp-0036）。**落とすと再起動で未処理が消える**
       * ——それが今回直している事故そのものなので、ここは必ず書く。
       */
      ...(thread.remainingCount > 0 ? { remainingCount: thread.remainingCount } : {}),
      ...(thread.settledAt ? { settledAt: thread.settledAt } : {}),
      ...(thread.settledWhere ? { settledWhere: thread.settledWhere } : {}),
      state: thread.state,
      createdAt: thread.createdAt,
      ...(thread.closedAt ? { closedAt: thread.closedAt } : {}),
      ...(thread.sessionFile ? { sessionFile: thread.sessionFile } : {}),
      /**
       * **バックエンド側の札**（決定97・task-0104）。無いときは書かない——`upsert` は
       * 既存へ重ねるので、まだ札の無い状態（一度も往復していない）が
       * 保存済みの札を消してしまうことはない。
       */
      ...(thread.harness.resumeToken?.()
        ? { backendSessionId: thread.harness.resumeToken()! }
        : {}),
      // **backend も残す**（PO裁定 2026-08-13）。落とすと、会話ごとのバックエンド選択が
      // 再起動で必ず消える——「会話に記録があるなら、それが勝つ」が成立しない
      ...(thread.model
        ? {
            model: {
              ...(thread.model.backend ? { backend: thread.model.backend } : {}),
              provider: thread.model.provider,
              id: thread.model.id,
            },
          }
        : {}),
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
      if (from !== undefined && !from_) throw this.unknownThread(from);
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
            // T3: 用件の鍵。次の同じ鍵の知らせがこの枝を見つけるための唯一の手掛かり
            ...(spec.subjectKey ? { subjectKey: spec.subjectKey } : {}),
          }
        : {}),
      harness: parts.harness,
      ...(parts.model ? { model: parts.model } : {}),
      ...(parts.canvas ? { canvas: parts.canvas } : {}),
      tools: parts.tools,
      ...(parts.getLastError ? { getLastError: parts.getLastError } : {}),
      ...(parts.sessionFile ? { sessionFile: parts.sessionFile } : {}),
      ...(parts.resumePendingTurn ? { resumePendingTurn: parts.resumePendingTurn } : {}),
      ...(parts.closeChapter ? { closeChapter: parts.closeChapter } : {}),
      ...(parts.chapterGate ? { chapterGate: parts.chapterGate } : {}),
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
   * 知らないIDを指されたときのエラー。**いま在る会話を名指しする**（inc-0054）。
   *
   * 「unknown thread: thread-999」だけでは、正しいIDを知る手立てが無い。
   * 畳んだものにも知らせは届く（決定35b）ので、開いているものを先に挙げつつ
   * 畳んだ数も添える——「IDが違う」のか「もう畳んだ」のかで直し方が別なため。
   */
  private unknownThread(threadId: string): Error {
    const open = this.list({ state: "open" }).map((t) => `${t.id}（${t.title}）`);
    const closed = this.list({ state: "closed" }).length;
    return new Error(
      `unknown thread: ${threadId} — いま開いているのは ` +
        (open.length > 0 ? open.join("、") : "ありません") +
        `${closed > 0 ? `。ほかに畳んだ会話が ${closed} 本あります（thread.list で引けます）` : ""}` +
        "。この中のIDを渡してください"
    );
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
   * **詳細（`detail`）は幹へ流さない**（決定108・PO指示 2026-08-13）。何を調べ・何を決め・
   * 何が残ったかは**枝に残り**、`thread.read` で開いたときにだけ読める。幹に積むのは
   * 1行のまま——両方を幹へ流すと、決定77 が守っていた「幹は端から端まで読める帯」が壊れる。
   *
   * I2: 幹・未知のID・空の結論は黙って成功にせずエラーにする。
   */
  merge(
    threadId: string,
    conclusion: string,
    options: { detail?: string; remainingCount?: number; now?: Date } = {}
  ): Thread {
    const now = options.now ?? new Date();
    const thread = this.threads.get(threadId);
    if (!thread) throw this.unknownThread(threadId);
    if (thread.kind === "trunk") {
      throw new Error("幹は畳めません（幹は永続・決定77）");
    }
    const text = conclusion.replace(/\s+/gu, " ").trim();
    if (text === "") throw new Error("結論は空にできません（保留なら「保留：理由」と書く）");
    const detail = options.detail?.trim();
    if (thread.state === "closed" && thread.conclusion === text) return thread; // 冪等
    thread.conclusion = text;
    // 空の詳細で既にある詳細を消さない（畳み直しで中身が痩せるのを防ぐ）
    if (detail) thread.conclusionDetail = detail;
    /**
     * 残作業を非空で受け取ったら**未処理として立てる**（imp-0036）。
     *
     * 詳細と同じく**空では消さない**——畳み直しで痩せない、が決定108 から引き継ぐ扱い。
     * 改めて残作業を書いたなら、それは**新しい言明**なので所在は降ろし直させる
     * （前に降ろした所在は、いま書かれた残作業を指していない）。
     */
    if (options.remainingCount !== undefined && options.remainingCount > 0) {
      thread.remainingCount = options.remainingCount;
      thread.settledAt = undefined;
      thread.settledWhere = undefined;
    }
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
        // 詳細は幹に載せない。**在ることだけ**を言い、読むのは枝を開いてから（決定108）
        ...(thread.conclusionDetail ? { hasDetail: true as const } : {}),
      };
      trunk.record(entry);
      this.onBranchResult?.(trunk, entry);
    }
    // 取次への知らせ（決定109）。幹の帯とは別の置き場——親を引けなくても枝は畳まれている
    this.onBranchMerged?.(thread);
    // 畳むときは間引かず今すぐ書く（畳んだ直後に落ちても会話が残るように）
    this.flush(thread);
    this.refreshDefault();
    this.emit();
    return thread;
  }

  /**
   * 畳んだ枝の**未処理を降ろす**（imp-0036・番頭裁定 2026-08-15）。
   *
   * 未処理は「片付いた」と言うだけでは降りない——**所在**（起票 id・立てた職人の
   * sessionId・幹での委譲先）を書かせる。降ろす口を所在なしで開けると、
   * ただの消しゴムになって、一覧から消えたのに誰も持っていない状態が復活する。
   *
   * 所在は**自由文字列**（番頭裁定）。`imp-NNNN` の形に縛ると「幹で委譲予定」
   * 「PO 判断待ち」のような、id を持たない正当な所在が書けなくなる。
   * ただし**空白のみは断る**——素通しさせるとこの口の意味が無い。
   *
   * **所在は枝の記録に残す**（番頭裁定）。あとから「これはどこへ行ったのか」を
   * 辿れなければ、降ろしたことの裏が取れない。
   *
   * I2: 未処理の無い枝・幹・未知のID・空の所在は、黙って成功にしない。
   */
  settle(threadId: string, where: string, now = new Date()): Thread {
    const thread = this.threads.get(threadId);
    if (!thread) throw this.unknownThread(threadId);
    if (thread.kind !== "branch") {
      throw new Error("未処理を降ろせるのは枝だけです（幹は畳むときに残作業を書きません）");
    }
    const text = where.replace(/\s+/gu, " ").trim();
    if (text === "") {
      throw new Error(
        "所在は空にできません（imp-0036 / task-0091 / 職人の sessionId /「幹で委譲予定」など、" +
          "**どこへ行ったか**を書いてください）"
      );
    }
    if (thread.remainingCount === 0) {
      throw new Error(
        `枝「${thread.title}」に未処理はありません（畳むときに remaining が書かれていません）`
      );
    }
    // 冪等：同じ所在で二度降ろしても足さない
    if (thread.settledAt !== undefined && thread.settledWhere === text) return thread;
    thread.settledAt = now.toISOString();
    thread.settledWhere = text;
    thread.record({
      role: "notice",
      source: "thread",
      text: `未処理 ${thread.remainingCount}件の所在：${text}`,
    });
    this.flush(thread);
    this.emit();
    return thread;
  }

  /**
   * **枝から幹へ、畳む前に一言を還す**（決定107・PO指示 2026-08-13）。
   *
   * 決定77 は「幹に還るのは開いた1行と結論1行だけ」としていたが、**枝の途中で幹の判断が
   * 要る場面**（前提が崩れた・思っていたより大きい・どちらの筋で進めるか）はそこから
   * 漏れていた。畳むまで黙るか、結論を捏造して畳むかの二択になっていたのを開ける。
   *
   * **札として幹に立つ**（`notice` にしない）。知らせで流すと番頭の他の知らせに紛れ、
   * 読み返したときにどの枝の話か辿れない——枝の札（`open`）・結論（`merge`）と
   * 同じ列に並べる。埋没しない不変条件（決定77）はこれで保たれる。
   *
   * **幹のターンは回さない**（ここは帳簿・D5）。回すのは配信を持っている側の仕事。
   *
   * I2: 幹から・畳んだ枝から・空の本文・親を引けない枝は、黙って成功にしない。
   */
  consult(
    branchId: string,
    params: { kind: BranchNoteKind; message: string },
    now = new Date()
  ): { trunk: Thread; branch: Thread; entry: BranchNote } {
    const branch = this.threads.get(branchId);
    if (!branch) throw this.unknownThread(branchId);
    if (branch.kind !== "branch") {
      throw new Error(
        "これは幹です。幹から幹へは thread.send、幹から枝へは thread.steer を使ってください"
      );
    }
    if (branch.state === "closed") {
      throw new Error(
        `枝「${branch.title}」は畳んであります（結論：${branch.conclusion ?? "なし"}）。` +
          "続きがあるなら開き直してください"
      );
    }
    const text = params.message.trim();
    if (text === "") throw new Error("空の相談は還せません");
    const trunk = branch.parentId ? this.threads.get(branch.parentId) : undefined;
    // I2: 親を引けないのは帳簿の壊れ。黙って帳場へ落とすと、別の幹に相談が紛れ込む
    if (!trunk) {
      throw new Error(
        `枝 ${branch.id} の親（${branch.parentId ?? "なし"}）を引けないため、幹へ還せません`
      );
    }
    const entry: BranchNote = {
      role: "branch_note",
      branchId: branch.id,
      title: branch.title,
      kind: params.kind,
      text,
      at: now.toISOString(),
    };
    trunk.record(entry);
    // 枝も動いている。滞留（決定77）の数え直しはここでもする
    branch.lastActivityAt = entry.at;
    this.onBranchNote?.(trunk, entry);
    return { trunk, branch, entry };
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
    if (!thread) throw this.unknownThread(threadId);
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
        entry: {
          branchId: string;
          title: string;
          conclusion: string;
          at: string;
          hasDetail?: boolean;
        }
      ) => void)
    | undefined;
  /**
   * 枝が畳まれたときに呼ばれる（ADR-0022 決定109）。
   *
   * `onBranchResult` の隣——ただし宛先は違う。あちらは幹の帯（記録）へ、こちらは
   * **取次**（知らせ）へ積むためのフック。帳簿は配信も取次も知らない（D5）ので、
   * サーバが差し込む。親を引けなかった枝（`trunk` が無い）でも、枝自体は畳まれている
   * ので呼ぶ——知らせの宛先は枝そのもの（`opens.threadId`）であって幹ではない。
   */
  onBranchMerged: ((thread: Thread) => void) | undefined;
  /** 枝から幹へ札が1枚立ったときに呼ばれる（決定107）。 */
  onBranchNote: ((trunk: Thread, entry: BranchNote) => void) | undefined;

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
    if (!thread) throw this.unknownThread(threadId);
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
    if (!thread) throw this.unknownThread(threadId);
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
      // （inc-0054: 「no trunk」だけでは何が起きたのか読めないので、状態と直し方を書く）
      if (!trunk)
        throw new Error(
          "no trunk — 開いている幹が1本もないため、宛先を省略した呼び出しは通せません。" +
            "thread.open で幹を開くか、threadId を明示してください"
        );
      return trunk;
    }
    const thread = this.threads.get(threadId);
    if (!thread) throw this.unknownThread(threadId);
    return thread;
  }

  get(threadId: string): Thread | undefined {
    return this.threads.get(threadId);
  }

  /**
   * **用件の枝を鍵で引く**（T3）。同じ対象（職人・タスク・検証環境）の知らせを
   * 1本の枝に集めるための逆引き。
   *
   * **畳んだ枝も返す**。返さないと、鍵が終端に達して畳んだあとに遅れて届いた1通が
   * 新しい枝を立ててしまい、「畳んだ枝への配達は開き直す」（T2）が働かない。
   * 開いているものを先に返す——同じ鍵で2本ある（畳んだ古い枝と、いまの枝）ときは、
   * いま開いている側が正しい宛先。
   *
   * 引き当てるのは**鍵と親の組**。題では引かない（改名で壊れる・PO 指示 2026-08-15）。
   */
  findBySubject(parentId: string, subjectKey: string): Thread | undefined {
    let closed: Thread | undefined;
    for (const thread of this.threads.values()) {
      if (thread.kind !== "branch") continue;
      if (thread.parentId !== parentId) continue;
      if (thread.subjectKey !== subjectKey) continue;
      if (thread.state === "open") return thread;
      closed = thread;
    }
    return closed;
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
