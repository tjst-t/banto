---
id: spec-file-browser
type: spec
status: draft
refs: [vision, principles, spec-ui, spec-multi-project, spec-daemon-core]
---

# Spec: File Browser（ファイル／プレビュー面）

番頭のキャンバスに開く基本GUI「ファイル」（`file.browser`）の仕様。`spec-chat-ui` と対をなす。

第一原理：**実体はホスト側にあり、GUIは表示と操作だけを持つ**（D3・D5）。ファイル一覧・中身の実体は
workspace モジュールのデータAPI（`file.*` ToolのHTTP口）にあり、GUIは `useModuleTool` 経由でそれを取得する
だけ。閲覧はどの場所にも届き、**変更（書き込み・新規・削除・アップロード）は PO が場所ごとに許した範囲に
限られる**（決定38・`file.write`、`place.request_write`）。

---
前提（決定25・27）：GUIと番頭は同じ Tool 契約を共有——GUIは `{endpoint}/tools/{Tool名}` の HTTP 口、
番頭はホスト内で同じ実装を直接呼ぶ。経路が違うだけで契約は1つ。
`file.browser` は `places` のデータAPIから読む（場所が指定されなければ PO が PlacePicker で選ぶ）。
---

## 1. 画面構成

```
┌──────────────────────────────────────────────────────┐
│ [PlacePicker ▾]  [↑上へ]  /path/to/dir   (N件)      │  bar
├───────────────────────────┬──────────────────────────┤
│ ツリー（リストビュー）     │ プレビュー／ソース        │
│  📁 src/                  │                          │
│  📄 index.ts      3KB     │  (ファイルの中身)         │
│  📄 tsconfig.json 2KB     │                          │
│  … 上限で一部                │                          │
└───────────────────────────┴──────────────────────────┘
```

ツリーは左カラム、プレビュー／ソースは右カラム。

## 2. ツリー（リストビュー）

### 2.1 エントリ

エントリは `{name, type: "dir"|"file", size?}`。表示は名前＋サイズ、ディレクトリは
アイコン `📁`、ファイルは `📄`。

### 2.2 ナビゲーション

- **カレントディレクトリ**はバーに完全パスで表示。`↑上へ`は親へ
- ディレクトリを選ぶ→その中身、ファイルを選ぶ→右カラムに中身
- パスがディレクトリかファイルかは先に `file.stat` で確かめる（どちらでも出発できる）
  - ファイルパス → 親ディレクトリを開き、そのファイルを選択状態で開始
- `params.line`（と `endLine`）を渡すとその行まで自動スクロール・強調（`file.grep` の結果をそのまま見せる）
  - 強調表示は**「番頭が指定したファイルを見ている」ときだけ**。別のファイルを選んだら解除

### 2.3 一覧の省略（truncation）

`file.list` の `truncated` が true のとき「… 上限を超えたため一部のみ表示」を出す。件数カウント
（"N件"）は `total`（全件数）。この先はファイル名プレフィックス一致の絞り込み（v2、§6.2）。

## 3. プレビュー（preview）とソース（source）

種別判定（`filePreview.ts`）は**純粋関数**で UI から独立（DOM・shiki 非依存）。ブラウザでも node:test
でも読める。

### 3.1 種別判定 `kindOfPath`

拡張子 → 種別の表（task-0050〜0055 で確定）：

| 種別 | 拡張子 | 描画 |
|---|---|---|
| `markdown` | md | GFM（remark-gfm）Markdown、コードブロック内は mermaid→shiki |
| `mermaid` | mmd, mermaid | mermaid.js 描画（動的 import、エラーは生コード表示） |
| `csv` | csv, tsv | papaparse でテーブル表示（1行目をヘッダ強調、列数は最大に揃えて） |
| `diff` | diff, patch | unified 色分け（gv-add / gv-del / gv-hunk 流用） |
| `code` | ts, js, py, … | shiki ハイライト（行番号なしの preview、行番号付きは source） |
| `plain` | その他 | 素のテキスト。source 固定 |

### 3.2 preview / source 切替

- preview / source トグルはローカル state。ファイル切替でリセット
- preview では行番号を**出さない**。行強調（from/to）は source モードでのみ有効
- **2000行超**のファイルは preview を無効化し source に落とす（`PREVIEW_MAX_LINES=2000`、task-0050 a4）
- 折り返しトグルは source モードのみ
- **モード切替時にスクロール位置を割合（fraction）で復元**する——preview と source では行の高さが違う
  ため、再カウント単位ではなく割合で。復元は切替のたびに**1回だけ**（非同期描画完了の再実行で
  手動スクロール位置を巻き戻さない）

## 4. プレビューの描画規約

- 読込中・言語非対応でも**素のコードを出して読める状態を保つ**（ハイライト不可時は plain text fallback）
- `mermaid`・`csv` は動的 import（初回ロードに載せない）
- diff は行ごとに色分け（naive 判定）

## 5. モバイル対応（決定21）

- 2カラム（ツリー＋プレビュー）は幅がせまいと 1カラムに縦積み：ツリー単独→ファイル選択でプレビューへ
  遷移、上戻りはバーでツリーへ戻す
- ペイン内スクロールは素直な垂直スクロールのみ
- `env(safe-area-inset-bottom)` 等の実機余白を入れて下端まで見えるようにする（chat-ui と同じ節配）

## 6. 未決事項・今後の展望（実装前）

ここより下は**現実装では未着手**。VSCode の explorer（`fileImportExport.ts`・`fileActions.ts`・
`explorerViewer.ts`）および file upload UX のベストプラクティスを参照に、追加候補を整理する。

D1（不可逆な外部副作用：書き込み・削除・アップロードは one-way）のため、実装前は PO 承認と場所の
許可（`place.request_write`）が要る。

### 6.1 ファイル操作の追加候補

| 操作 | 内容 | 前提 |
|---|---|---|
| **アップロード** | 複数ファイルを `<input type=file multiple>` で選択→ツリー内の target フォルダへ書き込み。進捗表示・上書き確認・1件なら即 preview 開く | その場所の書き込み許可 |
| **ダウンロード** | 単ファイルは blob 保存。フォルダ／複数は構造を保った zip | 閲覧権限のみで可 |
| **ドラッグ&ドロップ** | OS からの投入＝**アップロード**（フォルダに落とす）。ツリー内の移動＝**移動／コピー**（`file.write`）。自己への移動・祖先への移動・readonly は弾く。フォルダ hover で auto-expand | 移動は書き込み許可、DROP はフォルダのみ |
| **新規ファイル／フォルダ** | リスト最下部に vacant label を出し、インラインで名前入力・検証（空／重複／不正文字→ Error、末尾 whitespace→ Warning） | 書き込み許可 |
| **リネーム** | インライン編集（編集中は横スクロール無効）で名前検証・確定 | 書き込み許可 |
| **削除** | 確認ダイアログ（件数認識・「未コミットの変更があります」警告）・ゴミ箱か完全削除 | 書き込み許可（D1） |
| **複数選択** | shift/ctrl の multiple selection で複数操作（削除・ダウンロード等） | – |

実装時の制約：**操作がすべて Tool 契約（`file.write` 等）に落ち、GUI 側に判断・実体操作を置かない**（D5）。
書き込み系はいずれも「その場所の許可」がないと不可で、PO へ `place.request_write` で頼む。

### 6.2 検索・フィルタ（v2 候補）

- リスト上でプレフィックス型 type-ahead 絞り込み
- フォルダ横に一致件数バッジ

### 6.3 未決・未着手

- バイナリ画像のプレビュー（画像の描画）。既存は「バイナリのため表示できません」のみ
- `file.read` の `maxLines` 既定値（現状は `file.grep` 強調行があるとき `Math.max(400, highlightTo + 40)`）
- D1 に関わる操作（§6.1）の実装順序・承認フロー
- 折り返し（wrap）の既定値（現状 false）

## 7. 現実装の持つ「特筆すべき知識」

- stat→親を確かめてからツリーを組み立てる順（`file.stat`→`file.list`→`file.read`）
- preview／source 切替のスクロール復元は「割合」ベース
- `useModuleTool` は指定エンドポイントの Tool を構造化データとして呼ぶ（番頭と同一契約）
