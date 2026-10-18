# SSH の接続を Project ごとにする（Backlog #366、2026-10-18）

仕様は `docs/specs/v4-security.md` §1「別のサーバの中のコンテナ」の「SSH の接続は Project ごとに1本」（実装済みの段落もそこ）。
ここには決めた理由と、踏んだもの・残したものを置く。

## 決めたこと（実装者）

- **`machine` のトンネルの向こうの側は TCP のまま**。仕様の案は「Project ごとの決まったパスの UNIX ソケット」だが、`machine` の
  Module は `bantoOrigin`（`http://127.0.0.1:<番号>`）で繋ぐ。ソケットにすると Module の側（node の fetch・Claude の中継）に
  ソケットへ繋ぐ道が要り、`machine` のためだけに増える。`machine` は1つの実行場所に Project が1つなので、A3（切れている間に
  同じ番号が別の Project に渡る）は起きない。ソケットは proxy device が繋ぐ先として `containers` で入れる
- **先に送るためだけの接続（`warmUp`）は Project を持たない**。トンネルも待ち受けも張らない。前は張った接続を Project がそのまま
  使ったが、接続が Project ごとになると使い回せない。資源の画面が読めるよう、その実行場所の Project の接続が張れるまでは残し、
  張れたら閉じる（前と同じく、Project を手放せば接続は残らない）
  - 却下：先に送り終えたらすぐ閉じる——Project を開くまで資源の画面が「繋いでいません」になる（前と違う振る舞い）
- **同じ実行場所のコードの照合・送り込みは1本ずつ**（`oneSyncAtATime`）。Project の接続が同時に張られると、どちらも「版が違う」と
  見て同じ `<版>-<連番>` を組もうとする。あとの方は前のが送り終えた版を照合するだけになる
- **待ち受けは手放したら閉じる**（前は閉じなかった）。待ち受けの番号は host の側だけのもので、Module が使う番号（向こうの側）は
  繋ぐたびに変わるので、閉じても困らない。閉じないと Project ごとに増え続ける
- **繋がらないお知らせ（#339）は実行場所ごとに1枚のまま**（アーキ仕様 §2.4 の 3.）。鍵を Project ごとの接続にしたのは「閉じる」の
  側：繋がらなかった Module を Project ごとに覚え、その Project の接続が張れたらその分を外し、全部外れたら閉じる。
  先に送るためだけの接続が張れても閉じない（Project の Module が繋がったことにならない）。画面の「!」も繋がらない Project だけ
  （前は実行場所の Project 全部——`machine` では同じ）
- **2択は問いごとの関数に**（`runtime/runtime-kind.ts`）。`isRemoteProject` を使っていた場所は、問いが4つに分かれていた：
  根がこの機械のパスか（store・移す先の重なり・Runner の作業ディレクトリ）／この機械のコンテナか（状態・上限・中で引く・止める・
  眠ったものを起こし直しで止める）／眠らせるとき Service を止めるか／閉じるとき Service を止めるか。`containers` ではこの4つの
  答えが揃わない（根は向こう・コンテナはあるが向こう・眠らせるならコンテナを止める・閉じても空かない）。`remoteNameOf` は
  「どの実行場所か」を引くもので2択ではないので残した

## 踏んだもの

- 新しい worktree の frontend のビルドが `next/font/google` で落ちる（`docs/notes/2026-10-04-repositories-polish.md` と同じ）。
  `.next/cache` を写して通した。ビルドの途中で banto が起こし直されると、写した Turbopack の cache が壊れて（`*.sst` が無い）
  落ちる——`.next` を消して写し直すと通る
- `runtime/socket-dir.test.ts` の2本は、TMPDIR が長い環境（このエージェントのホームの tmp）では落ちる（ソケットのパスの上限）。
  変更とは関係しない。`TMPDIR=/tmp` で通る

## 残したもの（規則6）

- `delivery/turn-continuation.test.ts` の「繋がり直したあと Module が続けられないと答えたら、理由つきの『途中で終わりました』」が、
  core の単体試験を全部流した4回のうち1回落ちた（その1つのファイルだけを10回流すと0回、全部をあと3回流すと0回）。
  試験は決まった 20ms を待ってから見ている（`setTimeout(r, 20)`）ので、全部を並べて流して重いときに間に合わないと思われる。
  偽の `unreachableReason` は引数を見ないので、この変更（引数に Project を足した）とは関係しない。スコープ外なので直していない

## main に載せ直したとき（2026-10-18）

- 作ったあとに main へ「エージェントの本体（OpenCode）を取ってきて別のサーバへ送る」（`ensureAgentBinary`・`pruneAgentBinaries`）が
  入っていた。本体の置き場（`<置き場>/agent-binaries/`）は実行場所ごとに1つなので、接続が Project ごとになると、ある Project の
  接続が繋いだときの片づけ（目録に無いものを消す）が、別の Project の接続が送っている途中の `<名前>.incoming-*` を消しうる。
  **本体の送り込みと片づけも、コードの照合と同じ列（`oneSyncAtATime`）に並べた**。`remoteHasAvx2`・`ensureAgentBinary` は
  呼び元の Module の Project の接続（`liveConnection`）を引く——その Module が動いているので接続はある
- レビューの指摘：`connect()` の途中（待ち受けを作ったあと、表に入れる前）に `release()` が来ると、`release` は待ち受けだけを閉じ、
  `connect` は閉じた待ち受けへの `-R` を張った接続を表に残した。手放した回数を Project の接続ごとに数え、`connect` は表に入れる
  直前に見て、手放されていたら閉じて断る（`closeRuntime` の回数と同じ形）。手放したあとに使い直したときに、断って終わる前の
  繋ぎに相乗りしないよう、回数は繋ぎをまとめる鍵（`flightKey`）にも含めた
