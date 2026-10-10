"use client";

// 設定（banto 全体）の「実行場所」（決定・2026-10-08、ユーザー。`docs/specs/v4-security.md` §1「Project の実行場所——
// 別のサーバ」、Backlog `remote-runtime-registry`。画面はモック `mock/components/banto/settings/runtimes-panel.tsx` の形で
// 決定・2026-10-10）。
//
// - 一番上は既定の「この機械のコンテナ」——外せない・設定も無い。比べる基準として置く
// - 別のサーバは1件ずつ：名前・宛先・鍵（Vault の alias だけ）・使っている Project・前提の確かめの結果
// - **選べない理由は隠さず出す**（host 鍵が変わった・前提が足りない・ほかの Project が使っている）——判断は host
//   （`unavailableReason`）。新しい Project の画面と同じ言い方
// - 足すときは「繋いで確かめる」→ host 鍵の指紋を人が確かめる → 前提の確かめ → 登録、の順。指紋を見ずに覚えない
// - 注意（サーバ丸ごと AI のもの・LAN から直に届く・他のアカウントにも中継の口が見える）は足す前に読める位置に置く
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  CircleAlert,
  CircleCheck,
  CircleX,
  KeyRound,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { describeFailure } from "@/lib/report-failure";
import {
  acceptRealRuntimeHostKey,
  checkRealRuntime,
  listRealRuntimes,
  listRealSshIdentities,
  recheckRealRuntime,
  registerRealRuntime,
  removeRealRuntime,
  scanRealRuntimeHostKey,
  type RealHostKey,
  type RealRemoteRuntime,
  type RealRuntimeCheck,
  type RealRuntimeInput,
} from "@/lib/backend/client";

const DEFAULT_DATA_ROOT = "~/.local/share/banto-remote";

/** `user@host`（22 番以外ならポートも） */
export function sshTarget(r: Pick<RealRuntimeInput, "user" | "host" | "port">): string {
  return `${r.user}@${r.host}${r.port === 22 ? "" : `:${r.port}`}`;
}

/** 人に見せる鍵の種類（`ssh-keygen -l` の括弧の中と同じ） */
function keyTypeLabel(type: string): string {
  if (type === "ssh-ed25519") return "ED25519";
  if (type.startsWith("ecdsa-")) return "ECDSA";
  if (type === "ssh-rsa") return "RSA";
  return type;
}

/** 向こうで打って見比べるコマンド（覚えた鍵の種類のファイル） */
function keygenCommand(type: string): string {
  const file = type === "ssh-ed25519" ? "ed25519" : type.startsWith("ecdsa-") ? "ecdsa" : "rsa";
  return `ssh-keygen -lf /etc/ssh/ssh_host_${file}_key.pub`;
}

/** host の時刻（ISO）を、人の言葉の日時に */
function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function RuntimesPanel() {
  const [runtimes, setRuntimes] = useState<RealRemoteRuntime[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const reload = useCallback(() => {
    listRealRuntimes()
      .then((list) => {
        setError(null);
        setRuntimes(list);
      })
      // **読めなかったことを、空の一覧に見せない**（規則2）
      .catch((err: unknown) => setError(describeFailure(err)));
  }, []);
  useEffect(() => reload(), [reload]);

  return (
    <div className="flex flex-col gap-4" data-testid="runtimes-panel">
      <ul data-testid="runtimes" className="flex flex-col divide-y divide-border rounded-md border border-border bg-card">
        <li className="flex items-start gap-3 px-3 py-3" data-testid="runtime-host-container">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-ink-3" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="text-sm font-medium text-foreground">この機械のコンテナ</p>
            <p className="text-xs text-ink-3">
              既定。Project ごとに1台、資源の上限つきで閉じ込めます。Project の数に決まりはありません。
            </p>
          </div>
        </li>
        {runtimes?.map((r) => (
          <RuntimeRow key={r.name} runtime={r} onChanged={reload} />
        ))}
      </ul>
      {error ? (
        <p data-testid="runtimes-error" className="text-xs text-stop">
          別のサーバの一覧を読めませんでした：{error}
        </p>
      ) : null}

      {adding ? (
        <AddRuntimeForm
          taken={runtimes?.map((r) => r.name) ?? []}
          onDone={(added) => {
            setAdding(false);
            if (added) reload();
          }}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <Cautions />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 w-fit gap-1 text-xs"
            onClick={() => setAdding(true)}
            data-testid="runtime-add"
          >
            <Plus className="size-3.5" />
            別のサーバを登録
          </Button>
        </div>
      )}
    </div>
  );
}

/** 登録する前に読んでほしいこと。足す画面にも同じものを出す */
function Cautions() {
  return (
    <div className="rounded-md bg-surface-2 px-3 py-2.5 text-xs text-ink-2" data-testid="runtime-cautions">
      <p className="mb-1.5 font-medium text-foreground">別のサーバで動かすとき</p>
      <ul className="flex list-disc flex-col gap-1 pl-4">
        <li>
          {"サーバ丸ごとが、その Project の箱になります。AI は SSH のユーザーができることを全部できます（Docker を使えるなら、実質 root）。" +
            "検証専用のサーバと、banto 専用のユーザーを使ってください。"}
        </li>
        <li>向こうで動かしたサービスは、LAN から直に届きます。Publish の前のログインを通りません。</li>
        <li>向こうにほかの人のアカウントがあると、その人にも banto への中継の口が見えます（合言葉で守ります）。</li>
        <li>1つのサーバで動かせる Project は1つです。</li>
      </ul>
    </div>
  );
}

function RuntimeRow({ runtime: r, onChanged }: { runtime: RealRemoteRuntime; onChanged: () => void }) {
  const [open, setOpen] = useState(!!r.hostKeyMismatch);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 鍵が変わったのを、開いていない間に見つけたら開く
  const [sawMismatch, setSawMismatch] = useState(!!r.hostKeyMismatch);
  if (!!r.hostKeyMismatch !== sawMismatch) {
    setSawMismatch(!!r.hostKeyMismatch);
    if (r.hostKeyMismatch) setOpen(true);
  }
  const used = r.usedBy[0];
  const warns = r.checks.filter((c) => c.status === "warn");
  const state: { tone: "ok" | "warn" | "stop"; text: string } = r.hostKeyMismatch
    ? { tone: "stop", text: "host 鍵が前と違うので繋ぎません" }
    : r.checks.some((c) => c.status === "fail")
      ? { tone: "stop", text: "前提が足りません" }
      : used
        ? { tone: "ok", text: `Project「${used.name}」が使っています` }
        : warns.length > 0
          ? { tone: "warn", text: `使えます（注意 ${warns.length} 件）` }
          : { tone: "ok", text: "使えます——まだどの Project も使っていません" };

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(describeFailure(err));
    } finally {
      setBusy(false);
      // 失敗しても読み直す——鍵が違うと分かったら host が記録している
      onChanged();
    }
  }

  return (
    <li data-testid={`runtime-${r.name}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-3 py-3 text-left hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <Server className="mt-0.5 size-4 shrink-0 text-ink-3" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className="font-medium text-foreground">{r.name}</span>
            <span className="font-mono text-xs text-ink-3" data-testid="runtime-target">
              {sshTarget(r)}
            </span>
          </p>
          <p
            data-testid="runtime-state"
            className={cn(
              "flex items-center gap-1 text-xs",
              state.tone === "stop" && "text-stop",
              state.tone === "warn" && "text-warn",
              state.tone === "ok" && "text-ink-2",
            )}
          >
            {state.tone === "stop" ? (
              <CircleX className="size-3.5 shrink-0" />
            ) : state.tone === "warn" ? (
              <CircleAlert className="size-3.5 shrink-0" />
            ) : (
              <CircleCheck className="size-3.5 shrink-0 text-ok" />
            )}
            {state.text}
          </p>
        </div>
      </button>

      {open ? (
        <div className="flex flex-col gap-3 px-3 pb-3 pl-10">
          {r.hostKeyMismatch ? <HostKeyMismatch runtime={r} busy={busy} onAccept={(fp) => act(() => acceptRealRuntimeHostKey(r.name, fp))} /> : null}

          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-ink-3">SSH 鍵</dt>
            <dd className="font-mono text-ink-2" data-testid="runtime-identity">
              ${r.identity}（Vault）
            </dd>
            <dt className="text-ink-3">host 鍵</dt>
            <dd className="font-mono break-all text-ink-2" data-testid="runtime-host-key">
              {keyTypeLabel(r.hostKey.type)} {r.hostKey.fingerprint}
              <span className="font-sans text-ink-3">（{when(r.hostKey.confirmedAt)} に確かめた）</span>
            </dd>
            <dt className="text-ink-3">向こうの置き場</dt>
            <dd className="font-mono text-ink-2">{r.dataRoot}</dd>
          </dl>

          <div className="flex flex-col gap-1.5">
            <p className="text-xs text-ink-3">前提（{when(r.checkedAt)} に確かめた）</p>
            <CheckList checks={r.checks} />
          </div>

          {error ? (
            <p data-testid="runtime-error" className="text-xs text-stop">
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1 text-xs"
              onClick={() => void act(() => recheckRealRuntime(r.name))}
              disabled={!!r.hostKeyMismatch || busy}
              data-testid="runtime-recheck"
            >
              <RefreshCw className={cn("size-3.5", busy && "animate-spin")} />
              確かめ直す
            </Button>
            {used ? (
              <span className="text-xs text-ink-3" data-testid="runtime-remove-blocked">
                Project「{used.name}」が使っているあいだは外せません。向こうの置き場は Project を閉じても消しません。
              </span>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-ink-3 hover:text-stop"
                disabled={busy}
                onClick={() => void act(() => removeRealRuntime(r.name))}
                data-testid="runtime-remove"
              >
                外す
              </Button>
            )}
          </div>
          {r.unavailableReason && !used && !r.hostKeyMismatch ? (
            <p className="text-xs text-ink-3">新しい Project では選べません：{r.unavailableReason}</p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** 前に覚えた鍵と違う指紋が返ってきた。黙って覚え直さない——人が向こうで確かめてから押す */
function HostKeyMismatch({
  runtime: r,
  busy,
  onAccept,
}: {
  runtime: RealRemoteRuntime;
  busy: boolean;
  onAccept: (fingerprint: string) => void;
}) {
  const now = r.hostKeyMismatch!;
  return (
    <div className="flex flex-col gap-2 rounded-md bg-stop-soft px-3 py-2.5 text-xs" data-testid="host-key-mismatch">
      <p className="flex items-center gap-1.5 font-medium text-foreground">
        <TriangleAlert className="size-4 shrink-0 text-stop" />
        host 鍵が前と違うので、繋いでいません
      </p>
      <p className="text-ink-2">
        サーバを入れ直したなら変わります。覚えのないまま変わったなら、別の機械に繋がっているかもしれません。向こうで
        <code className="mx-1 font-mono">{keygenCommand(now.type)}</code>
        を打ち、出た指紋が下の「いま返ってきた鍵」と同じなら覚え直してください。
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono">
        <dt className="font-sans text-ink-3">覚えていた鍵</dt>
        <dd className="break-all text-ink-2" data-testid="host-key-old">
          {r.hostKey.fingerprint}
        </dd>
        <dt className="font-sans text-ink-3">いま返ってきた鍵</dt>
        <dd className="break-all text-foreground" data-testid="host-key-new">
          {now.fingerprint}
        </dd>
      </dl>
      <Button
        type="button"
        size="sm"
        className="h-7 w-fit text-xs"
        disabled={busy}
        onClick={() => onAccept(now.fingerprint)}
        data-testid="host-key-accept"
      >
        新しい鍵を覚え直す
      </Button>
    </div>
  );
}

function CheckList({ checks }: { checks: readonly RealRuntimeCheck[] }) {
  return (
    <ul className="flex flex-col gap-1.5" data-testid="runtime-checks">
      {checks.map((c) => (
        <li key={c.id} className="flex items-start gap-2 text-xs" data-testid="runtime-check" data-check={c.id} data-status={c.status}>
          {c.status === "ok" ? (
            <CircleCheck className="mt-px size-3.5 shrink-0 text-ok" />
          ) : c.status === "warn" ? (
            <CircleAlert className="mt-px size-3.5 shrink-0 text-warn" />
          ) : (
            <CircleX className="mt-px size-3.5 shrink-0 text-stop" />
          )}
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className={c.status === "ok" ? "text-ink-2" : "text-foreground"}>{c.label}</span>
            {c.detail ? <span className="text-ink-3">{c.detail}</span> : null}
            {c.fix ? (
              <code className="w-fit rounded-sm bg-surface-2 px-1.5 py-0.5 font-mono break-all whitespace-pre-wrap text-ink-2">
                {c.fix}
              </code>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

type Step =
  | { kind: "form" }
  | { kind: "hostKey"; input: RealRuntimeInput; key: RealHostKey }
  | { kind: "checks"; input: RealRuntimeInput; key: RealHostKey; checks: RealRuntimeCheck[] };

function AddRuntimeForm({ taken, onDone }: { taken: readonly string[]; onDone: (added: boolean) => void }) {
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [user, setUser] = useState("banto");
  const [port, setPort] = useState("22");
  const [identity, setIdentity] = useState<string>("");
  const [dataRoot, setDataRoot] = useState(DEFAULT_DATA_ROOT);
  const [step, setStep] = useState<Step>({ kind: "form" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [identities, setIdentities] = useState<string[] | null>(null);
  const [identitiesError, setIdentitiesError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listRealSshIdentities().then(
      (list) => {
        if (cancelled) return;
        setIdentities(list);
        setIdentity((cur) => cur || list[0] || "");
      },
      (err: unknown) => !cancelled && setIdentitiesError(describeFailure(err)),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const input: RealRuntimeInput = {
    name: name.trim(),
    host: host.trim(),
    user: user.trim(),
    port: Number(port) || 22,
    identity,
    dataRoot: dataRoot.trim() || DEFAULT_DATA_ROOT,
  };
  const nameTaken = taken.includes(input.name);
  const filled = !!(input.name && input.host && input.user && input.identity) && !nameTaken;

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(describeFailure(err));
    } finally {
      setBusy(false);
    }
  }

  function connect(e: FormEvent) {
    e.preventDefault();
    if (!filled || busy) return;
    void run(async () => {
      const key = await scanRealRuntimeHostKey(input);
      setStep({ kind: "hostKey", input, key });
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-card p-3" data-testid="runtime-add-form">
      <p className="text-sm font-medium text-foreground">別のサーバを登録</p>
      <Cautions />

      {step.kind === "form" ? (
        <form onSubmit={connect} className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="rt-name" label="名前" hint={nameTaken ? "この名前はもう使われています" : "一覧と、Project を作る画面に出ます（英小文字・数字・-）"}>
              <Input id="rt-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="lab-pve" />
            </Field>
            <Field id="rt-host" label="ホスト" hint="名前か IP アドレス">
              <Input
                id="rt-host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                className="font-mono text-xs"
                placeholder="192.168.1.80"
              />
            </Field>
            <Field id="rt-user" label="ユーザー" hint="banto 専用のユーザーを勧めます">
              <Input id="rt-user" value={user} onChange={(e) => setUser(e.target.value)} className="font-mono text-xs" />
            </Field>
            <Field id="rt-port" label="ポート">
              <Input
                id="rt-port"
                inputMode="numeric"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                className="font-mono text-xs"
              />
            </Field>
          </div>
          <Field
            id="rt-key"
            label="SSH 鍵"
            hint={
              identitiesError
                ? `Vault の SSH 鍵を読めませんでした：${identitiesError}`
                : identities && identities.length === 0
                  ? "Vault に（banto 全体で使える）SSH 鍵がありません。先に Vault で SSH 鍵を登録してください"
                  : "Vault の鍵を使います。秘密鍵はこの機械のディスクにも、向こうにも置きません"
            }
          >
            <Select value={identity} onValueChange={setIdentity} disabled={!identities || identities.length === 0}>
              <SelectTrigger id="rt-key" className="h-8 w-full" data-testid="runtime-identity-select">
                <SelectValue placeholder={identities ? "SSH 鍵がありません" : "読み込み中…"} />
              </SelectTrigger>
              <SelectContent>
                {(identities ?? []).map((k) => (
                  <SelectItem key={k} value={k}>
                    <span className="font-mono">${k}</span>（Vault）
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="rt-root" label="向こうの置き場" hint="banto のコード・Module の状態を置きます。Project のフォルダとは別です">
            <Input id="rt-root" value={dataRoot} onChange={(e) => setDataRoot(e.target.value)} className="font-mono text-xs" />
          </Field>
          {error ? (
            <p data-testid="runtime-add-error" className="text-xs text-stop">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={!filled || busy} className="gap-1" data-testid="runtime-connect">
              <KeyRound className="size-3.5" />
              {busy ? "繋いでいます…" : "繋いで確かめる"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => onDone(false)}>
              やめる
            </Button>
          </div>
        </form>
      ) : step.kind === "hostKey" ? (
        <div className="flex flex-col gap-2.5" data-testid="runtime-host-key-step">
          <p className="text-sm text-foreground">
            {step.input.name}（<span className="font-mono">{sshTarget(step.input)}</span>）に初めて繋ぎます。
          </p>
          <p className="text-xs text-ink-2">
            向こうで
            <code className="mx-1 font-mono">{keygenCommand(step.key.type)}</code>
            を打って、出た指紋がこれと同じか確かめてください。同じなら覚えて、次からは違う鍵のときに繋ぎません。
          </p>
          <p className="rounded-md bg-surface-2 px-3 py-2 font-mono text-sm break-all text-foreground" data-testid="runtime-fingerprint">
            {keyTypeLabel(step.key.type)} {step.key.fingerprint}
          </p>
          {error ? (
            <p data-testid="runtime-add-error" className="text-xs text-stop">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy}
              data-testid="runtime-trust"
              onClick={() =>
                void run(async () => {
                  const checks = await checkRealRuntime(step.input, step.key);
                  setStep({ ...step, kind: "checks", checks });
                })
              }
            >
              {busy ? "前提を確かめています…" : "同じなので覚える"}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setStep({ kind: "form" })}>
              違うのでやめる
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5" data-testid="runtime-add-checks">
          <p className="text-sm text-foreground">向こうの前提を確かめました。</p>
          <CheckList checks={step.checks} />
          {step.checks.some((c) => c.status === "fail") ? (
            <p className="text-xs text-stop" data-testid="runtime-add-blocked">
              足りないものがあるので登録できません。向こうで上のコマンドを打ってから、確かめ直してください。
            </p>
          ) : null}
          {error ? (
            <p data-testid="runtime-add-error" className="text-xs text-stop">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy || step.checks.some((c) => c.status === "fail")}
              data-testid="runtime-register"
              onClick={() =>
                void run(async () => {
                  await registerRealRuntime(step.input, step.key);
                  onDone(true);
                })
              }
            >
              {busy ? "登録しています…" : "登録する"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setStep({ ...step, checks: await checkRealRuntime(step.input, step.key) });
                })
              }
            >
              <RefreshCw className="size-3.5" />
              確かめ直す
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => onDone(false)}>
              やめる
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-ink-3">{hint}</p> : null}
    </div>
  );
}
