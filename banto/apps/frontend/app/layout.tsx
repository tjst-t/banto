import type { Metadata, Viewport } from "next";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RealProjectsBootstrap } from "@/components/banto/real-projects-bootstrap";
import { PWA_COLORS } from "@/lib/pwa-colors";
// **フォントは手元から**（2026-10-21、ユーザー）。以前は next/font/google で組み立てのたびに Google Fonts から取っていたが、応答の形で
// Turbopack の組み立てがたまに止まり（vercel/next.js#99114、GitHub の prebuilt で2回）、ネットの無い所では組み立てられない。
// 同じフォントを @fontsource（版は固定、どれも SIL Open Font License 1.1——ライセンスの全文はパッケージの LICENSE）から読む。
// 太さは以前と同じ。CSS は字の範囲（unicode-range）ごとに分かれていて、ブラウザは使う字の分だけ取る（日本語も以前と同じ字形）
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/noto-sans-jp/400.css";
import "@fontsource/noto-sans-jp/500.css";
import "@fontsource/noto-sans-jp/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "banto",
  description: "banto",
  // タブと iOS のアイコン（§6.37）。どれも scripts/pwa-icons.mjs が public/icons/ に書き出し、ここから指す
  icons: {
    icon: [{ url: "/icons/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/icons/apple-icon.png", sizes: "180x180", type: "image/png" }],
  },
  // ホーム画面に置いたときの名前（iOS は manifest の名前を読まないことがある、§6.37）
  appleWebApp: { capable: true, title: "banto", statusBarStyle: "default" },
};

/**
 * **キーボードが出たら、レイアウトを縮める**（決定・2026-09-07、ユーザー報告）。
 *
 * Android Chrome の既定は `interactive-widget=resizes-visual`——キーボードが出ても
 * **レイアウトの高さは変わらない**。画面いっぱいの縦並び（ヘッダ／履歴／入力欄）は
 * そのままなので、入力欄はキーボードの裏に入り、ブラウザが入力欄を見せようと
 * 画面を持ち上げる。結果、**ヘッダが上に逃げ、入力欄も隠れる**
 * （実機報告・2026-09-07）。
 *
 * `resizes-content` にすると、キーボードのぶんだけレイアウトの高さが縮む
 * ——ヘッダと入力欄は画面に残り、間の履歴だけが狭くなる（あるべき形）。
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  interactiveWidget: "resizes-content",
  // アプリとして開いたときの上の帯の色（§6.37）。画面の地の色（--banto-bg）に揃える
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: PWA_COLORS.lightBackground },
    { media: "(prefers-color-scheme: dark)", color: PWA_COLORS.darkBackground },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="ja"
      className="h-full antialiased"
      suppressHydrationWarning
    >
      <body className="h-full flex flex-col overflow-hidden">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <RealProjectsBootstrap />
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster position="bottom-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
