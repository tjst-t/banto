---
id: imp-0086
title: PO が取次で「緩めてよい」と答えても、その答えが kobo.amend へ届く口が無い
status: open
severity: P2
origin: PO 指示（2026-08-16「Kobo が取次に質問して、ユーザが回答しているのに無視される問題を、工場の外で修正しておいて」）／枝「取次の答えを効かせる」の調査
refs:
  - 決定113（PO が押した答えを、そのまま工場へ届ける橋）
  - 決定57（契約の緩和は PO 判断）
  - imp-0064（supersede が amend の線を素通しする）
  - task-0169（同じ日に塞いだ canvasParams の穴。こちらは「機構はあるのに手前で切れていた」側）
  - task-0225 → task-0227（2026-08-16・迂回した実例）
---

## 何が起きるか（2026-08-16 実測）

`task-0225` の職人が「スコープに `packages/banto-host/src/server.ts` を足してよいか」と聞いて
`paused` になった。**取次に札が立ち、PO が「足してよい」と答えた。**

ところが番頭が `kobo.amend` を撃つと、機構はこう断る：

> 500: task-0225 の改訂は**緩める方向**なので PO の判断が要ります …——取次へ上げてください

**もう上げて、答えももらっている。** それでも通らない。
残った道は「新しく積んで `kobo.supersede` する」だけで、実際そうした（`task-0227`）。
**そしてそれは imp-0064 が書いているとおり、`kobo.amend` の線を素通りする。**
——線が守っているつもりのものを守れていない。

## 原因（調査済み・行番号つき。2026-08-16 現在の main）

**daemon の中身は、既に PO を通せる形になっている。到達する外の口が1本も無いだけ。**

- `amendTask` の署名は `by: "banto" | "po"` を受ける — `packages/banto-daemon/src/daemon.ts:1582`
- 断りの判定は `loosens && options.by !== "po"` — `daemon.ts:1628-1636`（文言は `:1632`）
  - `loosens` が立つのは2つ：スコープを広げた（`daemon.ts:1443`→`:1446`）／レビュー段を緩めた（`:1470-1475`、厳しさは `:1549-1558`）
- **しかし `amendTask` の呼び出し元は1箇所だけで、`by: "banto"` を直書きしている**
  — `packages/banto-daemon/src/kobo-tools.ts:1069-1074`（特に `:1073`）
- daemon の HTTP ルートは2本しかない — `packages/banto-daemon/src/http-server.ts:413`（`po-decision`）と `:491`（`/tools/*`）
  - `po-decision` は `decision` が `approve` / `send_back` 以外なら 400 で弾く — `http-server.ts:476-480`

**つまり「PO の答えを根拠に amend の断りを越える余地」は、引数・actor・別の口のどれにも無い。**

## 直し方（設計はここまで決まっている。明日これを拾う者は、見積もりを1から出し直さなくてよい）

**既存の橋（決定113 の `po-decision`）に `decision: "amend"` を1つ足す。**
新しい橋を架けない。理由は、決定113 の橋が既に4重の守りを持っていて、そこへ荷物を1つ足す形なら
**守りを1つも外さずに済む**から（守りの中身は下の「外してはいけないもの」）。

`packages/banto-host/src/kobo-po-decision.ts:18-20` に、
「`kobo.amend` のように `by:"banto"` を直書きしている道具も、`decision` を1つ足せば
同じ橋に乗せられる」と**設計意図として既に書いてある**。それに従う。

### 変える範囲と見積もり（別の職人による調査。合計 250〜300行）

| 場所 | 何をするか | 目安 |
| --- | --- | --- |
| `packages/banto-daemon/src/http-server.ts` | `po-decision` に `decision: "amend"` を通す（`:476-480` の弾きを広げ、改訂内容を受ける） | +40行 |
| `packages/banto-daemon/src/kobo-tools.ts` | `amendTask` を `by: "po"` で呼べる経路（`:1073` の直書きを分ける） | +20行 |
| `packages/banto-host/src/kobo-po-decision.ts` | 改訂内容を運ぶ引数と effect の組み立て | +40行 |
| `packages/banto-host/src/inbox-tools.ts` | `amendAction` と、改訂内容を札に載せる引数群 | +40行 |
| `packages/banto-host/src/bin.ts:1192-1196` | 結線に `amend` を足す | +10行 |
| `tests/acceptance/` | 通しの受け入れ試験（PO が押して初めて `by: po` で amend が通ること） | +150行 |

### 先に決めないと書けないこと（**未決の設計判断。ここで止まること**）

**「PO が承認する"改訂の中身"を、誰がどう書くのか」。**
- 番頭が札に改訂内容（新しい scope / acceptance）を全部書いて、PO は「はい／いいえ」を押すだけにするか
  → `inbox.post` の引数が一段重くなる（改訂の全項目を札に載せることになる）
- それとも PO が面で改訂内容を打つか
  → `kobo.review` に相当する面が amend には無いので、面から作ることになる（`KoboReview.tsx` +100〜150行）

**前者を推す**（番頭は既に amend の引数を組み立てられる／面を新設しないで済む／
「PO は番頭が出した具体案に是非を答える」という決定113 の形と同じ）。
**ただしこれは設計判断なので、着手前に PO へ上げること。**

### 外してはいけないもの（**ここを外したら改悪**）

決定113 の橋は、「**PO が実際に押した**という事実に紐づいて初めて `by: "po"` が立つ」構造になっている。
足すときも、この4つを1つも外さないこと：

1. **番頭は `effect` を書けない** — `inbox.post` は `effect` を受け取らない。書けるのは
   「どの選択肢がどの判断に当たるか」まで（`packages/banto-host/src/inbox-tools.ts:79-93`）。
   呼ぶ先を決めるのはホスト側の結線（`bin.ts:1192-1196`）
2. **画面にも `effect` を配らない** — `toView` が必ず落とす（`inbox.ts:135-145`）。
   画面は「押された」を投げ返すだけ（`packages/banto-web/src/useBantoSession.ts:801`）
3. **番頭は effect 付きの札を畳めない** — `inbox.resolve` が拒否（`inbox-tools.ts:232-238`）。
   effect が走るのは**画面から押された経路だけ**（`server.ts:1990-2007`）
4. **記録で担保する** — `via`（`inbox:<itemId>#<actionId>`）は daemon で必須（`http-server.ts:427-439`）。
   帳簿に `by: "po"` と `via` が残る

**やってはいけない直し（挙げるだけ・非推奨）**：`scopePatternCovered`（`daemon.ts:1531` 付近）を
緩めて「1パス追加は番頭が通せる」にする案は10行で済むが、**PO が答えていなくても番頭が通せるようになる。**
それは決定57 の線を消すのと同じで、改悪。

## 積むときの契約案（そのまま `kobo.enqueue` に使える）

- **kind**: `feature`
- **scope.paths**:
  - `packages/banto-daemon/src/http-server.ts`
  - `packages/banto-daemon/src/kobo-tools.ts`
  - `packages/banto-host/src/kobo-po-decision.ts`
  - `packages/banto-host/src/inbox-tools.ts`
  - `packages/banto-host/src/bin.ts`
  - `tests/acceptance/kobo-po-amend-from-inbox.spec.ts`
- **acceptance**（案）
  1. 「緩める向き」の改訂を載せた札を `inbox.post` で積める（`amendAction` に効果が結ばれる）
     — `node --import tsx --test tests/acceptance/kobo-po-amend-from-inbox.spec.ts`
  2. PO が札から押すと `by: "po"` で `amendTask` が通り、帳簿に `via: inbox:...` が残る — 同上
  3. **PO が押していない状態で番頭が `kobo.amend` を撃っても、緩める向きは今までどおり断られる**
     （守りが外れていないこと） — 同上
  4. 番頭は `inbox.resolve` でこの札を畳めない（決定57・111） — 同上
  5. 既存の受け入れ一式が通る — `npm test`
  6. 型検査が通る — `npm run typecheck`
- **review.policy**: `po`（PO 権限の口を1本増やすので、PO が見ること）

## 影響

- **入るまでの間**、緩める向きの改訂は「積み直して supersede」で迂回するしかない
  （imp-0064 が書いている抜け道そのもの）。**迂回のたびにタスク番号が飛び、経緯が分断される**
- **入れば imp-0064 の (a)**（supersede でも緩みを検出して PO へ回す）**の受け皿ができる**
  ——番頭が自分に課している線を、機械が守る線へ移せる
