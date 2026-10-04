# Backlog の正本を専用のブランチに移す（2026-10-04）

仕様は `docs/specs/v4-modules.md` §4.4「置き場——専用のブランチ」と §2.4「ブランチを送る口」、
`docs/specs/v4-security.md` の表（`relayCallerProject`）。ここは経緯・却下した案・実装で決めたこと・踏んだこと。

## 何が困っていたか

一覧（`docs/tasks.json`、形 `banto-backlog/1`）は Project の根の作業ツリーにあった。Backlog Module は作業ツリーの
ファイルを一時ファイル → rename で書き換えるだけで、コミットは誰もしない。

- 共有の作業ツリー（root）は複数の Thread が同時に使う。Backlog が書いた変更は root の未コミットの変更として残り、
  **他の Thread のコミットに混ざる**か、`git stash`・`git reset` で**消える**
- worktree で作業する Thread から見ると、正本は root の作業ツリー（別のファイル）。worktree の `docs/tasks.json` は
  ブランチを切った時点の写しで、**どれが正本か分からなくなる**
- 別のブランチを checkout すると、その時点の `docs/tasks.json` に**黙って正本が替わる**
- 取り込み（merge・rebase）のたびに `docs/tasks.json` がぶつかる

## 決めたこと（ユーザー、2026-10-04）

案B：**コードとつながらない専用のブランチ**（既定 `backlog`、orphan、中は tasks.json 1つ）。Module は作業ツリーも index も
使わず、低レベルのコマンド（`hash-object` → `mktree` → `commit-tree` → `update-ref <新> <古>`）で1件1コミットを積む。
push は Module が変更のたびに試み、失敗しても書き込みは止めない。資格情報は Repositories に頼む。読むときは origin が先なら
取り込み、食い違ったら書かない。ブランチが無ければ空、作業ツリーに一覧が残っていれば移す道を案内する（自動では移さない）。
設定は「ブランチ名」。先例は **git-bug**（課題をコードと別の ref に積む）。

## 却下した案

- **案A：root の作業ツリーで、既定ブランチにだけ書き、Module が tasks.json だけをコミットする**
  - root の作業ツリーと index を、人や他の Thread と取り合う（Module が `git add`・`git commit` する瞬間に、人が別の
    ファイルを stage していればそれも入る。index のロックで互いに失敗する）
  - 別のブランチを checkout すると、黙って正本が替わる（いまと同じ穴が残る）
  - 未コミットの変更（Module が書いてからコミットするまでの間・コミットに失敗したもの）が他人のコミットに混ざるか、
    stash・reset で消える
- **案C：git の外（banto のデータ置き場・DB）に置く**
  - 履歴が残らない（誰がいつ何を変えたかを git で追えない）
  - clone へ運べない（別の機械・別の人の手元で同じ一覧を見られない）

## 実装で決めたこと（ユーザーの決定の外で、実装者が詰めた）

- **compare-and-swap に失敗したら読み直してやり直す回数は5回**。`update-ref` の失敗のうち `cannot lock ref`（先を越された・
  ロックの取り合い）だけをやり直しの合図にし、ほかは理由つきで止める
- **土台は読んだ中身のコミット**——読み直しのあとで ref をもう一度読まない（読み直すと、中身と親が食い違いうる）
- **送るのは書く列の外**で、送る操作どうしは別の列。送るのはその時点の ref なので、先に並んだ書き込みの分もまとめて送られる
- **「まだ送っていない」は ref から導く**（手元のブランチが `refs/remotes/origin/<b>` より先にあるコミットの数）。覚えるのは
  最後に送った・取ってきたときの失敗の理由だけ（規則3）。push が成功すると git が追跡の ref も進めるので、数は0に戻る
- **fetch は書く前と画面を開いたとき**（`getBoard` の `fetch: true`）。画面の3秒ごとの読み直しと `listItems` では取ってこない
- **origin が無いリポジトリでは送らない**し「送っていない」とも言わない（送る先が無いのは状態であって失敗ではない）
- **画面に出す取ってこれなかった理由は、送れなかった理由と同じなら重ねない**（同じ origin に届かないだけ——実ブラウザで
  同じ文が2回並んだので直した）
- **移すスクリプト**は中身のバイトを変えない（読めることだけ確かめる）。ブランチが既にあれば断る（上書きしない）。
  元のファイルは消さない。`--push` を付ければ1回で送るところまで
- 作業ツリーに残った一覧を探す場所は `docs/tasks.json` だけ（以前の設定 `path` は読まない——設定は「ブランチ名」に替えた）

## Repositories に足した口と、core に足した中継の口

- Repositories に `push_branch`・`fetch_branch`（可視性 `module`）。**リポジトリは引数で受けない**——呼び出し元の Project の
  根で決める。Backlog は Project のコンテナの中で動き、中の AI は root で中継の合言葉も読める。リポジトリを名乗らせると、
  AI が人の GitHub のトークンで別のリポジトリへ push できる
- そのために Repositories は「いまの呼び出しはどの Project のためか・その根はどこか」を host に聞く必要がある。既存の
  `relayListProjects` は**人の画面からの呼び出しの間だけ**（AI のターンから引けると別の Project の地図になる）なので、
  AI のターンから Backlog が書いたときには使えなかった。**core の中継に `relayCallerProject` を足した**——いま処理している
  呼び出しの Project 1件だけ（ほかの Project は出ない）を、host の台帳（`ModuleCallTracker.projectFor`）で決めて返す。
  引けるのは banto 本体で動く同梱の banto 全体の Module だけ。指示の範囲（「呼び出し元の Project の root がそのリポジトリで
  あることを確かめる」）では避けられないので足した
- 承認は中継のゲートに任せる（`branch` を `auditArgs` で名乗る——コンテナからの頼みはブランチごとに初回だけ人に聞く）。
  `valueFree` にはしなかった：返り値に秘密は無いが、資格情報で外へ書く口で、AI が任意のブランチ名で頼める
- `Publisher` の資格情報の用意（一度きりの窓口か ssh-agent）を `gitCredentialFor` として外に出し、両方から使う
- origin の URL の確かめは**文字列の一致でなく、読んだ場所（owner/name）と方式・host の一致**で見る——この機械の banto の
  origin は `https://github.com/tjst-t/banto`（`.git` なし）で、公開と同じ「組んだ URL と完全一致」だと通らない
- 送り先を変える設定の検査は **origin を読む前**に。`url.*.insteadOf` があると origin の読み方そのものが変わり（GitHub の外と
  読まれ）、「引き受けない」に化けた（単体で見つけた）

## 踏んだこと

- **root の `banto/node_modules` が古い**（`@simplewebauthn/server` が無く core が build できない）。同じコミットの別の
  worktree（`stale-judgments`）の node_modules を `cp -al` で写して使った。root の node_modules は直していない（スコープ外）
- `execFile` の失敗で stderr が空のとき `err.message`（"Command failed: …"）を stderr の代わりに入れていたので、
  `rev-parse --verify -q` の「無い」（黙って 1）が「読めない」に化けた。stderr は git が言ったものだけにした
- `git push --porcelain` の断られた ref の行（`!`）を「見せる文言から外す行」に入れていて、non-fast-forward の理由が消えていた
- **フル E2E で落ちたもの**（どれもこの変更の外と見分けた）：
  - `inbox.spec`（バッジが「1」でなく「2」）——spec 1–26 の組の中でだけ落ちる。単独・`backlog.spec` の直後では通る。
    **変更なしの main（58db2f81）でも spec 1–19 の並びで同じ形で落ちた**——先の spec が受信箱に1件残す、既存の順序の依存
  - `oauth-remote-mcp.spec` の「ログイン前は繋がらない」（`fetch failed`——偽の OAuth サーバに届かない）——**このブランチで
    3回中1回**（spec 27–39 の組の中）。単独・spec 27–35 の並びでは通り、main でも同じ並びで通った（1回中0回）。この変更は
    リモートの MCP の経路を通らない。間欠の原因は追っていない（規則6——記録だけ残す）
  - `module-settings-canvas.spec` の Vault の置き場——この機械では構造的に通らない既知の失敗（開発用 Infisical に届かない）

## 試験

- 単体（Backlog 39件）：orphan の作成・1件1コミット・列の直列化・compare-and-swap の競合（読んだ直後に別の書き手が進める
  → やり直して両方入る。列を共有しない2つの店が同時に書く）・作業ツリーと index に触らない（`git status`・index のバイト・
  HEAD が変わらない）・別ブランチを checkout していても・worktree からでも同じ一覧・送れなくても書き込みは止めず未 push と
  理由が出る・戻ればまとめて送る・origin が先なら取り込む・食い違いは書かない・読めない中身は書かない・移すスクリプト
- 単体（Repositories 101件、うち新しい口5件）・core の中継（`relayCallerProject`）
- E2E（`backlog.spec.ts` 4本）：一時の bare リポジトリを origin にし、画面が案内した移すコマンドをそのまま走らせて移す →
  操作ごとのコミットの件名・orphan・作者・origin に送られている・作業ツリーに触っていない。AI のターンから書くと中継の承認
  （fetch_branch・push_branch）が出て、答えると書けて送られる。送れないときの「送っていない」と理由、戻れば消える、origin が
  先なら開いたときに取り込む、設定のブランチ名で別の一覧（orphan）、古い形の中身
