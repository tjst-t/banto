# 起こし直しをまたいで続ける——今の作りと実測（2026-10-04）

Backlog のストーリー resume-across-restart の検討。Fork「起こし直しをまたいで続ける」。

## 今の作り（コードを読んで分かったこと。起こし直しの実地では未確認）

- **途中だったターン**：人の発言（と積んだ届いたもの）は記録に残る。AI の返事は記録されず、resume-point も更新されない
  （`turn-runner.ts`——resume-point と返事はターンの最後に1回だけ書く）。「ターンが始まった」は Event Store に残らない
  （`ThreadTurns` はメモリだけ）ので、起き直した host は走っていたターンがあったことを知らない。新しい会話の最初の
  ターンは session id（`system/init` で分かる）も残らない
- **返事待ちの札**（runInBackground のサブエージェント等）：起動時に `deliverLostReply` が「途中で終わりました」を
  届け、AI が起きる（`cli.ts`）
- **判断待ち**：起動時に `expireOrphanedJudgments` が期限切れにする
- **Subagent**：走っている仕事の記録（`RunLog.running`）はメモリだけ。終わったものだけ `runs.jsonl`。ACP の `session/load`
  で続きから頼む口（`sessionId`）はもうある
- **起こす仕組み**：起動後に `deliveries.resumeAll()` が、届いていて起こしていない Thread のターンを回す。ここに
  「途中で切れました」を届ければ続きのターンを始められる
- **Factory の仕様の前提**（v4-modules.md §4.5「記録と再開」）：「Factory が起き直しても Subagent は走り続けている」。
  host を起こし直すと両方止まるので、この前提は host の起こし直しでは成り立たない

## 実測（2026-10-04、プローブ `.worktrees/resume-probe/banto/probes/`。偽の Anthropic API で、本物のモデルは使っていない）

本物のモデルを使わなかった理由：サブエージェントの Bash には `CLAUDE_CODE_OAUTH_TOKEN` が渡らない（CLI が外す）。
API に送られた要求の中身（＝モデルが見るもの）を記録した。

### Agent SDK（query、0.3.281＝CLI 2.1.281。banto core と同じ版）

| ケース | 結果 |
|---|---|
| Bash の tool の途中で kill → `resume` | 成功。CLI が切れた tool_use に `tool_result(is_error)`「[Tool call interrupted: … outcome is unknown. Check whether it took effect …]」と、合成の assistant「No response requested.」を足してから新しい発言を続ける |
| 文を流している途中で kill → `resume` | 成功。流れていた途中の文は CLI の記録にも API の要求にも残らない |
| `resumeSessionAt`＝前のターンの最後の assistant の uuid | 切れたターンを丸ごと落としてきれいに続く。切れたターンの人の発言の uuid を渡すと、古い発言と新しい発言が1つにまとまる（使わない） |
| 新しい会話の最初のターンを途中で kill → `system/init` の session id で `resume` | 成功（記録ファイルは API に送る前に書かれる） |
| `system/init` を受けた直後に kill | 失敗「No conversation found with session ID」（記録ファイルが無い）。`options.sessionId` で id を先に決められる |
| SIGTERM と SIGKILL | 会話の連なりは同じ |
| http の MCP の tool の途中で kill | Bash と同じ |

**CLI の版で切れた tool の扱いが変わる**：同じ記録を CLI 2.1.280（claude-agent-acp に同梱）で resume すると、合成の
tool_result を作らず、切れた tool_use を黙って落とす（呼んだ痕跡が残らない）。→ 切れた tool のことは CLI に任せず、
banto が自分で再開の文に書く。

Bash の子は CLI と別のプロセスグループにいる——CLI のグループだけに SIGKILL すると sleep が生き残った。systemd が
cgroup ごと止めるなら問題ない。

### ACP（サブエージェント）

| | claude-agent-acp 0.81.1 | opencode 1.18.32 |
|---|---|---|
| tool の途中で kill → 新しいプロセスで `session/load` → `session/prompt` | 成功。切れた tool_use は黙って落とされる（2.1.280 の動き） | 成功。`tool_result(is_error)`「[Tool execution was interrupted]」を合成 |
| 再生される履歴の切れた tool_call | `pending` のまま | `in_progress` のまま |
| `session/new` の直後（最初の prompt の前）に kill | `session/load` が「Resource not found」 | load できる |

### 確かめていないこと

- 本物のモデルが、合成の tool_result や banto の「途中で切れました」の文をどう受け取るか
- 稼働中と同じ形（systemd の起こし直し・Project のコンテナの中の Module）での通し
