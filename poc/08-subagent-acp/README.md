# 08-subagent-acp — SubAgent の backend を ACP で繋げるか

**問い**（`docs/specs/v4-architecture.md` §4.1「backend の共通口は ACP」の残り）：
Claude Code と OpenCode を ACP（Agent Client Protocol）の同じ口で動かしたとき、
banto が要るもの——能力の名乗り・途中経過・人への確認・使用量・途中停止・再開・
banto の MCP の受け渡し——が揃うか。**Landlock の中で動くか。資格情報をどう渡せるか。**

**捨てる。** 本実装に流れ込ませない（`CLAUDE.md`「PoC のコードは捨てる前提で書く」）。

```
npm install --include=dev
node probe.mjs claude                       # 閉じ込めなし（資格情報は ~/.claude を読む）
node probe.mjs claude --landlock            # banto の導出で閉じ込め、access token だけを env で渡す
node probe.mjs claude --bad-key             # 壊れた API キー——失敗がどう返るか
node probe.mjs opencode                     # 閉じ込めなし（auth.json と設定の写し、個人の MCP は外す）
node probe.mjs opencode --landlock --ask    # 閉じ込め＋permission を ask に
node probe.mjs opencode --landlock --env-key --model opencode-go/qwen3.6-plus
                                            # auth.json を渡さず、鍵は OPENCODE_API_KEY だけ
node landlock-bun-proc.mjs                  # Bun の単体実行ファイルが /proc のどこを要るか
node landlock-proc-scope.mjs                # /proc を許したとき、ドメインの外の environ が読めるか
```

**人の設定・記録に触らない**：Claude は `CLAUDE_CONFIG_DIR`、OpenCode は XDG の置き場を
使い捨てにする。使い捨ての置き場は終わったら消す（OpenCode の `auth.json` の写しを残さない）。

計測環境（2026-09-24）：kernel 6.8.0-137、Landlock ABI 4、
`@agentclientprotocol/claude-agent-acp` 0.81.1（Agent SDK 0.3.280・Claude Code 2.1.280 同梱）、
`opencode-ai` 1.18.32、`@agentclientprotocol/sdk` 1.5.0。

---

## 結論（先に）

1. **ACP の口で、両方とも同じように動く。** 1つの仕事（ファイル一覧→ファイルを書く→banto から
   渡した MCP の tool を呼ぶ）・途中停止・別プロセスでの再開が、同じクライアントのコードで通った
2. **banto の Module を渡すのは `session/new` の `mcpServers` で足りる。** HTTP の MCP を両方とも
   受け取り、呼んだ（呼び名だけ違う：Claude `mcp__banto-probe__probe_ping`／OpenCode `banto-probe_probe_ping`）
3. **Landlock の中で動く——ただし `/proc` の読み取りが要る。** どちらも Bun の単体実行ファイルで、
   `/proc` が読めないと起動した瞬間に `abort()` する（`CPU lacks AVX support` と出るが嘘。
   `/proc/self` を足すと直る）。Claude は ACP の口（node）が CLI を別プロセスで起こすので、
   `/proc/self` だけでは足りず `/proc` 全体が要る
4. **`/proc` を許しても、他のドメインの `environ` は読めない。** Landlock は ptrace 相当の
   読み取りをドメインの外に効かせる——**閉じ込めていないプロセスも、入れ子の親ドメインも
   `Permission denied`**。見えるのは `cmdline` などの ptrace 検査の無いものだけ
5. **渡した資格情報は、そのエージェントのシェルから読める。** Claude の Bash は env から
   トークンを消しているが（0件）、**同じドメインのエージェント本体の `/proc/<pid>/environ`
   から読める**（2プロセス）。OpenCode は消さない（シェルの env に1件、`environ` は4プロセス）。
   **サブエージェントに渡すものは、サブエージェントに読まれてよいものに限る**
6. **サブスクは env で渡せる。** Claude は `CLAUDE_CODE_OAUTH_TOKEN`（`~/.claude` を読ませずに
   通った）、OpenCode Go は `OPENCODE_API_KEY`（`auth.json` 無しで通った）

## 測ったもの

| | Claude Code（claude-agent-acp 0.81.1） | OpenCode 1.18.32 |
|---|---|---|
| `loadSession` | あり | あり |
| MCP の受け取り | `http`・`sse` | `http`・`sse` |
| sessionCapabilities | additionalDirectories・close・delete・fork・list・resume・subagents | close・fork・list・resume |
| authMethods | なし（env か `~/.claude` の資格情報を黙って使う） | `opencode-login` |
| session/new の設定項目 | `mode`（default/acceptEdits/plan/auto/bypassPermissions）・`model`（5件）・`effort`（`thought_level`）・`fast`（API キーのときだけ現れる） | `model`（427件／env の鍵だけなら108件——**候補は渡した資格情報で変わる**）・`mode`（build） |
| 既定のモデル | `default` | `opencode/big-pickle`——**人の設定の `model` を使わなかった**（→ banto が毎回明示する） |
| 仕事 | 通った（`hi` を書き、`PONG-7F3A` を受け取った） | 通った |
| 人への確認（`request_permission`） | default モードで Write と MCP の tool に来た（ls には来ない） | permission の設定どおり（allow なら0件、ask なら bash の ls も含めて全部） |
| 確認の選択肢 | `allow_once`・`allow_always`・`reject_once` | 同じ |
| 使用量（`PromptResponse.usage`） | input・output・cachedRead・cachedWrite | input・output・cachedRead・thought |
| `usage_update` | used・size（200000）・cost（$0.027〜0.036） | used・size（200000／1000000）・cost（無料モデルは $0） |
| 途中停止（`session/cancel`） | `cancelled`、15ms | `cancelled`、86〜119ms |
| 別プロセスで再開（`session/load`） | 履歴を再生し、`hi` と答えた | 同じ |
| Landlock の中 | 通った（`/proc` 読み取り・本体の置き場の実行が要る） | 通った（同じ） |
| 閉じ込めの中から `~/.claude` | `Permission denied` | `Permission denied` |
| シェルの env に秘密 | 0（消している） | 1（消さない） |
| 秘密が `environ` から読めるプロセス | 2 | 4 |
| 壊れた API キー | `authentication_failed` の JSON-RPC エラー——**ただし返るまで186秒**（再試行している） | 未計測 |

### 途中停止の測り方で踏んだもの

- 最初は `sleep 45` を頼んでいたが、Claude Code が長い `sleep` を断ることがある（「システムが
  長い sleep コマンドをブロックしている」）。`for i in $(seq 1 45); do sleep 1; done` にした
- 待ちのループが、仕事の結果に入れた配列と**同じ配列**を比べていたので、新しい tool 呼び出しを
  永遠に見つけられなかった（30秒待ってから停止を送っていた）

### Landlock で要ったもの（`probe.mjs` の `confine()`）

banto の `deriveProjectRuleset`（profile `exec`、根＝作業場所、Module の置き場＝使い捨てのホーム）
に、次の2つを足した：

- **エージェント本体の置き場に実行**（node_modules の中のネイティブ実行ファイル）
- **`/proc` の読み取り**（上の結論3・4）

`HOME`・`TMPDIR`・XDG は使い捨てのホームに向けた。人の `~/.claude`・`~/.config` は読めない。

## 決めていないこと（ここでは決められない）

- **Claude のサブスクの資格情報を、どの形で渡すか。** 通ったのは「env にトークン」だが、
  その中身が2通りある——① host がいまの access token だけを渡す（寿命は数時間、refresh token は
  渡さない。host に新しい口が要る）② 人が `claude setup-token` で作った長命のトークンを Vault に
  置き、API キーと同じ形で渡す（仕組みは増えないが、1年もののトークンがサブエージェントの
  シェルから読める）。**人に上げる**
- 認証の失敗が186秒かかる件を縮められるか

## 待つ形で何分まで待てるか（CLI 本体を読んだ。未実測）

同梱の Claude Code（2.1.280）の MCP クライアントには、**tool 呼び出しの上限が2つ**ある：

| | 値 | 進捗で延びるか |
|---|---|---|
| 全体の上限 | サーバごとの `timeout` → `MCP_TOOL_TIMEOUT` → 既定 **1e8 ms（約28時間）** | 延びない |
| 無音の上限（idle） | `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` → 既定 **stdio 30分／http 5分**（`sdk` 型は無し） | **延びる**（「no response or progress for …」で切る） |

→ **進捗を10秒ごとに送る Shell と同じ手当てで、数十分の仕事も待てる。**
banto の中継（`relay/agent-proxy.ts`）も `resetTimeoutOnProgress` で進捗を通す。

もう1つ、**長い MCP 呼び出しを CLI が勝手に背景へ回す仕組み**がある
（`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`、既定120秒）。ただし**非対話（SDK）では
`CLAUDE_AUTO_BACKGROUND_TASKS` を立てない限り切れている**——banto の Runner は SDK なので、
待つ形はそのまま待つ。**待たない形を作るときに、これが使えるかを見る**（自前で作る前に）
