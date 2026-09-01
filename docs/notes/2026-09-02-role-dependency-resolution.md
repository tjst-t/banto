# 検討ログ：role の定義と、依存先実装の選び方（2026-09-02）

> ## ⚠ この文書は仕様ではない。**検討のログ**である
>
> **仕様は `docs/specs/v4-architecture.md`。** 決まったことを知りたいなら
> そちらを読む。この文書には検討の経緯・却下した案・訂正の履歴がそのまま残る。

## 発端

item14「Project 単位の Module 管理 UI」をモックで作った
（`AddModuleDialog`、コミット `d3ba48d4`）。ユーザーに動線を説明したところ
「MCP をどう発見してどうインストールするかの話だと思っていた、Project の話とは
思っていなかった」と判明——**item14 という名前がそもそも2つの別の UI を
一括りにしていたこと**、そして**その手前で `role` という概念の理解が
仕様とズレていたこと**の2つが同時に露見した。

**その場で `AddModuleDialog` と関連するデータ層の変更は `git reset --hard`
で巻き戻した**（未 push だったため）。以下は巻き戻した後の、role の再定義の
議論。

## role は誰が定義するか

最初のズレ：mock の `settings.ts` は `roleDefs` という**banto 側が決め打ちした
固定6件のリスト**（filesystem/shell/skills/subagent/vault/repo）を持っていた。
実装（`implementations`）はその固定 ID のどれかに `roleId` で紐付くだけ、という
構造。

仕様（§2.5）を読み直すと、これは逆だった。**role は Module 自身が宣言するもので、
banto がリストを持つのではない。** host が Module の依存宣言を読んで
「role→{名前:実装} の辞書」を自動的に組み立てる。同じ役割を複数の Module が
名乗ってよく、衝突は「同じ*名前*を2つの Module が名乗ること」だけ。

## 「AI が直接触る Module」と「バックエンドとなる Module」——2回訂正した

次に出た疑問：AI が直接触る Module（Repo・Shell 等）と、他 Module のバックエンドに
なる Module（Vault 等）をどう区別するか。ここで2回、筋の悪い案を出しては
訂正された。

### 却下1：実装（Module）単位で「AI 向けかどうか」のフラグを持つ

最初に出した案：`implementations` の各要素に「Runner に繋ぐ既定か」という
フラグを足す。Vault はこれを OFF にすればよい、と考えた。

**却下理由**（ユーザー指摘）：Vault 自体にも AI 向けの Tool がある
（「使える秘密情報の名前一覧をちょうだい」）。AI から見えないのは Vault では
なく**Vault のバックエンド**（組み込みローカルか HashiCorp Vault か）の違い。
Module 単位のフラグでは表現できない。

### 却下2：Tool 単位で「AI 向けかどうか」を分ける

次に出した案：Module 単位ではなく Tool 単位で「この Tool は AI 向け、この Tool は
Module 間専用」と分ける。

**却下理由**（ユーザー指摘）：Tool の話は誰もしていない。聞きたいのは
「AI にサービスを提供する Module」と「その Module にサービスを提供して
バックエンドとなる Module」の区別——これは Tool の可視性の話ではない。

### 正しい形：Module 同士の依存関係（エッジ）の話

具体例（§2.5 の Repo→Vault ssh-agent の実例で確認）：

- Repo は AI に直接サービスを提供する（push tool 等）
- Repo は動くために Vault に依存する（裏で ssh-agent を借りる、AI は関与しない）
- **しかし Vault 自体も、AI に直接サービスを提供する Tool を持つ**
  （alias の名前一覧を返す、等）

つまり「AI 向け Module」「バックエンド専用 Module」という**Module に貼る固定
ラベル**は存在しない。**同じ Module が、相手によって役どころが変わる**——
Vault は AI に対しては「AI に直接サービスを提供する Module」、Repo に対しては
「Repo のバックエンド」。

表現すべきは Module のラベルではなく、**依存の向き**：各 Module は
①AI に何を提供するか（role として名乗るもの）と、②自分が動くために他の
どの role に依存しているか、の2つの情報を持つ。②を見せる場所が
これまでの mock には無かった。

## 依存先実装の選び方——2つのパターン

②が分かったところで次の疑問：ある Module が依存する role に複数の実装が
あるとき、どれを使わせるかをどう選ぶか。ここでユーザーから2パターンの
指摘が出た：

1. **設定で固定する型**——Vault がこれ。値は動かさず、接続を人が事前に選んで
   おく（§2.5 の alias 方式・D5 の割り当て表と整合）
2. **AI がその場で選ぶ型**——Subagent がこれ。候補一覧を取得できる Tool が
   あり、仕事の中身に応じて**呼び出しのたびに AI が選ぶ**
   （「どの Module の、どのモデルを、どの effort で呼ぶか」）

## 却下3：この2パターンを banto が一般化してカスケード UI を持つ

いったん「型1は3段カスケード（instance既定→Project上書き→Module自身の指定）
の UI を banto が一般に用意する」という方向で合意しかけたが、**ユーザーが
その場で撤回**：

> 型1のカスケード UI は banto がシステムとしてやる必要はない。これは
> Module ごとに様々だから、banto がわざわざ一般化する必要はない。Module が
> 必要なら Module の設定画面で出せばいいだけ。banto は Module に対して
> role を満たす Module のリストを渡せればいいだけでは。

**理由**：型1/型2 のどちらであるべきかも含めて Module 固有のロジックであり、
banto core がそこに口を出すのは Module の独立性（§1）と矛盾する。

## 決定（`docs/specs/v4-architecture.md` に反映済み）

- **banto がやることは「role→実装の一覧を、依存している Module に渡す」
  ことだけ。** 選び方（固定か動的か、カスケードの段数）は Module 自身の
  設定面（`ui://<id>/config`）の仕事
- **旧決定「Vault 接続の指定とカスケード」（2026-09-01）の instance既定・
  Project上書きの2段は撤回。** Vault に依存する Module（Repo・Shell 等）
  自身が選ぶ
- **副作用として新たに要る仕組み**：Module プロセスの寿命は Project に
  紐づかない（§10 未決事項の注記、2026-08-30）ため、Module 自身は「今どの
  Project のために設定を描いているか」を知りようがない。**banto が
  `ui://<id>/config` を埋め込むとき、現在の Project の識別子を渡す**
  （新しい仕組みではなく、既存の「面が自分で取りに行く」形にパラメータを
  1つ足すだけ）。対応するかは Module 次第
- **item14 は2つの別 UI に分割**（§10）：(a) instance が新しい実装を知る
  （§5.1 で決定済み、instance 全体の操作）／(b) この Project が Runner に
  直接繋ぐ Module を選ぶ（AI 向け role だけが対象、Vault のような裏方 role は
  対象外）

## まだ決めていないこと

- Subagent のような「AI がその場で選ぶ型」の具体的な Tool 形状
  （候補一覧の取り方、モデル・effort の渡し方）——Subagent Module 自身の
  設計であって banto core の話ではない、というのが今回の結論だが、
  Subagent Module 自体の設計はまだ着手していない
- `ui://<id>/config` への Project 識別子の運び方の具体的なプロトコル
  （`ui/initialize` のペイロードに乗せるか、Module 自身の tool 引数として
  渡すか）——仕様には「どちらでも足りる」としか書いていない
