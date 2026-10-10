# Terminal の Module を作ったときの記録（2026-10-08）

Backlog #238（terminal-module-impl）。仕様は v4-modules.md §4.6、流れの口はアーキ §5.8。ここには測ったこと・仕様の
未決を実装で決めたこと・選ばなかった案を残す。

## tmux との繋ぎ方：制御モードで足りた

仕様は「まず制御モード（`tmux -C`）を試し、合わなければ pty」だった。小さなプローブ（node から `tmux -L … -C
attach-session` を起こして標準入出力で話す、30 秒）で測った：

- `send-keys -H e3 81 82 …`（UTF-8 のバイトを1つずつ）で日本語がそのまま届く。`refresh-client -C 100x30` で大きさが変わる
- `%output` の中身は空白より小さい文字と `\` だけが `\ooo` になる。UTF-8 は生のまま
- `capture-pane -p -e` は履歴＋ペインの高さぶんの行（末尾の空行も含む）を返す
- **`;` で並べた1行のコマンドは、返事がコマンドごとに `%begin`/`%end` の1組ずつ返り、間に通知（`%output` など）が
  挟まらない**——写しを取る1行の返事より前の出力は写しに入っていると言える。これで写しと続きの継ぎ目が決まった
- **`window-size latest` の「最後」は、制御モードの client が `send-keys` しても動かない**。最後に繋いだ client が
  最後のまま。`switch-client -t <同じセッション>` で最後になり、次の `refresh-client -C` で大きさが効く
  → 打つ前に、別の流れが最後なら `switch-client` と `refresh-client` を足す（仕様の「最後に打った方」をこれで作る）
- tmux のサーバは、起こした `incus exec` の client を SIGKILL しても残る（使い捨てのコンテナで測った）——Module・banto を
  起こし直してもセッションが残ることの下地。E2E（`terminal.spec.ts` の起こし直し）でも確かめる

pty（`script` や node-pty）は使わない。制御モードだと tmux のキー操作（prefix）と状態の行は使えないが、セッションの
切り替えは画面が持つので要らない。

## 試験が教えたこと

- 単体試験が 8 回中 2 回落ちた（規則6）。`kill-server` の直後の `list-sessions` が「server exited unexpectedly」で失敗して
  いた——終わりかけのサーバに繋いだとき。本番でも最後のセッションが閉じた直後に起きうるので、「サーバが居ない」として
  扱うよう直した。直した後 20 回中 0 回

## 実装で決めたこと（仕様に書いた）

- **専用のホームは Terminal の置き場の `home`**。仕様は「Shell 専用のホーム」と書いていたが、Shell の置き場のホームを
  そのまま使うと、Shell がまだ起きていない（置き場がコンテナにマウントされていない）ときに無い。形（host が人の選んだ
  設定だけを写す）を揃え、置き場は分けた。写すのは同梱の Terminal だけ（`terminal` は予約された役割ではないので
  origin で見る）。**人に確かめたい点**：Shell と同じホーム（git の設定・npm のキャッシュの共有）にしたいなら、
  Shell の置き場を指す形に変える
- **tmux が無いコンテナ**（ベースのイメージに足す前に作ったもの）では、最初に使うときに `sudo apt-get install tmux`
  で入れる。中は誰でもパスワード無しで sudo できる（ベースのイメージの決めごと）。入れたことは記録に書き、
  入れられなければ理由ごと断る。選ばなかった案：画面に「tmux を入れてください」と出す——稼働中の banto の
  Project のコンテナは全部これに当たり、人に1つずつ打たせることになる
- **消えたセッションの控え**：名前と最後に見た作業ディレクトリだけを置き場の `sessions.json` に持つ（生きているかの
  真実は tmux）。シェルを `exit` したものも「前にあったセッション」に出る——コンテナの起こし直しと見分ける手段
  （起こし直しの印）を足すほどの違いが無いので、同じく「作り直す」「控えから消す」を出す
- **お知らせ（AI も読めます）を一度だけ**：閉じたことをサンドボックスのオリジンの localStorage に覚える。
  人の設定として持つほどのものではない
- コピー・貼り付けは `permissions` の申告なしで足りた（v4-modules.md §4.6 に書いた）

## 人のシェルを仕事の組に入れるか（2026-10-10）

main に仕事の組（v4-security.md §1 段2a、`inWorkScope`・`banto-work-jobs.slice`）が入ったので決めた。**入れる。ただし
oom.group は付けない。**

- 理由：§1「資源の逼迫を見せる・共倒れさせない」は、仕事がメモリを食い尽くしても Module を巻き込まないためのもの。人が
  ターミナルで打つビルド・テストは、AI が Shell で打つものと資源の使い方が同じで、Module の取り分を食う側にある。組に
  入れないと、コンテナの天井に当たったときに Module（この Terminal も含む）と同じ値で止められる
- 入れ方：`createSession` の `tmux new-session` を `inWorkScope(…, { kind: "terminal", oomGroup: false })` で起こす。
  tmux のサーバはこの呼び出しで生まれて自分で切り離すので、サーバとその下の全部のシェルが1つの scope
  （`banto-terminal-<乱数>.scope`）に入り、oom_score_adj +500 を受け継ぐ。サーバが前から居れば、scope に入るのは
  すぐ終わる client だけ
- **oom.group を付けない理由**：scope の中にはサーバと人のセッションが全部入る。丸ごと止めると、1つのセッションで打った
  ビルドのせいで別のセッションのシェルまで全部消える——人のセッションどうしの共倒れになる。付けなければカーネルが
  一番大きいもの（たいてい食い尽くしたコマンド）を止める。`inWorkScope` に `oomGroup: false` を足した（既定は今どおり true）
- 選ばなかった案：
  - Service の組（`banto-work-services.slice`、一段守る）——Service は人が「動かし続ける」と決めたもので、ターミナルで
    打つ一時のコマンドとは違う。人のシェルを Service より守る理由が無い
  - 組に入れない——上の理由で Module と共倒れになる
- **実測（このコンテナ、2026-10-10）**：シェルは `banto-work-jobs.slice` の下に居て oom_score_adj 500・oom.group 0。ただし
  居場所は `banto-terminal-*.scope` ではなく `tmux-spawn-<uuid>.scope`——tmux（3.4）はユーザーの systemd があると、ペインごとに
  自分で scope を作ってサーバと同じ slice に置く。サーバの slice が効くので組に入ることは変わらず、ペインごとに分かれるので
  oom.group を付けても止まるのはペイン1つだった（それでも付けない形にしたのは、tmux のこの動きに頼らないため）
- 資源の画面の内訳では「コマンド」の組に「ターミナル」として出す（`resources.ts` の `unitServiceName` で `banto-terminal-*` と
  `tmux-spawn-*` の scope。「コマンド」と同じく scope ごとに1行）
- 残ること：AI が Shell から `tmux -L banto-terminal new-session` で**先に**サーバを起こすと、サーバは Shell の scope
  （oom.group あり）に入る。人のセッションも道連れで丸ごと止まりうるが、起きるのは AI がわざわざサーバを起こしたときだけ
  なので、塞がない
- 入れ子のコンテナ（E2E）では組に入れられない（`inWorkScope` が試して諦め、そのまま起こす）ので、E2E はこの経路を
  通らない。
- **稼働中の banto の Project のコンテナで確かめた（2026-10-10）**：Factory の作業場所（稼働中の banto の Project のコンテナ、
  入れ子でない・Ubuntu 24.04・tmux 3.4）で、この版の Terminal の部品（`Terminal`・`terminalStreamHandler`・
  `@banto/stream-server` の口）を通し、流れに `echo "real-$((6*7))"` を打って `real-42` が返り、ホームは専用のホーム。
  tmux のサーバは `banto-work-jobs.slice/banto-terminal-<乱数>.scope`、シェルは `banto-work-jobs.slice/tmux-spawn-<uuid>.scope`
  で、どちらも oom_score_adj 500・oom.group 0。
  **まだ確かめていないこと**：稼働中の banto そのものへの反映（release に載せて更新し、画面の入口から開いて打つ）。
  反映は release ブランチと更新の段（`scripts/update.mjs`）を通るので、push しない約束の作業場所からはできない
  ——main に入ったあと、人が更新して入口から打って確かめる

## 走り直しで踏んだもの（2026-10-10）

- main へ rebase した後の E2E で、画面が「繋いでいます…」のまま止まった。trace の pageError：`Cannot access 'opened' before
  initialization`——`openStream` が中で `onState("connecting")` を同じ流れのまま呼び、その中で `const opened` を読んでいた（TDZ）。
  宣言を先にして直した。画面の例外は Canvas の入れ子の iframe の中なので host のログには出ず、trace の pageError で見つけた

## レビューの指摘で直したもの（2026-10-10）

- **写しと続きの継ぎ目で出力が落ちていた**。tmux の stdout の1チャンクに写しの最後の返事の `%end` と続く `%output` が
  一緒に入ると、`onData` のループは同期で `%output` まで読むが、`syncing = false` は `%end` の Promise が解決した後の
  マイクロタスク——その `%output` は捨てられていた。前の節の「`;` の1行の間に通知が挟まらない」は正しかったが、
  境目を Promise の解決で決めたので、tmux の側の保証を Module の中で崩していた。
  直し方：`TmuxControlClient.run` に `onReplied`（最後の `%end` を読んだその場で同期で呼ぶ）を足し、そこから写しを送り
  終えるまでの出力は溜めて写しの後に流す。選ばなかった案：`onLine` で残りの行を次のマクロタスクへ回す——client の
  読み方が流れ1本の都合に引きずられ、ほかの返事の待ちまで遅れる。
  測り：連番を速く流すペインに 30 回繋ぐ（`terminal.test.ts` の継ぎ目の試験、`BANTO_TERMINAL_SEAM_ROUNDS=30`）。
  直す前の作り（溜めない）に戻すと落ち、直した後は 30 回中 0 回
- **閉じる理由が 123 バイトを越えて `ws.close` が投げていた**。名前は 40 字までなので日本語 28 字前後から越える。
  無いセッション・使えない名前では流れが閉じられずに残り（画面は「繋いでいます…」のまま）、開いている間に閉じたときは
  onExit の非同期の中で受け口の無い reject になり Module ごと落ちた。閉じる口を `closeStream`（文字の境目で 123 バイトに
  切る・それでも投げたら理由なしで閉じる）1つにし、onExit の非同期にも受け口を付けた。試験：日本語 31 字・41 字の名前
  （直す前の作りでは試験が終わらない——流れが宙に浮くので、試験に時間の上限を付けた）
