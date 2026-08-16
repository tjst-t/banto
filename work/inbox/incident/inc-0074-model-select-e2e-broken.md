---
id: inc-0074
kind: incident
status: open
severity: medium
created: 2026-08-14
measured: 2026-08-16 / SHA fc673a71 / 5回
refs: [inc-0069, inc-0071, imp-0068]
---

# モデル選択の e2e が落ちたまま放置されている（実測 6件・決定的）

## 起きたこと

2026-08-14、別件（章を畳んだときの使用量の持ち越し／main 01564d81）の検証で
Playwright を回したところ、`tests/chat-ux.spec.ts` 48件のうち **4件が落ちていた**。
落ちているのはすべてモデル選択UI 絡みで、症状は同じ:

```
Error: expect(locator).toContainText(expected) failed
Locator: locator('.model-select-item').first()
Expected substring: "200k"
Timeout: 5000ms
Error: element(s) not found
```

`.model-select-trigger` を押したあと `.model-select-item` が1つも現れない。

## 実測で数え直した（2026-08-16・SHA `fc673a71` を固定して5回）

**4件ではなく6件**だった。5回とも同じ6件が同じ理由で落ちる＝**完全に決定的**（5/5・間欠ではない）。

`tests/chat-ux.spec.ts`（5件）

- 送信ボタンは状態で姿を変える（送る→独楽→中断）— `.composer-submit .loader` が出ない（5000ms）
- いまのモデルが出て、選ぶとホストへ切替を送る — `.model-select-item` が **0件**（期待2件）
- 絞り込んだあと、上下と Enter で確定できる — `.model-select-item.is-on` が出ない（期待 "Qwen 3.6 35B"）
- モデルの切替は、その列の会話を宛先にする — **試験全体が30秒で時間切れ**
- モデル一覧に文脈の長さが出る — `.model-select-item` が出ない（期待 "200k"）

`tests/settings-scroll.spec.ts`（1件・**この起票の範囲外だったもの**）

- 職人の設定はモジュールの GUI として描かれ、変更は設定画面の口から送られる —
  `getByLabel('高精度（reasoning） に当てるモデル')` が出ない（期待 "opus"）

計測条件：ワークツリー `/home/ubuntu/worktrees/banto/browser-flake`、`npm ci` →
`npm run build:web` で dist を作り直し、`npx playwright test --workers=2`（retries 0）を5回。
出力は `/tmp/browser-flake/run-{1..5}.{txt,json}`。

**「送信ボタン」と「settings-scroll」が起票から漏れていた。**症状（要素が出ない）は同じ系列に見えるが、
同じ原因かどうかは**確かめていない**。

## これが今回の変更由来でないことの確認

職人 `context-meter-reset` が、自分の差分を `git stash` で退避した状態
（基準 `6f1b448f`）で同じ4件を実行し、**同じ理由で落ちる**ことを確認している
（`stash pop` 後に `git status` がクリーンに戻ることも確認済み）。
今回の差分は `packages/banto-web/**` に1行も触っていない（`git diff --name-only`）。

つまり **元から落ちていて、誰も拾っていなかった**。

## なぜ問題か

- モデル選択は PO が画面から触る機能で、e2e が唯一の見張りになっている。
  それが赤のまま放置されると、**壊れているのか、テストが古いのかが誰にも分からない**。
- 常時赤のテストがあると、e2e 全体が「どうせ赤い」と読み飛ばされる。
  今回もまさに、別件の検証中に**ノイズとして素通りしかけた**。
- **さらに、この赤は工場に届かない。** マージ前ゲートの器にはブラウザが入っておらず、
  ブラウザ試験は**1件も走らない**（`imp-0068`）。放置されているのではなく**誰も見ていない**。

## 調べる筋（未検証）

1. **UI が変わってセレクタが古い**（`.model-select-item` というクラスが今は無い、
   あるいは描画が遅延して 5s では出ない）。この場合はテストを直す。
2. **モデル一覧そのものが空**。`llm.list` 相当の口が e2e の偽サーバで応答しておらず、
   項目が1つも描かれていない。この場合は本体側かテスト用スタブの不具合。
3. **`200k` という文字列の出し方が変わった**（`contextWindow` の整形）。
   項目は出ているが期待文字列が合っていないだけなら、失敗は
   「element(s) not found」ではなくテキスト不一致になるはずなので、可能性は低い。

まず 1 と 2 の切り分け（項目が描かれているか）から。
**`.composer-submit .loader` と settings-scroll の1件が同じ原因かどうかも、同時に見ること。**

## いつから赤いか

未特定。`6f1b448f` の時点で既に赤いことまでは分かっている。
`git log -- packages/banto-web/src`（モデル選択まわり）と e2e の実行記録を
突き合わせて、赤くなった commit を特定すること。

## 手当て

未着手。番頭が起票のみ。**直しを機械で確かめるには `imp-0068` の決着が要る**（器にブラウザが無い）。
