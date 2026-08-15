---
id: inc-0074
kind: incident
status: open
severity: medium
created: 2026-08-14
refs: [inc-0069]
---

# モデル選択の e2e が4件落ちたまま放置されている

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

## これが今回の変更由来でないことの確認

職人 `context-meter-reset` が、自分の差分を `git stash` で退避した状態
（基準 `6f1b448f`）で同じ4件を実行し、**同じ理由で落ちる**ことを確認している
（`stash pop` 後に `git status` がクリーンに戻ることも確認済み）。
今回の差分は `packages/banto-web/**` に1行も触っていない（`git diff --name-only`）。

つまり **元から落ちていて、誰も拾っていなかった**。

## なぜ問題か

- モデル選択は PO が画面から触る機能で、e2e が唯一の見張りになっている。
  それが赤のまま放置されると、**壊れているのか、テストが古いのかが誰にも分からない**。
- 常時赤のテストが4件あると、e2e 全体が「どうせ赤い」と読み飛ばされる。
  今回もまさに、別件の検証中に**ノイズとして素通りしかけた**。

## 調べる筋（未検証）

1. **UI が変わってセレクタが古い**（`.model-select-item` というクラスが今は無い、
   あるいは描画が遅延して 5s では出ない）。この場合はテストを直す。
2. **モデル一覧そのものが空**。`llm.list` 相当の口が e2e の偽サーバで応答しておらず、
   項目が1つも描かれていない。この場合は本体側かテスト用スタブの不具合。
3. **`200k` という文字列の出し方が変わった**（`contextWindow` の整形）。
   項目は出ているが期待文字列が合っていないだけなら、失敗は
   「element(s) not found」ではなくテキスト不一致になるはずなので、可能性は低い。

まず 1 と 2 の切り分け（項目が描かれているか）から。

## いつから赤いか

未特定。`6f1b448f` の時点で既に赤いことまでは分かっている。
`git log -- packages/banto-web/src`（モデル選択まわり）と e2e の実行記録を
突き合わせて、赤くなった commit を特定すること。

## 手当て

未着手。番頭が起票のみ。
