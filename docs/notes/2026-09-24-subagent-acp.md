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

## PoC の結果（2026-09-24、`poc/08-subagent-acp/`）

数字と表は PoC の README。ここには**決め方に効いたこと**と、**途中で間違えたこと**を残す。

### 決め方に効いたこと

- **ACP の口で、Claude Code と OpenCode が同じクライアントのコードで通った**——仕事・途中停止
  （`cancelled`、0.1秒以内）・別プロセスでの再開（`session/load`）。8月に `opencode run` で
  「無い」とした streaming と割り込みは、ACP の口では両方ある。§4.1 の古い表は ACP の表に差し替えた
- **Landlock の中で、どちらも `/proc` が無いと起動しない**（Bun の単体実行ファイル）。9月10日に
  「`/proc` は許可しない」と決めた理由（同じドメインの子が Module の `environ` を読める）が
  サブエージェントにも当たるかを測った——**Landlock は ptrace 相当の読み取りをドメインの外に効かせる**
  ので、**入れ子のドメインで起こせば当たらない**。例外をこのドメインにだけ置いた
- **渡した資格情報は、サブエージェントのシェルから読める。** Claude Code の Bash は env から
  トークンを消しているのに、`/proc/<pid>/environ` から読めた（`/proc` を許したので）。OpenCode は
  そもそも消さない。**「渡すものを絞る」しか手が無い**——これが「Claude のサブスクで何を渡すか」を
  人に上げる理由になった
- **OpenCode は人の設定の `model` を使わなかった**（`opencode/big-pickle` になった）。
  banto が毎回明示する
- **Claude Code の MCP クライアントの上限**を CLI 本体から読んだ：全体は約28時間、無音は stdio 30分／
  http 5分で**進捗で延びる**。待つ形は Shell と同じ手当てで足りる。ついでに、**長い MCP 呼び出しを
  CLI が背景に回す仕組み**（非対話では既定で切れている）があるのを見つけた——待たない形の前に見る

### 決めたが、別の道もあったもの

- **エージェント自身の確認の出し方を main の Runner と揃える**（Claude は `auto`）。全部を
  `bypassPermissions` にする案もあった——Landlock が強制層なので安全面は同じだが、main と
  サブで挙動が違うと、人が「どこで聞かれるか」を覚え直すことになる
- **1回の呼び出し＝プロセス1つ**。常駐させる案もあった——常駐は起動の1〜2秒を省けるが、
  モデル・資格情報の差し替えのたびに作り直しが要り、§2.3 のモデルB と同じ理由で採らない

### 途中で間違えたこと

- 途中停止の測定が2回無効だった。①`sleep 45` を Claude Code が断ることがあった（長い sleep を
  ブロックする）。②待ちのループが、仕事の結果に入れた配列と**同じ配列**を比べていたので、
  新しい tool 呼び出しを永遠に見つけられなかった（30秒待ってから停止を送り、「止まらない」ように
  見えていた）。**自分の測り方を先に疑う**
- Claude を閉じ込めたとき `/proc/self` だけ足して直したつもりになった——Claude は node が CLI を
  別プロセスで起こすので、self が違う。単体の `--version` で通ったものが、ACP 越しでは通らなかった
