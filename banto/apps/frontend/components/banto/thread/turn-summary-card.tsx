"use client";

// **ターンの終わりのまとめ**（決定・2026-10-06、ユーザー。v4-frontend.md §6.35）。
//
// AI が `report_turn` で渡したものを、そのターンの AI の発言の一番下に「票」として出す。普通の発言（地の文）と見分けが
// つくように会話の幅いっぱいの枠で、3段：頼んだこと・結果・決めること（返答の候補つき）。
//
//  - 左の太い線は「人が何かする必要があるか」だけ（ユーザー決定）：決めることがあれば人の番の色、無ければ緑。結果の状態
//    （終わった／途中まで／できなかった）は「結果」の段の印と文字で出す
//  - 元の人の発言は AI に引用させず、会話の記録（このターンの前の人の発言）から取る
//  - 候補を押すと入力欄に文が入る（送らない）。判断が複数なら選んだものを上から1行ずつ。人が手で書いた文は消さずに下へ足す。
//    もう一度押すと外す。まとめの後ろに人の返事があれば押せなくする
//  - tool の折りたたみの中には出さない（human-tool-card.tsx が隠す）。発言の中のどこで呼ばれても一番下に置く。
//    1つの発言に何度呼ばれても最後の1つだけ
import { useRef, useState } from "react";
import { useAui, useAuiState } from "@assistant-ui/react";
import {
  Check,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  ClipboardList,
  CornerDownLeft,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  OUTCOME_LABEL,
  TURN_SUMMARY_TOOL_NAME,
  asTurnSummary,
  type TurnOutcomeStatus,
  type TurnSummary,
  type TurnSummaryOption,
} from "@/lib/turn-summary";

const STATUS_TONE: Record<TurnOutcomeStatus, { icon: LucideIcon; text: string }> = {
  done: { icon: CircleCheck, text: "text-ok" },
  partial: { icon: CircleDashed, text: "text-warn" },
  failed: { icon: CircleX, text: "text-destructive" },
};

/** 入力欄へ文を入れる。候補で入れた文だけを入れ替え、人が打った文は消さない */
function useComposerFill() {
  const aui = useAui();
  const lastWritten = useRef<string | null>(null);
  return (lines: readonly string[], anchor: HTMLElement | null) => {
    const composer = aui.thread().composer();
    const current = composer.getState().text;
    const ours = lines.join("\n");
    const humanText = current !== "" && current !== lastWritten.current ? current : "";
    const next = humanText && ours ? `${humanText}\n${ours}` : humanText || ours;
    composer.setText(next);
    lastWritten.current = humanText ? null : next;
    // 同じ会話の入力欄に焦点を移し、末尾にカーソルを置く
    const root = anchor?.closest(".aui-thread-root") ?? document;
    const input = root.querySelector<HTMLTextAreaElement>("textarea.aui-composer-input");
    if (input) {
      requestAnimationFrame(() => {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      });
    }
  };
}

function Row({ label, tone, children }: { label: string; tone?: "turn"; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-1 px-4 py-3 @md:grid-cols-[5.5rem_1fr] @md:gap-4",
        tone === "turn" && "bg-turn-soft/45",
      )}
    >
      <div className={cn("pt-0.5 text-xs font-semibold text-ink-3", tone === "turn" && "text-turn")}>{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function OptionButton({
  option,
  selected,
  disabled,
  onPick,
}: {
  option: TurnSummaryOption;
  selected: boolean;
  disabled: boolean;
  onPick: (el: HTMLElement) => void;
}) {
  return (
    <button
      type="button"
      data-testid="turn-summary-option"
      disabled={disabled}
      title={option.reply}
      aria-pressed={selected}
      onClick={(e) => onPick(e.currentTarget)}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50",
        selected
          ? "border-turn bg-turn text-on-color"
          : option.recommended
            ? "border-turn/60 bg-surface text-turn hover:bg-turn-soft"
            : "border-border bg-surface text-foreground hover:bg-surface-2",
      )}
    >
      {selected ? <Check className="size-3.5" /> : null}
      {option.label}
      {option.recommended && !selected ? <span className="text-xs text-turn/80">おすすめ</span> : null}
    </button>
  );
}

function timeOf(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

export function TurnSummaryView({
  summary,
  at,
  said,
  answered,
}: {
  summary: TurnSummary;
  /** host が受け付けた時刻（ISO）。走っている間は分からないので無い */
  at?: string;
  /** このターンの元になった人の発言（そのまま）。無ければ出さない */
  said?: string;
  answered: boolean;
}) {
  const fill = useComposerFill();
  const [picked, setPicked] = useState<Record<number, number>>({});
  const [pickedNext, setPickedNext] = useState<number | null>(null);
  const tone = STATUS_TONE[summary.outcome.status];
  const hasDecisions = summary.decisions.length > 0;

  const pickDecision = (di: number, oi: number, el: HTMLElement) => {
    const nextPicked = { ...picked };
    if (nextPicked[di] === oi) delete nextPicked[di];
    else nextPicked[di] = oi;
    setPicked(nextPicked);
    const lines = summary.decisions.flatMap((d, i) => {
      const chosen = nextPicked[i];
      return chosen === undefined ? [] : [d.options[chosen]!.reply];
    });
    fill(lines, el);
  };

  const pickNext = (i: number, el: HTMLElement) => {
    const next = pickedNext === i ? null : i;
    setPickedNext(next);
    fill(next === null ? [] : [summary.nextSuggestions![next]!.reply], el);
  };

  const pickedCount = Object.keys(picked).length;
  const remaining = summary.decisions.length - pickedCount;
  const time = timeOf(at);

  return (
    <section
      aria-label="このターンのまとめ"
      data-testid="turn-summary"
      data-outcome={summary.outcome.status}
      className={cn(
        "@container my-4 overflow-hidden rounded-lg border border-l-4 border-border bg-card shadow-sm",
        hasDecisions ? "border-l-turn" : "border-l-ok",
      )}
    >
      <header className="flex items-center gap-2 border-b border-border bg-surface-2 px-4 py-2">
        <ClipboardList className="size-4 text-ink-2" />
        <h3 className="text-sm font-semibold text-foreground">このターンのまとめ</h3>
        {time ? <span className="ml-auto text-xs text-ink-3">{time}</span> : null}
      </header>

      <div className="divide-y divide-border">
        <Row label="頼んだこと">
          <p data-testid="turn-summary-request" className="text-md leading-snug font-semibold text-foreground">
            {summary.request}
          </p>
          {said && said.trim() !== summary.request.trim() ? (
            <p className="mt-1 line-clamp-2 text-xs text-ink-3">
              {"あなたの発言「"}
              {said}
              {"」を、前の話から読み替えています"}
            </p>
          ) : null}
        </Row>

        <Row label="結果">
          <p className={cn("flex items-center gap-1.5 text-xs font-semibold", tone.text)}>
            <tone.icon className="size-3.5" aria-hidden />
            {OUTCOME_LABEL[summary.outcome.status]}
          </p>
          <p className="mt-1 text-sm leading-relaxed font-medium text-foreground">{summary.outcome.headline}</p>
          {summary.outcome.points.length > 0 ? (
            <ul className="mt-2 flex list-disc flex-col gap-1 pl-4 text-sm leading-relaxed text-ink-2 marker:text-ink-3">
              {summary.outcome.points.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          ) : null}
          {summary.outcome.notVerified?.length ? (
            <div className="mt-2 flex gap-1.5 rounded-md bg-warn-soft/60 px-2.5 py-1.5 text-sm text-ink-2">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />
              <div>
                <span className="font-medium text-warn">確かめていないこと：</span>
                {summary.outcome.notVerified.join("／")}
              </div>
            </div>
          ) : null}
          {summary.outcome.artifacts?.length ? (
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
              {summary.outcome.artifacts.map((a, i) => (
                <div key={i} className="contents">
                  <dt className="text-ink-3">{a.label}</dt>
                  <dd className="min-w-0 break-all text-ink-2">{a.detail}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </Row>

        {hasDecisions ? (
          <Row label="決めること" tone="turn">
            <ol className="flex flex-col gap-3">
              {summary.decisions.map((d, di) => (
                <li key={di} className="flex flex-col gap-1.5" data-testid="turn-summary-decision">
                  <p className="text-sm font-semibold text-foreground">
                    {summary.decisions.length > 1 ? <span className="mr-1 text-turn">{di + 1}.</span> : null}
                    {d.question}
                  </p>
                  {d.context ? <p className="text-xs leading-relaxed text-ink-2">{d.context}</p> : null}
                  <div className="flex flex-wrap gap-1.5">
                    {d.options.map((o, oi) => (
                      <OptionButton
                        key={oi}
                        option={o}
                        selected={picked[di] === oi}
                        disabled={answered}
                        onPick={(el) => pickDecision(di, oi, el)}
                      />
                    ))}
                  </div>
                </li>
              ))}
            </ol>
            <p className="mt-3 flex items-center gap-1 text-xs text-ink-3">
              <CornerDownLeft className="size-3" />
              {answered
                ? "このまとめのあとに返事をしています"
                : remaining > 0 && pickedCount > 0
                  ? `入力欄に入れました。あと ${remaining} つ決めると全部そろいます`
                  : "押すと入力欄に入ります。直してから送れます"}
            </p>
          </Row>
        ) : summary.nextSuggestions?.length ? (
          <Row label="次に頼めること">
            <div className="flex flex-wrap gap-1.5">
              {summary.nextSuggestions.map((o, i) => (
                <OptionButton
                  key={i}
                  option={o}
                  selected={pickedNext === i}
                  disabled={answered}
                  onPick={(el) => pickNext(i, el)}
                />
              ))}
            </div>
            <p className="mt-2 text-xs text-ink-3">決めてもらうことはありません。押すと入力欄に入ります</p>
          </Row>
        ) : null}
      </div>
    </section>
  );
}

/** このターンの元になった人の発言（届いたものなら、その題）。部品ごとに文字列で読む——配列を返すと再描画が止まらない */
function useSaidBefore(): string | undefined {
  return useAuiState((s) => {
    const messages = s.thread.messages;
    for (let i = s.message.index - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m || m.role !== "user") continue;
      const origin = (m.metadata?.custom as { origin?: { title?: string } } | undefined)?.origin;
      if (origin) return origin.title ? `（届いたもの）${origin.title}` : undefined;
      const text = m.content
        .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
        .map((p) => p.text)
        .join(" ")
        .trim();
      return text === "" ? undefined : text;
    }
    return undefined;
  });
}

/**
 * AI の発言の一番下（`AssistantMessageFooter`）。その発言の最後の `report_turn` を描く。無ければ何も描かない
 */
export function TurnSummaryFooter() {
  const index = useAuiState((s) => {
    const parts = s.message.parts;
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (p?.type !== "tool-call" || p.toolName !== TURN_SUMMARY_TOOL_NAME) continue;
      // 断られた（形が合わない）呼び出しは飛ばす——その前に受け付けたものがあればそれを出す
      const r = p.result as { error?: unknown } | undefined;
      if (r && typeof r === "object" && "error" in r) continue;
      return i;
    }
    return -1;
  });
  if (index < 0) return null;
  return <TurnSummaryForPart index={index} />;
}

function TurnSummaryForPart({ index }: { index: number }) {
  const part = useAuiState((s) => s.message.parts[index]);
  const isLast = useAuiState((s) => s.message.isLast);
  const said = useSaidBefore();
  // 走っている間（host が受け付ける前）は時刻が分からない——最初に描いた時刻で代える
  const [seenAt] = useState(() => new Date().toISOString());
  if (!part || part.type !== "tool-call") return null;
  const result = part.result as { at?: unknown } | undefined;
  const summary = asTurnSummary(part.args);
  if (!summary) return null;
  const at = result && typeof result === "object" && typeof result.at === "string" ? result.at : seenAt;
  return <TurnSummaryView summary={summary} at={at} said={said} answered={!isLast} />;
}
