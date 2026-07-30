# 記憶の分類に第3の種類（fact）を追加する提案

## 現状

`memory.save` / `memory.recall` の `kind` パラメータは **`preference`（好み）** と **`habit`（習慣）** の2種しか定義されていない（banto-core の `MemoryKind` 型、banto-host の `MemoryKindSchema`）。

| kind | 意味 | 例 |
|---|---|---|
| `preference` | 好み（選好） | 「構造より動作を先に見たい」「日本語で返答してほしい」 |
| `habit` | 習慣（行動パターン） | 「毎朝最初にアテンションキューを確認する」「リリース前にCHANGELOGを更新する」 |

### 問題

POの名前「たくみ」、使用している言語（日本語）、プロジェクトのルートパス、連絡先メールアドレス、許諾範囲（「staging環境へのデプロイは承認不要」）のような**属性情報（事実）** を保存するための分類が存在しない。

現状はやむを得ず `preference` に押し込んでいるが、意味的に不適切である。

- 「名前」は好み（preference）ではない——選好の対象ではなく、単に事実として参照すべき値である
- 「名前」は習慣（habit）でもない——行動パターンではなく、変わらない属性である
- `preference` に混ぜると、**「好みの一覧」を見た番頭が「これは好みとして尊重すべき事項」と受け取るリスクがある**——POの名前を好みとして扱うと、システムが「名前を変えるのも好みの変更だ」と解釈する誤った推論を誘発しうる

### 関連する原則

- **D1**: `MemoryKind` 型の変更（新しいリテラルの追加）は公開インターフェースの変更であり、不可逆な選択にあたる。提案として起票し、PO（番頭）の裁定を仰ぐべき領域である
- **D3**: 今回提案する `fact` は「導出できない値」を保存するための種別である。POの名前のように外部から与えられ、そこから導出も推論もできない値を適切な分類の下に置く

### 既存の実装（影響を受ける箇所）

```
packages/banto-core/src/memory.ts
  - MemoryKind 型: "preference" | "habit"
  - MemoryRecord / MemoryInput / MemoryQuery: kind フィールドで MemoryKind を使用
  - JsonlMemoryStore: kind によるフィルタリング

packages/banto-host/src/memory-tools.ts
  - MemoryKindSchema: Type.Literal("preference") | Type.Literal("habit")
  - createMemoryTools(): memory.save / memory.recall のパラメータバリデーション
  - renderMemoryForPrompt(): "好み" / "習慣" のセクションを生成
```

## 提案

### 追加する種類：`fact`（事実・属性情報）

`MemoryKind` に第3の値として `fact` を追加する。

| kind | 意味 | 変更 |
|---|---|---|
| `preference` | 好み（選好） | 現状維持 |
| `habit` | 習慣（行動パターン） | 現状維持 |
| `fact` | **事実（属性情報）** — 変更が難しいか、本来変えるべきでない固定的な情報 | **新規追加** |

#### 定義

`fact` は以下の性質をすべて満たす情報を保存するために使う：

1. **命題の真偽が一意に定まる**——「POの名前はたくみです」は真であり、好みではない
2. **導出できない**（D3）——どこかのファイルから読める値でも、推論で出せる値でもない。番頭が人から直接聞いたか、確認して確定した値である
3. **変更は訂正（supersede）で表現する**——preference/habit と同じく追記＋supersede 方式は変わらないが、fact の訂正は「発見された事実の修正」であり「好みの変化」とは異なる

#### preference / habit との違い

| 軸 | preference | habit | fact |
|---|---|---|---|
| 変更の性質 | 好みの変化 | 習慣の獲得/変化 | 誤りの訂正（発見ベース） |
| 時間的性質 | 変わってよい | 変わってよい | 変わらないことが期待される |
| 典型例 | 応答の文体、レイアウトの好み | 手順のルーティン、チェック習慣 | 名前、役割、許諾範囲、契約条件 |
| 誤った解釈のリスク | 中（「好みとして尊重」は妥当） | 低 | **高（事実を好みと誤認すると意思決定が歪む）** |

### 追加による影響

#### 1. `MemoryKind` 型（banto-core）

```typescript
// 変更前
export type MemoryKind = "preference" | "habit";

// 変更後
export type MemoryKind = "preference" | "habit" | "fact";
```

#### 2. `MemoryKindSchema`（banto-host）

```typescript
// 変更前
const MemoryKindSchema = Type.Union([Type.Literal("preference"), Type.Literal("habit")], {
  description: "preference（好み）または habit（習慣）",
});

// 変更後
const MemoryKindSchema = Type.Union([Type.Literal("preference"), Type.Literal("habit"), Type.Literal("fact")], {
  description: "preference（好み）、habit（習慣）、または fact（事実）",
});
```

#### 3. `renderMemoryForPrompt`（banto-host）

`fact` のセクションを追加でレンダリングする。「好み」「習慣」とは別のセクションとして表示し、番頭が事実と選好を混同しないようにする。

```typescript
// 追加イメージ
const facts = byKind("fact");
if (facts.length > 0) sections.push("## 事実\n" + facts.join("\n"));
```

プロンプトでの表示順は「事実 → 好み → 習慣」が自然と考えられる（事実は最も安定した情報であり、先に読むべきである）。ただしこれは実装時の判断に委ねる。

#### 4. `memory.save` / `memory.recall` の利用

- `memory.save` に `kind: "fact"` を渡せるようになる
- `memory.recall` に `kind: "fact"` を指定して事実のみ取り出せる
- kind を指定しない（全件取得）場合、fact も含めて返る
- **後方互換性**: 既存の preference / habit の記憶には一切影響しない。既存のレコードの kind は変わらず、新しく fact を保存しても JSONL のフォーマットは同じ（`kind: "fact"` という文字列が増えるだけ）

#### 5. データ変更の分類（D1 判断）

`MemoryKind` へのリテラル追加は**公開インターフェースの拡張**であり、既存の利用を壊さない（新しい値を追加するだけの場合は破壊的変更ではない）。ただし：

- 型としては `"preference" | "habit"` から `"preference" | "habit" | "fact"` への拡張
- 既存コードの `switch` / `if` で kind を網羅している箇所はコンパイルエラーになる可能性がある → その場合は追加の修正が必要
- 半構造化データ（JSONL）には影響なし——新しい値が出現するだけ

### 実装手順（概要）

1. `packages/banto-core/src/memory.ts` の `MemoryKind` 型に `"fact"` を追加
2. `packages/banto-host/src/memory-tools.ts` の `MemoryKindSchema` に `Type.Literal("fact")` を追加し description を更新
3. `renderMemoryForPrompt()` に `fact` のセクションを追加
4. コンパイルエラーが出る箇所（kind の網羅チェック等）を修正
5. テストを追加（fact の保存、取り出し、他 kind との独立性、後方互換性）

## 検討事項

### A. 既存の記憶システム（Hermes Agent）との整合性

Hermes Agent は記憶を大きく分けて三層で設計している：

- **Episodic memory**（エピソード記憶）：過去の会話の要約・埋め込み
- **Semantic memory**（意味記憶）：抽出された知識・概念
- **Procedural memory**（手続き記憶）：SKILL.md 形式の手順

今回提案する `fact` はこの分類のうち **Semantic memory** に近い位置づけになる。「POの名前」のような抽出された知識を保存する層である。番頭の第一層（preference / habit / fact）は Hermes の三層よりフラットだが、事実を独立した分類にすることで意味的には semantic memory の役割を部分的に担うことになる。

Hermes の設計を直接なぞる必要はない（ADR-0010 決定10：「設計のみ踏襲して自前実装」）が、方向性としては一致している。

### B. 分類を増やすことのトレードオフ

#### メリット
- 意味的な正確さ——事実を事実として保存・参照できる
- 推論の歪み防止——好みと事実を混同した誤った意思決定を防ぐ
- フィルタリングの精度——`memory.recall` で kind を指定して事実だけ取得できる
- プロンプトでの明示性——セクションが分かれることで番頭の認知負荷が下がる

#### デメリット
- 複雑さの増加——分類が3つになることで「どれに当たるか」の判断が増える。save 時の kind 選択に迷う場面が出てくる可能性がある
- 既存コードの修正——kind の網羅的チェックをしている箇所は修正が必要
- 学習コスト——新しく番頭として動くエージェント（ハーネスを差し替えた場合等）が3分類を理解する必要が生じる

### C. 代替案

#### 案1: 現状維持（2分類で運用し続ける）

- メリット: 変更コストゼロ。preference に事実を混ぜても、実用上は困っていない（POの名前は好みとして保存され、参照はできている）
- デメリット:
  - 意味的な誤りが蓄積する。「好み」と「事実」の区別が無いまま運用が続く
  - 番頭（LLM）が「preference は好みとして尊重すべき対象」と学習している場合、事実を好みと誤認して「変えてもよいもの」と判断するリスクがある
  - 時間が経つほど修正コストが高くなる（蓄積された記憶の kind 再分類が必要になりうる）

#### 案2: `attribute` または `information` という名前にする

- 命名の選択肢:
  - `fact`: 簡潔。命題の真偽が定まる情報という含意。やや広い（「習慣も事実の一種では？」という疑問がありうる）
  - `attribute`: 属性情報に限定される。POの名前・役割等にフィットするが、契約条件（「staging へのデプロイは承認不要」）のようなルール的性質の情報にはやや狭い
  - `information`: 最も広い。事実・属性・ルールすべてを含むが、preference/habit との境界が曖昧になりうる
- 本提案では `fact` を推す。理由: (a)「導出できない真偽値」という意味が名前から推測できる、(b) 他システム（Hermes 等）との用語衝突が少ない、(c) 1単語で簡潔

#### 案3: kind を階層化する（preference.habit に統合）

- メリット: kind の数を増やさずにサブカテゴリで表現できる
- デメリット: インターフェースが複雑になる。Tool パラメータのスキーマがネスト構造になり、memory.save の呼び出しが煩雑になる

## 作成日

2026-07-30

## 状態

**採用。ADR-0010 決定31 として記録し、task-0032 で実装済み（2026-07-30、PO裁定）。**

### 問題が実在することを確認した（I1）

主張を鵜呑みにせず手元の記憶を確認したところ、`「POの名前は「たくみ」である」` が実際に
`preference` として保存されていた。仮定の話ではなかった。

### 提案が見ていなかった点：`fact` は同音異義になる

決定29(a) で `WorkerEventKind = "fact" | "claim"` を既に使っている（職人のイベントが
観測された事実か、職人の自己申告かの区別）。語彙表には「充ててはいけない語」を確認してから
新設する規律がある。

検討した結果、**衝突しないと判断した**——軸が違うため。

- 決定29 の `fact`/`claim` は**証拠の状態**（観測か自己申告か）
- 記憶の `fact` は**言明の種類**（事実か、好みか、習慣か）
- 記憶における確からしさは `kind` ではなく**出所**が担う（決定28：自動抽出した記憶は
  出所を持たせて消せるようにする）。**分類と確からしさを同じフィールドに載せない**

別フィールド（`kind` と `origin`）・別ドメイン（記憶と職人のイベント）なので取り違えない。
決定31(b) に注記として残した。

### 命名

提案の推す `fact` を採った。`attribute` は許諾範囲のような規則性のある情報に狭く、
`information` は広すぎて好み・習慣との境界が曖昧になる。

### 実装

提案の手順どおり。プロンプトの表示順は提案が「実装時の判断に委ねる」としていた点で、
**事実 → 好み → 習慣**を採った（事実が最も安定しており、先に読ませる方が判断が安定する）。
