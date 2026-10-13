# Factory の実装役が ACP の EPIPE で落ちる（Backlog #284）

## 何が起きていたか

同じ形で3回落ちた（10-05 09:17・10-10 15:53・10-13 07:33）。Subagent の記録（`runs.jsonl`）の失敗の文は毎回
「エージェントが終了しました（code=1）。stderr: … [session/create] … phase=register … Error: write EPIPE … utils.js:46」。

## 突き止めた順

1. **書いていたのは claude-agent-acp の stdout**（`utils.js:46` は `nodeToWebWritable(process.stdout)`——`acp-agent.js` で
   唯一の呼び元）。読み手は Subagent Module。動いているエージェントで、stdout のソケットの相手を持つのは Module だけだと
   確かめた（`/proc/*/fd`）。Module は3回とも生きていた（失敗を記録したのは同じプロセス）——**Module 自身が読み口を閉じた**
2. **`[session/create]` の行は手がかりではなかった**——起動直後（totalMs≈500）の行で、そのあと stderr に何も出ていなかった
   だけ。「新しいセッションを作るときに起きる」という見立ては外れ
3. **エージェントの会話の記録**（専用ホームの `.claude/projects/<cwd>/<sessionId>.jsonl`）の末尾が3回とも同じ：
   `api_error 401 "OAuth access token has expired"` → 合成の assistant「Failed to authenticate. API Error: 401 …」
4. 本物の claude-agent-acp を、401 を返す偽の上流に向けて `runSubagent` で走らせた（プローブ）：stderr の末尾が本番と
   同じ形になり、`session/prompt` が `Internal error: Failed to authenticate … {"errorKind":"authentication_failed"}` で断られた

つまり：**本体の Claude ログインのトークンが仕事の途中で切れた → claude-agent-acp が頼みを断る → ACP の SDK の
`connectWith` が接続を閉じ、Module の読み口（child.stdout）が閉じる → claude-agent-acp が断ったあとに書いた1行で
EPIPE（'error' を聞いていないので落ちる） → Module は接続が閉じた理由を伝える前に終了を最大1秒待っていたので、
「終了しました（EPIPE）」が本当の理由を上書きしていた**。EPIPE は結果であって原因ではない。

偽のエージェントで同じ形を作り（`[login-expired-once]`）、直す前のコードで本番と同じ「終了しました（code=1）… write EPIPE」
になることを確かめてから直した。

## 直したこと

- `acp-run.ts`：断られた理由がログイン切れなら `LoginExpiredError`（会話の id つき）。ほかの理由でも、エージェントが理由を
  添えて断ったら終了を待たずにそれを伝える
- `server.ts`：ログイン切れなら 30秒・2分・5分と待ちながら同じ会話を `session/load` して続ける。尽きたら会話の id を添えて失敗
- Factory（`engine.ts`）：実装役の段が失敗したら、未コミットの変更を `wip:` でコミットしてから止まる

## 選ばなかったもの

- **claude-agent-acp に EPIPE を握らせるパッチ・版上げ**：落ちること自体は害が無い（断ったあとなので、続ける仕事は無い）。
  直すべきは「理由が隠れること」と「続けられないこと」だった
- **トークンを core の中継が自分で更新する**（refresh token を使う）：原因を根から断つのはこれだが、本体のログインの
  更新の仕方（本体の CLI が持つ）に踏み込む——このタスクの外（規則7）。人に上げる：
  **本体の CLI がしばらく使われないと、サブエージェントだけが動いている間にトークンが切れたまま戻らない**。
  そのとき Subagent の待ち（合計 7.5 分）は尽きて失敗を返す。受信箱の「期限切れ」の知らせで人が更新する前提
- **待ちを長く・回数を多く**：戻る見込みは本体の CLI が使われるかどうかで、待ちの長さでは決まらない。尽きたら会話の id を
  返すので、人が更新してから頼み直せば同じ会話の続きから始まる

## 試験の環境のこと（このタスクと別）

この worktree の `node_modules`（main の作業ツリーから `cp -al`）に `ws`・`@types/ws` と、`@banto/stream-server`・
`stream-client`・`module-browser`・`module-terminal` の link が無く、`npm run build` が stream-server で止まった。main の
作業ツリーの `node_modules` が package-lock より古い。この worktree にだけ足して通した（main のは触っていない）。
