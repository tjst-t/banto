# system prompt を banto 自前にした（と、その途中で見つかった Memory の食い違い）

2026-09-05。決まったことは `docs/specs/v4-architecture.md` §1.1・§2.2・§2.3・§2.9・§8
にある。ここには**なぜそうしたか・何を却下したか・途中で何を間違えたか**を残す。

## きっかけ

ユーザーからの相談：「system prompt を Claude Code のもの＋banto のものにしている
せいで、AI が Claude Code のツールを使おうとしたり、Memory 機能を使ったりする。
まるっと banto 専用に置き換えるのはどうか」。

## 調べて出た事実（推測ではなく実測）

`adapter.ts` は `{ type: "preset", preset: "claude_code", append: … }` を渡していた。
実 daemon（`~/.local/share/banto/events.jsonl`）の `usage.recorded` 4件はすべて：

- System prompt **3,515** / System tools 902 / MCP tools 1,003 / **Memory files 155**

ここから2つの食い違い（規則8）が見えた。

1. **無い tool の使い方が書かれている。** banto は `tools: ["WebSearch","WebFetch"]`
   で組み込みを絞っている（Shell への経路は Landlock で絞った Module 経由だけ）のに、
   プリセットは Bash / Read / Edit / TodoWrite / Task の使い方を語り続ける。
   **`append` では打ち消せない**——本文が勝つ。
2. **SDK 側の記憶が文脈に入っていた。** `Memory files: 155` は banto の Memory では
   なく、`~/.claude/projects/<cwd>/memory/` の auto-memory。実際 `-tmp/memory/` が
   その日に作られていた。banto の Event Store の外に記憶が積まれていた。

## 決めた形と、その理由

### なぜ「参考にする」で「写さない」のか

Claude Code のプロンプトはノウハウの塊だが、**本文を写すと根拠が banto の外に出る**。
借りたのは結論だけ（結論先出し・読みやすさ優先・スコープの規律・報告の誠実さ）。
これは前の実装（`main`・v3）に対する姿勢と同じ——部品として引くのはよいが土台にしない。

### 骨格は領域不可知にした

vision は「第一の領域はソフトウェア開発」と「**Banto 中核は領域の意味を知らない**」の
両方を言っている。ユーザーと相談して**領域不可知**を選んだ。開発固有の作法は
Module の tool description と Project 指示に置く。「第一の領域は開発」は**標準で繋がる
Module の選び方**の話であって、中核の人格の話ではない、と整理した。

### 「ツールは Module 越しにしか存在しない」は嘘だった

最初の骨格案にこう書いていたが、WebSearch / WebFetch は組み込みを使うので**嘘**
（ユーザー指摘）。かといって「組み込みは WebSearch と WebFetch」と書くのも駄目で、
それは Runner の設定の写しになり、設定を変えた瞬間に嘘になる（規則3）。
**骨格は構造だけを言う**——「環境に触れる操作は Module の tool 越し」「見えている
一覧が全部」。列挙が要ると分かったら、設定から**導出して**渡す。

### 日付と「Fork かどうか」は system prompt に入れない

ユーザー指摘：「日付は日をまたぐと嘘になる」「fork かどうかもセッションが分岐するから
扱いが難しくないか」。どちらも正しく、**両方とも入れない**ことにした。

- **日付**：日をまたぐだけで先頭が変わり、走行中の枝のキャッシュが全部崩れる（§3）。
  加えて長いターンでは終わるころに過去になる——**「今日は〜」と断定形で書けば嘘**。
- **Fork かどうか**：§8 の実測で「Fork は親の resume-point を引き継いでキャッシュも
  引き継げる」と分かっている。system prompt に「これは Fork」と書けば、分岐した
  瞬間に親と先頭が変わり、**引き継げるはずのキャッシュを自分で捨てる**。

置き場は**その回の user メッセージ**にした。メッセージ列は追記なので前方一致は壊れない。
手法自体は SDK も採っている（`excludeDynamicSections` は cwd・git status を剥がして
最初の user メッセージとして入れ直す、と型定義に明記）。

### Memory の持ち主を Project に直した（仕様どおり）

§1.1・§2.2 は「Memory は Project が持つ」と書いてあったが、**実装は Thread 持ち**
だった。さらに悪いことに——

> **Memory は一度も system prompt に入っていなかった。**

`appendMemory` / `invalidateMemory` は Event Store に積まれ、フロントの Project 設定
にも出るが、**Runner へ渡す経路がどこにも無かった**。`remember_decision` で残した
決定を、次のターンの AI は読めていなかった。今回の層3で解消。

### 走行中の更新は「メッセージで届ける」（ユーザー提案）

§3 の「走行中の枝の先頭は変えない」と「最新の決定が届く」を両立させる唯一の形。
system prompt に入る Memory は Thread 作成時（畳んだときはその時点）に確定し、
その後に増えた分・取り消された分は**出所つきでターンに添える**。

**Fork のスナップショット固定（§2.2 item 6）は変えていない**——届けるのは
「別の枝でこう決まった」という**知らせ**であって、Fork が持つ Memory の置き換えでは
ない。item 6 の意図（キャッシュ境界を切る変更は明示的にだけ）は、メッセージで
届ける限り損なわれない。

### Global Memory を足した（ユーザー要望。名前は当日中に改名した）

人の名前など Project に紐づかない記憶。**新しい機構は作らない**——Project Memory と
同じ規律（追記のみ・訂正は無効化イベント・上限で判断待ち）をそのまま適用した。
system prompt では Project の文脈より**前**（キャッシュ境界の内側）に置いたので、
前方一致が **Project をまたいで**効く。

**Phase 0 では人が書くだけにした。** AI が「人の名前」を勝手に書き換える経路を、
観測の仕組みが揃う前に開けない。

## 実装の途中で直した設計ミス

### `invalidated: boolean` では足りなかった

無効化を boolean で持つと、**確定より後に無効化されたときに system prompt の中身が
変わる**——走行中の枝の先頭が変わり、キャッシュが崩れる。無効化の**時点**（seq）を
持ち、確定時点との前後で扱いを分ける形に直した。

### 境界の物差しは Event Store の seq にした

最初は「その Project の Memory の最後の seq」を境界にしていたが、Global Memory を
足す段で**種類ごとに別の境界が要る**ことに気づいた。境界を
**`thread.created` イベント自身の seq**（＝グローバルに単調増加する1本の時間軸）に
変えたら、Project Memory も Global Memory も同じ1つの値で扱えるようになった。
`splitMemory()` に判断を1箇所だけ置いている。

### 既存イベントは書き換えていない

`memory.appended` は以前 `{threadId, text}` で積まれていた。Event Store は追記のみ
（規則3）なので**書き換えず、fold で Thread → Project を解決して読む**。
その回帰試験も置いた。

## Base と Fork が同じセッションで動いていた（ユーザー報告・2026-09-05、直した）

上の作業を実機に入れた直後、ユーザーが気づいた：**Base Thread の AI が「直前の
ターンは Fork でした」と答え、Fork の話が Base の文脈に出ていた。**

実データで確認すると明白だった——Fork の `resumePoint` が親と**同一**：

```
base  b8443fad  now_rp= bc02fe8e
fork  d018aca2  parent= b8443fad  created_rp= bc02fe8e  now_rp= bc02fe8e
fork  1486a93e  parent= b8443fad  created_rp= bc02fe8e  now_rp= bc02fe8e
fork  e770bbc7  parent= b8443fad  created_rp= bc02fe8e  now_rp= bc02fe8e
```

**原因**：SDK の `resume` は「**同じセッションの続き**」であって枝分かれではない。
banto は Fork Thread に親の resume-point をコピーするだけで、そのまま `resume` して
いた——だから 1本のセッションを複数の Thread が共有し、会話が混ざった。

**SDK には最初から手段があった**：`query({ options: { forkSession: true } })`
（「resume したセッションを続けず、新しい session id へ分岐する」）。
**§8 の実測にも「`forkSession` で枝分かれ——新しい `session_id` になるがキャッシュは
引き継ぐ、元の枝もそのまま続けられる」と書いてあった。** 仕様（§2.2「新しい枝として
引き継いだ resume-point」）も分岐を意図していたが、**実装がそれを resume の
コピーだと読んだ**。仕様の言葉が曖昧だったので、§2.2 に「最初のターンで
`forkSession`」と明記した。

**直し方**：`ownsSession`（その resume-point が自分のセッションか）を fold で導出し、
借り物のときだけ最初のターンに `forkSession` を渡す。実機で確認：

- 分岐前：`fork作成直後 resumePoint 一致? true`
- Fork で1ターン → `base rp: 2be71b15  fork rp: 90158dc6  分岐した? true`
- Base に「知っている合言葉」を聞くと、Fork で決めた分は **Memory 経由でしか
  来ていない**（AI 自身が「別の Fork Thread 限定として決まったもの」と出所を説明する）

**教訓**：`resume` と「枝分かれ」は別物。**セッションを複数の Thread で共有すると、
Thread という分離そのものが成立しない**——引き継ぐのはキャッシュであって、
セッションの同一性ではない。

### 名前を `Instance Memory` から `Global Memory` に変えた（ユーザー指摘・2026-09-05）

最初は `Instance Memory` にした——設定の語彙（「instance 既定 → Project 上書き」、
§2.10）と揃うから。だが**「全体の記憶」に読めない**と指摘された。`instance` は
**設定の階層**を指す語であって、記憶の広がりを言う語ではない。`global` ↔ `project` は
一般的な対で、初見のエンジニアが範囲をそのまま想像できる（規則11）。

**変えるなら早いほうが安いので、その場でやった**——Global Memory はまだイベントが
1件も無かったので、**イベント型名（`global_memory.appended` 等）まで含めて丸ごと**
置き換えられた。データが入った後だと、`memory.appended` でいまやっているような
旧イベント名の読み替えが要る。

**設定の語彙は変えていない**（`SHOW_INSTANCE_SETTINGS`・「instance 設定」はそのまま）
——あちらは階層の話で、こちらは記憶の範囲の話。同じ語を無理に揃えない。

## 却下した案

| 案 | なぜ却下したか |
|---|---|
| プリセットのまま `append` を強化する | 本文が勝つ。無い tool の説明も SDK 側の記憶も消えない |
| `excludeDynamicSections: true` で様子を見る | 動的セクションが剥がれるだけで、プリセット本文（＝無い tool の説明）は残る |
| 骨格に開発固有の作法を書く | vision「中核は領域の意味を知らない」に反する。Module／Project 指示に置く |
| 骨格に有効な組み込み tool を列挙する | Runner の設定の写しになる（規則3）。変えた瞬間に嘘になる |
| 日付・Fork かどうかを system prompt に入れる | 走行中の枝の先頭が変わる。Fork はキャッシュ継承まで失う |
| Memory の持ち主を Thread のままにする | 仕様（§1.1・§2.2）と食い違ったまま。ユーザーの判断で Project に直した |
| Fork のスナップショット固定をやめる | item 6 の決定を崩さずに要望を満たせる形（メッセージで届ける）があった |
| Fork で毎ターン `forkSession` を渡す | 2ターン目以降も分岐し続け、**ターンごとに別セッションになる**。借り物のときだけ渡す |
| 「Fork の最初のターンか」を messages の件数等から推測する | 導出できるが脆い。`resume_point_updated` が来たかどうかという**事実**で判定する（fold で導出、規則3） |

## 残っている宿題

- **AI から Global Memory に書く経路**——未決（§2.2）。Phase 0 では開けない
- **Project 固有の指示（層3の3つ目）**——組み立てには入れてあるが、人が書く画面がまだ無い
（この作業中に見つけた E2E の間欠は、**テストの待ち条件の穴**だと分かって直した
——`Base Thread —` が別 Project にも一致していた。経緯は
`2026-09-05-phase0-real-wiring-progress.md` の「訂正（2026-09-05）」に書いた。
**途中で「製品の不具合」と判断して報告したが、それは誤りだった**）
