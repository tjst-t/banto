---
id: adr-0023
type: adr
status: accepted
refs: [adr-0013, adr-0015, adr-0010, imp-0034, task-0147, spec-daemon-core, spec-ui]
amends: adr-0013
---

# ADR-0023: PO と番頭を分けるのは**合言葉ではなく経路**。取次の札の答えを工場まで届かせる

> status: **accepted**（2026-08-15。PO 裁定）。決定番号は 112（ADR-0022）の続きから採る。
> **ADR-0013 決定57 は変えていない。** 変えたのは「番頭が通せない」を機構でどう担保するか
> ——その線の引き方だけ。決定66（PO 必須の面の判定表）にも触れていない。

## 文脈

PO の訴え（2026-08-15、幹「電卓開発」で dentaku task-0005 を通す際に実地に踏んだ・imp-0034）：

> 帳場で Kobo のレビュー OK を出したら、Kobo 的にもレビュー OK にしてほしい。
> `BANTO_PO_TOKEN` の類を要求しないでほしい。GUI で OK を出せば、それで通ること。

### 何が起きていたか

`review.policy: po` のタスク（統治コード・PO 必須の面に触るもの）は決定57 により番頭が通せない。
そこで番頭は `inbox.post`（`canvasKind: "kobo.review"`）で PO に判断を仰ぐ。PO は札の選択肢を
押して「マージしてよい」と答える——**ところがその答えは Kobo の帳簿へ一切流れなかった。**

| PO の意思表示の口 | 実際 |
|---|---|
| 取次の札の選択肢を押す | 取次の帳簿に「答えが出た」と記録され、番頭のターンが回るだけ。**工場へは何も届かない** |
| レビュー面の「PO として通す」を押す | 届く。ただし**合言葉（`BANTO_PO_TOKEN`）を毎回打つ**必要があった |

結果、番頭が続けて `kobo.approve` を呼ぶと 500（「番頭は通せません——取次へ上げてください」）で、
**PO はレビュー面をもう一度開いて承認ボタンを押す二度手間**を踏んだ。

### 三すくみで永久に止まる（dentaku task-0007・2026-08-15 04:15Z 実測）

別のプロジェクトでは二度手間では済まず、**行き止まり**になった：

- `task-0007`（`review: po`）が review-ready まで来た
- PO は取次の札 `in-b1e691dc` に「通す（マージへ）」と答えた
- **Kobo 側は review-ready のまま。** イベント列は 04:02:18 の `audit_passed:po` が最後で、
  その後 1 本も積まれていない
- 番頭が `kobo.approve` を呼ぶと 500

**「PO は通すと答えた／番頭は通せない／Kobo には答えが届かない」**——このタスクは
誰の操作でも動かない。これが本 ADR の受け入れ条件の中心である。

判断を仰ぐ道具が `canvasKind: "kobo.review"` を添えられる以上、繋がっていると読むのが自然で、
実際には繋がっていない——**道具の見かけと実体の食い違い**（I1）でもある。

### 合言葉が置かれていた理由（task-0147 の縛り）

task-0147 は「番頭ホストは合言葉を保存しない」を縛りとして置いた。**保存すると番頭が自分で
通せる状態になり、決定57 が空文になる**——これは当時の正しい心配だった。合言葉は「PO 本人か」
を確かめる手段として置かれている。

だが PO からは「画面はもともと自分専用なのに、なぜ毎回名乗らされるのか」に見えており、
**合言葉を条件にするなら、PO にとっては「OK を出せない」のと同じ**だった。

## 決定

### 決定113: 番頭と PO を分ける線は「合言葉の有無」ではなく「**Tool の経路か、人が押した経路か**」

決定57 が禁じているのは「**番頭＝LLM が自分の判断で通す**」ことであって、
「**番頭ホスト（プロセス）が、PO が画面で押した操作を受けて Kobo を叩く**」ことではない。
線をそこへ引き直す。

**(a) PO 専用の承認口は合言葉を要求しない。** `POST {koboUrl}/projects/:proj/tasks/:id/approve` は
他の口と同じく前段と待ち受けアドレス（決定40）で守る。`BANTO_PO_TOKEN` / `DaemonConfig.poToken`
は廃止する——**効かない設定を残すのは、実態と食い違う仕様を残すのと同じ**（P3）。

**(b) 代わりに `via` を要る形にする。** `task_approved` に `via`（どの画面のどの操作から来た
意思表示か）を足し、無い承認は 400 で断る。**監査可能性は名乗りではなく記録で担保する。**
レビュー面からなら `ui:kobo.review`、取次の札からなら `inbox:in-xxxxxxxx#approve`。

**(c) 取次の札の回答を、その既存の口へ結ぶ。** 番頭は `inbox.post` に
`canvasKind` / `canvasParams: {projectTag, taskId}` に加えて **`approveAction`**（通す選択肢の id）と
**`sendBackAction` / `sendBackReason`**（戻す方）を書く。押されたときに Kobo を叩くのは
取次の処理（`InboxEffect`・決定73）で、LLM ではない。**口は増やさない**——足したのは結線であって
3つ目の経路ではない。

**(c-2) 橋は承認専用にしない**（PO要望 2026-08-15）。運ぶのは「**PO がどう答えたか**」であって
承認ではない。工場側の口は `POST .../po-decision`（`{decision, via, ...}`）1つに集め、
ホスト側の口は `kobo.po_decide` 1つにする。理由は2つ：

- **通す側だけ繋ぐと、PO が「駄目だ」を押しても何も起きない**——imp-0034 の形が半分残る
- `kobo.amend` にも同じ穴がある（道具が `by: "banto"` を直書きしていて、PO 権限で呼ぶ経路が
  無い）。**amend は本 ADR のスコープ外**だが、`decision` を1つ足せば同じ橋に乗る形にしてある

**(d) LLM からは通せないことは、次の4点で機構が担保する**（名乗りではなく構造で）：

| どこで切れているか | 何が起きるか |
|---|---|
| `kobo.approve`（番頭に渡っている Tool）は `by: "banto"` しか渡さない | `Daemon.approveTask` が `po` 段のタスクを断る（**今までどおり**・試験も残す） |
| PO の判断を届ける口（`kobo.po_decide`）は `internalTools` | `ModuleRegistry.tools()` に出ない＝番頭の在庫にも提示にも載らない。モデルからは呼べない |
| `inbox.post` に `effect` を書かせない（決定73 のまま） | 番頭が書けるのは「どの選択肢が承認か」まで。呼ぶ先を決めるのはホスト |
| `inbox.resolve`（番頭の口）は処理を伴う選択肢を畳めない | 番頭が札を畳んで PO の押下を先回りできない。押すのは PO |

**番頭が自分で PO を名乗れる口は作っていない。** 上の4点は「番頭が `by: "po"` を渡せる経路が
1本も無い」ことを言っている——`by: "po"` を書くのは工場の HTTP 面（人の操作を受けた
ホストが叩く）だけで、番頭に渡っている Tool からはその値に到達できない。

**(e) 通しても関所は飛ばない。** ここまでは決定57 と同じ——承認の後にマージ前ゲートが回る。

## 変えていないもの（後から読む人へ）

- **決定57 は変えていない。** `po` と判定されたタスクを番頭（LLM）が通せないことは、
  経路の側で今までより強く担保されている。判定表（決定66）にも触れていない
- **決定73 も変えていない。** `InboxEffect` を番頭に書かせないのはそのまま。足したのは
  `originArg`（押された札と回答を、効果が望んだ名前の引数として渡す）1つだけ
- **task-0147 の縛りのうち「ホストは合言葉を保存しない」は、意味を失ったのではなく前提が
  消えた。** 合言葉そのものが無いので、保存しようがない。他の縛り（Tool の口は中継しない・
  通しても関所は飛ばない・書き手の名前を変えない）は今までどおり効いている

## 残る危うさ（記録として残す）

**この口に届く者は PO を名乗れる。** 合言葉をやめた以上これは事実で、決定113 はそれを
承知の上で選んでいる。根拠は2つ：

1. **既に同じ広さだった。** 取次の札を押す経路（WebSocket の `inbox_answer`）は元から無認証で、
   そこには書き込み許可の承認（`place.approve_write`）が既に載っている。Kobo の PO 承認だけを
   合言葉で守っても、隣の口から同じ強さの操作ができる
2. **守るのは前段**（決定40）。Kobo は 127.0.0.1 にしか出ておらず、番頭ホストの面は
   前段（Caddy 等）の認証の後ろにある。中継は**その認証を継承した先**にある（決定39）

**`internalTools` は番頭ホストの HTTP 面にも出る**（決定29e のまま・`module-serve.ts`）ので、
`POST /api/kobo/tools/kobo.po_decide` も前段の認証の後ろで叩ける。ここも `via` が要るので、
通れば帳簿に出どころが残る——**隠すのではなく残す**という決定113(b) の考え方はここでも同じ。

ただし**番頭のハーネスは shell を持ちうる**ので、番頭が「自分の判断で curl する」ことは
技術的には防げない。ここは Tool の一覧と SKILL（＝番頭が読む指示）で断っており、
**機構ではなく規律**である。合言葉があった頃も、合言葉を知らないという一点でだけ防げていた
——`BANTO_PO_TOKEN` が同じ機械の環境変数にある以上、その差は大きくない。

## 影響

| ファイル | 変更 |
|---|---|
| `packages/banto-core/src/events.ts` | `task_approved.via`（決定113(b)） |
| `packages/banto-daemon/src/daemon.ts` | `approveTask` が `by: "po"` のとき `via` を要る形に。`poToken` を廃止 |
| `packages/banto-daemon/src/http-server.ts` | PO の口から合言葉の照合を外し、`/approve` を `/po-decision`（`decision` で分岐）へ。`via` の検査を足す |
| `packages/banto-daemon/src/daemon.ts` | `sendBackTask` も `via` を受ける（承認と同じ扱い） |
| `packages/banto-host/src/kobo-po-decision.ts` | 札の回答 → 既存の口の結線（新規・`internalTools`） |
| `packages/banto-host/src/inbox-tools.ts` | `approveAction` / `sendBackAction` / `sendBackReason`／処理を伴う選択肢は `inbox.resolve` で畳めない |
| `packages/banto-host/src/inbox.ts` | `InboxEffect.originArg`（決定113(b)） |
| `packages/banto-host/src/server.ts` | `runInboxEffect` に押された札と回答を渡す |
| `packages/banto-host/src/bin.ts` | 結線の登録（`internalTools` と `resolvePoDecisionEffect`） |
| `packages/banto-web/src/views/KoboReview.tsx` | 合言葉の入力欄を外し、`via` を添える |
| `packages/banto-daemon/skills/kobo-review/SKILL.md` | `approveAction` を書く手順 |

試験は `tests/acceptance/kobo-po-approve-from-inbox.spec.ts`（端から端まで。通す／戻すの両方と、
**承認がマージ待ちの列に載るところまで**）と `tests/acceptance/kobo-po-approve-from-ui.spec.ts`
（画面からの経路）。**「番頭では通せない」の試験は消していない**
——決定57 が生きていることの見張りだから。

## 残った穴（本 ADR のスコープ外）

`kobo.amend` は `by: "banto"` を直書きしていて、PO 権限で呼ぶ経路が無い。同じ穴だが
今回は直していない——直すときは `po-decision` に `decision: "amend"` を足すのが筋。
