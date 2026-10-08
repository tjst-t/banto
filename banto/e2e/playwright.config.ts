import { defineConfig } from "@playwright/test";
import { ensureIncusAccess } from "./incus-access.ts";
import { acquireMachineLock } from "./run-lock.ts";

// **流し方**（2026-10-08）：`cd banto/e2e && npx playwright test [spec...]`。
//   - **並列の数は `BANTO_E2E_WORKERS`**（既定は `config.ts` の DEFAULT_WORKERS。1〜6）。worker ごとに core を1本起こす
//     （下の webServer）——`--workers`／`-j` は使わない（core の無い worker ができ、`config.ts` が止める）
//   - **切り分けは `BANTO_E2E_WORKERS=1`**——core 1本・worker 1つで、並列にする前と同じ形に走る
//   - 経緯と測った数字は `docs/notes/2026-10-08-e2e-parallel.md`

// **Incus に繋がる形で走る**（`incus-access.ts`）。incus グループの付いていないプロセスから流されたら、ここで自分を
// 起こし直す。**`config.ts` を読む前に**——config は読んだプロセスの pid を回の印にし、TMPDIR を書き換える
// （起こし直す親の値が子に渡ってはいけない）ので、静的な import にしない
await ensureIncusAccess();
const {
  CORE_COUNT,
  coreBaseUrl,
  FRONTEND_BASE_URL,
  FRONTEND_LISTEN_URL,
  FRONTEND_PORT,
  FRONTEND_DIST_DIR,
} = await import("./config.js");

// **同じ機械の E2E は一度に1回**（`run-lock.ts`）。webServer を起こす前に取る——config はここで読まれ終わってから
// webServer が起きる。worker・webServer の子は env の印を見て何もしない
acquireMachineLock(new URL("..", import.meta.url).pathname);

// **土台イメージは core を起こす前に用意する**（追加・2026-10-08）。無ければ core は最初の Project のコンテナで作るが、
// core が何本もあると同時に作り始め、後から publish したほうが「alias がもうある」で落ちる（`@banto/container` の
// ensureBaseImage が1回にまとめるのはプロセスの中だけ）。あれば1回の問い合わせで終わる。主プロセスでだけ
if (process.env.TEST_PARALLEL_INDEX === undefined && CORE_COUNT > 1) {
  const { ensureBaseImage, runIncus } = await import("@banto/container");
  await ensureBaseImage(runIncus);
}

export default defineConfig({
  testDir: "./specs",
  timeout: 60_000,
  // ファイル**内**の順序は固定する（spec の中のテストは同じ worker で順に走る）。ファイル単位で worker に配る
  fullyParallel: false,
  // **worker ごとに自分の core を持たせて並べる**（改訂・2026-10-08、`config.ts` の CORE_COUNT）。
  // 以前（決定・2026-09-10、`e2e-run-isolation`）は1本ずつだった——全 spec が同じ core・同じ**受信箱**を共有して
  // いたので、判断待ちを起こす spec 同士が互いの1件を掴んだり、件数の検査が間欠で落ちたりした。いまは worker と
  // core が1対1なので、受信箱・Project・banto 全体の Module は worker の間で混ざらない。共有するのは画面（next）と
  // Incus・CPU・メモリ——並列の数はそこで決まる（測った数字は docs/notes/2026-10-08-e2e-parallel.md）
  workers: CORE_COUNT,
  // この回が作ったコンテナを消す（`global-teardown.ts`）
  globalTeardown: "./global-teardown.ts",
  retries: 0,
  // **spec ごとの所要時間を残す**（追加・2026-10-08）。list は流れを見るため、json は回のあとで調べるため（trace と同じ
  // test-results に置く。次の回が始まるときに消える）、spec-timing は回の終わりに遅い spec の上位と合計を出す
  reporter: [["list"], ["json", { outputFile: "test-results/report.json" }], ["./spec-timing-reporter.ts"]],
  use: {
    baseURL: FRONTEND_BASE_URL,
    trace: "retain-on-failure",
    // **action と画面の移動に上限を付ける**（追加・2026-10-08）。無いと、押せないボタンを試験全体の上限（長い spec は
    // 300秒）まで黙って待ち、何を待っていたのかだけが残る。本当に長い action は、その場で理由を書いて個別に延ばす
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
  },
  webServer: [
    // core（banto host）を **worker の数だけ**（追加・2026-10-08、`config.ts` の CORE_COUNT）。worker は自分の番号
    // （TEST_PARALLEL_INDEX）の core だけを相手にする。寿命は worker ではなく回に結びつく——webServer は主プロセスが
    // 回の始めに起こし、回の終わりに止める。worker が落ちて作り直されても、同じ番号の core をそのまま使う
    ...Array.from({ length: CORE_COUNT }, (_, index) => ({
      // 実データ・本番トークンとは別のdataDir・port。start-core.tsが起動直前に確実に
      // config.jsonを書く——globalSetupとwebServer起動の順序に依存しない
      command: `node ${new URL("./start-core.ts", import.meta.url).pathname}`,
      url: `${coreBaseUrl(index)}/healthz`,
      // 実行の印（port・置き場を決める）と core の番号を渡す——別プロセスでも同じ実行・同じ番号の値になる
      env: { BANTO_E2E_RUN_ID: process.env.BANTO_E2E_RUN_ID!, BANTO_E2E_CORE_INDEX: String(index) },
      // **既に誰かが立っていたら相乗りしない**——別の実行の core を掴むと、
      // 受信箱もデータも混ざる。Playwright はここで止まる（黙って続けない）
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe" as const,
      stderr: "pipe" as const,
    })),
    {
      // **フロントも E2E 専用に起こす**（訂正・2026-09-13、config.ts 参照）。
      // 以前は人が使っている 4175 を借りていたので、**開発中のビルドが
      // 人の画面を壊していた**。port も dist も実行ごとに分ける。
      //
      // **本番ビルドで試験する**（dev サーバではない）——4175 は 2026-09-07 から
      // `next build` + `next start`。dev で試験すると、人が見ているものと違う
      // ものを見ることになる（規則1）。
      command:
        `npm run build --workspace=@banto/frontend && ` +
        `npm exec --workspace=@banto/frontend -- next start -H 127.0.0.1 -p ${FRONTEND_PORT}`,
      cwd: new URL("..", import.meta.url).pathname,
      env: { BANTO_NEXT_DIST_DIR: FRONTEND_DIST_DIR },
      url: FRONTEND_LISTEN_URL,
      // **黙って相乗りしない**（core と同じ規律）——別の実行のフロントを
      // 掴むと、どのビルドを試験したのか分からなくなる
      reuseExistingServer: false,
      // ビルドを含むので長め
      timeout: 300_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
