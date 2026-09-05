import { AppShell } from "@/components/banto/shell/app-shell";
import { HomeContent } from "@/components/banto/project/home-content";

// デモ用の固定Project（旧"banto"）は撤去した（決定・2026-09-03）——
// 実Projectしか無い前提では、リダイレクト先を決め打ちできない。
// 実データの読み込み待ち・0件時の空状態はクライアント側（HomeContent）で扱う
export default function Home() {
  return (
    <AppShell projectId={null}>
      <HomeContent />
    </AppShell>
  );
}
