---
id: inc-0067
type: incident
kind: incident
origin: agent
class: bug
status: open
resolution:
refs: [inc-0018, inc-0019, task-0057, packages/banto-worker-pool/src/resume.ts]
---

## 内容

2026-08-14 06:31、工房（`banto-worker-pool`）の再起動時に、**落ちる前に生きていた職人が1件あったのに1件も復帰しなかった**。起動ログの原文：

```
[worker-pool] 落ちる前に生きていた職人: 1 件
[worker-pool] 見送り: 検証用ワークツリー（task: kobo-realign-2-merge, session: cde7ad50-...）
[worker-pool] 職人の復帰: 0 件（対象 1 件）
```

realign 第2便の統合作業が13分ぶん中断された。番頭が気づいて手で `worker.wake` して復旧した。

## 原因

`packages/banto-worker-pool/src/resume.ts` の見送り条件のうち、`isWorktreeSafe()`:

```ts
/** 検証用ワークツリーでの実行は、ホストの資産を書き換えうるので復帰させない。 */
function isWorktreeSafe(worktree: string): boolean {
  return !worktree.includes("/worktrees/") && !worktree.includes(".worktrees/");
}
```

**この条件が、いまの banto では実質「全職人を除外する」条件になっている。** banto の作業ツリーは例外なく `/home/ubuntu/worktrees/github.com/tjst-t/banto/<枝名>` 配下にあり、Kobo が起こす職人も番頭が worktree で起こす職人も、ひとつ残らずこのパターンに一致する。復帰するのは本体ツリー（`/home/ubuntu/ghq/github.com/tjst-t/banto`）で走らせた職人だけ——つまり、**復帰させたい相手をちょうど反対に選んでいる**。

「配線はあるのに動いていない」の一種で、機能そのものが実質死んでいた。

## 条件4に事故の裏付けが無いこと

記録を当たった（職人 `resume-worktree-guard-study`）。`isWorktreeSafe` は task-0057 で `isTaskSafe` と同時に足されたもので、**根拠として挙がっているのは本文の「検証用 branch での実行は安全でない」という一文だけ**。これに対応する実際の事故記録は無い。

実測事故（inc-0018＝380回超の再起動ループ）に基づいているのは、

- 条件1: 前回の起動から60秒以内なら復帰を丸ごと見送る
- 条件3: `isTaskSafe()`（taskId が `-restart$` / `reboot$` / `systemctl`）

の2つであり、条件4ではない。守りはこの2つが引き続き担う。

## 対応（方針）

条件4を撤去し、`fs.existsSync(worktree)` の実在チェックだけに置き換える。理由書きも「検証用ワークツリーだから危険」から「実在しないなら `wake` が失敗するだけなので事前に弾く」へ書き換える。

検討して**採らなかった**案：

- **案A'**（Kobo の帳簿を見て在庫にあるか判定する）— `banto-worker-pool → banto-daemon` の逆依存になる。決定23・27c「Worker Pool は Kobo から独立。番頭は Kobo 無しでも職人に委譲できる」に正面から反する
- **案B'**（環境プールの使い捨てディレクトリだけ除外する）— 前提となる「環境プールが職人用に別ディレクトリを作る」実装が存在しない。ゲート検証は職人の worktree で回している

残る筋（別件として検討）：

- **案C'** — `worker.delegate` の時点で復帰可否を宣言させ、台帳に載せる（`resumeSafe?: boolean`、既定 true）。パスから意図を推測するのをやめ、起こした側の意図を直接記録する形。筋は最も良いが `DelegateInput` とスキーマの変更を伴うので、今回の修正とは分ける

## 影響

- 工房を再起動するたび、稼働中の職人が黙って落ちたままになる（ログには「見送り」と出るので黙ってはいないが、復帰はしない）
- 今回の実測損失は13分。番頭が気づかなければ、職人は畳まれもせず放置される

## 教訓

**「安全のため」で足した条件が、環境の変化で「全部を弾く条件」に育つ。** 足した時点では検証用ワークツリーが例外的な場所だったが、いまは worktree で作業するのが常態になった。事故の裏付けが無い予防的な条件は、前提が変わったときに誰も見直さない。
