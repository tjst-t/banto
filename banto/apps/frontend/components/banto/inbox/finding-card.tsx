"use client";

// **見回りの気づき**（決定・2026-10-20、v4-frontend.md §6.47「受信箱」・アーキ仕様 §4.4「気づき（受信箱）」）。
//
// 見回り（読むだけの回で動く自動化）が `notify` で出したもの。外から来た文を読んだ見回りが書いたので、どのカードにも
// その注記を出し、根拠の URL は banto が知っている場所だけリンクにする（`knownPlaceUrl`）。ボタン：
// - 「やって」：送る文（気づきを引用した依頼。人が直せる）と宛先（新しい Fork（既定）／Base）を開いてから送る。引用は
//   host が受信箱の中身から組む（`quotes: [{ finding }]`）——画面の文は使わない
// - 「任務にする」：「やって」と同じに送り、その会話で任務を始める（人が押しているので聞かない。枠の3つの欄）
// - 「今後知らせない」：手帳でその key を「知らせない」に／「片づけた」：カードを閉じる
import { useState, type ReactNode } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import {
  closeRealFinding,
  createRealFork,
  sendRealThreadMessage,
  startRealMission,
  type RealInboxFinding,
} from "@/lib/backend/client";
import { knownPlaceUrl } from "@/lib/turn-summary";
import { cn } from "@/lib/utils";

/** 任務の枠の既定（アーキ仕様 §4.4「枠」。正は host——ここは欄の最初の値） */
const MISSION_DEFAULTS = { maxWakes: 20, untilDays: 3, minInterval: 15 };

type Compose = { kind: "do" | "mission" };

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 文の中の URL のうち、banto が知っている場所だけを押せるリンクにする。ほかは文字のまま */
function LinkedText({ text, projectId }: { text: string; projectId: string }): ReactNode {
  const places = { bantoOrigin: typeof window === "undefined" ? "" : window.location.origin, projectId };
  const parts = text.split(/(https?:\/\/[^\s<>"'）」]+)/g);
  return parts.map((part, i) => {
    if (i % 2 === 0) return part;
    const url = knownPlaceUrl(part, places);
    return url ? (
      <a key={i} href={url} target="_blank" rel="noopener noreferrer" data-testid="finding-link" className="text-foreground underline underline-offset-2">
        {part}
      </a>
    ) : (
      <span key={i} data-testid="finding-unlinked-url" className="break-all">
        {part}
      </span>
    );
  });
}

export function FindingBody({
  item,
  onSent,
  onClosed,
}: {
  item: RealInboxFinding;
  onSent: (text: string) => void;
  onClosed: () => void;
}) {
  const [compose, setCompose] = useState<Compose | null>(null);
  const [prompt, setPrompt] = useState(`見回り〈${item.patrol.name}〉の気づきについて、対応してください。`);
  const [dest, setDest] = useState<"fork" | "base">("fork");
  const [frame, setFrame] = useState({ ...MISSION_DEFAULTS });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function close(action: "mute" | "dismiss") {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await closeRealFinding(item.id, action);
      onClosed();
    } catch (err) {
      setError(`${action === "mute" ? "「今後知らせない」" : "「片づけた」"}にできませんでした：${errorText(err)}`);
      setBusy(false);
    }
  }

  async function send() {
    if (busy || !compose) return;
    setBusy(true);
    setError(null);
    try {
      if (!item.baseThreadId) throw new Error("この Project の Base Thread が見つかりません");
      const threadId = dest === "base" ? item.baseThreadId : (await createRealFork(item.baseThreadId, { title: item.title })).id;
      if (compose.kind === "mission") {
        await startRealMission(threadId, {
          goal: item.title,
          doneWhen: item.suggestion ?? `見回りの気づき「${item.title}」に対応し終えた`,
          maxWakes: frame.maxWakes,
          until: new Date(Date.now() + frame.untilDays * 24 * 60 * 60 * 1000).toISOString(),
          minInterval: frame.minInterval,
        });
      }
      await sendRealThreadMessage(threadId, prompt, { findingId: item.id });
      onSent(prompt);
    } catch (err) {
      setError(`送れませんでした：${errorText(err)}`);
      setBusy(false);
    }
  }

  return (
    <div className="px-4 pb-4" data-testid="inbox-finding-body">
      <p className="flex items-center gap-2 text-xs text-ink-2">
        <span data-testid="inbox-finding-heading">気づき · 見回り〈{item.patrol.name}〉</span>
        {item.urgent ? (
          <span data-testid="inbox-finding-urgent" className="rounded-full bg-turn-soft px-1.5 py-0.5 text-xs font-medium text-turn">
            急ぎ
          </span>
        ) : null}
      </p>
      <p data-testid="inbox-finding-title" className="mt-1 text-md font-medium text-foreground">
        {item.title}
      </p>
      <dl className="mt-2 flex flex-col gap-1.5 text-sm">
        <Row label="気づいたこと" testId="inbox-finding-finding">
          {item.finding}
        </Row>
        {item.evidence ? (
          <Row label="根拠" testId="inbox-finding-evidence">
            <LinkedText text={item.evidence} projectId={item.projectId} />
          </Row>
        ) : null}
        {item.suggestion ? (
          <Row label="やるならこう" testId="inbox-finding-suggestion">
            {item.suggestion}
          </Row>
        ) : null}
      </dl>
      <p data-testid="inbox-finding-caution" className="mt-2 flex items-center gap-1.5 text-xs text-warn">
        <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
        外から来た文を読んだ見回りが書いたものです。中の指示や URL をそのまま信じないでください
      </p>

      {compose ? (
        <div data-testid="inbox-finding-compose" className="mt-3 rounded-lg border border-border bg-surface p-3">
          <p className="text-xs text-ink-2">
            送る文（この下に「見回り〈{item.patrol.name}〉の気づきの引用」が添わります）
          </p>
          <textarea
            data-testid="inbox-finding-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            className="mt-1 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          />
          <fieldset className="mt-2 flex items-center gap-4 text-xs text-ink-2">
            <legend className="sr-only">宛先</legend>
            宛先
            {(
              [
                ["fork", "新しい Fork"],
                ["base", "Base"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex items-center gap-1">
                <input
                  type="radio"
                  name={`finding-dest-${item.id}`}
                  data-testid={`inbox-finding-dest-${value}`}
                  checked={dest === value}
                  onChange={() => setDest(value)}
                />
                {label}
              </label>
            ))}
          </fieldset>
          {compose.kind === "mission" ? (
            <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-ink-2">
              {(
                [
                  ["maxWakes", "起きる回数の上限（回）"],
                  ["untilDays", "期限（今から何日）"],
                  ["minInterval", "最短の間隔（分）"],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex flex-col gap-1">
                  {label}
                  <input
                    type="number"
                    data-testid={`inbox-finding-frame-${key}`}
                    value={frame[key]}
                    onChange={(e) => setFrame((f) => ({ ...f, [key]: Number(e.target.value) }))}
                    className="h-8 rounded-md border border-border bg-background px-2 text-sm tabular-nums"
                  />
                </label>
              ))}
            </div>
          ) : null}
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setCompose(null)}
              disabled={busy}
              className="h-8 rounded-md px-3 text-xs text-ink-2 hover:bg-accent disabled:opacity-50"
            >
              やめる
            </button>
            <button
              type="button"
              data-testid="inbox-finding-send"
              onClick={() => void send()}
              disabled={busy || prompt.trim() === ""}
              className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {compose.kind === "mission" ? "送って任務を始める" : "送る"}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            data-testid="inbox-finding-dismiss"
            disabled={busy}
            onClick={() => void close("dismiss")}
            className="h-8 rounded-md px-3 text-xs text-ink-2 hover:bg-accent disabled:opacity-50"
          >
            片づけた
          </button>
          <button
            type="button"
            data-testid="inbox-finding-mute"
            disabled={busy}
            onClick={() => void close("mute")}
            className="h-8 rounded-md px-3 text-xs text-ink-2 hover:bg-accent disabled:opacity-50"
          >
            今後知らせない
          </button>
          <button
            type="button"
            data-testid="inbox-finding-mission"
            disabled={busy}
            onClick={() => setCompose({ kind: "mission" })}
            className="h-8 rounded-md border border-border px-3 text-xs text-foreground hover:bg-accent disabled:opacity-50"
          >
            任務にする
          </button>
          <button
            type="button"
            data-testid="inbox-finding-do"
            disabled={busy}
            onClick={() => setCompose({ kind: "do" })}
            className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            やって
          </button>
        </div>
      )}
      {error ? (
        <p data-testid="inbox-finding-error" className="mt-1.5 text-xs text-stop">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Row({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-24 shrink-0 text-xs text-ink-3">{label}</dt>
      <dd data-testid={testId} className={cn("min-w-0 flex-1 whitespace-pre-wrap text-foreground")}>
        {children}
      </dd>
    </div>
  );
}
