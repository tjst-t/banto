"use client";

// Elicitation の mode:"form" / mode:"url" を受信箱の中で描く。
// 生きている間（Module 側のタイムアウト前）は、受信箱から答えても元の tool
// 呼び出しをそのまま解決できる——banto は手元に残る Promise を resolve するだけ。
// タイムアウト済みのものだけ、答えが次のターンへの新しい入力として渡る
// （v4-architecture.md §2.4.1、2026-08-31改訂：3状態を出し分ける）
import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { parseFieldValue } from "@/lib/form-fields";
import type { MockElicitationForm, MockElicitationUrl } from "@/lib/mock/types";

export function ElicitationFormView({
  elicitation,
  onAnswered,
  timedOut = false,
}: {
  elicitation: MockElicitationForm | MockElicitationUrl;
  /** `values`＝欄（`fields`）の値。許すボタン（最初の選択肢）を押したときだけ渡す */
  onAnswered: (answer: string, values?: Record<string, number>) => void | Promise<void>;
  /**
   * true：受信箱の項目が既にタイムアウト済み。答えると次のターンへの新しい
   * 入力として渡る旨を出す。false（既定）：まだ生きている（会話中のライブカード、
   * または受信箱でもタイムアウト前の項目）——元の tool 呼び出しを直接解決するので
   * 特別な説明は要らない。
   */
  timedOut?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      {timedOut ? (
        <p className="text-xs text-ink-3">
          この問いへの回答期限（tool 呼び出しの中）は既に過ぎています。ここで答えると、
          元の処理を直接再開するのではなく、次の会話ターンへの新しい指示として渡ります。
        </p>
      ) : null}
      {elicitation.mode === "url" ? (
        <ElicitationUrlView elicitation={elicitation} onAnswered={onAnswered} />
      ) : (
        <ElicitationFormFields elicitation={elicitation} onAnswered={onAnswered} />
      )}
    </div>
  );
}

function ElicitationFormFields({
  elicitation,
  onAnswered,
}: {
  elicitation: MockElicitationForm;
  onAnswered: (answer: string, values?: Record<string, number>) => void | Promise<void>;
}) {
  // **答えに添える数の欄**（任務の枠、v4-frontend.md §6.47）。既定の値を入れておき、許すボタンで一緒に送る
  const fields = elicitation.fields ?? [];
  const [texts, setTexts] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.name, f.default !== undefined ? String(f.default) : ""])),
  );
  const parsed = fields.map((f) => ({ field: f, result: parseFieldValue(f, texts[f.name] ?? "") }));
  const problems = parsed.flatMap((p) => ("problem" in p.result ? [p.result.problem] : []));
  const values = Object.fromEntries(parsed.flatMap((p) => ("value" in p.result ? [[p.field.name, p.result.value]] : [])));
  // **選択肢は押したらそのまま送る**（決定・2026-10-05、ユーザー要望）——以前は選んでから「この内容で送る」を
  // 押す2段で、承認のたびに2回押させていた。自由記述だけは打ち終わりが分からないので送るボタンを残す。
  // 2回押して二重に答えないよう、送ったら全部押せなくする（失敗したら呼び出し側が文言を出し、カードは出たまま）
  const [sending, setSending] = useState(false);
  const [freeText, setFreeText] = useState("");
  const send = async (answer: string, withValues?: Record<string, number>) => {
    if (sending) return;
    setSending(true);
    try {
      await onAnswered(answer, withValues);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {fields.length > 0 ? (
        <div className="grid grid-cols-[auto_8rem] items-center gap-x-3 gap-y-1.5">
          {fields.map((f) => (
            <label key={f.name} className="contents text-xs text-ink-2">
              <span>{f.title}</span>
              <Input
                data-testid={`judgment-field-${f.name}`}
                type="number"
                inputMode="decimal"
                {...(f.minimum !== undefined ? { min: f.minimum } : {})}
                {...(f.maximum !== undefined ? { max: f.maximum } : {})}
                step={f.type === "integer" ? 1 : "any"}
                value={texts[f.name] ?? ""}
                disabled={sending}
                onChange={(e) => setTexts((prev) => ({ ...prev, [f.name]: e.target.value }))}
                className="h-8 text-sm"
              />
            </label>
          ))}
          {problems.length > 0 ? (
            <p data-testid="judgment-field-problem" className="col-span-2 text-xs text-destructive">
              {problems[0]}
            </p>
          ) : null}
        </div>
      ) : null}
      {elicitation.allowFreeText ? (
        <div className="flex flex-col gap-2">
          <Textarea
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            placeholder="自由記述で答える（任意）"
            className="min-h-16 resize-none text-sm"
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              disabled={sending || freeText.trim().length === 0}
              onClick={() => void send(freeText.trim())}
            >
              この内容で送る
            </Button>
          </div>
        </div>
      ) : null}
      {/* 右に寄せる（ユーザー要望）。最初の選択肢（ふつうは「許可する」）だけ塗る */}
      <div className="flex flex-wrap justify-end gap-1.5">
        {elicitation.enumOptions.map((option, i) => (
          <Button
            key={option}
            size="sm"
            variant={i === 0 ? "default" : "outline"}
            // 欄が決まりに合わなければ許すボタンは押せない（断るほうは押せる）
            disabled={sending || (i === 0 && problems.length > 0)}
            onClick={() => void send(option, i === 0 && fields.length > 0 ? values : undefined)}
          >
            {option}
          </Button>
        ))}
      </div>
    </div>
  );
}

function ElicitationUrlView({
  elicitation,
  onAnswered,
}: {
  elicitation: MockElicitationUrl;
  onAnswered: (answer: string) => void | Promise<void>;
}) {
  // 要件：URL は遷移前にドメインを見せて同意を取る（§2.4.1 の MUST）
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-ink-3">
        続けると <span className="font-medium text-foreground">{elicitation.domain}</span> へ移動します。
      </p>
      <div className="flex justify-end">
        <Button size="sm" asChild onClick={() => onAnswered(`${elicitation.domain} を開きました`)}>
          <a href={elicitation.url} target="_blank" rel="noreferrer">
            {elicitation.domain} を開く
            <ExternalLink className="size-3.5" />
          </a>
        </Button>
      </div>
    </div>
  );
}
