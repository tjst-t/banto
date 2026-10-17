# Browser：許可を求める吹き出しを出さずブロック（Backlog #379）——実測と E2E の結果

決めたことは `docs/specs/v4-modules.md` §4.1「形」の「許可を求める吹き出し」。ここは計測の記録と、完了条件に
届いていない部分の記録（規則1・8）。

## 実測（2026-10-17、Google Chrome 155、`test-page.ts` の `/permissions`、統合試験で）

- 引数なし：`permissions.query` は notifications・geolocation とも `prompt`。押して求めても答えが来ない
  （「まだ」のまま 10 秒——吹き出しが出たまま）
- `--deny-permission-prompts` あり：`Notification.requestPermission()` は `denied`、`getCurrentPosition` は
  `PERMISSION_DENIED` ですぐ返る。`permissions.query` は求める前は `prompt` のまま、断ったあとは `denied`

## Browser の E2E 5本——**4本通り、1本（browser-video）が別の原因で落ちている**

完了条件は「Browser の E2E 5本が通る」だが、**browser-video.spec.ts の「倍率が端数の画面（1.5・1.25・1.75）」
（:428、落ちる行は :532）が落ちている**。最初の報告で「別の原因で落ちている」を十分に書かず、「通っている」と読める
形にしてしまった（レビューの指摘）。

| spec | 結果 |
|---|---|
| browser.spec.ts | 通る（許可のページで denied が返る検査を含む。1回目は試験の `refOf` が読み直し後の ref `f2e1` を読めず落ち、直して通った） |
| browser-view.spec.ts | 通る（5.2分） |
| browser-tabs.spec.ts | 通る（4.5分） |
| browser-search.spec.ts | 通る（4.4分） |
| browser-video.spec.ts | :234 は通る。**:428 が :532 で落ちる**——ほかの画面の `viewport` が期待 `ページ 436×488`・実際 `ページ 436×448` |

browser-video の :428 が #379 と無関係なことの根拠（同じ行・同じ値で落ちる）：

- **main（01f0981e、#379 の変更なし）：2回中2回落ちる**
- #379 の枝：2回中2回（ほかにレビューの再実行でも落ちた）
- #379 の枝で引数だけ外した写し：1回中1回

→ Backlog **#382** にバグとして積んだ。直すのは #379 の外（規則7）。

## ついでに見つけた間欠的な失敗（#379 と無関係）

単体試験 `view.test.ts`「動画：人の画面で静かなページのタブ（別の窓）に切り替えると…キーフレームからすぐ来る」が
間欠的に落ちる（引数あり 38回中3回・引数なし 31回中1回）。Backlog **#381**。
