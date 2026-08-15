---
id: imp-0035
type: improvement
kind: correctness
origin: po
status: done
resolution: "main 6d8abf5c（Merge branch 'fix/utsuwa-tolerant-rendering'）で着地。仕様追記は 926ba370。番頭が env.verify（docker/test）で main を検証し 2145 件・失敗 0 を確認（2026-08-15）"
refs: [adr-0017, thread-86, skill-utsuwa]
---

# 器が道具の戻り値をほとんど描けない（しかも `facts` は偽の成功を返す）

## 内容

`canvas.show` が「必ず失敗する」。枝「器が使えない件」(thread-86) で切り分けた結果、
原因は **「道具がテキストしか返していないから」ではない**。
全 75 本の道具は非空の `details`（パース済み JSON）を返しており、器にも渡っている
（`withArtifactOffload` が大きさに関係なく毎回 `a-NNNN.md`＝本文 と `a-NNNN.json`＝素性 の
二層で保存し、器は `record.details` を読む。テキストは一切見ていない）。

壊れているのは3点：

1. **番頭が `path` を指定できない。** `artifact.read` は `.md` しか読まないので、
   **番頭には `details` の鍵名を知る手段が無い**。SKILL utsuwa の例 `path: "envs"` も誤り
   （正しくは `environments`）。**実測**：`path` を足せば通る（`worker.list` + `path:"workers"`、
   `kobo.list` + `path:"tasks"`）。
2. **行の見出しが `label` / `name` / `title` に限られている。** `worker.list` / `env.list` /
   `git.log` / `file.grep` など **11本は `path` を正しく渡しても全行が「—」**になる。
3. **`state` の5役（`run` / `turn` / `stop` / `warn` / `done`）が実データと1件も当たらない。**
   実際に来る語は `closed` / `running` / `idle` / `live` / `open` 等。**色が一度も点いていない。**

さらに悪いのは **`facts` だけが `path` 無しでも「成功」すること**。`toPairs` が入れ子を捨てる
（`canvas-utsuwa.ts:473`）ので、`worker.list` なら `workers` 配列が消えて
`total` / `closedTotal` / `limit` / `offset` だけが残る。**中身が無いのに成功として描かれる**——
I1（機構が返すのは事実）違反であり、3点の中でいちばん質が悪い。

## 直す筋

- **器側を寛容にする**（見出しの候補を広げる・`state` の語彙を実データに合わせる・
  描けないものは描けないと言う）。
- **観測の栞に鍵名を載せる**（番頭が `path` を書けるようにする）。**2ファイル・道具の追加は0本**。

## 却下した案（記録）

PO 案「道具の返り値を器に合わせる」は **ADR-0017 決定81(a) が明文で却下済み**であり、
面が30箇所連れて壊れるため採らない。`inline` 引数（番頭がその場で作ったデータを渡す口）も
I1 違反（番頭の作文が観測に見える）で反対。**その場で組み立てたものを見せたいなら
`file.write` → `file.read` → `doc` の器で既に通る。**

## 優先度

P1。番頭が PO に事実を見せる手段が事実上ゼロで、しかも一部は嘘（偽成功）を描く。

## 経緯

2026-08-15、枝「器が使えない件」(thread-86) で調査・番頭が実測で裏取り。調査は畳んだが
実装が誰にも渡っていなかったため、PO の指摘を受けて起票し職人へ委譲した。

## 決着（2026-08-15）

- 実装 `90eabc82` → main へ `6d8abf5c`（`--no-ff`、衝突なし・7ファイル・+669/-60）
- 仕様の追記 `926ba370`（`docs/spec/canvas-ui.md` §12.2 / §12.3）。外から見た約束だけ：
  **当てはまらない `state` は無色で素通し**／**落とした行・列・鍵は添え書きで必ず告知**／
  **`path` は一意に決まるなら省ける・候補が複数なら勝手に選ばず断る**／
  **`facts` は入れ子があれば描かずに断る（畳んだ数は器が作った数字であって観測ではない）**
- 検証：番頭が `env.verify`（docker / test プロファイル）で main を実測。
  **2145 件・失敗 0・cancelled 0**（skipped 5・296.6 秒）。職人の主張ではなく機構が返した事実。
- 残した懸念（未着手・別件）：`env.list` の `orphans`、`file.grep` の見出し。
  docker での `source-hygiene.spec.ts` は imp-0038 で別に起票済み。
