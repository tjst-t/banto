# メタ Project の権限——実装で決めたこと（2026-10-23、Backlog #537）

仕様の下書き：fork/meta-project のアーキ仕様 §4.6「権限——人に残すのは publish・money・destructive」。決まったことは
main のアーキ仕様「メタ Project の権限」（§2.3 の「AI への指示」の後）と v4-modules.md §4.3 に書いた。

## 仕様と実態の食い違い（規則8——人に上げる）

- タスクと §4.6 の下書きは「番頭の方針表（§4.5）を土台に」と言うが、**main には番頭が入っていない**（番頭の実装
  #506〜#511 は `release` ブランチにだけある。§4.5 の文も fork/meta-project にしか無い）。この作業ツリーは main から
  切られているので、番頭の表（`supervisor.delegate`・問いの種類 `kind`）は引けなかった
- そのため、メタ Project の任せ方は**番頭の表に繋がず、独立に持った**（鍵 `metaProject.release` と、system prompt の節と、
  公開の印）。release に載せるとき（Backlog #539）に番頭と並ぶ。そのとき番頭の表とまとめるか（例：メタ Project の任せ方を
  番頭の `action`・`kind` の語彙で書き直す）は**決めていない**——人が決める

## 決めたこと

- **spec・release は AI の判断で守る**。main で「人に聞く」かを決めているのは、AI がまとめの決めることに出すかどうかで、
  host が「これは spec の判断だ」と見分ける口は無い（番頭の `kind` も無い）。なので system prompt の節で、任されている
  もの・人に残すものを伝えるだけにした。「止める仕組み」を作るなら番頭の `kind` のような申告が要るが、それは番頭と
  合わせて決めること
- **LAN の中の公開は host が印で守る**。Publish の承認は人を待つ仕組みがはっきりあるので、そこだけは印
  （`dev.banto/autoApproveReach: "lan"`）で外した。「承認をすべて自動で許可する」の印（`dev.banto/autoApprove`）を流用
  しなかったのは、あちらは届く範囲を問わず通すから——インターネットに届く公開まで通ってしまう
- 届く範囲を確かめるのは**実装が名乗る値**（publish-caddy の設定の `reach`）。人が設定で決める値で、AI からは変えられない
  （`setCaddySettings` は人の刻印だけ）。窓口と実装の両方で確かめる
- release の既定「任せる」は**値を持たないこと**で表す（「人に残す」のときだけ `"human"` を持つ）。メタ Project を作る
  ときに鍵を書かなくても既定になる。普通の Project では鍵を読まないので、誤って値があっても効かない（HTTP の口も 409 で断る）
- money・destructive・インターネットに届く公開は**何も変えていない**——今の承認がそのまま止める

## 却下した案

- メタ Project を作るときに「承認をすべて自動で許可する」をオンにする——money・destructive まで通ってしまう
- release の設定を `boolean`（`metaProject.keepReleaseForHuman`）にする——モック（`releasePolicy: "delegate" | "human"`）と
  語が揃わない。口は `{ release: "delegate" | "human" }` にした
