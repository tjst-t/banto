"use client";

// item14「instance が新しい実装を知る」——§5.1「Module の発見元は3つ」の
// モック実装。一度選んだら取り込んで閉じる one-shot 操作なので Dialog
// （§6.6の基準どおり、Sheetではない）。banto 自身は検索・カタログ・レビューを
// 持つ「ストア」ではない——`server.json`／`mcpServers`という既存の規約への
// 薄い入口を切り替えるだけ（2026-09-02、Gitリポジトリ・ローカルパスという
// 独自分類は撤回——どちらも「server.jsonをどこから読むか」のバリエーション
// でしかないと分かった、docs/notes/2026-09-02-server-json-mcpservers.md）。
import { useState, type ChangeEvent, type ReactNode } from "react";
import { FileJson, Globe, Search, Upload } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createImplementation, getRoles } from "@/lib/mock/settings";

// 公式 MCP レジストリの検索結果（モック——実際には registry.modelcontextprotocol.io
// への REST 呼び出しになる、§5.1）。role は `server.json` の `_meta` から分かる前提
const MOCK_REGISTRY_RESULTS: readonly { id: string; name: string; roleId: string }[] = [
  { id: "io.github.mark3labs/mcp-filesystem-server", name: "mcp-filesystem-server", roleId: "filesystem" },
  { id: "io.github.wonderwhy-er/desktop-commander", name: "Desktop Commander", roleId: "shell" },
  { id: "io.github.anthropics/skill-hub", name: "Skill Hub Registry", roleId: "skills" },
  { id: "io.github.github/github-mcp-server", name: "GitHub MCP Server", roleId: "repo" },
  { id: "io.github.hashicorp/vault-mcp", name: "HashiCorp Vault", roleId: "vault" },
];

export function AddModuleDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [source, setSource] = useState<"registry" | "server-json" | "mcp-servers">("registry");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Module を追加</DialogTitle>
          <DialogDescription>
            banto 自身はストア（検索・カタログ・レビュー）を持たない——既にある
            `server.json`／`mcpServers` の規約に乗るだけ。
          </DialogDescription>
        </DialogHeader>

        <Tabs value={source} onValueChange={(v) => setSource(v as typeof source)}>
          <TabsList className="w-full">
            <TabsTrigger value="registry">
              <Search className="size-3.5" /> レジストリ
            </TabsTrigger>
            <TabsTrigger value="server-json">
              <FileJson className="size-3.5" /> server.json
            </TabsTrigger>
            <TabsTrigger value="mcp-servers">
              <Globe className="size-3.5" /> mcpServers
            </TabsTrigger>
          </TabsList>

          <TabsContent value="registry" className="pt-2">
            <RegistryTab onDone={() => onOpenChange(false)} />
          </TabsContent>
          <TabsContent value="server-json" className="pt-2">
            <ServerJsonTab onDone={() => onOpenChange(false)} />
          </TabsContent>
          <TabsContent value="mcp-servers" className="pt-2">
            <McpServersTab onDone={() => onOpenChange(false)} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function RegistryTab({ onDone }: { onDone: () => void }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const results = q ? MOCK_REGISTRY_RESULTS.filter((r) => r.name.toLowerCase().includes(q)) : MOCK_REGISTRY_RESULTS;

  function importResult(result: (typeof MOCK_REGISTRY_RESULTS)[number]) {
    createImplementation({
      id: `registry:${result.id}`,
      roleId: result.roleId,
      name: result.name,
      isolation: "subprocess",
    });
    onDone();
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-ink-3">
        registry.modelcontextprotocol.io を検索する——見つけた server.json を
        mcpServers エントリに変換して保存する
      </p>
      <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="サーバー名で検索…" className="h-8" />
      {results.length === 0 ? (
        <p className="py-3 text-center text-sm text-ink-3">見つからない</p>
      ) : (
        <div className="flex max-h-72 flex-col gap-1.5 overflow-auto">
          {results.map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm text-foreground">{r.name}</p>
                <p className="truncate text-xs text-ink-3">{r.id}</p>
              </div>
              <Button type="button" size="sm" onClick={() => importResult(r)}>
                取り込む
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ServerJsonTab({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"url" | "upload">("url");
  const [url, setUrl] = useState("");
  const [fileName, setFileName] = useState("");
  const [name, setName] = useState("");
  const [roleId, setRoleId] = useState<string | undefined>(undefined);
  const roles = getRoles();

  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    // server.json の name/title があれば表示名を埋める——role は _meta を
    // 読めば分かる想定だが、モックでは実際にパースせず人に選ばせる
    try {
      const parsed = JSON.parse(await file.text());
      if (typeof parsed.title === "string") setName(parsed.title);
      else if (typeof parsed.name === "string") setName(parsed.name);
    } catch {
      // JSON として読めなくても、ファイル名だけは残す
    }
  }

  function handleImport() {
    const location = mode === "url" ? url.trim() : fileName;
    if (!location || !name.trim() || !roleId) return;
    createImplementation({
      id: `server-json:${location}:${Date.now()}`,
      roleId,
      name: name.trim(),
      isolation: "subprocess",
    });
    onDone();
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-ink-3">
        リモートの server.json を URL で指定するか、手元のファイルをアップロードする——
        どちらも同じ「server.json を読む」処理。banto 用の Module も、GitHub 上に置いた
        server.json を URL で指すだけで取り込める。
      </p>

      <div className="flex gap-1.5">
        <SourceButton active={mode === "url"} icon={<Globe className="size-3.5" />} label="URL で指定" onClick={() => setMode("url")} />
        <SourceButton active={mode === "upload"} icon={<Upload className="size-3.5" />} label="ファイルをアップロード" onClick={() => setMode("upload")} />
      </div>

      {mode === "url" ? (
        <div key="url" className="flex flex-col gap-1.5">
          <Label htmlFor="server-json-url" className="text-xs">
            server.json の URL
          </Label>
          <Input
            id="server-json-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://raw.githubusercontent.com/owner/repo/main/server.json"
            className="h-8 font-mono text-xs"
          />
        </div>
      ) : (
        <div key="upload" className="flex flex-col gap-1.5">
          <Label htmlFor="server-json-file" className="text-xs">
            server.json ファイル
          </Label>
          <Input id="server-json-file" type="file" accept="application/json" onChange={handleFile} className="h-8 text-xs" />
          {fileName ? <p className="text-xs text-ink-3">選択中：{fileName}</p> : null}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="server-json-name" className="text-xs">
          表示名
        </Label>
        <Input
          id="server-json-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="この Module の名前"
          className="h-8"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="server-json-role" className="text-xs">
          この Module が名乗る role
        </Label>
        <Select value={roleId} onValueChange={setRoleId}>
          <SelectTrigger id="server-json-role" className="h-8 w-full">
            <SelectValue placeholder="role を選ぶ" />
          </SelectTrigger>
          <SelectContent>
            {roles.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Button
        type="button"
        size="sm"
        disabled={(mode === "url" ? !url.trim() : !fileName) || !name.trim() || !roleId}
        onClick={handleImport}
        className="self-end"
      >
        取り込む
      </Button>
    </div>
  );
}

// role の宣言は _meta["dev.banto/module"] に乗る（§5.1、決定・2026-09-02）——
// 別立ての role ドロップダウンを持たず、この1つの JSON がすべての出どころに
// なる。書式を知らないと書けないので、動く値のまま最初から埋めておく
// （placeholder ではなく初期値——空欄からこの形を思いつける人はいない）
const MCP_SERVERS_SAMPLE = `{
  "my-server": {
    "command": "npx",
    "args": ["-y", "my-mcp-package"],
    "env": { "API_KEY": "$my-alias" },
    "_meta": {
      "dev.banto/module": {
        "satisfies": ["shell"],
        "dependsOn": ["vault"]
      }
    }
  }
}`;

/**
 * role・依存の宣言も含めた mcpServers エントリの生JSONを読み書きするだけの
 * フォーム。Module の追加（新規JSON）にも、インストール済み Module の設定変更
 * （既存JSONの編集、§6.1）にも同じものを使う——banto は「書ける形」を1つに
 * 絞る（§5.1、mcpServersが唯一の真実）。構造化フィールド編集は作らない。
 */
export function McpServersEditor({
  initialJson,
  submitLabel,
  onSubmit,
}: {
  initialJson: string;
  submitLabel: string;
  onSubmit: (json: string, roleId: string, serverName: string) => void;
}) {
  const [json, setJson] = useState(initialJson);
  const [error, setError] = useState<string | null>(null);

  function handleSubmit() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      setError("JSON として読めない");
      return;
    }
    if (typeof parsed !== "object" || parsed === null) {
      setError("mcpServers のオブジェクトではない");
      return;
    }
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length === 0) {
      setError("サーバー名が無い");
      return;
    }
    const [serverName, entry] = entries[0];
    const meta = (entry as { _meta?: Record<string, unknown> } | undefined)?._meta;
    const moduleMeta = meta?.["dev.banto/module"] as { satisfies?: readonly string[] } | undefined;
    const roleId = moduleMeta?.satisfies?.[0];
    if (!roleId) {
      setError('_meta["dev.banto/module"].satisfies に role が無い');
      return;
    }
    setError(null);
    onSubmit(json, roleId, serverName);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="mcp-servers-json" className="text-xs">
          mcpServers エントリ
        </Label>
        <Textarea
          id="mcp-servers-json"
          value={json}
          onChange={(e) => setJson(e.target.value)}
          className="h-48 font-mono text-xs"
        />
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>

      <Button type="button" size="sm" disabled={!json.trim()} onClick={handleSubmit} className="self-end">
        {submitLabel}
      </Button>
    </div>
  );
}

function McpServersTab({ onDone }: { onDone: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-ink-3">
        server.json すら無い場合の最終手段——mcpServers 規約（Claude Desktop・Claude Code・
        Cursor 等が共通して使う設定形式）のエントリを直接書く。role の宣言も
        <code className="mx-1 rounded bg-surface-2 px-1 py-0.5">
          _meta[&quot;dev.banto/module&quot;]
        </code>
        としてこの JSON の中に書く（§5.1）——server.json 由来の発見元と同じ場所を見る。
      </p>
      <McpServersEditor
        initialJson={MCP_SERVERS_SAMPLE}
        submitLabel="取り込む"
        onSubmit={(json, roleId, serverName) => {
          createImplementation({
            id: `mcp-servers:${serverName}:${Date.now()}`,
            roleId,
            name: serverName,
            isolation: "subprocess",
            mcpServersJson: json,
          });
          onDone();
        }}
      />
    </div>
  );
}

function SourceButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs ${
        active ? "border-ring bg-accent text-foreground" : "border-border text-ink-3 hover:bg-accent"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
