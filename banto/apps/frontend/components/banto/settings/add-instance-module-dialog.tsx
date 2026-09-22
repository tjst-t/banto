"use client";

// **Module を1本足す**（改訂・2026-09-16、ユーザー指摘「普通の人には使いづらい」）。
//
// **打たせない。貼らせる。** 人が実際にやっているのは、README や Claude Code の
// 設定から `mcpServers` の JSON をコピーしてくること——それをそのまま受ける
// （`docs/specs/v4-architecture.md` §5.1「独自形式を作らない」）。
//
// 手で書く欄も残すが、**二番手**にする。
//
// **いちばん上は「banto 同梱」**（追加・2026-09-20、ユーザー決定）。`vault-infisical`
// のように **banto のコードだが誰もが使うわけではない**ものは、既定に入れずここに
// 置く。要る人が、好きな名前で何本でも入れる（接続先ごとに1本）。
// **宣言を組み立てるのは host**——画面は目録の id と名前しか送らない。役割を
// 画面に組み立てさせると、貼り付けた JSON が金庫の窓口を名乗る経路が復活する。
//
// **聞かないことは変えていない**：
// - 「Project のフォルダを触りますか」は聞かない（誤答の被害が釣り合わない）
//   ——`${projectRoot}` を書いたかで決まる
// - 閉じ込めは外せない。外から繋ぐコードは必ず閉じ込める

import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PillTabs, SegmentedTabs } from "@/components/banto/shell/segmented-tabs";
import {
  installRealModuleFromCatalog,
  listRealModuleCatalog,
  installRealModuleFromRegistry,
  type RealCatalogEntry,
} from "@/lib/backend/client";
import {
  RegistryModulePicker,
  type RegistryPick,
} from "@/components/banto/settings/registry-module-picker";

const PROJECT_ROOT = "${projectRoot}";

const SAMPLE = `{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "\${secret:github-token}" }
    }
  }
}`;

/**
 * **貼られた設定のうち、URL に繋ぐものの相手**（追加・2026-09-17）。
 *
 * 「呼ぶたびに、会話から来た内容がここへ出ていく」——**押す前に、相手の名前で
 * 言う**（`docs/specs/v4-security.md`）。読めない JSON のときは空（まだ言えない）。
 */
function remoteHostsIn(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const servers = (parsed.mcpServers ?? parsed) as Record<string, { type?: string; url?: string }>;
    return [
      ...new Set(
        Object.values(servers)
          .filter((s) => s && (s.type === "http" || typeof s.url === "string"))
          .map((s) => {
            try {
              return new URL(s.url ?? "").host;
            } catch {
              return "";
            }
          })
          .filter(Boolean),
      ),
    ];
  } catch {
    return [];
  }
}

/** 貼られた設定に、API キーらしき平文が入っていないか（記録に残ると伝えるため）。 */
function looksLikePlainSecret(json: string): boolean {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const servers = (parsed.mcpServers ?? parsed) as Record<string, { env?: Record<string, string> }>;
    return Object.values(servers).some((s) =>
      Object.entries(s?.env ?? {}).some(
        ([k, v]) =>
          /KEY|TOKEN|SECRET|PASSWORD/i.test(k) && typeof v === "string" && !v.includes("${secret:"),
      ),
    );
  } catch {
    return false;
  }
}

export interface AddInstanceModuleDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** いま在る Module の名前。**同じ名前を既定に出さない**ために使う */
  existingNames: readonly string[];
  /** 目録から入れたあと、一覧を読み直す */
  onInstalled(): Promise<void>;
  /** 手で書いた1本を足す。**URL に繋ぐ形のときは承知の印も渡す**。 */
  onSubmit(
    declaration: {
      name: string;
      launch:
        | { command: string; args: string[]; env?: Record<string, string> }
        | { type: "http"; url: string; headers?: Record<string, string> };
      meta: unknown;
    },
    acknowledgeEgress?: boolean,
  ): Promise<void>;
  /** 貼り付けた `mcpServers` を足す。足した名前を返す。 */
  onPaste(json: string, acknowledgeEgress?: boolean): Promise<string[]>;
}

export function AddInstanceModuleDialog({
  open,
  onOpenChange,
  onSubmit,
  onPaste,
  existingNames,
  onInstalled,
}: AddInstanceModuleDialogProps) {
  // **外のタブは2つ**（改訂・2026-09-20、ユーザー指摘）。「貼り付ける」「自分で書く」は
  // 並べる粒度が違ううえ、名前が何を指すのか分からなかった——**公式か、自分で足すか**で
  // 分け、入れ方（JSON か、項目を手で入れるか）は中のサブタブにする。
  // 語は既存ソフトの慣習に合わせる：設定ファイルを取り込む（Import）と、
  // 項目を手で入れる（Add manually）——VS Code・Postman・1Password などが同じ分け方
  // **外のタブは3つ**（改訂・2026-09-21、ユーザー要望）——公式（banto 同梱）・
  // MCP Registry（世の中の目録）・カスタム（自分で足す）。registry は
  // 「誰かが公開したものを選ぶ」という点で同梱と同じ粒度なので、隣に並ぶ
  const [mode, setMode] = useState<"bundled" | "registry" | "custom">("bundled");
  // registry から選んだ1件（必須の欄が埋まっているかまで含む）
  const [registryPick, setRegistryPick] = useState<RegistryPick | null>(null);
  const [customMode, setCustomMode] = useState<"json" | "manual">("json");
  const [pasted, setPasted] = useState("");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  // **URL に繋ぐ形**（追加・2026-09-17）。手で書く道でも選べる
  const [connect, setConnect] = useState<"stdio" | "remote">("stdio");
  const [url, setUrl] = useState("");
  /** 「machine の外へ出す」ことを人が承知したか。**既定は未承知**（規則2）。 */
  const [egressOk, setEgressOk] = useState(false);
  const [envName, setEnvName] = useState("");
  const [envValue, setEnvValue] = useState("");
  // **既定は金庫から**——直書きは消せないので、楽な道を安全なほうに置く
  const [fromVault, setFromVault] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // **同梱の目録**（既定には入れていないが banto が持っている実装）
  const [catalog, setCatalog] = useState<RealCatalogEntry[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [catalogName, setCatalogName] = useState("");

  // **開いたときに読む**（閉じている間は聞かない）
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listRealModuleCatalog()
      .then((list) => !cancelled && setCatalog(list))
      // **読めなかったことを「無い」と混同しない**（規則2）
      .catch((err: unknown) => {
        if (cancelled) return;
        setCatalog([]);
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const args = argsText.split(/\s+/).filter(Boolean);
  const manualRemote = mode === "custom" && customMode === "manual" && connect === "remote";
  // **どこに立つかは、書いたものから決まる**（聞かない）
  const perProject = manualRemote
    ? false
    : mode === "custom" && customMode === "manual"
      ? args.includes(PROJECT_ROOT) || command.includes(PROJECT_ROOT)
      : pasted.includes(PROJECT_ROOT);

  // **相手の名前**——押す前に、どこへ出ていくかを言うために
  // **registry から選んだものが URL に繋ぐ形なら、そこも承知を取る**
  // （追加・2026-09-21）——閉じ込めが効かない代わりに要るのがこの承知
  const registryRemoteHost =
    mode === "registry" && registryPick?.entry.connect.kind === "remote"
      ? registryPick.entry.connect.host
      : undefined;
  const remoteHosts = manualRemote
    ? (() => {
        try {
          return url.trim() ? [new URL(url.trim()).host] : [];
        } catch {
          return [];
        }
      })()
    : mode === "custom" && customMode === "json"
      ? remoteHostsIn(pasted)
      : [];
  const isRemote = manualRemote || remoteHosts.length > 0 || registryRemoteHost !== undefined;

  function reset() {
    setPasted("");
    setName("");
    setCommand("");
    setArgsText("");
    setEnvName("");
    setEnvValue("");
    setFromVault(true);
    setConnect("stdio");
    setUrl("");
    setEgressOk(false);
    setError(null);
    setMode("bundled");
    setCustomMode("json");
    setPicked(null);
    setCatalogName("");
    setRegistryPick(null);
  }

  const canSubmit =
    (mode === "registry"
      ? registryPick !== null && registryPick.ready
      : mode === "bundled"
      ? picked !== null && catalogName.trim().length > 0
      : customMode === "json"
      ? pasted.trim().length > 0
      : manualRemote
        ? name.trim().length > 0 && url.trim().length > 0
        : name.trim().length > 0 && command.trim().length > 0) &&
    // **外へ出すものは、承知していなければ押せない**（規則2——既定は止める側）
    (!isRemote || egressOk);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Module を追加</DialogTitle>
          {/* **説明文は置かない**（改訂・2026-09-20、ユーザー指摘）
              ——タブを見れば分かることを、上でもう一度言わない */}
        </DialogHeader>

        {/* **履歴のタブと同じ作り**（`SegmentedTabs`・決定・2026-09-20、ユーザー） */}
        <SegmentedTabs
          label="Module の入れ方"
          testId="add-module-tabs"
          value={mode}
          onChange={(id) => setMode(id as typeof mode)}
          tabs={[
            { id: "bundled", label: "公式モジュール", count: catalog?.length },
            { id: "registry", label: "MCP Registry" },
            { id: "custom", label: "カスタム" },
          ]}
        />

        {mode === "bundled" ? (
          <div className="flex flex-col gap-3" data-testid="add-module-bundled">
            <p className="text-xs text-ink-3">
              banto が公式に提供している Module のうち、<strong>最初から入っていないもの</strong>。
              接続先ごとに1本入れます——同じものを何本入れても構いません。
            </p>
            {catalog === null ? (
              <p className="text-xs text-ink-3">読み込み中…</p>
            ) : catalog.length === 0 ? (
              <p className="rounded-md border border-dashed border-border p-4 text-center text-xs text-ink-3">
                入れられる同梱 Module はありません
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                {catalog.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    data-testid={`add-module-bundled-${e.id}`}
                    data-state={picked === e.id ? "active" : "inactive"}
                    onClick={() => {
                      setPicked(e.id);
                      // **同じ名前が在れば、番号を足して出す**（人が考えなくてよい）
                      const taken = new Set(existingNames);
                      let next = e.suggestedName;
                      for (let i = 2; taken.has(next); i += 1) next = `${e.suggestedName}-${i}`;
                      setCatalogName(next);
                    }}
                    className={
                      "flex flex-col items-start gap-0.5 rounded-md border p-2.5 text-left " +
                      (picked === e.id ? "border-accent bg-accent-soft/40" : "border-border")
                    }
                  >
                    <span className="text-sm font-medium text-foreground">{e.name}</span>
                    <span className="text-xs text-ink-3">{e.description}</span>
                    <span className="text-xs text-ink-3">
                      役割：{e.satisfies.join("・") || "—"}・
                      {e.scope === "instance" ? "banto 全体で1本" : "Project ごとに1本"}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {picked ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="add-module-bundled-name">名前</Label>
                <Input
                  id="add-module-bundled-name"
                  value={catalogName}
                  onChange={(e) => setCatalogName(e.target.value)}
                />
                <p className="text-xs text-ink-3">
                  設定画面と置き場は、この名前ごとに分かれます
                </p>
              </div>
            ) : null}
          </div>
        ) : null}

        {mode === "registry" ? (
          <RegistryModulePicker existingNames={existingNames} onChange={setRegistryPick} />
        ) : null}

        {mode === "custom" ? (
          // **入れ方は2つ**——設定ファイルを取り込むか、項目を手で入れるか。
          // 既存ソフトと同じ分け方（Import / Add manually）
          <PillTabs
            label="カスタム Module の入れ方"
            testId="add-module-custom-tabs"
            value={customMode}
            onChange={(id) => setCustomMode(id as typeof customMode)}
            tabs={[
              { id: "json", label: "JSON を貼り付け" },
              { id: "manual", label: "手動で入力" },
            ]}
          />
        ) : null}

        {mode === "custom" && customMode === "json" ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="add-module-paste">設定（JSON）</Label>
            <Textarea
              id="add-module-paste"
              rows={10}
              className="font-mono text-xs"
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder={SAMPLE}
            />
            <p className="text-xs text-ink-3">
              <code>mcpServers</code> の中身だけでも受けます。複数まとめて貼ってもかまいません
            </p>
            {/* **秘密は Vault から引ける**（追加・2026-09-16）。直書きも通すが、
                **記録に残ることは隠さない**（規則2） */}
            <p className="text-xs text-ink-3">
              API キーは <code>{"${secret:名前}"}</code> と書くと、
              <strong>Vault から引いて起動時に渡します</strong>（記録には名前だけ残ります）
            </p>
            {looksLikePlainSecret(pasted) ? (
              <p className="text-xs text-danger" data-testid="add-module-plain-secret">
                値が直接書かれています。<strong>この値は banto の記録に残り続けます（後から消せません）。</strong>
                Vault に入れて <code>{"${secret:名前}"}</code> で参照することをすすめます
              </p>
            ) : null}
          </div>
        ) : mode === "custom" ? (
          <div className="flex flex-col gap-3">
            {/* **3段目のタブは作らない**（改訂・2026-09-20）——これは「どこに居るか」
                ではなく**入力の1項目**なので、ラベルを付けてフォームに降ろす */}
            <div className="flex flex-col gap-1.5">
              <Label>接続方法</Label>
              <PillTabs
                label="接続方法"
                testId="add-module-connect"
                value={connect}
                onChange={(id) => setConnect(id as typeof connect)}
                tabs={[
                  { id: "stdio", label: "このサーバで起動" },
                  { id: "remote", label: "URL に接続" },
                ]}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="add-module-name">名前</Label>
              <Input
                id="add-module-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="weather"
              />
            </div>
            {manualRemote ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="add-module-url">URL</Label>
                <Input
                  id="add-module-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/mcp"
                />
              </div>
            ) : (
              <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="add-module-command">コマンド</Label>
              <Input
                id="add-module-command"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="npx"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="add-module-args">引数（空白区切り）</Label>
              <Input
                id="add-module-args"
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                placeholder="-y @modelcontextprotocol/server-weather"
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 w-fit self-start px-1.5 text-xs text-ink-2"
                onClick={() => setArgsText((prev) => `${prev} ${PROJECT_ROOT}`.trim())}
              >
                ＋ この Project のフォルダを渡す
              </Button>
            </div>
              </>
            )}

            {/* **API キーを入れる場所**（追加・2026-09-16）。ここが無いと、
                手で書く道では鍵の要る MCP サーバを繋げない。
                **既定は「Vault から」**——直書きは記録に残り続けるので、
                楽な道を安全なほうに置く */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="add-module-env-name">
                {manualRemote ? "API キー（ヘッダ名／要るときだけ）" : "API キー（要るときだけ）"}
              </Label>
              <div className="flex gap-2">
                <Input
                  id="add-module-env-name"
                  className="flex-1"
                  value={envName}
                  onChange={(e) => setEnvName(e.target.value)}
                  placeholder={manualRemote ? "Authorization" : "ACCUWEATHER_API_KEY"}
                />
                <Input
                  aria-label={fromVault ? "Vault に入れた名前" : "値"}
                  className="flex-1"
                  value={envValue}
                  onChange={(e) => setEnvValue(e.target.value)}
                  placeholder={fromVault ? "accuweather" : "sk-…"}
                />
              </div>
              <PillTabs
                label="API キーの渡し方"
                testId="add-module-secret-source"
                size="xs"
                value={fromVault ? "vault" : "plain"}
                onChange={(id) => setFromVault(id === "vault")}
                tabs={[
                  { id: "vault", label: "Vault から" },
                  { id: "plain", label: "直接入力" },
                ]}
              />
              <p
                className={fromVault ? "text-xs text-ink-3" : "text-xs text-danger"}
                data-testid="add-module-secret-note"
              >
                {fromVault
                  ? "Vault に預けた名前を書きます。起動のたびに引いて渡すので、記録には名前だけが残ります"
                  : "この値は banto の記録に残り続けます（後から消せません）"}
              </p>
            </div>
          </div>
        ) : null}

        {/* **押す前に、何が決まるかを出す**（導出は隠さない）。
            同梱タブでは出さない——そこは目録の行が役割と立つ場所を言っている */}
        {mode === "bundled" || mode === "registry" ? null : (
          // **押す前に、何が決まるかを1行で**（導出は隠さない）。
          // 以前は説明の段落を3つ積んでいて、どれが大事か分からなかった
          <p
            className="rounded-md bg-surface-2 px-3 py-2 text-xs text-ink-2"
            data-testid="add-module-effect"
          >
            {isRemote
              ? "banto 全体から使えます。プロセスは立てません（相手のサーバで動いています）"
              : perProject
                ? "Project ごとに1本立ち、その Project のフォルダだけを渡します"
                : "banto 全体で1本立ちます（Project のフォルダは渡りません）"}
            。
            <strong className="text-foreground">
              {isRemote
                ? "相手のコードは閉じ込められません（こちらで動いていないため）"
                : "外から繋ぐコードは必ず閉じ込めます"}
            </strong>
          </p>
        )}

        {/* **外へ出すことは、押す前に、相手の名前で言う**（決定・2026-09-17、
            `docs/specs/v4-security.md`「Module が machine の外へデータを出す」）。
            閉じ込めが効かない代わりに要るのが、この承知 */}
        {isRemote ? (
          <label
            className="flex items-start gap-2 rounded-lg bg-turn-soft px-3 py-2 text-xs text-foreground"
            data-testid="add-module-egress-notice"
          >
            <input
              type="checkbox"
              className="mt-0.5"
              checked={egressOk}
              onChange={(e) => setEgressOk(e.target.checked)}
              data-testid="add-module-egress-ack"
            />
            <span>
              この Module を呼ぶたびに、会話から来た内容が
              <strong className="text-danger">
                {registryRemoteHost ?? (remoteHosts.length > 0 ? remoteHosts.join("・") : "この URL の相手")}
              </strong>
              へ送られます（banto の外に出ます）。承知しました
            </span>
          </label>
        ) : null}

        {error ? (
          <p className="text-xs text-danger" data-testid="add-module-error">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            キャンセル
          </Button>
          <Button
            type="button"
            disabled={busy || !canSubmit}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                if (mode === "registry") {
                  // **画面は「どれか・名前・値」しか送らない**——起動の指定は
                  // host が `server.json` を引き直して作る（`v4-security.md`）
                  await installRealModuleFromRegistry(
                    registryPick!.entry.name,
                    registryPick!.name,
                    registryPick!.answers,
                  );
                  await onInstalled();
                } else if (mode === "bundled") {
                  await installRealModuleFromCatalog(picked!, catalogName.trim());
                  await onInstalled();
                } else if (customMode === "json") {
                  await onPaste(pasted, isRemote);
                } else if (manualRemote) {
                  const key = envName.trim();
                  const val = envValue.trim();
                  const headers =
                    key && val ? { [key]: fromVault ? `\${secret:${val}}` : val } : undefined;
                  await onSubmit(
                    {
                      name: name.trim(),
                      launch: { type: "http", url: url.trim(), ...(headers ? { headers } : {}) },
                      // **閉じ込めは書かない**——掛からないものを付けたふりをしない
                      meta: { satisfies: [], dependsOn: [], isolation: "subprocess", scope: "instance" },
                    },
                    true,
                  );
                } else {
                  const key = envName.trim();
                  const val = envValue.trim();
                  const env =
                    key && val ? { [key]: fromVault ? `\${secret:${val}}` : val } : undefined;
                  await onSubmit({
                    name: name.trim(),
                    launch: { command: command.trim(), args, ...(env ? { env } : {}) },
                    meta: {
                      satisfies: [],
                      dependsOn: [],
                      isolation: "subprocess",
                      ...(perProject ? { scope: "project" } : {}),
                      confinement: { kind: "landlock", root: perProject ? "project" : "none" },
                    },
                  });
                }
                reset();
                onOpenChange(false);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            追加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
