# 04-canusetool-hold-the-line

**捨てる。本実装に流れ込ませない。**

## 問い

承認ゲート（§6.0・§6.4）を「(A) 電話を切らずに待つ」モデル——`canUseTool` の
Promise が解決するまで、その turn の `query()` プロセスをそのまま待たせる——
で実装できるか。§2.3 の決定（1ターン＝1回の `query()`、モデルB）は**ターン間**の
話であって、ターンの**途中**の一時停止（tool 承認）とは別の階層のはず、という
仮説を実測で確かめる。

具体的に確かめること：

1. `canUseTool` の Promise を長時間（60秒超）解決しないまま放置しても、
   SDK 側が独自にタイムアウトして自動拒否しないか——Elicitation の
   `elicitInput()` にあった60秒タイムアウト（item13, `poc/02-...`）と同じ制約が
   `canUseTool` にもあるかもしれない、という懸念の確認
2. 長時間待たせたあとに `allow` を返したら、実際に tool が実行され、
   その結果が同じ `query()` の会話の続きとして出てくるか

## 実測

`run-hold-the-line.mjs`：`canUseTool` の中で90秒待ってから `{behavior: 'allow'}`
を返す。

**つまずいた点**：builtin tool（`Bash` 等）で試すと、`canUseTool` が一度も
呼ばれずに自動承認された。この実行環境が Claude Code の子セッション
（`CLAUDE_CODE_CHILD_SESSION=1`）であるため、親セッションの信任を継承して
builtin tool をバイパスしているとみられる——**環境固有の事情**であって、
banto の本実装（子セッションではない、単独プロセス）には無関係のはず。
代わりに `module.mjs`（MCP tool、`destructiveHint: true` を宣言した
`echo_test`）を使うと、このバイパスを受けず `canUseTool` が正しく呼ばれた。

## 結果

| 項目 | 結果 |
|---|---|
| `canUseTool` が呼ばれたタイミング | 5.7秒（tool 呼び出し発生時） |
| Promise を解決したタイミング | 95.7秒（90秒待たせたあと） |
| SDK 側の自動タイムアウト | **発生しなかった** |
| 90秒後に `allow` した結果 | 正しく tool が実行され、`echoed: hold-the-line-ok` が同じ `query()` 呼び出し（同じターン）の会話としてそのまま返ってきた |

## 決定的な発見

**「(A) 電話を切らずに待つ」モデルは、`canUseTool` による承認ゲートで成立する。**
Elicitation の `elicitInput()` にあった60秒のプロトコルタイムアウト
（item13、`poc/02-item13-parked-elicitation/`）と違い、`canUseTool` はそのような
制約を持たない——少なくとも90秒（既定60秒より長い）待たせても、SDK 側が
勝手に諦めたり自動拒否したりすることはなかった。

**§2.3 の「1ターン＝1回の `query()`」という決定は、ターンとターンの間の話であって、
ターンの途中の一時停止（tool 承認）とは別の階層である**、という仮説が実測で
裏付けられた。turn の `query()` プロセスは、承認待ちの間もそのまま生きていて
（`for await` が SDK 内部の待ちでブロックされているだけ）、新しいプロセスを
立ち上げ直す必要はない。

**帰結**：承認ゲートは Agent SDK の `canUseTool` を「(A) 待つ」前提で実装できる。
assistant-ui 側では、この形（同じ一続きの `run()` の中で、後から結果が
自然に出てくる）は `approval`/`respondToApproval`（provider が結果を出す
前提、`EDGE_CASES.md` A.8）の想定と噛み合う可能性が高い——モックで踏んだ
「離散ステップの return-and-reinvoke」問題は、本実装のアダプタが一続きの
generator として作られる限り再発しない見込み。

## 仕様書のどの行を更新したか

- `docs/specs/v4-architecture.md` §6.4（承認ゲート、モデルAを前提に採用）
