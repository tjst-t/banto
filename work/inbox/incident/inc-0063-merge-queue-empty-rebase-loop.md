---
id: inc-0063
type: incident
kind: incident
origin: agent
class: bug
status: open
refs: [task-0097, task-0099, task-0093, task-0112, task-0146]
---

## 内容

マージキューが 1 分周期の無限ループに陥り、**35 本のゴミタスク（task-0112〜0146）を自動起票し続けた**
（2026-08-13 08:20〜09:40 頃）。増殖したタスクは `scope.paths: ["**"]` を持つため、スコープ重複ゲートで
**後続タスク全部を塞ぐ**。同時に task-0097 が `merging` に居座り、マージキューは直列なので
**プロジェクト全体のマージが止まった**。

番頭の手では止められなかった。`kobo.reopen` は failed 専用、`kobo.abandon` は番頭の道具に無い、
`kobo.approve` は merging に効かない——**merging に入ったタスクに番頭が触れる口が1本も無い**。
最終的に PO が HTTP で `task-0097 → failed` を叩いて止めた。

## 周回

```
merge-queue tick   → rebase が衝突 → 解消タスクを新規起票 → origin を paused
  ↓（同じ tick の中で）
conflict-resolution-check → closed 済みの task-0099 を毎回拾い直す → origin を resume（merging へ）
  ↓（60 秒後）
最初へ戻る
```

1 周＝イベント 6 件＋`work/tasks/*.md` 1 本。08:20:13 から正確に 60 秒間隔で task-0112〜0146。

## 原因（実測で確定。当初の診断は誤りだった）

**訂正: 「空 rebase をコンフリクトと誤検知」ではない。本物の内容コンフリクトだった。**

```
$ git merge-tree --write-tree --name-only main 5fbf177
docker/Dockerfile.test
CONFLICT (content): Merge conflict in docker/Dockerfile.test
```

main（86fb5a9 経由）も `task/task-0097`（5fbf177）も `FROM node:24-alpine` に変えているが、
**直上のコメント本文だけが違う**ため同じ行群が衝突する。機能的な中身は完全に main が先取り済みで、
このブランチに取り込むべきものは無い。にもかかわらず rebase は永久に失敗し続ける。

ループの本体は**衝突そのものではなく、解消の判定側**にある。

`conflict-filer.ts:278-312` の `deriveOriginResolutionPairs` が見ているのは
①kind=conflict ②refs[0] ③origin が paused か、の3つだけで、
**「その解消タスクが既に消費済みか」を見る条件が無い**。docstring には
"status != one of the terminal states we already handled" と書かれているのに、
**実装にその除外が1行も無い**（仕様と実態の食い違い＝P3）。

その結果、closed のまま台帳に残る task-0099（refs=["task-0097"]）が**恒久的なペアの片割れ**になり、
`runConflictResolutionCheck`（daemon.ts:3577-）が origin を paused と見るたびに無条件で resume する
（daemon.ts:3596）。resume には冪等性の印が無い。

## 直すべきところ（6件）

### 1. 消費済みの解消タスクを除外していない ★根本原因
`conflict-filer.ts:278-312` `deriveOriginResolutionPairs` に、docstring どおり
「解消タスクが既に terminal（merged / closed / failed / abandoned）で、かつその resume を
一度実施済みなら、そのペアは返さない」条件を入れる。

### 2. resume が冪等でない ★根本原因
`daemon.ts:3577-` `runConflictResolutionCheck` は、同じ解消タスクで何度でも resume できてしまう。
**「この解消タスクによる resume は済んだ」印**を帳簿から導出できる形で持ち、二度目を打たない。

### 3. 解消タスクの重複起票を止めていない
`daemon.ts:3469-` `handleRebaseConflict` は、同一 origin に対する未解決の解消タスクが既に
queued にあっても二本目を積む。1・2 を直しても、別の原因で周回すればまた増殖する。
**同一 origin に未解決の解消タスクがあるなら積まない**（べき等性）。

### 4. `po_operation` を機構が PO 名義で書いている ★監査証跡の汚染
`daemon.ts:3612-3618` は resume 成功のたびに `type: "po_operation", operation: "conflict_resolved"`
を無条件で append する。**PO は操作していない。** 帳簿の `po_operation` はほぼ全部これになっており、
「誰が決めたか」が追えない。機構の自動処理は PO 名義で書かない（別の type にする）。

### 5. merging に入ったタスクに番頭が触れる口が無い ★今回止血できなかった直接の原因
- `kobo.abandon` / `kobo.supersede` / `kobo.amend` が**番頭の道具に出ていない**。
  デーモン側には `abandonTask`（daemon.ts:1331）等が実装済みで、**機構の通知文は
  「kobo.abandon で畳んでください」と案内してくる**のに、番頭の手には無い。
- `kobo.reopen` は failed 専用のため、merging で詰まったタスクを降ろせない。
- 結果、番頭は職人に HTTP を直叩きさせるしかなかった。**道具の一覧と案内文が食い違っている**。

### 6. 一件の後始末が 35 件の判断待ちに見える
35 本を畳む間、まったく同じ通知が 35 回 PO に届いた。**同じ理由で連続する通知は束ねる**べき。
（これは取次の設計に関わるため、実装ではなく調査と提案までとする）

## 暫定処置（2026-08-13 実施済み）

- PO が HTTP で `task-0097 → failed`。両方のループが同時に停止した
- 職人が増殖分 task-0112〜0146 の 35 本を failed → abandon で畳んだ。`work/tasks/` の該当 .md も残っていない
- 畳む間の再取り込みを防ぐため、番頭が `kobo.set_watch(banto, false)` で取り込みを一時停止し、完了後に戻した

## 再発の検知

同一タイトルの「コンフリクト解消: &lt;task&gt; vs main」が queued に 2 本以上並んだら、この周回に入っている
（`kobo.list --state queued` で見える）。加えて、`po_operation` が PO の操作なしに増えていないかを見る。
