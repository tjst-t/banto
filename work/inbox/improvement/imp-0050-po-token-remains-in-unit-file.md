---
id: imp-0050
title: 決定113 で不要になった BANTO_PO_TOKEN が systemd の unit に残っている
status: open
severity: low
kind: hygiene
found_at: 2026-08-15
found_by: banto
refs: [imp-0034, adr-0023, 決定113]
---

## 何が残っているか

`banto-daemon.service` に `Environment=BANTO_PO_TOKEN=cd9b5a93...` が書かれたままになっている。

決定113（ADR-0023）で **PO 承認の関所は合言葉ではなく「経路 ＋ via の記録」で守る**形に変え、`/approve` の合言葉照合はコードから削除した（imp-0034・main `33ed48ae`）。したがって **この環境変数を読むコードはもう1行も無い**。

## なぜ気になるか

動作は変わらない（誰も読まないので無害）。問題は**読み手が誤解すること**の一点：

- unit を読んだ人は「PO 承認は合言葉で守られている」と思う。実際の守りは経路の分離（`kobo.approve` は `by:"banto"` しか渡せない／橋は internalTools で番頭の在庫に載らない）であり、**守り方の理解を取り違える**
- 秘密の見た目をしたものが設定に残っていると、**棚卸しのたびに「これは使われているのか」を調べ直す**羽目になる（現に今回それをやった）
- 実際には無効な値なので、**万一これを頼りにした運用が生まれると、守られていないのに守られたつもりになる**

## どう直すか

1. `banto-daemon.service` から `Environment=BANTO_PO_TOKEN=...` の行を削る
2. リポジトリ内に unit の雛形・配布物・ドキュメントで `BANTO_PO_TOKEN` に触れているものが残っていないか grep して落とす
3. 値そのものは秘密として扱い、消すだけで再利用しない

## 確かめ方

- `systemctl cat banto-daemon | grep BANTO_PO_TOKEN` が空
- `grep -rn 'BANTO_PO_TOKEN' packages docs meta` が空（または「廃止した」と書いた履歴だけ）
- 消した後に PO がレビュー面から「通す」を押して、従来どおり `/po-decision` が通ること（合言葉に依存していないことの実地確認）

## 見つけた経緯

imp-0034 の反映（Kobo の入れ替え）で職人が unit を読んだときに発見。反映の作業とは切り離すため、その場では触らせずに起票した。
