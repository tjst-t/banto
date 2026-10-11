# 写した Claude の会話の記録から、別の作業ディレクトリで続けられるか（Backlog #262、2026-10-11）

v4-security.md §1「Project を別の実行場所へ移す」の「Claude の会話の記録」で、作るときに最初に測ると決めたもの。
**結論：写した記録で resume・resumeSessionAt・forkSession の3つとも通る。作業ディレクトリを `runner-cwd/<id>` に揃える案には
戻さない。** ただし「写さなくても通る」ことも分かった（下の「対照」）。

## 測り方

- プローブ：`banto/probes/r-move-resume.mjs`（`node probes/r-move-resume.mjs copy` / `nocopy`）
- **版：`@anthropic-ai/claude-agent-sdk` 0.3.281、同梱の CLI 2.1.281（Claude Code）**（banto が `packages/core` で使っている版）
- 本物の SDK の `query()` に、偽の Anthropic API（`probes/fake-api.mjs`）を `ANTHROPIC_BASE_URL` で当てた。CLI が送った要求
  （＝モデルが見た履歴）を記録して、何が見えていたかで判定した
- `CLAUDE_CONFIG_DIR` は1つ（tmpdir の下）。作業ディレクトリは A＝`…/rootA/work`、B＝`…/runner-cwd/proj-1`
- A で2ターン：1ターン目は合言葉 `apple-17` とサブエージェント（Agent の tool）を1回——`<id>/subagents/agent-*.jsonl` と
  `.meta.json` が出ることを確かめた。2ターン目は合言葉 `banana-29`
- `copy`：`projects/<A>/<id>.jsonl` と `<id>/` だけを `projects/<B>/` へ写し（元は残す）、B で順に
  1. resume（`third:`）
  2. resumeSessionAt（1ターン目の最後の assistant の uuid で切る、`fourth:`）
  3. forkSession（resume＋forkSession、`fifth:`）とその続き（分けた先の id で resume、`sixth:`）

## 結果（copy）

| 操作 | 通ったか | モデルが見たもの | 記録はどこに足されたか |
|---|---|---|---|
| resume | 通る。session id は同じ | apple・banana・サブエージェントの tool_result まで全部 | B の記録に足された（A は 0 行） |
| resumeSessionAt | 通る | apple だけ。banana・third は見えない（切れている） | B の記録に足された（A は 0 行） |
| forkSession | 通る。新しい session id | apple と、直前の取り消し後の fourth。banana・third は見えない | 分けた先の `<新しい id>.jsonl` は **B のフォルダ**にできた（A には無い） |
| fork の続き | 通る。分けた先の id のまま | fifth と apple | — |

- CLI は記録をそのまま読む。記録の各行の `cwd` は A のまま残り、B で足した行は `cwd` が B になる（1つの記録に A と B が混ざる）。
  写した `<id>.jsonl` の中には A のパスが26箇所残っていた——仕様どおり、知らせで AI に新しい根を伝える
- 続けたターンの頭に、CLI 自身が「# Environment update / Primary working directory: <B>」の system-reminder を入れていた
  （作業ディレクトリが変わったことは CLI もモデルに伝える）

## 対照（nocopy）——写さなくても通った

**仕様の前提「CLI は今の作業ディレクトリのフォルダから会話 id で探して続く」は、この版では正しくなかった。**
写さずに B で resume すると、CLI は **ほかの作業ディレクトリのフォルダ（A）まで探して** 見つけ、3つとも通った：

| 操作 | 通ったか | 記録はどこに足されたか |
|---|---|---|
| resume | 通る | **A の記録**に足された（B のフォルダはできない） |
| resumeSessionAt | 通る（切れ方も copy と同じ） | A の記録 |
| forkSession | 通る | 分けた先の記録は **B のフォルダ**にできた |
| fork の続き | 通る | — |

つまり同じ `CLAUDE_CONFIG_DIR` を使うかぎり、作業ディレクトリが変わっても写さずに続けられる。ただしこれは
**文書に無い振る舞い**（探す範囲が変わる版が来れば黙って「会話が見つからない」になる）で、続けるたびに元の作業ディレクトリの
フォルダに足していく（元の根が人のフォルダでも、記録は CLI の置き場の中なので人のフォルダは汚れない）。

## 仕様への反映

- 写す形（全 Thread の全 resumePoint の `<id>.jsonl` と `<id>/`）は **そのまま**——写せば、探し方に頼らずに済む
  （元のフォルダが残っているかどうか・CLI の探す範囲に左右されない）
- 仕様の「今の作業ディレクトリのフォルダから探す」は事実と違うので、測った結果に直した
- **人に上げること（規則8）**：写さなくても通る以上、「写す」をやめて CLI の探し方に任せる選択肢もある。仕様では写す形を
  残し、決めるのは人に任せた
