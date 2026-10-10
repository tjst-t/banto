import type { MetadataRoute } from "next";
import { PWA_COLORS } from "@/lib/pwa-colors";

/**
 * **アプリとして入れられるようにする**（追加・2026-10-10、ユーザー報告「Windows では PWA にできたが Android ではできない」。
 * `docs/specs/v4-frontend.md` §6.37）。
 *
 * それまで manifest が無かった。Windows の Chrome・Edge は manifest が無くても「アプリとしてインストール」を出すが、
 * Android の Chrome は manifest（名前・192 と 512 のアイコン・start_url・display）が無いと入れられない。
 *
 * Service Worker は置かない——Android の Chrome は 108 からメニューの「アプリをインストール」に Service Worker を
 * 求めない。置くと古い画面を抱え込み、更新したら画面も新しくする仕組み（§6.34、`/banto-build`）とぶつかる。
 * アイコンは `scripts/pwa-icons.mjs` が書き出す
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "banto",
    short_name: "banto",
    description: "仕事と会話をいくつ同時に持っても、いま何がどこまで進んでいるかを覚えておかなくて済むようにする道具",
    lang: "ja",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: PWA_COLORS.lightBackground,
    theme_color: PWA_COLORS.lightBackground,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
