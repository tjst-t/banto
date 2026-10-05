"use client";

// Elicitation の mode:"form" / mode:"url" を受信箱の中で描く。
// 生きている間（Module 側のタイムアウト前）は、受信箱から答えても元の tool
// 呼び出しをそのまま解決できる——banto は手元に残る Promise を resolve するだけ。
// タイムアウト済みのものだけ、答えが次のターンへの新しい入力として渡る
// （v4-architecture.md §2.4.1、2026-08-31改訂：3状態を出し分ける）
import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { MockElicitationForm, MockElicitationUrl } from "@/lib/mock/types";

export function ElicitationFormView({
  elicitation,
  onAnswered,
  timedOut = false,
}: {
  elicitation: MockElicitationForm | MockElicitationUrl;
  onAnswered: (answer: string) => void | Promise<void>;
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
  onAnswered: (answer: string) => void | Promise<void>;
}) {
  // **選択肢は押したらそのまま送る**（決定・2026-10-05、ユーザー要望）——以前は選んでから「この内容で送る」を
  // 押す2段で、承認のたびに2回押させていた。自由記述だけは打ち終わりが分からないので送るボタンを残す。
  // 2回押して二重に答えないよう、送ったら全部押せなくする（失敗したら呼び出し側が文言を出し、カードは出たまま）
  const [sending, setSending] = useState(false);
  const [freeText, setFreeText] = useState("");
  const send = async (answer: string) => {
    if (sending) return;
    setSending(true);
    try {
      await onAnswered(answer);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
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
            disabled={sending}
            onClick={() => void send(option)}
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
