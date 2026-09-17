"use client";

// **Module を1本足す**（改訂・2026-09-16、ユーザー指摘「普通の人には使いづらい」）。
//
// **打たせない。貼らせる。** 人が実際にやっているのは、README や Claude Code の
// 設定から `mcpServers` の JSON をコピーしてくること——それをそのまま受ける
// （`docs/specs/v4-architecture.md` §5.1「独自形式を作らない」）。
//
// 手で書く欄も残すが、**二番手**にする。
//
// **聞かないことは変えていない**：
// - 「Project のフォルダを触りますか」は聞かない（誤答の被害が釣り合わない）
//   ——`${projectRoot}` を書いたかで決まる
// - 閉じ込めは外せない。外から繋ぐコードは必ず閉じ込める

import { useState } from "react";
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
}: AddInstanceModuleDialogProps) {
  const [mode, setMode] = useState<"paste" | "manual">("paste");
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

  const args = argsText.split(/\s+/).filter(Boolean);
  const manualRemote = mode === "manual" && connect === "remote";
  // **どこに立つかは、書いたものから決まる**（聞かない）
  const perProject = manualRemote
    ? false
    : mode === "manual"
      ? args.includes(PROJECT_ROOT) || command.includes(PROJECT_ROOT)
      : pasted.includes(PROJECT_ROOT);

  // **相手の名前**——押す前に、どこへ出ていくかを言うために
  const remoteHosts = manualRemote
    ? (() => {
        try {
          return url.trim() ? [new URL(url.trim()).host] : [];
        } catch {
          return [];
        }
      })()
    : mode === "paste"
      ? remoteHostsIn(pasted)
      : [];
  const isRemote = manualRemote || remoteHosts.length > 0;

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
    setMode("paste");
  }

  const canSubmit =
    (mode === "paste"
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
          <DialogDescription>
            <strong>設定をそのまま貼り付けてください。</strong>
            Claude Code などと同じ形（<code>mcpServers</code>）で受けます
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1" role="tablist">
          <Button
            type="button"
            size="sm"
            role="tab"
            variant={mode === "paste" ? "default" : "ghost"}
            onClick={() => setMode("paste")}
          >
            貼り付ける
          </Button>
          <Button
            type="button"
            size="sm"
            role="tab"
            variant={mode === "manual" ? "default" : "ghost"}
            onClick={() => setMode("manual")}
          >
            自分で書く
          </Button>
        </div>

        {mode === "paste" ? (
          <div className="flex flex-col gap-1">
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
            {/* **秘密は金庫から引ける**（追加・2026-09-16）。直書きも通すが、
                **記録に残ることは隠さない**（規則2） */}
            <p className="text-xs text-ink-3">
              API キーは <code>{"${secret:名前}"}</code> と書くと、
              <strong>金庫から引いて起動時に渡します</strong>（記録には名前だけ残ります）
            </p>
            {looksLikePlainSecret(pasted) ? (
              <p className="text-xs text-danger" data-testid="add-module-plain-secret">
                値が直接書かれています。<strong>この値は banto の記録に残り続けます（後から消せません）。</strong>
                金庫に入れて <code>{"${secret:名前}"}</code> で参照することをすすめます
              </p>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {/* **形は2つ**（追加・2026-09-17）——こちらで起こすか、URL に繋ぐか */}
            <div className="flex gap-1">
              <Button
                type="button"
                size="sm"
                role="tab"
                variant={connect === "stdio" ? "default" : "ghost"}
                onClick={() => setConnect("stdio")}
              >
                このサーバで起動する
              </Button>
              <Button
                type="button"
                size="sm"
                role="tab"
                variant={connect === "remote" ? "default" : "ghost"}
                onClick={() => setConnect("remote")}
              >
                URL に繋ぐ
              </Button>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="add-module-name">名前</Label>
              <Input
                id="add-module-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="weather"
              />
            </div>
            {manualRemote ? (
              <div className="flex flex-col gap-1">
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
            <div className="flex flex-col gap-1">
              <Label htmlFor="add-module-command">コマンド</Label>
              <Input
                id="add-module-command"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="npx"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="add-module-args">引数（空白区切り）</Label>
              <Input
                id="add-module-args"
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                placeholder="-y @modelcontextprotocol/server-weather"
              />
              <div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setArgsText((prev) => `${prev} ${PROJECT_ROOT}`.trim())}
                >
                  ＋ この Project のフォルダを渡す
                </Button>
              </div>
            </div>
              </>
            )}

            {/* **API キーを入れる場所**（追加・2026-09-16）。ここが無いと、
                手で書く道では鍵の要る MCP サーバを繋げない。
                **既定は「金庫から」**——直書きは記録に残り続けるので、
                楽な道を安全なほうに置く */}
            <div className="flex flex-col gap-1">
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
                  aria-label={fromVault ? "金庫に入れた名前" : "値"}
                  className="flex-1"
                  value={envValue}
                  onChange={(e) => setEnvValue(e.target.value)}
                  placeholder={fromVault ? "accuweather" : "sk-…"}
                />
              </div>
              <div className="flex gap-1">
                <Button
                  type="button"
                  size="sm"
                  role="tab"
                  variant={fromVault ? "default" : "ghost"}
                  onClick={() => setFromVault(true)}
                >
                  金庫から
                </Button>
                <Button
                  type="button"
                  size="sm"
                  role="tab"
                  variant={fromVault ? "ghost" : "default"}
                  onClick={() => setFromVault(false)}
                >
                  直接入力
                </Button>
              </div>
              <p
                className={fromVault ? "text-xs text-ink-3" : "text-xs text-danger"}
                data-testid="add-module-secret-note"
              >
                {fromVault
                  ? "金庫に預けた名前を書きます。起動のたびに引いて渡すので、記録には名前だけが残ります"
                  : "この値は banto の記録に残り続けます（後から消せません）"}
              </p>
            </div>
          </div>
        )}

        {/* **押す前に、何が決まるかを出す**（導出は隠さない） */}
        <p className="text-xs text-ink-3" data-testid="add-module-effect">
          {isRemote
            ? "banto 全体から使えます。プロセスは立てません（相手のサーバで動いています）"
            : perProject
              ? "Project ごとに1本立ち、その Project のフォルダだけを渡します"
              : "banto 全体で1本立ちます（Project のフォルダは渡りません）"}
          。
          <strong>
            {isRemote
              ? "相手のコードは閉じ込められません（こちらで動いていないため）"
              : "外から繋ぐコードは必ず閉じ込めます"}
          </strong>
        </p>

        {/* **外へ出すことは、押す前に、相手の名前で言う**（決定・2026-09-17、
            `docs/specs/v4-security.md`「Module が machine の外へデータを出す」）。
            閉じ込めが効かない代わりに要るのが、この承知 */}
        {isRemote ? (
          <label
            className="flex items-start gap-2 rounded-lg border border-danger/40 p-2 text-xs text-danger"
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
              この Module を呼ぶたびに、<strong>会話から来た内容が
              {remoteHosts.length > 0 ? `「${remoteHosts.join("・")}」` : "この URL の相手"}へ送られます</strong>
              （banto の外に出ます）。承知しました
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
            やめる
          </Button>
          <Button
            type="button"
            disabled={busy || !canSubmit}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                if (mode === "paste") {
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
            追加する
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
