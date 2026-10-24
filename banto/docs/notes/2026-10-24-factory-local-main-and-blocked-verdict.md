# メタ Project(#532〜#539)が origin に無かった件——原因と直した点(2026-10-24)

## 分かった事実

- Project root の `.worktrees/localmain`(ブランチ `main`)は、2026-10-15 10:12 UTC 時点のコミット(`ef16bea81`)で
  origin/main から分岐したまま、以後470件以上のコミットが積まれ続けていた。2026-10-24 時点でローカル `main` は
  origin/main に無い独自コミットを182個、逆に origin/main はローカル `main` に無いコミットを421個持ち、
  ほぼ丸2週間分、完全に分岐した2本の歴史になっていた。
- Backlog #526(メタ Project)の子 #532〜#539 はすべて `done`、resolution は Factory の既定文言
  「Factory が取り込みました(factory/xxx)」のままだった。実装コミット(`dea2926ca` 等)は実在したが、
  **ローカルの `main` ブランチにだけ**存在し、origin(GitHub)の main にも release にもどのブランチにも
  含まれていなかった。

## ローカル main への直接コミットは「事故」ではなく、Factory の設計どおりの挙動

`packages/modules/factory/src/engine.ts` の `fastForward()` を読むと、Factory の「main へ取り込み」は
**ローカルの `refs/heads/<targetBranch>`(ふつう `main`)を worktree の HEAD まで fast-forward するだけ**で、
`git push` は一切行わない。これは Memory #58971 にも「Factory の土台はローカルの main の branch に入れる」と
明記されている、**既知の仕様**である。origin へ反映するのは別工程(誰かが worktree を作って origin/main の上に
載せ直し、push する)で、これは実際、確認した範囲のほとんどの Backlog 項目(#294・#411・#477/#478・#527 等)で
ちゃんと行われていた(resolution にコミットハッシュが上書きされている)。

問題は「ローカル main が育ち続けること」自体ではなく、**#539 で、この後始末の工程が一度も行われなかった**こと。

## 本当の原因:レビューの判定に「ブロック」が無かった

`#539` の最後の2コミット(`7166fc07b`・`b8f2d62bd`)を読むと、当時の実装役・レビュー役は状況を正しく把握していた:

> レビュー(2回)の指摘どおり、完了条件の後半「release に反映されている」は満たしていない。#539 は完了ではなく、
> 次の2つが揃うまでブロックとして人に上げる…Backlog の状態を変える tool はこの作業者に無いので、ここに書き、
> 報告で上げた。

つまり「まだ決まっていない設計判断(番頭との3点の重複)」と「release への push 権限」という、**コードの直しでは
解決できない2つの外部要因**で止まっていることを、レビュー役は正確に文章(docs/notes)に書き残していた。

しかし `packages/modules/factory/src/procedure.ts` の `REVIEW_SCHEMA` は、当時 `verdict: "pass" | "changes"` の
2択しかなかった。コード自体は完成していてテストも通るため、レビュー役が選べる判定は実質 `"pass"` だけ——
その結果 `engine.ts` の `run()` は手順(`procedure()`)が例外を投げずに終わったとみなし、機械的に

```ts
await this.step("backlog:done", async () => {
  await this.call("backlog", "updateItem", { id: item.task.id, status: "done", resolution: `Factory が取り込みました（${item.branch}）` });
```

を実行して Backlog を `done` にした。**文章で書いた「ブロック」は、Factory の状態機械のどこにも読まれなかった。**
これが、実装自体は存在するのに Backlog 上は「完了」として扱われ、誰も改めて origin への反映に気づかなかった
直接の原因。

## 直した点

`packages/modules/factory/src/procedure.ts` に、レビューの判定へ3つ目の選択肢 **`"blocked"`** を追加した:

- `REVIEW_SCHEMA` の `verdict` に `"blocked"` を足した
- `reviewPrompt()` に「コードは直しようがなく、完了条件を満たすには worktree の外の操作(release への push 等)か、
  まだ決まっていない設計判断を人に仰ぐ必要があるときは、このまま pass にせず必ず blocked にする」ことを明記した
- `deliverTask()` で `verdict === "blocked"` のときは、回数の上限を数えずに必ず `ctx.ask()` で人に聞く
  (コードを直しても回数が減らないため)。人が「このまま取り込む」と答えれば `pass` と同じ扱い、「指示」が
  あれば実装役に続きを頼み、「やめる」と答えれば Backlog は `ready` に戻る(`dropItem` の既存の経路)——
  **人が明示的に答えるまで、黙って `done` にはならない**ようにした。

## 監査(サンプル)

「`done` かつ resolution が Factory の既定文言のまま(手で書き換えられていない)」の Backlog 項目を
`tasks.json` から抽出し(16件)、うち #268・#411 をサンプルで origin/main と突き合わせたところ、どちらも
正しく origin/main に入っていた(resolution の文言が更新されていないだけ)。#537・#538・#539(メタ Project)
だけが実際に origin に無いことを確認済み。全件の監査は行っていない——他にも同様の「文言未更新」はありうるが、
今回の事故の型(release への反映を含む doneWhen + 設計判断待ち)に当てはまるのは #539 系だけだった。

## なぜ「育ち続ける」ままだったか——`.worktrees/localmain` は誰も押し戻していなかった

`.worktrees/localmain`(ブランチ `main`)の HEAD は `cc3548125`「test(core): #539 管理対象のターンの知らせの
試験を…」で、直前の2コミットは `b8f2d62bd`・`7166fc07b`——まさに #539 の「ブロックです」という docs/notes を
書いたコミットそのものだった。Factory がこの Project のタスクを運ぶとき、`fastForward()` は「branch `main` を
checkout している worktree」を探してそこへ `merge --ff-only` する。この Project ではそれが常に
`.worktrees/localmain` であり、ここへ着地したコミットを origin/main の上に載せ直して push するのは
(Memory #58971 のとおり)**人か別セッションが手で行う別工程**。

  #268・#411 のようにこの載せ直しがちゃんと行われた項目がある一方、#539 は「blocked のまま done にされた」ために
  誰も「ここ、まだ origin に無い」と気づく機会が無く、載せ直されないまま `.worktrees/localmain` に残り続けた。
  それに加えて、ほかの作業はこの Project でも軒並み `.worktrees/<名前>` → origin/main の直接 push(今回の修正も
  この経路)で届けられており、`.worktrees/localmain` を能動的に origin へ押し戻す役目を持つ人・仕組みが無かった
  ため、2週間、押し戻されないまま積み上がった。**今回の本質的な原因は #539 の blocked 判定の欠落だが、
  `.worktrees/localmain` が「育っても誰も気づかない」構造になっていたことが、分岐が2週間も放置された
  土台になっている。**

## 残っていること(人と相談して決めること)

- メタ Project(#532〜#539)のローカル専用コミットを origin へ復旧・push するかどうかは、この修正の範囲外
  (人と相談のうえで判断)。
- `.worktrees/localmain` の今後の扱い:このまま Factory の着地点として使い続けるなら、定期的に
  origin/main の上に rebase して push する運用(か、乖離が一定件数を超えたら気づける仕組み)が要る。
  使わないなら、たまっている分を一度精算して役目を終わらせる手もある——どちらにするかは人の判断。
- 今回の修正(`verdict: "blocked"`)は、今後 Factory に新しく流すタスクにのみ効く。過去の「pass にされてしまった
  ブロック」を遡って拾い直す仕組みは作っていない。

## 直した版

`fork/factory-blocked-verdict`(origin/main の `ec921e335` の上に1コミット)を、Factory module の単体テスト
(43件、既存41+新規2:blocked で accept/drop)を通したあと origin/main(`00a9525a3`)へ fast-forward 済み。
