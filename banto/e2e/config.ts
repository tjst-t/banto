// E2E専用のポート・パス定数。テストとglobal-setupの両方から参照する
// ——真実は一箇所（規則3）、同じ値をあちこちに書き写さない。
import { join } from "node:path";

export const CORE_PORT = 4738;
// Next 16はディレクトリごとに1つしかdevサーバを許さない（別portでも二重起動を
// 拒否する）——なので専用portを別に起こすのではなく、既存の開発用devサーバ
// （4175、常時起動している前提）をそのまま使う。frontend自体はブラウザの
// localStorageに保存したhost/tokenで接続先を切り替えるだけなので、
// テストの隔離はcore側（port・dataDir）だけで足りる
export const FRONTEND_PORT = 4175;
// dataDirとconfig.jsonの置き場は重なってはいけない（bootstrap.tsのassertNoOverlap、
// §9の事故対策）——なので兄弟ディレクトリに分ける
export const DATA_DIR = join(import.meta.dirname, ".tmp-data");
export const CONFIG_PATH = join(import.meta.dirname, ".tmp-config", "config.json");
export const AUTH_TOKEN = "e2e-fixed-token";
export const PORT = CORE_PORT;

export const CORE_BASE_URL = `http://127.0.0.1:${CORE_PORT}`;
export const FRONTEND_BASE_URL = `http://127.0.0.1:${FRONTEND_PORT}`;
