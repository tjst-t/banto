"use client";

// **会話の画面の番頭の部分**（v4-frontend.md §6.54「会話の画面」。実装・Backlog #511）：
// - 番頭の会話（`restriction: "supervisor"` の Fork）の上の帯と「番頭の画面を開く」
// - 番頭の頼みが届いたターンの頭の薄い1行「番頭の頼み——〈行いの題〉」。押すと届けた全文・番頭の補足（`note`）・理由（番頭の記録から）
import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { MessagePrimitive } from "@assistant-ui/react";
import { ChevronDown, ChevronRight, UserCheck } from "lucide-react";
import { listRealSupervisorLog, type RealMessageOrigin } from "@/lib/backend/client";
import { describeFailure } from "@/lib/report-failure";
import { SUPERVISOR_LABEL as L } from "@/lib/supervisor-label";
import { navigateUrl } from "@/lib/url-nav";

/** いまの画面の上に番頭の画面を重ねる URL（受信箱と同じ `overlay`） */
function useOpenSupervisorPage(): () => void {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return () => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("overlay", "supervisor");
    navigateUrl(router, `${pathname}?${params.toString()}`);
  };
}

export function SupervisorThreadBand() {
  const open = useOpenSupervisorPage();
  return (
    <div data-testid="supervisor-thread-band" className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-surface-2 px-3 py-1.5 text-xs text-ink-2">
      <UserCheck className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        {`${L}の会話です。この Project の方針で、決めることに答える・決まった手順を頼む・Factory に流すだけをします`}
      </span>
      <button
        type="button"
        onClick={open}
        data-testid="supervisor-thread-band-open"
        className="shrink-0 rounded-md px-1.5 py-0.5 text-ink-2 underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {`${L}の画面を開く`}
      </button>
    </div>
  );
}

/** 番頭の頼みの題。届けものの題は host が「番頭の指示：〈行いの題〉」で組む——頭の印を外して題だけにする */
function instructionTitle(origin: RealMessageOrigin): string {
  const at = origin.title.indexOf("：");
  return at >= 0 ? origin.title.slice(at + 1) : origin.title;
}

export function SupervisorInstructionLine({
  origin,
  supervisor,
  text,
  threadId,
}: {
  origin: RealMessageOrigin;
  supervisor: NonNullable<RealMessageOrigin["supervisor"]>;
  text: string;
  threadId: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string | null>(null);

  function toggle() {
    const next = !open;
    setOpen(next);
    // 理由は届けものに載せていない（宛先に送らない）——番頭の記録から引く
    if (next && reason === null && threadId) {
      listRealSupervisorLog({ thread: threadId, kinds: ["instructed"] })
        .then((acts) => setReason(acts.find((a) => a.actionId === supervisor.actionId)?.reason ?? ""))
        .catch((err: unknown) => setReason(`（理由を読めませんでした：${describeFailure(err)}）`));
    }
  }

  return (
    <MessagePrimitive.Root data-role="delivered" data-testid="supervisor-instruction-line" data-from={origin.from} className="px-2">
      <div className="my-1 flex flex-col gap-1">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="flex items-center gap-1.5 self-start rounded-md text-left text-xs text-ink-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <UserCheck className="size-3.5 shrink-0" />
          <span className="line-clamp-2" data-testid="supervisor-instruction-text">
            {`${L}の頼み——${instructionTitle(origin)}`}
          </span>
          {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        </button>
        {open ? (
          <div className="flex flex-col gap-1.5 pl-5" data-testid="supervisor-instruction-details">
            <pre className="max-h-80 overflow-auto rounded-md bg-surface-2 p-2 text-xs whitespace-pre-wrap text-ink-2" data-testid="delivered-body">
              {text}
            </pre>
            {supervisor.note ? (
              <p className="rounded-md border border-dashed border-border px-2.5 py-1.5 text-xs text-ink-2" data-testid="supervisor-instruction-note">
                {`${L}の補足（データとして渡しています）：${supervisor.note}`}
              </p>
            ) : null}
            <p className="text-xs text-ink-3" data-testid="supervisor-instruction-reason">
              {reason === null ? "理由を読み込んでいます…" : reason === "" ? "理由は記録に残っていません" : `理由：${reason}`}
            </p>
          </div>
        ) : null}
      </div>
    </MessagePrimitive.Root>
  );
}
