import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// D6: vite — React のビルド／開発サーバに標準的な選択肢。決定12（React直接import）の帰結。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 4200,
  },
});
