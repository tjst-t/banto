---
id: imp-0004
type: improvement
kind: incident
origin: agent
class: spec-impl-mismatch
status: resolved
resolution: PiRpcDriver が systemPrompt を --append-system-prompt、tools を --tools として渡すようにし、絞ったときも報告経路が残るよう WorkerPool 側で足す。本物の pi を起こす受け入れテストで確認（2026-07-30）
refs: [task-0010, task-0026, adr-0010]
---

## 内容

`RuntimeDriver` の契約（`banto-core/src/runtime-driver.ts` の `SpawnOptions`）は
`systemPrompt` と `tools` を受け取ることになっているが、**`PiRpcDriver` はどちらも読んでいない**。
`grep systemPrompt packages/banto-worker-pool/src/pi-rpc-driver.ts` は0件、`tools` も未使用。

結果として2つのことが起きている。

### 1. `WORKER_SYSTEM_PROMPT` が職人に届いていない

`pool.ts` は「立場（職人であること）はシステムプロンプト、やることは inject で渡す」と書き、
`WORKER_SYSTEM_PROMPT`（記憶を持たないこと・足りなければ聞くこと・終わったら報告すること）を
`spawn` に渡している。**この文面はどこにも届いていない。**

task-0010 で「spawn だけでは職人が動かない」不具合を直した際、systemPrompt と instruction を
分ける形にしたが、systemPrompt 側の経路が繋がっていないことは確認していなかった。職人が
instruction どおりに動いたので気づけなかった（I1 の失敗例：動いたことを経路の証明にしてしまった）。

D11「職人は記憶を持たない」を職人自身に伝える手段が、いま実質的に無い。

### 2. `worker.delegate` の `tools` パラメータが黙って無視される

Tool契約は「職人に使わせるTool名（省略時はランタイムの既定）」と説明しているが、何を渡しても
職人は pi の既定ツール一式（`read` / `write` / `edit` / `bash` 等）を持つ。番頭が
「読み取りだけさせる」つもりで委譲しても、職人は書き込みも任意コマンド実行もできる。

I2（エラーを握りつぶさない）に反する。効かない指定を成功として受け取っている。

## 実害

- 職人が本来受け取るべき立場・作法の説明を受け取っていない。決定29 の報告経路は拡張側の
  プロンプトで補われているが、それ以外（記憶を持たないこと等）は伝わっていない
- 番頭が委譲時にツールを絞れない。「調査だけ」のつもりの委譲でも、職人は worktree 内の
  ファイルを書き換え、コマンドを実行できる。POが試しに触るときの事故要因になる

## 検出経緯

task-0026 の確認後、PO に試用プロンプトを出す前に「職人は何ができるのか」を確かめていて発見した。

## 対応方針（案）

1. `PiRpcDriver.spawn` で `systemPrompt` を pi に渡す（`--system-prompt` 相当か、拡張の
   `before_agent_start` フック経由。決定29e で使った拡張の仕組みが使える）
2. `tools` を pi の `--tools` 相当へ渡す。渡せないなら**契約から外す**——効かない項目を
   契約に残さない
3. どちらも「渡したものが効いていること」を実プロセスで確認するテストを付ける。
   偽ドライバでは検出できない類の欠落である（task-0026 の inject の件と同じ構図）

## 対応（2026-07-30・resolved）

対応方針の1・2・3をそのまま実施した。契約から外す（案2の後段）必要は無かった——pi は
`--tools` で拡張の Tool まで含めて絞れる。

- **systemPrompt → `--append-system-prompt`**（差し替えではなく追記）。pi の既定プロンプトには
  使える道具の一覧と作法が入っており、`--system-prompt` で置き換えるとそれが消える。
  ここで渡したいのは立場であって、道具の説明の削除ではない。`SpawnOptions.systemPrompt` の
  契約コメントにもこの意味を書いた
- **tools → `--tools`**（カンマ区切りの許可リスト）。空配列は「ランタイムの既定のまま」の意味で
  `--tools` を渡さない——空の許可リストを渡すと道具が1つも無い職人になる
- **絞っても報告経路は残す**（`WorkerPool.resolveTools`）。pi の許可リストは**拡張の Tool にも
  効く**ので、番頭が `["read","grep"]` のつもりで絞ると `worker.report` / `worker.ask` まで
  消え、職人は報告も質問もできないのに誰も気づけない。報告先があるときは Worker Pool が
  この2つを自動で足す

### 検証（I1）

`tests/acceptance/pi-rpc-system-prompt-tools.spec.ts` を追加。**本物の pi を起こして**、
覗き見用の拡張が `session_start` の時点で確定した道具の一覧とシステムプロンプトを書き出す
（LLM もネットワークも使わない。PI_OFFLINE=1）。

- 渡した文面が pi のシステムプロンプトに入っていること・既定プロンプトが残っていること
- 絞ると `write` / `edit` / `bash` が実際に消えること
- 許可リストが拡張の Tool にも効くこと（報告経路が消える理由の実証）
- 渡さなければ既定一式のままであること

直す前の driver に戻すと 8 件中 5 件が落ちることを確認済み（偽ドライバでは1件も落ちない）。
`npm test` 659件全通過。

### 波及

Kobo（`banto-daemon`）も同じドライバを使っており、監査・rework セッションの systemPrompt
（`audit-system` + チェックリスト / `executor-system`）はこれまで届いていなかったのが届くように
なった。「PiRpcDriver は systemPrompt を無視する」と書いてあったコメント2箇所を実態に合わせた。
