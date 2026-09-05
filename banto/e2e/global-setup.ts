// core（packages/core）をE2E専用のdataDir・portで起動するための下ごしらえ。
// 実データ・本番トークンと完全に分離する（メモリ「実機検証は別データディレクトリの
// ホストで」と同じ原則、BANTO_CONFIG_PATHはbootstrap.tsの上書き機構）。
// 毎回まっさらな状態から始める——前回の実行が残っているとテストが
// 「たまたま前回のデータが残っていたから通った」になりかねない。
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CONFIG_PATH, DATA_DIR, PORT, AUTH_TOKEN } from "./config.ts";

export default function globalSetup(): void {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(dirname(CONFIG_PATH), { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({ dataDir: DATA_DIR, port: PORT, authToken: AUTH_TOKEN }, null, 2),
  );
}
