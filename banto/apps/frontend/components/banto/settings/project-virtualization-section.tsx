"use client";

// **この Project の仮想化の実験**（決定・2026-10-20、ユーザー。`docs/specs/v4-security.md` §1「`containers` で仮想化の実験——
// /dev/kvm と特権」の 2.・4.、Backlog 462 番）。Project の設定「一般」の実行場所の下に置く。
//
// - 出すのは、その実行場所が `containers` で、仮想化の実験を許しているときだけ（判断は host の `available`）
// - 3つ：「/dev/kvm を見せる」（足すモジュールの名前つき）・hugepages の数・「特権コンテナにする」。3つとも既定はオフで、
//   人が押したときだけ変わる（AI の tool は無い）
// - 同じ実行場所にほかの特権の Project があれば、許していなくても上に出す——守られていないのはこの Project の側
// - **断られたら host の理由をそのまま出す**（規則2）。押したあとは host から読み直す（画面の思い込みで描かない）
import { useCallback, useEffect, useState } from "react";
import { ShieldAlert, TriangleAlert } from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  fetchRealProjectContainer,
  setRealProjectContainerNesting,
  setRealProjectHugepages,
  setRealProjectKvm,
  setRealProjectPrivileged,
  type RealProjectVirtualization,
} from "@/lib/backend/client";
import { syncRealProjects } from "@/lib/mock/projects";
import { describeFailure, reportFailure } from "@/lib/report-failure";
import { includesBrNetfilter, parseModuleNames, sameModuleNames } from "@/lib/virtualization";

// 文言は仕様の 4.「警告」のとおり（文を JSX の中で折り返さない——改行が空白になり、日本語の途中に隙間が出る）
const KVM_WARNING =
  "この Project の AI はサーバのカーネルの KVM と vhost-net を直に使います。同じサーバのほかの Project を守るのは、" +
  "カーネルのこの部分の堅さだけになります。読み込んだモジュールはサーバ全体に効きます。";
const PRIVILEGED_WARNING =
  "この Project の AI はこのサーバの root になれます。同じサーバの全 Project が動かす banto のコードと土台のイメージを" +
  "書き換えられ、ほかの Project のコンテナの中身（合言葉・Claude のログイン・環境変数）と鍵の窓口・トンネルのソケットにも届きます。";

interface State {
  virtualization: RealProjectVirtualization;
  /** 「中で Docker を使う」（`container.nesting`）。/dev/kvm を入れるとき、切れていれば一緒に入れるか聞く */
  nesting: boolean;
}

/** どの Project について読んだものか——別の Project に切り替わったら、読み終わるまで出さない */
type Loaded = { projectId: string } & ({ value: State } | { error: string });

export function ProjectVirtualizationSection({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  const reload = useCallback(async () => {
    const c = await fetchRealProjectContainer(projectId);
    if (!c.virtualization) {
      setLoaded({ projectId, error: "この banto は仮想化の実験を扱えません" });
      return;
    }
    setLoaded({ projectId, value: { virtualization: c.virtualization, nesting: c.nesting } });
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    fetchRealProjectContainer(projectId).then(
      (c) => {
        if (cancelled) return;
        // host が仮想化を扱えない（この機械だけで動かしている等）なら、節ごと出さない——使えないものを出さない（規則13）
        setLoaded(c.virtualization ? { projectId, value: { virtualization: c.virtualization, nesting: c.nesting } } : null);
      },
      (err: unknown) => !cancelled && setLoaded({ projectId, error: describeFailure(err) }),
    );
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const current = loaded?.projectId === projectId ? loaded : null;
  if (!current) return null;
  if ("error" in current) {
    return (
      <p data-testid="project-virtualization-error" className="text-xs text-stop">
        仮想化の実験の様子を読めませんでした：{current.error}
      </p>
    );
  }
  const { virtualization: v } = current.value;
  const others = v.privilegedOnServer;
  if (!v.available && others.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {others.length > 0 ? (
        <p
          data-testid="project-virt-privileged-on-server"
          className="flex items-start gap-2 rounded-md bg-stop-soft px-3 py-2 text-xs text-stop"
        >
          <ShieldAlert className="mt-px size-3.5 shrink-0" />
          <span>
            {`このサーバには特権の Project があります（${others.map((p) => p.name).join("・")}）。` +
              "その Project の AI はこのサーバの root になれ、この Project のコンテナの中身にも届きます。"}
          </span>
        </p>
      ) : null}
      {v.available ? (
        <section data-testid="project-virtualization" className="flex flex-col gap-3 rounded-md border border-border p-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">仮想化の実験</h2>
            <p className="text-xs text-ink-3">
              {"この実行場所は仮想化の実験を許しています。KVM の VM・containerlab などを、この Project のコンテナの中で動かせます。" +
                "3つとも既定はオフで、要るものだけ入れてください。"}
            </p>
          </div>
          <KvmSetting projectId={projectId} state={current.value} onChanged={reload} />
          <HugepagesSetting projectId={projectId} count={v.hugepages} onChanged={reload} />
          <PrivilegedSetting projectId={projectId} projectName={projectName} privileged={v.privileged} onChanged={reload} />
        </section>
      ) : null}
    </div>
  );
}

/** 「/dev/kvm を見せる」とモジュールの名前。入れるとき「中で Docker を使う」が切れていれば、一緒に入れるか聞く */
function KvmSetting({ projectId, state, onChanged }: { projectId: string; state: State; onChanged: () => Promise<void> }) {
  const v = state.virtualization;
  const [text, setText] = useState(v.modules.join(" "));
  const [saving, setSaving] = useState(false);
  const [askNesting, setAskNesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const { names, invalid } = parseModuleNames(text);
  const modulesChanged = !sameModuleNames(names, v.modules);

  async function apply(enabled: boolean, withNesting: boolean) {
    setSaving(true);
    setError(null);
    setWarnings([]);
    try {
      const result = await setRealProjectKvm(projectId, enabled, names);
      setWarnings(result.warnings);
      if (withNesting) await setRealProjectContainerNesting(projectId, true);
      setText(result.modules.join(" "));
    } catch (err) {
      setError(describeFailure(err));
    } finally {
      setSaving(false);
      // 失敗しても読み直す——途中まで進んだかもしれない
      await onChanged().catch((err: unknown) => reportFailure("仮想化の実験の様子を読み直せませんでした", err));
    }
  }

  function toggle(enabled: boolean) {
    if (enabled && !state.nesting) {
      setAskNesting(true);
      return;
    }
    void apply(enabled, false);
  }

  return (
    <div data-testid="project-virt-kvm" className="flex flex-col gap-2 border-t border-border pt-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="project-virt-kvm-switch">/dev/kvm を見せる</Label>
          <p data-testid="project-virt-kvm-warning" className="flex items-start gap-1.5 text-xs text-warn">
            <TriangleAlert className="mt-px size-3.5 shrink-0" />
            <span>{KVM_WARNING}</span>
          </p>
          <p className="text-xs text-ink-3">{"/dev/kvm と /dev/vhost-net をコンテナに見せ、vhost_net をサーバで読みます。動いているコンテナに足すので、起こし直しはしません。"}</p>
        </div>
        <Switch
          id="project-virt-kvm-switch"
          data-testid="project-virt-kvm-switch"
          checked={v.kvm}
          disabled={saving || invalid.length > 0}
          onCheckedChange={toggle}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="project-virt-kvm-modules" className="text-xs">
          足すカーネルモジュール（空白で区切る。vhost_net は入れなくても読みます）
        </Label>
        <div className="flex items-center gap-2">
          <Input
            id="project-virt-kvm-modules"
            data-testid="project-virt-kvm-modules"
            value={text}
            placeholder="例：br_netfilter"
            className="h-8 font-mono text-xs"
            onChange={(e) => setText(e.target.value)}
          />
          {/* オンのときだけ、名前を変えたら保存する（オフなら、入れるときに一緒に送る） */}
          {v.kvm && modulesChanged ? (
            <Button
              type="button"
              size="sm"
              className="h-8 text-xs"
              disabled={saving || invalid.length > 0}
              data-testid="project-virt-kvm-modules-save"
              onClick={() => void apply(true, false)}
            >
              保存
            </Button>
          ) : null}
        </div>
        {invalid.length > 0 ? (
          <p data-testid="project-virt-kvm-modules-invalid" className="text-xs text-stop">
            {`名前に使えるのは英小文字・数字・「_」「-」だけです：${invalid.join("、")}`}
          </p>
        ) : null}
        {includesBrNetfilter(names) ? (
          <p data-testid="project-virt-br-netfilter" className="text-xs text-warn">
            {"br_netfilter はサーバのブリッジ全部の通り方を変えます（ブリッジを通るパケットが iptables を通るようになる）。同じサーバのほかの Project や Incus の網にも効きます。"}
          </p>
        ) : null}
      </div>
      {warnings.map((w) => (
        <p key={w} data-testid="project-virt-kvm-result-warning" className="text-xs text-warn">
          {w}
        </p>
      ))}
      {error ? (
        <p data-testid="project-virt-kvm-error" className="text-xs text-stop">
          {error}
        </p>
      ) : null}

      <AlertDialog open={askNesting} onOpenChange={setAskNesting}>
        <AlertDialogContent data-testid="project-virt-nesting-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>「中で Docker を使う」も入れますか</AlertDialogTitle>
            <AlertDialogDescription>
              {"containerlab などは中で Docker を使います。「中で Docker を使う」はいま切れています。入れると、コンテナの一部の保護（/proc・/sys への書き込みの制限）が外れ、この Project の Module は立て直しになります。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="project-virt-nesting-cancel">やめる</AlertDialogCancel>
            <Button
              type="button"
              variant="outline"
              data-testid="project-virt-nesting-no"
              onClick={() => {
                setAskNesting(false);
                void apply(true, false);
              }}
            >
              /dev/kvm だけ
            </Button>
            <Button
              type="button"
              data-testid="project-virt-nesting-yes"
              onClick={() => {
                setAskNesting(false);
                void apply(true, true);
              }}
            >
              Docker も使う
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** hugepages（2MiB の数）。断られたら理由、確保できた数が返れば出す */
function HugepagesSetting({ projectId, count, onChanged }: { projectId: string; count: number; onChanged: () => Promise<void> }) {
  const [text, setText] = useState(String(count));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ warnings: string[]; allocated: number; total: number } | null>(null);
  const parsed = /^\d+$/.test(text.trim()) ? Number(text.trim()) : null;

  async function save() {
    if (parsed === null) return;
    setSaving(true);
    setError(null);
    setResult(null);
    try {
      const r = await setRealProjectHugepages(projectId, parsed);
      setResult({ warnings: r.warnings, allocated: r.allocated, total: r.total });
      setText(String(r.hugepages));
    } catch (err) {
      setError(describeFailure(err));
    } finally {
      setSaving(false);
      await onChanged().catch((err: unknown) => reportFailure("仮想化の実験の様子を読み直せませんでした", err));
    }
  }

  return (
    <div data-testid="project-virt-hugepages" className="flex flex-col gap-1.5 border-t border-border pt-3">
      <Label htmlFor="project-virt-hugepages-count">hugepages（2MiB の数）</Label>
      <p className="text-xs text-ink-3">
        {"サーバで確保し、この Project のコンテナはこの数までしか使えません（qemu は -object memory-backend-memfd,hugetlb=on で使う）。" +
          "0 で外します。使っている間は減らせません。確保した分はコンテナのメモリの上限から引かれます。"}
      </p>
      <div className="flex items-center gap-2">
        <Input
          id="project-virt-hugepages-count"
          data-testid="project-virt-hugepages-count"
          inputMode="numeric"
          value={text}
          className="h-8 w-32 font-mono text-xs"
          onChange={(e) => setText(e.target.value)}
        />
        <span className="text-xs text-ink-3">{parsed !== null ? `＝ ${parsed * 2} MiB` : ""}</span>
        <Button
          type="button"
          size="sm"
          className="h-8 text-xs"
          disabled={saving || parsed === null || parsed === count}
          data-testid="project-virt-hugepages-save"
          onClick={() => void save()}
        >
          保存
        </Button>
      </div>
      {parsed === null ? <p className="text-xs text-stop">0 以上の整数で書いてください</p> : null}
      {result ? (
        <p data-testid="project-virt-hugepages-result" className="text-xs text-ink-2">
          {`このサーバで確保できたのは ${result.allocated} 個です（この実行場所の合計 ${result.total} 個）`}
        </p>
      ) : null}
      {result?.warnings.map((w) => (
        <p key={w} className="text-xs text-warn">
          {w}
        </p>
      ))}
      {error ? (
        <p data-testid="project-virt-hugepages-error" className="text-xs text-stop">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** 「特権コンテナにする」。押すと強い警告と、Project の名前を打たせる小窓（オン・オフとも打たせる——host も確かめる） */
function PrivilegedSetting({
  projectId,
  projectName,
  privileged,
  onChanged,
}: {
  projectId: string;
  projectName: string;
  privileged: boolean;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = !privileged;

  async function confirm() {
    setSaving(true);
    setError(null);
    try {
      await setRealProjectPrivileged(projectId, next, typed);
      setOpen(false);
    } catch (err) {
      setError(describeFailure(err));
    } finally {
      setSaving(false);
      await onChanged().catch((err: unknown) => reportFailure("仮想化の実験の様子を読み直せませんでした", err));
      // サイドバーの行の印（host の一覧の `privileged`）
      await syncRealProjects().catch((err: unknown) => reportFailure("Project の一覧を読み直せませんでした", err));
    }
  }

  return (
    <div data-testid="project-virt-privileged" className="flex flex-col gap-1.5 border-t border-border pt-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <p className="flex items-center gap-2 text-sm font-medium text-foreground">
            特権コンテナにする
            {privileged ? (
              <span
                data-testid="project-virt-privileged-on"
                className="inline-flex items-center gap-1 rounded-sm bg-stop-soft px-1.5 py-0.5 text-xs font-medium text-stop"
              >
                <ShieldAlert className="size-3" />
                特権コンテナです
              </span>
            ) : null}
          </p>
          <p className="text-xs text-ink-3">
            {"上の2つで足りない実験のための逃げ道です。特権にしても /dev/kvm は「/dev/kvm を見せる」を入れないと見えません。"}
          </p>
        </div>
        <Button
          type="button"
          variant={privileged ? "outline" : "destructive"}
          size="sm"
          className="h-7 shrink-0 text-xs"
          data-testid="project-virt-privileged-open"
          onClick={() => {
            setTyped("");
            setError(null);
            setOpen(true);
          }}
        >
          {privileged ? "特権をやめる…" : "特権コンテナにする…"}
        </Button>
      </div>
      {error && !open ? (
        <p data-testid="project-virt-privileged-error" className="text-xs text-stop">
          {error}
        </p>
      ) : null}

      <AlertDialog open={open} onOpenChange={(o) => !saving && setOpen(o)}>
        <AlertDialogContent data-testid="project-virt-privileged-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{next ? `「${projectName}」を特権コンテナにしますか` : `「${projectName}」の特権をやめますか`}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-2 text-sm">
                {next ? (
                  <p data-testid="project-virt-privileged-warning" className="rounded-md bg-stop-soft px-3 py-2 font-medium text-stop">
                    {PRIVILEGED_WARNING}
                  </p>
                ) : null}
                <p>
                  {next
                    ? "押すと、この Project のコンテナを止めて、特権で起こし直します。この Project の Module は立て直しになります。"
                    : "押すと、この Project のコンテナを止めて、特権無しで起こし直します。この Project の Module は立て直しになります。"}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-virt-privileged-confirm" className="text-xs">
              確かめのため、この Project の名前「{projectName}」を打ってください
            </Label>
            <Input
              id="project-virt-privileged-confirm"
              data-testid="project-virt-privileged-confirm"
              value={typed}
              autoComplete="off"
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
          {error ? (
            <p data-testid="project-virt-privileged-dialog-error" className="text-xs text-stop">
              {error}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>やめる</AlertDialogCancel>
            <Button
              type="button"
              variant={next ? "destructive" : "default"}
              disabled={saving || typed !== projectName}
              data-testid="project-virt-privileged-submit"
              onClick={() => void confirm()}
            >
              {saving ? "止めて起こし直しています…" : next ? "止めて特権で起こし直す" : "止めて特権無しで起こし直す"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
