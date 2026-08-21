/**
 * Factory の段と、**次にどの段をやるかの判定**（要件 B2・B5、仕様 §5.2〜5.3）。
 *
 * ここが耐久ワークフロー（durable execution）の核である。名前のついた問題なので、
 * 機構そのものは既知の答えに乗る（規則12）。banto に固有なのは**判定のしかた**だけ：
 *
 * > **「その段は済んだ」というフラグを保存しない。世界を見て判定する**（規則3）。
 *
 * git を使う段はほぼ全部が観測可能なので、フラグを持つ必要が無い。
 * **フラグを持たないので、フラグと現実がずれない。**
 */

/** 段。**順序そのものが仕様**なので、配列で持って1箇所に置く。 */
export const STAGES = [
  'worktree',
  'environment',
  'implement',
  'test',
  'review',
  'merge',
  'teardown',
] as const;

export type Stage = (typeof STAGES)[number];

/**
 * 段の並びの外にある3つ。もう進めない／もう進む必要がない／人が入れないと決めた。
 *
 * **却下は失敗ではない。** 機構は正しく動いて、答えが「入れない」だっただけである。
 * 同じ語にすると、直せば通るもの（failed）と、直しても通らないもの（rejected）が混ざる。
 */
export type Outcome = 'done' | 'failed' | 'rejected';

/**
 * 人の確認がどこまで進んだか（要件 B4）。
 *
 * **boolean 2つ（needsReview / reviewApproved）を1つの語に寄せた**（決定7）。
 * 2つに分けると「確認不要かつ未承認」という、意味の無い組み合わせが表せてしまう。
 *
 * `waiting` は「まだ聞いていない」と「聞いて、返事が選択でなかった」の両方を指す。
 * **どちらも、まだ答えが出ていない**——区別しても次にやることは変わらない。
 */
export type Review = 'not-required' | 'waiting' | 'approved' | 'rejected';

export type Next = Stage | Outcome;

/**
 * いま世界がどうなっているか。**全部が観測値**で、1つを除いて導出できる。
 *
 * 唯一の例外が `testedHead`——テストは再実行しないと分からないので記録するが、
 * **commit の sha で鍵をつける**ので、sha が変われば自動的に無効になる。
 */
export interface Observation {
  /** `run.failed` が記録されている。**これも導出できない**（止まっているのか、まだ着いていないのか）。 */
  readonly failed: boolean;
  readonly hasWorktree: boolean;
  readonly environment: 'ready' | 'gone';
  /** ブランチが取り込み先より先に進んでいる。＝実装が済んでいる。 */
  readonly hasCommits: boolean;
  /** いまのブランチの先端。まだ無ければ null。 */
  readonly head: string | null;
  /** **いまの先端に対する**テスト結果。古い sha の結果はここに現れない。 */
  readonly testedHead: { readonly passed: boolean } | null;
  /** 人の確認（要件 B4）。既定は待たないので `not-required`。 */
  readonly review: Review;
  readonly merged: boolean;
}

/**
 * 次にやる段を決める。**純粋関数**——ここで世界に触れない。
 *
 * 触れないので、判定だけを試験で網羅できる。実際に触るのは engine のほうで、
 * そこは「観測する」と「1段だけ進める」に分かれている。
 */
export function nextStage(o: Observation): Next {
  // 記録された失敗が最優先。記録しないと、機構は永久に同じ段を試み続ける。
  if (o.failed) return 'failed';

  // **取り込み済みなら、残っているのは後片付けだけ。**
  // これを先に見ないと、畳んだあとに「環境が無い」と言って作り直しに戻る。
  if (o.merged) return o.environment === 'ready' ? 'teardown' : 'done';

  // **却下も同じ場所で見る。** 取り込まずに畳んで終わる（枝は残るので、拾い直せる）。
  // 下の並びに置くと、畳んだあとに「作業ツリーが無い」と言って作り直しに戻る。
  if (o.review === 'rejected') return o.environment === 'ready' ? 'teardown' : 'rejected';

  if (!o.hasWorktree) return 'worktree';
  if (o.environment !== 'ready') return 'environment';
  if (!o.hasCommits) return 'implement';

  // 先端に対する結果が無い＝まだ測っていない。**古い sha の結果はここに来ない。**
  if (o.testedHead === null) return 'test';
  // 落ちたテストを黙って通さない。直すのは人か、次の依頼（規則2）。
  if (!o.testedHead.passed) return 'failed';

  if (o.review === 'waiting') return 'review';
  return 'merge';
}

/** 終端か。engine はこれで「もう触らない Run」を外す。 */
export function isSettled(next: Next): next is Outcome {
  return next === 'done' || next === 'failed' || next === 'rejected';
}
