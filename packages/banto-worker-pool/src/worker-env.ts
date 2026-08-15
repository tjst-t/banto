// ── 職人へ持ち込まない環境変数 ────────────────────────────────────────────────
//
// 環境プール側の `env-driver-runner.ts`（`ENV_NOT_INHERITED_BY_DRIVER` /
// `driverSpawnEnv`）と同じ形。**同じ穴が、工房→職人の経路にも開いていた**（imp-0043）。

/**
 * **常駐サービス自身の deploy 姿勢**。職人の子プロセスへは持ち込まない。
 *
 * ## 何が起きたか（2026-08-15・実機 dentaku）
 *
 * `banto-worker-pool.service` は `Environment=NODE_ENV=production` で動く。職人は
 * 子プロセスなのでそれを継ぐ。すると職人の手元で:
 *
 *   $ npm install
 *   up to date, audited 1 package
 *   $ ls node_modules  → 無い
 *
 * npm は production では devDependencies を入れない。dentaku の依存は**全部
 * devDependencies**（typescript / vite / vitest）なので、入るものが1つも無い。
 * 「1 package」は根のパッケージだけを数えた数で、**別の package.json を読んで
 * いるわけではない**（`npm prefix` も `npm root` も正しかった。実測済み）。
 *
 * 職人はこれに詰まり、凌ぎとして作業ツリーの `node_modules` を本体チェックアウトへ
 * symlink した。その symlink が検証環境（docker）のボリュームの載り先をずらし、
 * マージ前ゲートが3タスク連続で落ちた（task-0020・0021・0023）——**根はここ**。
 * ずれる仕組みそのものは `docker-driver.ts` の
 * `assertVolumeTargetsAreNotSymlinks` に書いた。
 *
 * ## なぜ「消す」で、「development を渡す」ではないか
 *
 * 職人が回すプロジェクトがどのモードであるべきかを決めるのは**そのプロジェクトの側**で
 * あって、工房の deploy 事情ではない。工房に言えるのは「**うちの姿勢を持ち込まない**」
 * だけで、そこから先に口を出す筋合いは無い（D5）。
 *
 * **キーごと消す**のが要点。空文字にすると npm からは「空という値が設定されている」に
 * 見え、未設定とは別の意味になりうる。
 *
 * ユニットファイルからは外さない。あれは工房自身の実行環境の話で、外すと工房の挙動まで
 * 変わる。落とすのは**渡すときのここ一箇所**だけ。
 */
export const ENV_NOT_INHERITED_BY_WORKER: readonly string[] = ["NODE_ENV"];

/**
 * 職人の子プロセスへ渡す環境を組み立てる（純関数）。
 *
 * 継ぐもの・落とすもの・上書きするものを1箇所で決める。**ここが唯一の合流点**——
 * ドライバごとに書くと、書き忘れた経路だけが同じ穴に落ちる。
 */
export function workerSpawnEnv(
  base: NodeJS.ProcessEnv,
  extraEnv?: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (ENV_NOT_INHERITED_BY_WORKER.includes(key)) continue;
    out[key] = value;
  }
  // 明示は継承より強い。落とした変数もここで名指しすれば戻せる
  for (const [key, value] of Object.entries(extraEnv ?? {})) out[key] = value;
  return out;
}
