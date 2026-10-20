# デスクトップ版（Windows）の検討（2026-10-20）

仕様の下書きは `docs/specs/v4-desktop.md`。ここは経緯と却下した案。

## 経緯

- ユーザー：「banto のデスクトップアプリ化できるかな」。最初は、サーバの banto を窓で開く薄い殻（案A）と、本体ごと手元で動かす形
  （案B）を出し、薄い殻を勧めた
- ユーザー：「仕事で使うには完全に独立したデスクトップアプリにする必要がある。そのときはコンテナでの分離は不要とする」——案B に決まった
- ユーザー：「会社の PC は Windows。Claude への接続は個人のログインでできる」。殻は Electron（こちらの提案をそのまま採った）

## 却下した案

- **サーバの banto を窓で開く薄い殻**：仕事の PC からサーバに届かない・社外のサーバにデータを置けない場面で使えない（ユーザー）
- **Tauri**：窓は軽いが、本体（core）は Node で動くので結局 node を同梱する。Electron なら通知・トレイ・更新の既知の部品
  （electron-updater 等）がそろっている。本体の言葉と殻の言葉を揃える
- **Electron の内蔵の Node で core を動かす**：Electron の Node の版は Electron の版に縛られる（Electron 39 は Node 22）。core は
  Node 24 を前提にしている。node.exe を同梱すれば版を core 側で決められる（別のサーバの実行場所が host と同じ node を送るのと同じ）
- **WSL の中で core を動かす**：今の Linux のコードがほぼそのまま動くが、会社の PC では WSL を入れられないことが多い（仮想化・
  管理者の権限・IT の規則）。Windows のフォルダとの行き来（`/mnt/c`）も遅い
- **Shell を PowerShell にする**：AI が書くコマンド・今の Shell の `/bin/sh -c` の決まり・Claude Code 自身（Git for Windows があれば
  Bash 道具に Git Bash を使う）と揃わない。後から Project ごとの選択として足す余地は残す
- **別のサーバの実行場所を最初の段から入れる**：Windows に入っている ssh.exe（Win32-OpenSSH）は `ControlMaster` を持たない
  （`getsockname failed: Not a socket`）。今の実装は多重化した1本の接続が土台なので、作り直しになる。後の段に回す

## 調べたこと

- Claude Code はネイティブの Windows で動く。Git for Windows は任意で、あれば Bash 道具に Git Bash を使い、無ければ PowerShell 道具に
  なる（https://code.claude.com/docs/en/setup）
- banto の会話の本体（Runner）は組み込みの道具を `tools: [...]` で絞り、Bash を切っている（`core/src/runner/adapter.ts`）——本体は
  Git Bash に依らない
- コードの中で Windows でそのまま動かないものの洗い出し（サブエージェント、コードを読んだだけで Windows では動かしていない）。結果は
  仕様の下書き §4・§5・§7 の表に入れた。要点：
  - ネイティブの npm 依存（node-gyp）は無い。Event Store は JSONL の1ファイル（SQLite ではない）
  - 大きい山は3つ：(1) プロセスの起こし方・止め方・シェル（`/bin/sh -c`・`kill(-pid)`・systemd・`process.execPath`）、
    (2) Unix ソケットに乗った通信路（流れの口・ssh-agent・git の credential・mkfifo）、(3) Linux 専用の道具の上の Module（Terminal・
    Browser・Documents・Service）と、閉じ込めが無いことの決め直し
  - 小さいが最初に当たるもの：ディレクトリの fsync（`event-store/log.ts`、直さないと core が起きない見込み）、Repositories の台帳
    （`ledger.ts` の `startsWith("/")`、1件登録すると読めなくなる）、`config/bootstrap.ts` の `isAncestorOrEqual`（重なりの見落とし）
  - 画面は静的に書き出せそう（妨げは `generateStaticParams` の無い動的な道と `headers()`）。今は `/api` を repo の外の Caddy が流している
