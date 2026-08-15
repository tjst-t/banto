/**
 * **落ちて消えたターンを、記録の並びから見つける**（inc: thread-104 / imp-0061）。
 *
 * 起きたこと: `thread.open` の最初の一言（seed）を枝へ渡した1秒後にホストが SIGKILL で
 * 落ちた。`deliverToThread` は **記録してから prompt する**ので、枝には知らせの行だけが
 * 残り、番頭のターンは1本も回らないまま消えた。台帳（`turns.jsonl`）はターンの**終わり**に
 * 書くので行すら残らず、`[banto]` のログにも何も出ない——PO が話しかけるまで枝は沈黙した。
 *
 * 既にある回収は2つあり、どちらもこの形を拾えない:
 *
 * - `resumeInterruptedTurn`（`turn-guard.ts`）は**最後のメッセージが toolResult のときだけ**
 *   `continue()` する。道具を1回も呼ぶ前に落ちた今回は対象外
 * - `resumeAfterRestart`（`threads.restore`）は `system.restart` を**自分で呼んだ**会話だけ。
 *   外から一言が入ったところで落ちた会話は入らない
 *
 * ここはその3つ目——**会話の記録の並びだけ**を見て「番頭がそこで黙ったまま」を見つける。
 * 純関数にしてあるのは、プロセスもハーネスも要らずに境目を試験で書けるようにするため。
 *
 * ## imp-0061: 自分で再起動を撃った会話も、ここが拾う
 *
 * 起きたこと: 番頭が `system.restart` を呼び、ホストは起動し直したのに、その会話は
 * 1本もターンが回らないまま黙った（thread-105。人が言伝で起こすまで）。回収の入口が
 * **2つとも空振りしていた**:
 *
 * - `settleInterrupted` は `state:"running"` の `system.restart` を探すが、`restart-tool.ts`
 *   は imp-0037 の直しで**結果を返してから落ちる**形になった——記録は `ok` で残るので、
 *   探しているものがもう発生しない（imp-0037 の直しが imp-0037 の検知器を無効にした）
 * - ここの判定は末尾の `tool` を「番頭が動いた証拠」に数えていたので、失われていないと
 *   判定していた
 *
 * そこで**末尾が道具・器なら中断とみなす**側へ広げた（`interruptedTail`）。`system.restart`
 * だけは意図した中断なので、投げ直す文を `RESTART_RESUME_NOTICE` に分ける。
 *
 * ## 判定
 *
 * 記録を**末尾から**辿り、最初に当たったものが
 *
 * - **道具の記録・器**（imp-0061）なら、そのターンは**そこで切れている**。詳しくは
 *   `interruptedTail`——正常に終わったターンは番頭の発言かエラーで終わる
 * - **番頭が動いた証拠**（本文・思考・error・枝の札・還った結論）なら、失われていない
 * - **外から入った一言**（PO の発話・別の会話からの言伝や seed・職人／工房／検証環境の
 *   知らせ・枝からの相談）なら、そのターンは失われている
 * - どちらでもない**印**（章の区切り・ホスト自身の書き置き）なら、読み飛ばして次を見る
 *
 * 印を読み飛ばすのは、**回収した印を自分で積むから**である。回収してもなお番頭が
 * 何も返さなければ、次の起動でまた同じ一言を拾う——それは許容する（黙って諦めるより、
 * 同じ一言がもう一度届くほうがまだ気づける）。
 *
 * ## 拾わないと決めたもの（取りこぼす側に倒す）
 *
 * `source: "system"` の知らせは**駆動しない側**に分類する。ホスト自身の書き置き
 * （章を畳んでいる断り・開き直しの印・回収の印）と、ターンを回す知らせ（`restart-tool.ts`
 * 等）が同じ `system` を名乗っていて、記録からは見分けが付かないため。誤って会話を
 * 起こすより、拾い損ねるほうを選ぶ——**幹の待ち状態を壊さない**（T3）ほうが重い。
 */

import type { TranscriptEntry } from "./protocol.js";
import { RESTART_RESUME_NOTICE, RESTART_TOOL_NAME, type Thread } from "./threads.js";

/**
 * 投げ直すときに頭へ付ける断り。
 *
 * 番頭は自分が落ちたことを知らない。断りが無いと、同じ一言が二度届いたようにしか
 * 見えず、「さっき答えたはず」と食い違う。
 */
export const LOST_TURN_PREFIX =
  "（前回の再起動で、この一言に対するターンが失われていました。あらためてお渡しします）";

/** 回収したことを会話の記録にも残す1行（人が「なぜ急に動いたか」を辿れるように）。 */
export const LOST_TURN_RECOVERED_NOTICE =
  "前回の再起動で、直前の一言に対するターンが失われていました。" +
  "その一言をあらためて番頭へ渡し直します（記録の重複ではありません）。";

/**
 * **道具を叩いた直後に切れたターン**を起こし直すときの断り（imp-0061）。
 *
 * 道具は**やり直させない**——結果は記録に残っており（`ok`／`failed`／確定した `failed`）、
 * 番頭はそれを読んだうえで続きを決められる。ここで「もう一度叩け」と言うと、
 * マージやコミットが二度走る。
 */
export const INTERRUPTED_TOOL_PREFIX =
  "（前回の起動で、道具を叩いた直後にターンが中断されていました。" +
  "道具の結果は会話の記録に残っています——同じ道具をやり直さず、中断した続きを進めてください）";

/** 道具で切れたターンを起こしたことを、会話の記録にも残す1行。 */
export const INTERRUPTED_TOOL_RECOVERED_NOTICE =
  "前回の起動で、道具を叩いた直後にターンが中断されていました。" +
  "中断した続きを番頭へ進めてもらいます（道具はやり直しません）。";

/**
 * **その知らせでターンが回る出所**。`deliverToThread` を通って番頭が起きるもの。
 *
 * `system` を入れないのは上の注記のとおり（見分けが付かないので取りこぼす側へ倒す）。
 */
const DRIVING_NOTICE_SOURCES: ReadonlySet<string> = new Set(["thread", "worker", "kobo", "env"]);

/**
 * **どの形で失われたか**。投げ直す文と、記録に残す印を分けるために持つ。
 *
 * - `input` … 外から一言が入ったのに、番頭が1本も回さないまま落ちた
 * - `restart` … 番頭が `system.restart` を自分で撃って、そのまま落ちた（**意図した中断**）
 * - `tool` … それ以外の道具を叩いた直後に切れた
 */
export type LostTurnKind = "input" | "restart" | "tool";

/** 見つかった「失われたターン」。 */
export interface LostTurn {
  /** どの形で失われたか。 */
  readonly kind: LostTurnKind;
  /** 失われた一言そのもの、または中断された道具の名前（ログと試験のため）。 */
  readonly original: string;
  /** 投げ直す本文。 */
  readonly message: string;
  /** 回収したことを会話の記録に残す1行。 */
  readonly notice: string;
}

/** 番頭が動いた証拠か（これが末尾側にあれば、ターンは失われていない）。 */
function isBantoResponse(entry: TranscriptEntry): boolean {
  switch (entry.role) {
    case "banto":
    case "reasoning":
    case "error":
    // 枝の札と還った結論は、番頭が `thread.open` / `thread.merge` を呼んだ跡である
    case "branch":
    case "branch_result":
      return true;
    default:
      return false;
  }
}

/**
 * **道具で終わっているなら、そのターンは中断されている**（imp-0061）。
 *
 * 正常に終わったターンは必ず番頭の発言（`banto`）かエラー（`error`）で終わる
 * ——道具で終わっているのは、結果を受け取ったあと（または受け取る前）に落ちた形である。
 * `state` は見ない：`ok`／`failed`／`running` のどれでも「そこで切れた」ことは変わらない。
 *
 * **`utsuwa`（`canvas.show` の器）も同じ扱いにする（採用）。** 器は番頭が道具の戻り値を
 * 載せたときにだけ積まれ、必ず道具の記録と対になって出る——器で終わっているのは
 * 「道具のあと、言葉を返す前に切れた」であって、道具で終わっているのと同じ形だから。
 *
 * **`reasoning`（思考）は入れない。** 思考で終わっている記録は落ちた形以外にも出る
 * （`durationMs` を後から書き足す・思考だけ出して空応答になったターンを空応答ガードが
 * 拾い直す）ので、ここに入れると起こさなくてよい会話まで起こす。imp-0061 の現物にも
 * その形は無い——広げるなら現物が出てからにする。
 */
function interruptedTail(entry: TranscriptEntry): LostTurn | undefined {
  if (entry.role === "utsuwa") {
    // 器には載せた道具の名が入っている（決定81(d) の `from`）ので、名指しはそこから取る
    const name = entry.utsuwa.from.tool;
    return {
      kind: "tool",
      original: name,
      message: `${INTERRUPTED_TOOL_PREFIX}\n\n中断された道具：${name}（結果は器に載っています）`,
      notice: INTERRUPTED_TOOL_RECOVERED_NOTICE,
    };
  }
  if (entry.role !== "tool") return undefined;
  /**
   * **自分で撃った再起動は、他と文言を分ける**（意図した中断）。
   *
   * `settleInterrupted`（`threads.ts`）が `running` の `system.restart` に対して出すのと
   * 同じ知らせを渡す——番頭から見て「どちらの入口で回収されたか」は違いを持たない。
   */
  if (entry.name === RESTART_TOOL_NAME) {
    return {
      kind: "restart",
      original: RESTART_TOOL_NAME,
      message: RESTART_RESUME_NOTICE,
      notice: RESTART_RESUME_NOTICE,
    };
  }
  return {
    kind: "tool",
    original: entry.name,
    message: `${INTERRUPTED_TOOL_PREFIX}\n\n中断された道具：${entry.name}（${entry.state}）`,
    notice: INTERRUPTED_TOOL_RECOVERED_NOTICE,
  };
}

/**
 * 外から入ってターンを起こす一言なら、その本文。そうでなければ undefined。
 *
 * `branch_note`（枝からの相談）は `thread.consult` が `nudge` で幹のターンを回すので、
 * ここも駆動する側。投げ直す文は道具が組み立てていた形に揃える——`nudge` には札とは
 * 別の文が渡っており、記録の `text` をそのまま投げると「どの枝からの何なのか」が落ちる。
 */
function drivingInput(entry: TranscriptEntry): string | undefined {
  if (entry.role === "po") return entry.text;
  if (entry.role === "notice") {
    return DRIVING_NOTICE_SOURCES.has(entry.source) ? entry.text : undefined;
  }
  if (entry.role === "branch_note") {
    const what = entry.kind === "question" ? "問い" : "報告";
    return (
      `枝「${entry.title}」からの${what}です：\n\n${entry.text}\n\n` +
      `（この枝はまだ開いています。返すなら thread.steer({ threadId: "${entry.branchId}", message: … })）`
    );
  }
  return undefined;
}

/**
 * 失われたターンを1本だけ見つける。
 *
 * @param entries 会話の記録（古い順）。`Thread.transcript` をそのまま渡す。
 * @returns 失われていれば投げ直す一言。無ければ undefined。
 */
export function findLostTurn(entries: readonly TranscriptEntry[]): LostTurn | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry) continue;
    // 道具・器で終わっている＝ターンがそこで切れている（imp-0061）
    const interrupted = interruptedTail(entry);
    if (interrupted) return interrupted;
    if (isBantoResponse(entry)) return undefined;
    const original = drivingInput(entry);
    if (original === undefined) continue; // どちらでもない印。読み飛ばす
    return {
      kind: "input",
      original,
      message: `${LOST_TURN_PREFIX}\n\n${original}`,
      notice: LOST_TURN_RECOVERED_NOTICE,
    };
  }
  return undefined;
}

/**
 * **失われたターンを起こし直す**（起動時に1回だけ呼ぶ）。
 *
 * 既にある2つの回収（`resumePendingTurn`＝最後が toolResult ／ `resumeAfterRestart`＝
 * `system.restart` を自分で呼んだ会話）の**3つ目**。それらが既に起こした会話は
 * `alreadyResumed` で外す——重ねると同じ話を2本進める。
 *
 * 起こすのは**失われたターンの宛先の会話だけ**。知らせを幹へ回し直したりはしない
 * （幹はいつでも PO の入力を受けられる待ち状態でいる・T3）。
 *
 * `nudge` を渡すこと（`notify` ではない）：知らせの行は**既に記録に残っている**
 * ——そこまでは走ってから落ちた——ので、`notify` を通すと同じ一言が二度積まれる。
 *
 * **1会話につき1本まで**。起こしてもなお番頭が何も返さなければ、次の起動でまた同じ
 * 一言を拾う（回収の印は「どちらでもない印」なので判定を塞がない）。黙って諦めるより、
 * もう一度届くほうが気づける、という判断。
 *
 * @returns 起こし直した会話の id（ログと試験のため）。
 */
export function recoverLostTurns(options: {
  threads: readonly Thread[];
  /** 既に別の回収が起こした会話。ここは触らない。 */
  alreadyResumed: ReadonlySet<string>;
  /** ターンだけ回す口（`server.nudge`）。**待たない**——起動をぶら下げない。 */
  nudge: (threadId: string, message: string) => Promise<void>;
  /** 何をしたかを出す口。既定は `console`。 */
  log?: (message: string) => void;
  onError?: (message: string) => void;
}): string[] {
  const log = options.log ?? ((m: string) => console.log(m));
  const onError = options.onError ?? ((m: string) => console.error(m));
  const woken: string[] = [];
  for (const thread of options.threads) {
    // 畳んだ会話は起こさない（開き直すまで話さない、が読み戻しの約束）
    if (thread.state === "closed") continue;
    if (options.alreadyResumed.has(thread.id)) continue;
    const lost = findLostTurn(thread.transcript);
    if (!lost) continue;
    // I2: なぜ急に動いたのかを人が辿れるように、会話の記録にも1行残す
    thread.record({ role: "notice", source: "system", text: lost.notice });
    log(
      `[banto] ${thread.id}: 前回の再起動で失われたターンを起こし直します` +
        `（${lost.original.slice(0, 40)}…）`
    );
    woken.push(thread.id);
    void options.nudge(thread.id, lost.message).catch((err: unknown) => {
      // I2: 起こせなかったことを黙らせない（また番頭が黙ったままになる）
      onError(`[banto] ${thread.id} の失われたターンを起こせませんでした: ${String(err)}`);
    });
  }
  return woken;
}
