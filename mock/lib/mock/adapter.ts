// Thread ごとの台本を再生するダミーの ChatModelAdapter。
// 累積スナップショットを毎回 yield する（差分ではない）——実測されたドキュメントの注意点：
// tool 呼び出しは配列の外の状態として持たなくても、累積 parts 配列を作り直す形で保てば、
// 文字だけの chunk が来たときに tool カードが消える事故は起きない（parts を毎回複製するため）。
import type { ChatModelAdapter, ThreadAssistantMessagePart, ThreadMessage } from "@assistant-ui/react";
import type { ReadonlyJSONObject } from "assistant-stream/utils";
import { addInboxItem, removeInboxItem } from "./inbox";
import { getThreadPermissionMode } from "./permission-mode";
import { isRelayApproved, relayCacheKey, type MockRelayRequest } from "./relay-approval";
import { notifyMockStoreChange } from "./store-events";
import type { MockScript, MockStep, MockThread } from "./types";

// useLocalRuntime の unstable_humanToolNames と合わせる（thread-panel.tsx）
export const HUMAN_TOOL_NAME = "banto_ask";

// Shell Module（v4-modules.md §2.3）の唯一の tool。会話内のインラインカード
// （ShellCommandCard）はこの名前で分岐する——resource を持たない Shell には
// InlineModuleView（Module の Canvas コンテンツを埋め込む経路）が無いため、
// 専用の表示を持つ
export const SHELL_RUN_COMMAND_TOOL_NAME = "banto_shell_run_command";

// 承認ゲートを通りうる tool 名。unstable_humanToolNames にも含める
// （thread-panel.tsx）——「承認専用の別 tool」は作らない：承認ゲートは
// `canUseTool` の一般機構であって、tool の側が承認用に分裂するものではない
// （Shell の tool は runCommand 1本だけ、v4-modules.md §2.3）。
// 実測で分かったこと（規則1）：assistant-ui の `approval` フィールド／
// `respondToApproval` は「承認された直後、次の run() が同じ round trip の中で
// 結果を返す」前提で shouldContinue が組まれており（承認済みでも result が
// 無ければ do-while が回り続ける）、こちらの資産（コンポーネントの副作用で
// 後から addResult する形）とは相性が悪く、二重に _runLoop が走って
// スタックする事故を実測で踏んだ。**human tool とまったく同じ枠組み**
// （unstable_humanToolNames + addResult）に統一することで、既に動作確認済みの
// 経路だけを使う（規則12——一度ハマった機構をもう一度別の形で作り直さない）
// host が中継する Module 間の呼び出し（v4-architecture.md §2.5）。Runner の tool 一覧には
// 載らない（visibility: module）ので、これは「AI が呼んだ tool」ではなく
// **host 自身が発生源の判断待ち**である——会話の中に出すために、他と同じ
// tool 呼び出しの器に載せているだけ
export const MODULE_RELAY_TOOL_NAME = "banto_module_relay";

export const APPROVAL_TOOL_NAMES: readonly string[] = [
  SHELL_RUN_COMMAND_TOOL_NAME,
  MODULE_RELAY_TOOL_NAME,
];

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("aborted", "AbortError"));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function chunksOf(text: string, size = 3): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function pickReply(script: MockScript, userText: string): readonly MockStep[] {
  for (const r of script.replies) {
    if (r.match === "*") continue;
    if (r.match.test(userText)) return r.steps;
  }
  const fallback = script.replies.find((r) => r.match === "*");
  return fallback?.steps ?? [{ t: "text", text: "（ダミー応答）" }];
}

function lastUserText(messages: readonly ThreadMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === "user");
  if (!last) return "";
  return last.content
    .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

/** 累積 parts。yield のたびにこの配列のコピーを返す。 */
class PartsAccumulator {
  private parts: ThreadAssistantMessagePart[] = [];

  appendText(chunk: string) {
    const last = this.parts[this.parts.length - 1];
    if (last && last.type === "text") {
      this.parts[this.parts.length - 1] = { ...last, text: last.text + chunk };
    } else {
      this.parts.push({ type: "text", text: chunk });
    }
  }

  startTool(step: Extract<MockStep, { t: "tool" }>, toolCallId: string) {
    this.parts.push({
      type: "tool-call",
      toolCallId,
      toolName: step.name,
      args: step.args,
      argsText: JSON.stringify(step.args),
    });
    if (step.inlineView) toolInlineViews.set(toolCallId, step.inlineView);
    if (step.fullscreenView) toolFullscreenViews.set(toolCallId, step.fullscreenView);
  }

  // 人に聞く tool 呼び出し。result を付けない——unstable_humanToolNames により
  // ランタイムがこれを requires-action のまま止め、addResult が渡ってくる
  startHumanTool(step: Extract<MockStep, { t: "human" }>, toolCallId: string) {
    this.parts.push({
      type: "tool-call",
      toolCallId,
      toolName: HUMAN_TOOL_NAME,
      // MockElicitationForm/Url は string index signature を持たないプレーンな
      // interface なので、tool-call の args（ReadonlyJSONObject）としては構造的に
      // 弾かれる——中身は JSON 互換なので unknown 経由でキャストする
      args: { serverName: step.serverName, message: step.message, elicitation: step.elicitation } as unknown as ReadonlyJSONObject,
      argsText: JSON.stringify({ serverName: step.serverName, message: step.message }),
    });
  }

  finishTool(toolCallId: string, result: unknown) {
    const idx = this.parts.findIndex((p) => p.type === "tool-call" && p.toolCallId === toolCallId);
    if (idx === -1) return;
    const part = this.parts[idx];
    if (part.type !== "tool-call") return;
    this.parts[idx] = { ...part, result };
  }

  // 承認ゲート。human tool とまったく同じ形——result を付けずに置き、
  // unstable_humanToolNames が requires-action のまま止める。承認/拒否は
  // カード側（ApprovalToolCard）が addResult を直接呼ぶ（human tool の
  // ElicitationFormView と同じ経路）。§6.0 の要求（呼ぶ前に見せて拒否できる）は
  // 「result が付くまで実行されていない」という状態そのもので表現できる——
  // 見た目だけ承認ゲート用に変える
  startApprovalTool(
    step: Extract<MockStep, { t: "approval" }>,
    toolCallId: string,
    grantedResult: unknown,
  ) {
    this.parts.push({
      type: "tool-call",
      toolCallId,
      toolName: step.name,
      args: step.args,
      argsText: JSON.stringify(step.args),
    });
    approvalResults.set(toolCallId, grantedResult);
  }

  // host 中継の承認（入れ子の承認）。人に聞く場合は result を付けずに置き
  // （requires-action のまま止まる）、既に承認済みの組み合わせなら結果付きで置く
  // ——後者はカードが「自動承認」の見た目で出す
  startRelay(req: MockRelayRequest, toolCallId: string, cacheKey: string, autoApproved: boolean) {
    relayRequests.set(toolCallId, { ...req, cacheKey });
    this.parts.push({
      type: "tool-call",
      toolCallId,
      toolName: MODULE_RELAY_TOOL_NAME,
      args: { caller: req.caller, target: req.target, tool: req.tool, reason: req.reason },
      argsText: JSON.stringify(req),
      ...(autoApproved ? { result: { decision: "auto-approved" } } : {}),
    });
  }

  snapshot(): readonly ThreadAssistantMessagePart[] {
    return [...this.parts];
  }
}

/**
 * toolCallId → 承認されたときに返す結果。カード側（ApprovalToolCard）が
 * addResult に渡す値をここから読む——アダプタの外（描画側）から参照するため
 * module-level に持つ（toolCallSeq と同じ理由）。
 */
const approvalResults = new Map<string, unknown>();

export function getApprovalResult(toolCallId: string): unknown {
  return approvalResults.get(toolCallId);
}

/**
 * この tool 呼び出しが承認ゲート経由か（＝人が許可するまで実行されていない）。
 * カード側は、同じ tool でも「承認待ちの見た目」と「実行後の見た目」を
 * これで切り替える——承認用の別 tool を作らないので、判別はここでしかできない
 */
export function isApprovalGated(toolCallId: string): boolean {
  return approvalResults.has(toolCallId);
}

/**
 * permissionMode が `bypassPermissions` だったため、承認ゲートを作らずに
 * そのまま実行した呼び出し（v4-frontend.md §6.4）。カード側が「確認を
 * スキップした」と分かる印を出すためだけに持つ——判断そのものは
 * `createMockChatModelAdapter` の中で1回行う
 */
const bypassedApprovals = new Set<string>();

export function wasApprovalBypassed(toolCallId: string): boolean {
  return bypassedApprovals.has(toolCallId);
}

/**
 * 中継の承認は会話中のカードと受信箱の両方に出る（他の判断待ちと同じ二重の出し方）。
 * 会話側で答えたら受信箱からも取り除くので、id は toolCallId から導く（規則3）
 */
export function relayInboxItemId(toolCallId: string): string {
  return `relay-${toolCallId}`;
}

/** toolCallId → その中継呼び出しの中身（カード側 RelayApprovalCard が読む） */
const relayRequests = new Map<string, MockRelayRequest & { cacheKey: string }>();

export function getRelayRequest(toolCallId: string): (MockRelayRequest & { cacheKey: string }) | undefined {
  return relayRequests.get(toolCallId);
}

/**
 * 外側の tool（Shell の runCommand）の結果は、内側の中継が解決してから届く
 * ——承認された瞬間にこの印を result として置き、実際の出力は中継の決着後に
 * `deliveredResults` へ入れる。カードはこの印を見て「実行中（中継の確認待ち）」を出す。
 * assistant-ui のメッセージは追記しかできない（過去の part の result を後から
 * 書き換えられない、実測）ので、後から届く値だけはこちら側の store に持つ
 */
export const PENDING_RELAY_RESULT = { pending: "module-relay" } as const;

export function isPendingRelayResult(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { pending?: unknown }).pending === PENDING_RELAY_RESULT.pending
  );
}

/** 中継の決着待ちの間、外側の tool が返すはずの結果を預かる */
const heldResults = new Map<string, unknown>();
const deliveredResults = new Map<string, unknown>();

export function getDeliveredResult(toolCallId: string): unknown {
  return deliveredResults.get(toolCallId);
}

function deliverHeldResult(toolCallId: string | null): void {
  if (!toolCallId) return;
  if (!heldResults.has(toolCallId)) return;
  deliveredResults.set(toolCallId, heldResults.get(toolCallId));
  heldResults.delete(toolCallId);
  notifyMockStoreChange();
}

/** いま結果待ちのまま止まっている外側の tool 呼び出し（進行中のメッセージから探す） */
function findHeldToolCallId(current: ThreadMessage): string | null {
  if (current.role !== "assistant") return null;
  const parts = current.content as readonly ThreadAssistantMessagePart[];
  for (const p of parts) {
    if (p.type === "tool-call" && isPendingRelayResult(p.result) && heldResults.has(p.toolCallId)) {
      return p.toolCallId;
    }
  }
  return null;
}

/**
 * toolCallId → inline 表示する Module の Canvas コンテンツ（§6.2 の display mode
 * "inline"）。カード側（InlineModuleView）がここから読む。
 */
const toolInlineViews = new Map<string, { moduleId: string; viewId: string }>();

export function getInlineView(toolCallId: string): { moduleId: string; viewId: string } | undefined {
  return toolInlineViews.get(toolCallId);
}

/**
 * toolCallId → tool 呼び出し自身が fullscreen を要求した Canvas
 * （§6.2 軸2「AIのtool呼び出し」行）。結果が揃ったら banto が自動で Canvas を開く。
 */
const toolFullscreenViews = new Map<string, { moduleId: string; viewId: string }>();

export function getFullscreenView(toolCallId: string): { moduleId: string; viewId: string } | undefined {
  return toolFullscreenViews.get(toolCallId);
}

/**
 * 人の答えを待って止まった tool 呼び出し（human・承認ゲート・host 中継の承認）の
 * toolCallId → 「答えが付いたら steps のどこから再開するか」。
 * **1つの応答に待ちが2つ以上ある**（runCommand の承認 → その内側の中継の承認）
 * ようになったので、「最初の human/approval ステップを探す」形では足りない
 * ——待ちを作った時点で再開位置を持たせ、進行中のメッセージから
 * 「答えが付いた待ち」の再開位置の最大を取る。
 */
const gateResumeIndex = new Map<string, number>();

let toolCallSeq = 0;

export function createMockChatModelAdapter(thread: MockThread): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal, unstable_getMessage }) {
      const steps = pickReply(thread.script, lastUserText(messages));
      const acc = new PartsAccumulator();

      // 人への問いにすでに answer が付いていれば、続きの steps だけを再開する
      // （addResult のあとにランタイムが run() を呼び直す）。
      // ランタイム側で「このメッセージの既存 content」＋「今回 yield する content」
      // を連結する（local-thread-runtime-core.ts の updateMessage、実測で踏んだ）
      // ので、ここで手前の parts を作り直して二重に返してはいけない
      // ——toolCallId が重複し React の key 衝突で落ちる。
      // 進行中のメッセージ（まだ requires-action）は messages に現れないので
      // unstable_getMessage() で取る（これも実測で踏んだ）
      const current = unstable_getMessage();
      const currentParts =
        current.role === "assistant" ? (current.content as readonly ThreadAssistantMessagePart[]) : [];
      let resumeFrom = 0;
      let relayDeclined = false;
      for (const p of currentParts) {
        if (p.type !== "tool-call" || p.result === undefined) continue;
        const next = gateResumeIndex.get(p.toolCallId);
        if (next !== undefined && next > resumeFrom) resumeFrom = next;
        // 中継が決着したら、待たせていた外側の tool（runCommand）の結果をここで届ける
        if (p.toolName === MODULE_RELAY_TOOL_NAME) {
          // 会話の側で答えたので、受信箱に積んだ同じ判断待ちも取り下げる
          removeInboxItem(relayInboxItemId(p.toolCallId));
          const heldId = findHeldToolCallId(current);
          if (heldId) {
            if (typeof p.result === "object" && p.result !== null && "error" in p.result) {
              relayDeclined = true;
              heldResults.set(heldId, { error: "中継を拒否したので、コマンドは実行していません" });
            }
            deliverHeldResult(heldId);
          }
        }
      }
      // 中継を拒否したなら、そこで止まる（規則2：黙って別の経路へ落ちない）
      if (relayDeclined) {
        for (const chunk of chunksOf("中継が拒否されたので、ここで止めます。")) {
          acc.appendText(chunk);
          yield { content: acc.snapshot() };
        }
        return;
      }

      // 直前の tool 呼び出しの結果を、この run の中で中継の決着まで待たせている場合に使う
      let heldInThisRun: string | null = null;

      try {
        for (let stepIndex = resumeFrom; stepIndex < steps.length; stepIndex++) {
          const step = steps[stepIndex];
          if (step.t === "delay") {
            await sleep(step.ms, abortSignal);
            continue;
          }
          if (step.t === "text") {
            for (const chunk of chunksOf(step.text)) {
              acc.appendText(chunk);
              yield { content: acc.snapshot() };
              await sleep(step.charMs ?? 15, abortSignal);
            }
            continue;
          }
          if (step.t === "tool") {
            const toolCallId = `tool-${++toolCallSeq}`;
            acc.startTool(step, toolCallId);
            yield { content: acc.snapshot() };
            await sleep(step.runMs ?? 500, abortSignal);
            acc.finishTool(toolCallId, step.result);
            yield { content: acc.snapshot() };
          }
          if (step.t === "human") {
            const toolCallId = `tool-${++toolCallSeq}`;
            gateResumeIndex.set(toolCallId, stepIndex + 1);
            acc.startHumanTool(step, toolCallId);
            // status を明示しないと、generator が return した時点でランタイムが
            // 「running のまま終わった」と見なし complete に確定してしまう
            // （@assistant-ui/core の local-thread-runtime-core、実測で踏んだ）。
            // requires-action・reason "tool-calls" を明示して初めて、
            // unstable_humanToolNames が「このtoolは人が結果を出すまで止める」と扱う
            yield { content: acc.snapshot(), status: { type: "requires-action", reason: "tool-calls" } };
            return;
          }
          if (step.t === "approval") {
            const toolCallId = `tool-${++toolCallSeq}`;
            gateResumeIndex.set(toolCallId, stepIndex + 1);
            // 直後に中継のステップがあるなら、この tool のハンドラは内側で
            // 別 Module を呼ぶ——結果はその中継が決着してから届く（外側は
            // 「電話を切らずに待つ」）
            const holdsResult = steps[stepIndex + 1]?.t === "relay";
            const grantedResult: unknown = holdsResult ? PENDING_RELAY_RESULT : step.result;
            if (holdsResult) {
              heldResults.set(toolCallId, step.result);
              heldInThisRun = toolCallId;
            }
            // permissionMode が bypassPermissions のときは承認ゲートを作らず、
            // 普通の tool 呼び出しと同じようにそのまま実行する
            // （v4-frontend.md §6.4——素通りするのは `canUseTool` だけ。
            // 内側の中継の承認は下の relay ステップで必ず行う）
            if (getThreadPermissionMode(thread.id, thread.projectId) === "bypassPermissions") {
              bypassedApprovals.add(toolCallId);
              acc.startTool({ t: "tool", name: step.name, args: step.args, result: step.result }, toolCallId);
              yield { content: acc.snapshot() };
              await sleep(500, abortSignal);
              acc.finishTool(toolCallId, grantedResult);
              yield { content: acc.snapshot() };
              continue;
            }
            acc.startApprovalTool(step, toolCallId, grantedResult);
            yield { content: acc.snapshot(), status: { type: "requires-action", reason: "tool-calls" } };
            return;
          }
          if (step.t === "relay") {
            // host 中継の承認（入れ子の承認）。**permissionMode は見ない**
            // ——AI への信用（permissionMode）と Project の内部配線への信用は
            // 別の軸で、bypassPermissions を選んでもこの確認は省略しない
            const req: MockRelayRequest = {
              caller: step.caller,
              target: step.target,
              tool: step.tool,
              reason: step.reason,
            };
            const cacheKey = relayCacheKey(thread.projectId, req);
            const toolCallId = `tool-${++toolCallSeq}`;
            const autoApproved = isRelayApproved(cacheKey);
            acc.startRelay(req, toolCallId, cacheKey, autoApproved);
            yield { content: acc.snapshot() };
            if (autoApproved) {
              // 同じ組み合わせは Project 内で承認済み——待たせずに中継が通る
              await sleep(400, abortSignal);
              deliverHeldResult(heldInThisRun ?? findHeldToolCallId(current));
              heldInThisRun = null;
              continue;
            }
            gateResumeIndex.set(toolCallId, stepIndex + 1);
            // 会話中のインラインカードと受信箱、両方に出す（他の判断待ちと同じ二重の出し方）
            addInboxItem({
              kind: "judgment",
              source: "elicitation",
              id: relayInboxItemId(toolCallId),
              projectId: thread.projectId,
              serverName: req.caller,
              threadId: thread.id,
              threadKind: thread.kind,
              message: `${req.caller} が ${req.target} の ${req.tool} を呼び出そうとしています`,
              age: "たった今",
              elicitation: { mode: "form", enumOptions: ["許可する", "拒否する"], allowFreeText: false },
              status: "live",
            });
            yield { content: acc.snapshot(), status: { type: "requires-action", reason: "tool-calls" } };
            return;
          }
        }
      } catch (err) {
        // interrupt() による中断（規則2：止めたターンは流れてきた分をそのまま返す。
        // §2.3 の実測どおり、そこまでの出力を握りつぶさない）。
        // run() の戻り値型は void なので、最後の yield が最終状態として扱われる
        if (err instanceof DOMException && err.name === "AbortError") {
          yield { content: acc.snapshot() };
          return;
        }
        throw err;
      }
    },
  };
}
