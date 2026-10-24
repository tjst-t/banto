# チャットを Project にするとき、実行場所を選ぶ（2026-10-24）

ユーザー要望：「チャットから Project に移行するときに、実行場所を選べるようにして」。
決めた形は `docs/specs/v4-architecture.md` §2.2「Project にする」と `docs/specs/v4-frontend.md` §6.53。ここは経緯と却下した案。

## 前提

- チャットは中身が普通の Project（`kind: "chat"`）で、根は `~/banto/chats/…`、この機械のコンテナだけ
- Project を別の実行場所へ移す仕組み（`runtime/project-move.ts` の `ProjectMover`）は、この機械のコンテナ・`machine`・`containers`
  の全部の組み合わせを扱い、写して切り替える・進み具合・失敗の片づけ・起き直したときの片づけまで持っている

## 決めたこと

### 移し方は今の ProjectMover をそのまま使う

チャット専用の移し方は作らない（規則3・12）。Project にしたあとは普通の Project なので、今の「移す」と同じものになる。

### 口は1つ——promote の中で移し始める

`POST /api/projects/:id/promote` に `runtime`・`root` を渡すと、`ProjectMover.start` を呼ぶ。`start` に `beforeStarted` を1つ足し、
**断る確かめを全部通して移す先を押さえたあと・`project.runtime_move_started` を積む前**に `project.promoted`・グループを書く。

- 確かめ（`start` の頭：移している途中・眠っている・選べない実行場所・動いているもの。`prepareTarget`：根の形・空でない・重なり・
  containers の根の決まり）は全部 promote の前に済む。断られたら何も書かない
- `beforeStarted` が投げたら（その間に別の口で Project にされた等）、移す先で banto が作ったものを今の片づけ（`cleanupTarget`）で消す

**却下した案**

- **画面が promote と runtime-move を2回叩く**：promote が通って移すが断られると「Project にだけなって移せない」が残る。要望の
  条件そのものに反する
- **promote の口で先に見積もり（`estimate`）を呼んでから promote → start**：見積もりは大きさを測る（大きいフォルダでは遅い）うえ、
  見積もりと start の間に状況が変わりうる（ターンが始まる等）。確かめは start 自身がするので、その中に差し込むほうが短く・確か
- **移し終えてから promote**：写すのは数分〜1時間掛かる。その間チャットの欄に残り、失敗したら Project にならない——人が押した
  「Project にする」が、移すの成否に引きずられる。promote は人が決めたことなので先に済ませる

### 写している途中で失敗したら、Project にはなったまま元の場所

`started` を積んだあとの失敗（写す・確かめる・切り替える）は、今の移すと同じく `project.runtime_move_failed`・元の場所のまま・受信箱に
知らせる。promote は取り消さない——「Project にする」は人が決めたことで、移せなかったのは別の理由（向こうの空き・SSH が切れた等）。
帯と受信箱に理由が出るので、Project の設定「一般」から移し直せる。

### リポジトリの欄は出さない（`git init` だけ先にする案は取らない）

Repositories（`folder-adopter` の画面）は banto 本体の機械のフォルダしか扱えない。別のサーバを選んだら欄を出さず、
「リポジトリはここでは作りません（Repositories は banto の機械のフォルダしか扱えません）。移したあと、AI に頼んでください」と出す。

- **却下：移す前にこの機械で `git init` だけする**。Repositories の画面は `git init` と一緒に**台帳に足す**（と GitHub に公開）——台帳に
  載るのはこの機械のパスで、移したあとは向こうへ行ってしまい、台帳が古いパスを指す。`git init` だけを分けてする口は Repositories に
  無く、core が `git init` を自分でするのは「core は Repositories を名指しで知らない」（v4-modules.md の「core との境目」）に反する
- 頼みの文は「AI に頼むか、Project の設定から」だったが、**Project の設定にリポジトリを作る画面は無い**（`folder-adopter` を出すのは
  「Project にする」の小窓だけ）。無いものを案内しない（規則13）ので「AI に頼んでください」だけにした

### 画面

- 「どこで動かすか」は新しい Project の画面の `RuntimeStep` を使い回す（`testId` と説明の文だけ替える）。説明は「作ったあとで
  変えられません」ではなく、写して切り替えること・そのサーバでの閉じ込め
- 向こうの根の「新しいフォルダ」は**名前を決めるだけ**（作るのは押したとき、`ProjectMover` が作る）——「別の実行場所へ移す」の移す先と
  同じ。選んだだけで作ると、やめたときに向こうに空のフォルダが残る
- 根の初期値は入れない（新しい Project の画面と同じ、2026-09-11 のユーザー指摘）
- 押す前の見積もり（写す大きさ・移らないもの等）の段は持たない。押して断られたら理由を出すだけ。閉じ込めの注意は説明の文に入れた
- 受け付けられたら小窓を閉じてその Project の会話へ。進み具合は今の移す画面と同じく帯・サイドバーの印・設定の欄（Backlog #293 の形）

## 確かめたこと・確かめていないこと

- 単体（`http/app.test.ts`）：実行場所を渡すと移す口の中で promote が書かれる／動いているもの・無い実行場所・選べない実行場所
  （本物の `ProjectMover` の確かめ）では promote もしない／形のおかしい組み合わせは 400
- E2E（`e2e/specs/chat-promote-runtime.spec.ts`）：SSH の相手（machine）へ、小窓から。空でない根で断られてチャットのまま→選び直して
  移し、帯の終わり・host の記録・向こうのファイル
- **containers へ「Project にする」で移すのは E2E で見ていない**（containers の移すそのものは `runtime-move` の containers の試験が
  見ている。promote の側は実行場所の種類で分けていない）
- `beforeStarted` が投げたときに移す先を片づけることは、単体で見ていない（SSH の相手が要る。今の `start` の片づけの経路のまま）
