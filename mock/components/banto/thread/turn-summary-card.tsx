"use client";

// ターンの終わりのまとめ（検討中のモック・2026-10-06）。
// 普通の AI の発言（地の文）と見分けがつくように、会話の幅いっぱいの「票」として出す。
// 3段：依頼（何を頼んだか）・結果（どうなったか）・あなたが決めること（返答の候補つき）。
// 候補を押すと入力欄に文が入る（送らない）。直してから人が送る。
import { useRef, useState } from "react";
import { useAui } from "@assistant-ui/react";
import { Check, CircleAlert, CircleCheck, CircleDashed, CircleX, ClipboardList, CornerDownLeft, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  OUTCOME_LABEL,
  type TurnOutcomeStatus,
  type TurnSummaryArgs,
  type TurnSummaryOption,
} from "@/lib/mock/turn-summary";

const STATUS_TONE: Record<TurnOutcomeStatus, { icon: LucideIcon; text: string; rule: string }> = {
  done: { icon: CircleCheck, text: "text-ok", rule: "border-l-ok" },
  partial: { icon: CircleDashed, text: "text-warn", rule: "border-l-warn" },
  failed: { icon: CircleX, text: "text-destructive", rule: "border-l-destructive" },
};

/** 入力欄へ文を入れる。候補で入れた文だけを入れ替え、人が打った文は消さない */
function useComposerFill() {
  const aui = useAui();
  const lastWritten = useRef<string | null>(null);
  return (lines: readonly string[], anchor: HTMLElement | null) => {
    const composer = aui.thread().composer();
    const current = composer.getState().text;
    const ours = lines.join("\n");
    // 人が手で書いた（または直した）文があれば、その下に足す
    const humanText = current !== "" && current !== lastWritten.current ? current : "";
    const next = humanText && ours ? `${humanText}\n${ours}` : humanText || ours;
    composer.setText(next);
    lastWritten.current = humanText ? null : next;
    // 同じパネルの入力欄に焦点を移し、末尾にカーソルを置く
    const panel = anchor?.closest("[data-slot='aui_thread-root'], .aui-thread-root") ?? document;
    const input = panel.querySelector<HTMLTextAreaElement>("textarea");
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
      disabled={disabled}
      title={option.reply}
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

export function TurnSummaryView({ summary, answered }: { summary: TurnSummaryArgs; answered: boolean }) {
  const fill = useComposerFill();
  // 判断ごとに選んだ候補（index）。次へ進むための文は選んだものを上から並べる
  const [picked, setPicked] = useState<Record<number, number>>({});
  const [pickedNext, setPickedNext] = useState<number | null>(null);
  const tone = STATUS_TONE[summary.outcome.status];
  const hasDecisions = summary.decisions.length > 0;

  const pickDecision = (di: number, oi: number, el: HTMLElement) => {
    const nextPicked = { ...picked };
    if (nextPicked[di] === oi) delete nextPicked[di];
    else nextPicked[di] = oi;
    setPicked(nextPicked);
    const lines = summary.decisions.flatMap((d, i) =>
      nextPicked[i] === undefined ? [] : [d.options[nextPicked[i]].reply],
    );
    fill(lines, el);
  };

  const pickNext = (i: number, el: HTMLElement) => {
    const next = pickedNext === i ? null : i;
    setPickedNext(next);
    fill(next === null ? [] : [summary.nextSuggestions![next].reply], el);
  };

  const remaining = summary.decisions.length - Object.keys(picked).length;

  return (
    <section
      aria-label="このターンのまとめ"
      data-slot="banto-turn-summary"
      className={cn(
        "@container my-4 overflow-hidden rounded-lg border border-l-4 border-border bg-card shadow-sm",
        // 人が決めることがあれば人の番の色、無ければ結果の色
        hasDecisions ? "border-l-turn" : tone.rule,
      )}
    >
      <header className="flex items-center gap-2 border-b border-border bg-surface-2 px-4 py-2">
        <ClipboardList className="size-4 text-ink-2" />
        <h3 className="text-sm font-semibold text-foreground">このターンのまとめ</h3>
        <span className="ml-auto text-xs text-ink-3">
          {summary.span.from}〜{summary.span.to}
        </span>
      </header>

      <div className="divide-y divide-border">
        <Row label="頼んだこと">
          <p className="text-md leading-snug font-semibold text-foreground">{summary.request.text}</p>
          {summary.request.said ? (
            <p className="mt-1 text-xs text-ink-3">
              {summary.request.said.at} のあなたの発言「{summary.request.said.text}」を、前の話から読み替えています
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
              {summary.outcome.points.map((p) => (
                <li key={p}>{p}</li>
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
              {summary.outcome.artifacts.map((a) => (
                <div key={a.label} className="contents">
                  <dt className="text-ink-3">{a.label}</dt>
                  <dd className="min-w-0 truncate text-ink-2">{a.detail}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </Row>

        {hasDecisions ? (
          <Row label="決めること" tone="turn">
            <ol className="flex flex-col gap-3">
              {summary.decisions.map((d, di) => (
                <li key={d.question} className="flex flex-col gap-1.5">
                  <p className="text-sm font-semibold text-foreground">
                    {summary.decisions.length > 1 ? <span className="mr-1 text-turn">{di + 1}.</span> : null}
                    {d.question}
                  </p>
                  {d.context ? <p className="text-xs leading-relaxed text-ink-2">{d.context}</p> : null}
                  <div className="flex flex-wrap gap-1.5">
                    {d.options.map((o, oi) => (
                      <OptionButton
                        key={o.label}
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
                : remaining > 0 && Object.keys(picked).length > 0
                  ? `入力欄に入れました。あと ${remaining} つ決めると全部そろいます`
                  : "押すと入力欄に入ります。直してから送れます"}
            </p>
          </Row>
        ) : summary.nextSuggestions?.length ? (
          <Row label="次に頼めること">
            <div className="flex flex-wrap gap-1.5">
              {summary.nextSuggestions.map((o, i) => (
                <OptionButton
                  key={o.label}
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
