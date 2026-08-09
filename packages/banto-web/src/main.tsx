import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { FilePage } from "./FilePage.js";
import { parseFilePageTarget } from "./views/filePage.js";
// 意匠トークンは**いちばん先**に読む。色・字・余白の唯一の出どころ（spec-design）
import "./theme/tokens.css";
import "./styles.css";
// キャンバスGUIの意匠は別ファイル。**後に読む**——共通の語彙（.cv-*）が
// 画面側の古い規則より優先されるようにする
import "./views/views.css";
// 家ごとの「形」の層（ADR-0012 決定51）。**面の CSS より後**に読む——上から被せるため。
// 面ごとの CSS に [data-theme] の分岐を散らさないのが狙い（D5）
import "./theme/fucho.css";
import { applyStoredTheme } from "./theme/useTheme.js";
import { ThemeProvider } from "./theme/ThemeProvider.js";

// 最初の描画より前に地を当てる。React を待つと、暗色を選んでいる人に
// **一瞬だけ明るい画面が閃く**
applyStoredTheme();

const root = document.getElementById("root");
// I2: マウント先が無いなら黙って何もしないのではなく落とす
if (!root) throw new Error("#root not found");

/**
 * 別タブで開いた1枚か、いつもの画面か（spec-file-browser §5.8.4）。
 *
 * **位置の真実は URL**（`viewLocation.ts` と同じ考え）。ここで分けるのは、別タブが
 * 会話もキャンバスもホストへの接続も要らないため——1枚のために殻ごと立ち上げると、
 * ファイルを1つ見るのに会話の状態まで復元することになる。
 */
const filePage = parseFilePageTarget(window.location.search);

createRoot(root).render(
  <StrictMode>
    {/* テーマの状態は1つ。上段の明暗ボタンと設定の一覧が同じものを見る */}
    <ThemeProvider>{filePage ? <FilePage target={filePage} /> : <App />}</ThemeProvider>
  </StrictMode>
);
