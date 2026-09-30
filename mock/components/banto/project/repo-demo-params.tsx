"use client";

// **モックの見せ方のためだけ**の URL（2026-09-29）——状態ごとに開ける場所を作る。
// 本物の入口はサイドバーの「＋」のまま（あちらはこの URL を使わない）。
//
// - `?new-project=folder|clone|create` —— 新しい Project をその始め方で開く
// - `&repo=<owner>/<repo>` —— clone なら選んだ状態、新しいリポジトリなら名前に入る
// - `&folder=<path>` —— 手元のフォルダの Root パス（一覧の「Project を始める」と同じ状態）
// - `?accounts=0|1|2` —— 登録済みの GitHub アカウントの数（どの画面でも効く）
import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { setGithubAccountCountForDemo } from "@/lib/mock/github";
import { NewProjectDialog, type StartMethod } from "./new-project-dialog";

const METHODS: readonly StartMethod[] = ["folder", "clone", "create"];

export function RepoDemoParams() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const methodParam = searchParams.get("new-project");
  const method = METHODS.find((m) => m === methodParam);
  const repo = searchParams.get("repo") ?? undefined;
  const folder = searchParams.get("folder") ?? undefined;
  const accountsParam = searchParams.get("accounts");

  useEffect(() => {
    if (accountsParam !== null) setGithubAccountCountForDemo(Number(accountsParam));
  }, [accountsParam]);

  if (!method) return null;
  return (
    <NewProjectDialog
      // 別の状態の URL へ移ったら、初めから開き直す
      key={`${method}:${repo ?? ""}:${folder ?? ""}`}
      open
      preset={{ method, repo, folder, name: folder?.split("/").pop() }}
      onOpenChange={(open) => {
        if (open) return;
        const params = new URLSearchParams(searchParams.toString());
        params.delete("new-project");
        params.delete("repo");
        params.delete("folder");
        const qs = params.toString();
        router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
      }}
    />
  );
}
