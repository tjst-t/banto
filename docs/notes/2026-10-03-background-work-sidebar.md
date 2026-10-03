# サイドバーのバックグラウンドの印（2026-10-03）

ユーザー：「どのスレッドでサブエージェントが動いているか、UI で見る方法を作れるか。core の UI に Module の状態を見せるのは
依存関係的に難しい気がする」。

## 決めた筋

- core は Module の中身を知らなくてよい。host は前から「返事待ちの札」（AI が「終わったら届ける」tool を呼び、Module が
  「あとで届ける」と約束したもの、Thread・Module つき、Event Store の `reply.awaiting`）を持っている。それを画面に出す。
  文は tool が名乗るカード（`dev.banto/card`）から作るので、サブエージェント専用の作りにならない
- 却下：Module の画面（サブエージェントの launcher）に「頼んだ Thread」の列を足して、そこから Thread へ飛ぶ案（案B）。
  Module が Thread の名前を引き、Thread を開く口を core が Module の画面へ出すことになり、境目が広がる。要れば後で足す

## 置き場所（モックで3案を見比べた）

- 右端の「⧗ n」／アイコンの角の数／名前の下の1行。ユーザーは「名前の下」を選んだ。角の案は回る輪と重なって窮屈だった
- いま開いていない Project の行は、名前の下だとおかしいので頭文字の右下の数（ユーザー）
- 畳んだレールには出さない——レールの作りを根本から見直したいので（ユーザー）
- 待つ形の呼び出しは出さない（ユーザー）——その間はターンが走っていて輪が回る。出すと Shell の長いコマンドなども出る

## 文言

- 2件以上は件数だけ（ユーザー）。「返事待ち」は避けた——banto では「判断待ち」「レビュー待ち」が人の番を指し、人が返事をする
  番に読める。Claude Code は同じものを「3 background tasks」（Issue #33310・interactive mode の文書）、VS Code の日本語は
  「バックグラウンド タスク」、tool の引数も `runInBackground` なので「バックグラウンドで n 件」にした（ユーザーに任された）

## 押したら何を開くか

- 会話のカードは toolCallId（Runner の tool_use の id）で画面を開く。MCP の呼び出しにはその id が無いと思っていたが、
  同梱の Claude Code の CLI を読むと、tool 呼び出しの `_meta["claudecode/toolUseId"]` に入れて渡していた（2026-10-03）。
  host はそれを札に添え、画面は会話のカードと同じ URL（`canvas=<Module>:<resourceUri>&canvasTool=<toolCallId>`）で開く。
  E2E の偽の Runner も同じ `_meta` を添えるようにした
- カードの文の穴埋め（`{引数名}`）は host でも要るようになった。画面は workspace のパッケージに依存していないので、
  `module-contract` の `fillCardText` と画面の `inline-module-view.tsx` の同名の関数の2つになった（変えるなら両方）
