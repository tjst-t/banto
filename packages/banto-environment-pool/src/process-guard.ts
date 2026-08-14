/**
 * `driver: process` の危うさに対する見張り（2026-08-13 の事故の再発防止・A と B）。
 *
 * ## 何が危ういか
 *
 * `driver: process` は**器を作らない**。渡された場所でそのままコマンドを打つので、
 * その場所が稼働中の作業ツリーなら、`setup` はそこを直に書き換える。実際に起きた:
 * `test-docker` プロファイル（`driver: process` ＋ `setup: npm ci`）を打ったところ、
 * 稼働中の banto 本体ツリーから node_modules が入れ直され、**tsx / typescript が消えた**。
 * 同時に3つ壊れた——①検証が回らない ②新しい職人が起こせない（claude-agent ドライバが
 * `tsx/dist/loader.mjs` を解決できない）③サービスを再起動すると `node --import tsx` で起動不能。
 *
 * NODE_ENV の持ち込み（`driverSpawnEnv` で塞いだ）は引き金の一つに過ぎない。
 * `npm ci` は `--include=dev` を付けても **node_modules を消してから入れ直す**ので、
 * 入れ直している最中は tsx が無い窓が必ず開く。塞ぐべきは「稼働中のツリーで破壊的な
 * コマンドを打てること」そのものである。
 *
 * ## 2つの signal の**積**でだけ弾く
 *
 * 「守られた場所」だけで弾くと、その場所で走る**無害な** setup まで止まる——
 * 判定を取り違えて健全な検証を止めるのが一番まずい。だから
 * **守られた場所 ∧ 破壊的なコマンド**のときだけ refuse する（A）。
 * 破壊的なコマンドは、弾かなかったときも記録だけは残す（B）——逃げ道を使って通した回こそ、
 * 後から「誰が打ったのか」が要る。
 *
 * D5: ここに判断は無い。当たったか当たらないかを返すだけで、どうするかは呼び出し側。
 * D6: node 標準（path/fs）のみ。
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** 守る場所を指定する環境変数（`:` 区切り）。**空にすれば守らない＝明示の逃げ道**。 */
export const PROTECTED_PATHS_ENV = "BANTO_PROTECTED_PATHS";

/**
 * 破壊的と見なす setup。
 *
 * **狭く採る。** ここに当たると provision を弾く（A）ので、広く採ると健全な検証まで
 * 止まる。`npm ci` の変化形（`npm --prefix x ci` 等）は拾わない——拾えなかったものは
 * 弾かれないだけで、事故の形（素の `npm ci`）は確実に捕まえる。
 */
export const DESTRUCTIVE_SETUP_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  // node_modules を**消してから**入れ直す。入れ直しの最中は道具が無い窓が開く
  { name: "npm ci", pattern: /\bnpm\s+ci\b/u },
  // `-r` を伴う rm。稼働中のツリーで打てば何が消えるか分からない
  { name: "rm -r", pattern: /\brm\s+(?:-\S+\s+)*-\S*r/iu },
  // 追跡していないファイル（node_modules・ビルド成果・.env）を消す
  { name: "git clean", pattern: /\bgit\s+clean\b/u },
];

/** その setup は破壊的か。当たった名前を返す（当たらなければ `undefined`）。 */
export function destructiveSetupName(setup: string | undefined): string | undefined {
  if (typeof setup !== "string" || setup.trim().length === 0) return undefined;
  return DESTRUCTIVE_SETUP_PATTERNS.find((p) => p.pattern.test(setup))?.name;
}

/**
 * 守る場所を決める。
 *
 * - 環境変数があればそれが全て（空文字＝**守らない**。明示の逃げ道）
 * - 無ければ既定は**このドライバの cwd**。ドライバは常駐サービスの子として起こされるので、
 *   継いだ cwd がそのまま `WorkingDirectory`＝稼働中のツリーになる。systemd に問い合わせず
 *   済み、設定の書き忘れでも守りが消えない
 * - ただし `/` は既定に採らない。**全部を守る＝全部を止める**になり、
 *   「確信が持てないときは弾かない」に反する
 */
export function protectedRoots(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string
): string[] {
  const raw = env[PROTECTED_PATHS_ENV];
  if (raw !== undefined) {
    return raw
      .split(":")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => realOf(path.resolve(entry)));
  }
  const here = realOf(path.resolve(cwd));
  if (here === path.parse(here).root) return [];
  return [here];
}

/** その場所は守られているか。当たった root を返す（当たらなければ `undefined`）。 */
export function protectedRootFor(target: string, roots: readonly string[]): string | undefined {
  const resolved = realOf(path.resolve(target));
  return roots.find((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

/**
 * 実体のパスに寄せる（symlink 越しに同じ場所を指されて素通りしないため）。
 *
 * 存在しない場所は解決できないので、そのときは字面のまま——**守りを緩める側**に倒す
 * （まだ無い場所に破壊的なコマンドを打っても、壊れる稼働中の資産が無い）。
 */
function realOf(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

export interface ProtectedRefusal {
  /** 打とうとした場所。 */
  target: string;
  /** 当たった守り。 */
  root: string;
  /** 引っかかった語（`npm ci` 等）。 */
  destructive: string;
}

/**
 * 弾くかどうかを決める（純関数）。**積のときだけ**弾く。
 */
export function refuseDestructiveSetup(params: {
  target: string;
  setup: string | undefined;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
}): ProtectedRefusal | undefined {
  const destructive = destructiveSetupName(params.setup);
  if (!destructive) return undefined;
  const root = protectedRootFor(params.target, protectedRoots(params.env, params.cwd));
  if (!root) return undefined;
  return { target: realOf(path.resolve(params.target)), root, destructive };
}

/**
 * 断りの文面。
 *
 * **事情を知らない人が、これだけ読んで次の一手を打てること**（I2）。
 * 何が危ないのか・なぜ弾いたのか・どうすれば通せるのかを、この順で書く。
 */
export function renderProtectedRefusal(refusal: ProtectedRefusal): string {
  return [
    "process-driver provision: 稼働中の作業ツリーに破壊的な setup を打とうとしたので弾きました。",
    "",
    `  打とうとした場所: ${refusal.target}`,
    `  守っている場所  : ${refusal.root}`,
    `  引っかかった語  : ${refusal.destructive}`,
    "",
    "**なぜ弾いたか**",
    "このドライバ（driver: process）は器を作らず、その場所でそのままコマンドを打ちます。",
    "`npm ci` は node_modules を消してから入れ直すので（`--include=dev` を付けても同じ）、",
    "そこが稼働中の banto なら、入れ直している最中は道具が消えます。2026-08-13 に実際に起き、",
    "検証が回らない・新しい職人が起こせない・再起動すると起動不能、が同時に起きました。",
    "",
    "**通すには**（どれか1つ）",
    "  1. 別の場所で回す: workdir に使い捨ての worktree を渡す（本番の資産に触らない・推奨）",
    "  2. 破壊的でない setup にする: 例 `npm install --include=dev`（消してから入れ直さない）",
    `  3. 承知のうえで通す: ${PROTECTED_PATHS_ENV} を空にする（守らない）か、守る場所を別に指定する。`,
    "     **稼働中の banto が壊れうることを承知した場合だけ**にしてください。",
  ].join("\n");
}
