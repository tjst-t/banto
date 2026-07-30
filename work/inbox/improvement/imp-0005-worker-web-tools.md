---
id: imp-0005
type: improvement
kind: proposal
origin: po
class: capability-gap
status: resolved
resolution: 既定では渡さず worker.delegate の network: true のときだけ web.fetch / web.search を載せる。検索は鍵の要らない DuckDuckGo → Wikipedia の二段（ADR-0010 決定33、2026-07-30）
refs: [imp-0004, task-0010, adr-0010]
---

## 内容

職人（worker）に **WebFetch / WebSearch**（外部の取得・検索）の Tool を持たせたい（PO要望、2026-07-30）。調査タスクを職人へ委譲するとき、ドキュメントや API 仕様を自分で引けないと、番頭が全部渡すことになり D10（番頭は細かい仕事をしない）が空回りする。

## imp-0004 との関係（先に直す）

**imp-0004 が先。** `PiRpcDriver` はいま `SpawnOptions.tools` を読んでおらず、職人に渡す Tool を絞れない。この状態で web 系を足しても「全職人が常に web を持つ」形にしかできない。imp-0004 で `tools` を効かせてから、web 系を**選べる Tool の集合**として用意する。

## 設計で決めること

- **pi 側に web fetch/search があるか。** あればそれを有効化するだけ。無ければ拡張で足す（決定29e の `worker-report.ts` が拡張の雛形。banto-core 非依存の薄いアダプタにする）
- **既定で全職人に付けるか、明示指定か（D1）。** 外部ネットワークアクセスは職人に新しい能力を与える。取得先の制限（許可リスト等）が要るか、コスト・レート制限をどう扱うかを決める。番頭の判断で `worker.delegate` の `tools` に含める形が素直だが、既定に入れるなら one-way な外部依存として扱う
- **検証の経路との重複を避ける。** 動作検証は Environment Pool（決定32）が担う。web 取得は「調査のための読み取り」であって検証ではない——役割を混ぜない

## スコープ外

- Environment Pool（決定32・task-0033）。あれは実行して結果を得る経路で、これは読み取り経路

## 対応（2026-07-30・resolved）

「設計で決めること」の3点はいずれも決着した（ADR-0010 決定33に記録）。

- **pi 側に web fetch/search は無い**（組み込みは read/bash/edit/write/grep/find/ls の7つ）。
  エコシステムの既定路線は skill（`pi-skills` の brave-search）だが API キーが要る。
  拡張で足す方を採った：`packages/banto-worker-pool/src/pi-extension/web-tools.ts`
- **既定で渡すか明示指定か → 明示指定**（PO裁定）。`worker.delegate` に `network: true` を
  渡したときだけ拡張ごと載せる。載せなければ Tool 自体が存在しない
- **検索のバックエンド → 鍵の要らない経路**（PO裁定）。DuckDuckGo lite の HTML を読み、
  取れなければ Wikipedia 全文検索に落とす。参照実装は loamium の `web-search-provider.ts`

### 正直に書いておくこと

**これは砂箱ではない。** `bash` を持った職人は curl で外へ出られる。`network` が渡すのは
読みやすい口であって遮断の機構ではない。本当に外を断つなら `tools` から bash を外す。
効かない保証を契約に書かないため、Tool の説明にもこの旨を書いている。

### 「検証の経路との重複を避ける」について

Environment Pool（決定32）とは触れていない。web は職人プロセスの中で完結する読み取りで、
Worker Pool も Kobo も経由しない。何を取ったかは職人のセッションに残り `worker.attach` で辿れる。

### 検証（I1）

- `tests/acceptance/worker-web-tools.spec.ts`（19件）：門番・パース・整形・上限・エラー経路。
  HTTP は差し替えた fetch で置き換えるのでテストは外に出ない
- **門番の穴を1つテストが見つけた**：`new URL()` は `[::ffff:127.0.0.1]` を `[::ffff:7f00:1]` に
  正規化するため、埋め込みIPv4を10進のまま探す正規表現はすり抜ける（参照実装の loamium も
  同じ穴を持つ）。IPv6 を8グループに開いて数値で判定する形に直した
- **実プロセス**：本物の pi に拡張が載り `web__fetch` / `web__search` が登録されることを確認
  （単体テストは関数を直接呼ぶだけなので、拡張として読めるかは見ていない）
- **本物のネットワーク**（手元で1度・テストには入れない）：`keylessSearch("typescript satisfies
  operator")` が DuckDuckGo から10件（転送URLを実URLに戻せている）、`fetchPublicUrl(
  "https://example.com/")` が本文を取得、`http://localhost:4110/...` は門番が拒否
- `npm test` 683件全通過
