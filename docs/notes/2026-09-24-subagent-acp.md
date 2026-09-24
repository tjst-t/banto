# SubAgent の仕組み——ACP で繋ぐ（2026-09-24〜）

## 頼まれたこと

「SubAgent の仕組みを作りたい。MCP にしてプラガブルにしたい。Claude だけでなく OpenCode や
Codex なども使えるようにしたい。まず実装方針を」。

## 出発点

- 仕様 §4.1：サブエージェントの実行は Subagent Module の持ち物。core は「頼んだ」と「結果の転記」
  だけを知る。backend の差は Module の中に閉じる。**backend の口の具体形が未決**（§10 item 1、最優先）
- 2026-08-30 の実測（`poc/03-item1-backend-interface/`、`opencode run --format json`）：
  streaming・割り込み・文脈の内訳が無かった

## 方針（ユーザーと決めた、2026-09-24）

| 論点 | 決めたこと |
|---|---|
| backend の口 | **ACP（Agent Client Protocol）**。Subagent Module は MCP サーバ＋ACP クライアント |
| サブエージェントの道具 | エージェント自身の tool を **Landlock の中で**。banto の Module は追加で渡す |
| 最初に繋ぐもの | **Claude Code と OpenCode**（Codex はこの2つが通ってから——いま手元に無い） |
| 認証 | **サブスクで使えるものはサブスク、API キーでも使える**（エージェントごとに違う） |
| 待つか | **最初は待つ形**。待たない形は core の「Thread に届ける」口と一緒に後で |

## なぜ ACP か（規則12）

「複数のコーディングエージェントを1つの口で動かす」は解かれている。ACP は Zed が始めたもので、
2026-09-24 時点で Claude（Zed のアダプタ `claude-agent-acp`、Agent SDK の上に載る）・Codex
（`codex-acp`）・OpenCode（`opencode acp`）・Gemini CLI ほか40以上が対応している。

§4.1 の7項目が ACP の口にそのまま載る（`session/update`・`session/cancel`・`session/load`・
`tool_call`・`session/request_permission`）。持っているかは `initialize` で名乗り合う——§4.1 が
決めた「無いものは無いと明示する」が仕様の形のまま手に入る。さらに `session/new` で MCP サーバを
渡せるので、banto の Module をサブエージェントにも使わせられる。

### 却下した案

- **ベンダごとに専用の橋を書く**（Agent SDK・`codex exec --json`・`opencode run`）——3本それぞれの
  癖を抱える。8月の実測で `opencode run` は streaming も割り込みも無かった
- **Claude 自身のサブエージェント（Task tool）**——Claude でしか動かない。banto の Runner は組み込み
  tool を絞っていて、そもそも使えない
- **サブエージェントの道具を banto の Module だけにする**（ACP のファイル・端末の委譲で banto に
  回させる）——どのエージェントも従うとは限らない。強制できるのは Landlock

## 測ったこと（方針を出す前）

- **MCP の非同期の仕組み（Tasks）は使えない**：Claude Code 2.1.281 がクライアントとして名乗る能力は
  `roots`・`elicitation` だけ（2026-09-24、MCP サーバで initialize を受けて確認）。長い仕事の
  「終わった」は banto が自分で届けるしかない
