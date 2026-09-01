"use client";

// item14「instance が新しい実装を知る」——§5.1「Module の発見元は4つ」の
// モック実装。一度選んだら取り込んで閉じる one-shot 操作なので Dialog
// （§6.6の基準どおり、Sheetではない）。banto 自身は検索・カタログ・レビューを
// 持つ「ストア」ではない——4つの発見元それぞれへの薄い入口を切り替えるだけ。
import { useState } from "react";
import { FolderGit2, FolderOpen, Globe, Search } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createImplementation, getRoles } from "@/lib/mock/settings";

// 公式 MCP レジストリの検索結果（モック——実際には registry.modelcontextprotocol.io
// への REST 呼び出しになる、§5.1）。role は登録メタデータから分かる前提
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
  const [source, setSource] = useState<"registry" | "endpoint" | "git" | "local">("registry");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Module を追加</DialogTitle>
          <DialogDescription>
            banto 自身はストア（検索・カタログ・レビュー）を持たない——4つの発見元
            それぞれへの入口を切り替えるだけ。
          </DialogDescription>
        </DialogHeader>

        <Tabs value={source} onValueChange={(v) => setSource(v as typeof source)}>
          <TabsList className="w-full">
            <TabsTrigger value="registry">
              <Search className="size-3.5" /> レジストリ
            </TabsTrigger>
            <TabsTrigger value="endpoint">
              <Globe className="size-3.5" /> 接続情報
            </TabsTrigger>
            <TabsTrigger value="git">
              <FolderGit2 className="size-3.5" /> Git
            </TabsTrigger>
            <TabsTrigger value="local">
              <FolderOpen className="size-3.5" /> ローカル
            </TabsTrigger>
          </TabsList>

          <TabsContent value="registry" className="pt-2">
            <RegistryTab onDone={() => onOpenChange(false)} />
          </TabsContent>
          <TabsContent value="endpoint" className="pt-2">
            <ManualTab
              key="endpoint"
              placeholder="https://example.com/mcp、または起動コマンド"
              helpText="動いているエンドポイント（URL）か、ローカルで立てる stdio サーバーの起動コマンドを直接指定する。"
              onDone={() => onOpenChange(false)}
            />
          </TabsContent>
          <TabsContent value="git" className="pt-2">
            <ManualTab
              key="git"
              placeholder="owner/repo"
              helpText="公式レジストリに登録されていない、banto 用に作られたモジュール向け。Claude Code の `/plugin marketplace add owner/repo` と同じ形。"
              onDone={() => onOpenChange(false)}
            />
          </TabsContent>
          <TabsContent value="local" className="pt-2">
            <ManualTab
              key="local"
              placeholder="~/dev/my-banto-module"
              helpText="自分で書いている Module を、公開する前にそのまま試す（npm link 相当）。クローンもレジストリ登録もしない。"
              onDone={() => onOpenChange(false)}
            />
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
      <p className="text-xs text-ink-3">registry.modelcontextprotocol.io を検索する</p>
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

function ManualTab({
  placeholder,
  helpText,
  onDone,
}: {
  placeholder: string;
  helpText: string;
  onDone: () => void;
}) {
  const [value, setValue] = useState("");
  const [name, setName] = useState("");
  const [roleId, setRoleId] = useState<string | undefined>(undefined);
  const roles = getRoles();

  function handleImport() {
    if (!value.trim() || !name.trim() || !roleId) return;
    createImplementation({
      id: `local:${value.trim()}:${Date.now()}`,
      roleId,
      name: name.trim(),
      isolation: "subprocess",
    });
    onDone();
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-ink-3">{helpText}</p>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="add-module-value" className="text-xs">
          場所
        </Label>
        <Input
          id="add-module-value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          className="h-8 font-mono text-xs"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="add-module-name" className="text-xs">
          表示名
        </Label>
        <Input
          id="add-module-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="この Module の名前"
          className="h-8"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="add-module-role" className="text-xs">
          この Module が名乗る role
        </Label>
        <Select value={roleId} onValueChange={setRoleId}>
          <SelectTrigger id="add-module-role" className="h-8 w-full">
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
        disabled={!value.trim() || !name.trim() || !roleId}
        onClick={handleImport}
        className="self-end"
      >
        取り込む
      </Button>
    </div>
  );
}
