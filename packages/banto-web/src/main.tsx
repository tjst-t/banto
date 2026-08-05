import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";
// キャンバスGUIの意匠は別ファイル。**後に読む**——共通の語彙（.cv-*）が
// 画面側の古い規則より優先されるようにする
import "./views/views.css";

const root = document.getElementById("root");
// I2: マウント先が無いなら黙って何もしないのではなく落とす
if (!root) throw new Error("#root not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
