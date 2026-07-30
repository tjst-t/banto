---
id: imp-0004
type: improvement
kind: incident
origin: agent
class: spec-impl-mismatch
status: open
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
