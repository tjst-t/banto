"use client";

// **モックの見せ方のためだけ**の URL（2026-09-29）——状態ごとに開ける場所を作る。
// 本物の入口はサイドバーの「＋」のまま（あちらはこの URL を使わない）。
//
// - `?new-project=folder|<implementationId>:<providerId>` —— 新しい Project をその始め方で開く。
//   `clone`・`create` は前からの URL のための読み替え（`banto.repositories:clone`・`banto.repositories:create`）——**この読み替えは
//   モックの見せ方の層にだけ置く**。core の新しい Project の画面は Module の名前を知らない
// - `&repo=<owner>/<repo>` —— Module の画面に最初に入れておく値（clone なら選んだ状態、新しいリポジトリなら名前）
// - `?modules=none` —— フォルダを用意できる Module（いまは Repositories だけ）を無効にした banto（組み込みなので消せないが、無効にはできる）。新しい Project の画面は
//   「手元のフォルダ」だけになる
// - `&folder=<path>` —— 手元のフォルダの Root パス（一覧の「Project を始める」と同じ状態）
// - `&runtime=<名前>` —— 実行場所をその別のサーバにした状態で開く（設定の「実行場所」の名前。2026-10-10）
// - `?accounts=0|1|2` —— 登録済みの GitHub アカウントの数（どの画面でも効く）
// - `?repos=0` —— Repositories の台帳を空にする（リポジトリの一覧の空の状態）
// - `?import=<path>` —— リポジトリの一覧で、Import をそのフォルダから開く（一覧の側が読む）
import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { setGithubAccountCountForDemo, setLedgerEmptyForDemo } from "@/lib/mock/github";
import { disableFolderProvidersForDemo } from "@/lib/mock/settings";
import { getRuntimes } from "@/lib/mock/runtimes";
import { NewProjectDialog, type StartMethod } from "./new-project-dialog";

/** 前からの URL（`clone`・`create`）の読み替え——モックの見せ方のためだけ */
const LEGACY_METHODS: Record<string, StartMethod> = { clone: "banto.repositories:clone", create: "banto.repositories:create" };

export function RepoDemoParams() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const methodParam = searchParams.get("new-project");
  const method = methodParam ? (LEGACY_METHODS[methodParam] ?? methodParam) : undefined;
  const repo = searchParams.get("repo") ?? undefined;
  const folder = searchParams.get("folder") ?? undefined;
  const accountsParam = searchParams.get("accounts");
  const reposParam = searchParams.get("repos");
  const modulesParam = searchParams.get("modules");
  const runtimeName = searchParams.get("runtime");
  const runtimeId = runtimeName ? getRuntimes().find((r) => r.name === runtimeName)?.id : undefined;

  useEffect(() => {
    if (accountsParam !== null) setGithubAccountCountForDemo(Number(accountsParam));
  }, [accountsParam]);

  useEffect(() => {
    if (reposParam === "0") setLedgerEmptyForDemo();
  }, [reposParam]);

  useEffect(() => {
    if (modulesParam === "none") disableFolderProvidersForDemo();
  }, [modulesParam]);

  if (!method) return null;
  return (
    <NewProjectDialog
      // 別の状態の URL へ移ったら、初めから開き直す
      key={`${method}:${repo ?? ""}:${folder ?? ""}:${runtimeId ?? ""}`}
      open
      preset={{ method, input: repo, folder, name: folder?.split("/").pop(), runtimeId }}
      onOpenChange={(open) => {
        if (open) return;
        const params = new URLSearchParams(searchParams.toString());
        params.delete("new-project");
        params.delete("repo");
        params.delete("folder");
        params.delete("runtime");
        const qs = params.toString();
        router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
      }}
    />
  );
}
