"use client";

// Module が名乗ったアイコンを描く（2026-10-01）。本物は MCP の `icons`（画像の src）で、core はそれを
// そのまま描くだけ。モックは lucide の名前を、この小さな表で引く——**どの Module のものかでは分岐しない**
// （名前が無い・表に無いものは、汎用の箱）。
import { Box, CloudDownload, FolderGit2, FolderPlus, type LucideIcon } from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  "cloud-download": CloudDownload,
  "folder-plus": FolderPlus,
  "folder-git": FolderGit2,
};

export function ModuleIcon({ name, className }: { name: string; className?: string }) {
  const Icon = ICONS[name] ?? Box;
  return <Icon className={className} aria-hidden />;
}
