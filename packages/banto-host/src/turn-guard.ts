/**
 * 空応答ガード（imp-0016 の再発防止）。
 *
 * 2026-08-02、番頭ホストがツールコール（git status / file.read など）を実行した後、
 * 次の LLM 応答が生成されず、UI の送信ボタンが「送る」（＝アイドル）のまま停止する
 * 事象が起きた。調査の結論（検証済み）:
 *
 * - pi（@mariozechner/pi-coding-agent）の agent-loop は、ツールコール結果を context に
 *   入れた後も継続ターンを要求するが、次の LLM 応答が「空」（content に text も toolCall
 *   も無い、stopReason: "stop"）だと、それを異常と検出せず正常終了としてターンを閉じる。
 * - pi の自動リトライ（agent-session.js の `_isRetryableError`）は stopReason "error" の
 *   エラーパターン（overload/429/5xx/network）のみ対象で、stopReason "stop" の空応答は
 *   リトライされない。
 * - モデル/プロキシ（mimo-v2.5 / opencode-go 等）が思考のみ出力して content なしで stop
 *   し得る（deepseek 系思考フォーマット）。
 * - pi の `Agent` には `continue(): Promise<void>` があり、これで空応答後の再試行ができる。
 *
 * このモジュールはその防御を提供する:
 * - 判定は純関数（isEmptyResponse / isRetryableEmptyResponse）に分離し、実プロバイダを
 *   呼ばずにユニットテストできる形にする
 * - `withEmptyResponseGuard` は pi の AgentSession を包み、prompt() のターン進行に再試行を
 *   統合する。server.ts は HostSession 契約（ADR-0010 決定3）のまま無変更でよい
 *
 * D5: 判断ロジックはここに置き、配信層（server.ts）には書かない。ターン制御は番頭の
 *     core job（D11）だが、ハーネス差し替え可能性の契約は壊さず、bin.ts が適用するだけ。
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Message, ToolResultMessage } from "@mariozechner/pi-ai";
import type { HostSession } from "./server.js";

/** 空応答の再試行上限。超えたらエラーとして打ち切る（I2: 握りつぶさない）。 */
export const EMPTY_RESPONSE_MAX_RETRIES = 3;

/**
 * 復元されたセッションの中断ターンを再開する（imp-0016 の主対策）。
 *
 * 実機証跡で判明した真因: ツール結果後の LLM 応答生成中に banto プロセスが再起動されると、
 * pi のセッション復元は**完了済みメッセージのみ**で進行中ターンは復元されない。最後の
 * メッセージが toolResult のまま = ツール結果を受けた後の継続応答が生成されずに中断、
 * 番頭は黙ったままになる。
 *
 * 判定: 履歴（agent.state.messages。復元時に SessionManager から読み込まれる）の最後の
 * メッセージが toolResult かどうか——ツール結果が context に入った状態で応答が止まった
 * 証拠。該当すれば pi の `Agent.continue()` で続きのターンを生成する
 * （agent.d.ts の契約: 最後のメッセージは user か tool-result でなければならない）。
 *
 * @returns ターンを再開したら true。対象外（履歴なし・最後が assistant/user 等）なら false。
 */
export async function resumeInterruptedTurn(session: GuardableSession): Promise<boolean> {
  const messages = session.agent.state.messages;
  const last = messages[messages.length - 1];
  if (!last) return false;
  if ((last as Message).role !== "toolResult") return false;
  await session.agent.continue();
  return true;
}

/**
 * 応答が「空」か（content に text も toolCall も無い）。
 *
 * thinking のみの応答は空とみなす——imp-0016 のケースは、モデルが思考だけ出力して
 * content なしで stop したもの（deepseek 系思考フォーマット）。text が 1 文字でも
 * toolCall が 1 つでもあれば空ではない。
 */
export function isEmptyResponse(message: AssistantMessage): boolean {
  return !message.content.some((c) => c.type === "text" || c.type === "toolCall");
}

/**
 * 空応答ガードの3条件（すべて満たしたとき再試行する）。
 *
 * 1. ツールコールが実行され、そのツール結果が context に入っている
 *    （「直前のアシスタントメッセージに toolCall があり、そのツール結果が context に
 *    入っている」を、ツール結果が context に残っている限り true が続く形で扱う。
 *    再試行ターンは直前が空応答ターンになるため、ターン単位で切ると再試行自体を
 *    検出できなくなる）
 * 2. 今回の応答メッセージの content に text も toolCall も無い（空）
 * 3. stopReason が "stop"（"error" / "aborted" は pi が既にエラーとして扱う）
 */
export function isRetryableEmptyResponse(toolResultsInContext: boolean, message: AssistantMessage): boolean {
  if (message.stopReason !== "stop") return false;
  if (!toolResultsInContext) return false;
  return isEmptyResponse(message);
}

/**
 * 履歴の末尾から走査して、最初に見つかった「空の assistant メッセージ」の index を返す。
 * 無ければ -1。再試行（continue）の前に空応答を履歴から除くために使う。
 */
export function findLastEmptyAssistantIndex(messages: readonly AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Message;
    if (m.role !== "assistant") continue;
    return isEmptyResponse(m as AssistantMessage) ? i : -1;
  }
  return -1;
}

/**
 * ガードを掛ける対象の最小契約。pi の `AgentSession` は構造的にこれを満たす
 * （server が依存する HostSession 契約に、再試行に必要な `agent` を足した形）。
 * 契約を狭く保つことで、テストは実プロバイダを呼ばずに偽セッションで検証できる。
 */
export interface GuardableSession {
  readonly sessionId: string;
  readonly isStreaming: boolean;
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(text: string, options?: Parameters<HostSession["prompt"]>[1]): Promise<void>;
  abort(): Promise<void>;
  /** モデルの差し替え（対応するハーネスだけ）。ガードは素通しする。 */
  setModel?(model: unknown): Promise<void>;
  readonly agent: {
    readonly state: { messages: AgentMessage[] };
    continue(): Promise<void>;
  };
}

/**
 * pi の AgentSession を包み、「ツール実行後の空応答」を continue() で再試行する。
 *
 * 返り値は HostSession 契約のまま（server.ts は無変更）。再試行はここで完結するので、
 * クライアントから見ると 1 つのターン（prompt 1 回 → turn_end 1 回）に見え、
 * 不自然な重複イベントは出ない。
 *
 * 上限（EMPTY_RESPONSE_MAX_RETRIES）を超えたらエラーとして throw し、呼び出し側
 * （server の prompt/notify ハンドラ）がログと turn_end の errorMessage に載せる。
 */
export function withEmptyResponseGuard(session: GuardableSession): HostSession {
  // ツールコールが実行され、そのツール結果が context に入っているか。
  // pi の turn_end イベントは `{ message, toolResults }` を持ち、toolResults がそのターンで
  // 実行されたツール結果（agent-loop.js の emit を確認済み）。いったん true になったら次の
  // prompt() まで維持する——空応答ターンや再試行ターンは toolResults が空でも、ツール結果は
  // context に残っているから（指示の条件1）
  let toolResultsInContext = false;
  // いまの prompt() の中で「ツール実行後の空応答」が検出されたか。prompt() の戻り後に読む。
  // prompt() ごとにリセットする
  let emptyResponseDetected = false;

  session.subscribe((event) => {
    const e = event as { type?: string; message?: unknown; toolResults?: unknown } | null;
    if (e?.type !== "turn_end") return;
    const message = e.message as Message;
    if (message.role !== "assistant") return;
    if (isRetryableEmptyResponse(toolResultsInContext, message)) {
      emptyResponseDetected = true;
    }
    const toolResults = e.toolResults as ToolResultMessage[] | undefined;
    if ((toolResults?.length ?? 0) > 0) toolResultsInContext = true;
  });

  return {
    get sessionId(): string {
      return session.sessionId;
    },
    get isStreaming(): boolean {
      return session.isStreaming;
    },
    subscribe: (listener) => session.subscribe(listener),
    prompt: async (text, options) => {
      // prompt() ごとにリセット。この prompt() の最初の turn_end から監視し直す
      toolResultsInContext = false;
      emptyResponseDetected = false;
      let retries = 0;

      // 初回は prompt()。pi はツール結果を context に入れた後も継続ターンを要求するが、
      // 次の応答が空（stopReason: "stop"）だと正常終了としてターンを閉じてしまう
      // （imp-0016）。空応答が検出されたら、空応答を履歴から除いて continue() で
      // 同じターンを続ける
      await session.prompt(text, options);
      while (emptyResponseDetected) {
        if (retries >= EMPTY_RESPONSE_MAX_RETRIES) {
          // I2: 空応答を黙って握りつぶさない。打ち切ってエラーとして伝える
          throw new Error(
            `ツール実行後の継続応答が ${EMPTY_RESPONSE_MAX_RETRIES + 1} 回連続で空でした` +
              `（stopReason: "stop"、text/toolCall なし）。空応答ガードが再試行を打ち切りました`
          );
        }
        retries += 1;
        console.error(
          `[banto-host] 空応答ガード: ツール実行後の継続ターンが空応答（stopReason: "stop"）でした。` +
            `${retries}/${EMPTY_RESPONSE_MAX_RETRIES} 回目の再試行を continue() で行います`
        );
        removeLastEmptyAssistantMessage(session);
        emptyResponseDetected = false;
        await session.agent.continue();
      }
    },
    abort: () => session.abort(),
    // **包むと消える口を作らない**——ここは手で組み立てた object なので、
    // 足した契約を書き写さないと、ガードを通した瞬間に「対応していない」ことになる
    ...(session.setModel
      ? { setModel: (model: unknown): Promise<void> => session.setModel!(model) }
      : {}),
  };
}

/**
 * 履歴末尾の空 assistant メッセージを除く。
 *
 * pi の `Agent.continue()` は最後のメッセージが assistant だと拒否する
 * （agent.d.ts の continue 契約: "The last message must be a user or tool-result message"）。
 * 空応答を除いた後の最後はツール結果かユーザー発話なので、continue() が動く。
 * AgentState.messages のセッタは配列をコピーして保存する（types.d.ts の契約）。
 */
function removeLastEmptyAssistantMessage(session: GuardableSession): void {
  const index = findLastEmptyAssistantIndex(session.agent.state.messages);
  if (index === -1) return;
  const next = [...session.agent.state.messages];
  next.splice(index, 1);
  session.agent.state.messages = next;
}
