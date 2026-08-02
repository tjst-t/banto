---
id: epic-0011
type: epic
title: file.browser のプレビューモード（Markdown・図・コード・CSV・diff のレンダリング表示）
status: draft
refs: [2026-07-30-file-browser-preview-mode]
---

## 目的

FileBrowser（`packages/banto-web/src/views/FileBrowser.tsx`）は現在、ファイル内容をすべて生テキスト表示している。Markdown のレンダリング表示と preview/source のモード切替を導入し、図（Mermaid）・コード（シンタックスハイライト）・CSV/TSV（テーブル）・diff/patch（色分け）を適切に表示する。デフォルトは preview モード（レンダリング表示）とし、トグルで生テキスト（source モード）に切り替えられるようにする。

**採否の経緯**：

- 2026-07-31 の番頭の採否判断で「既存依存で足りる4項目（Markdown プレビュー／preview-source トグル／折り返しトグル／diff 色分け unified）」を採用。新しい依存も外部通信も増やさない範囲
- 2026-08-02 の PO 裁定で Mermaid・shiki（シンタックスハイライト）・papaparse（CSV）も採用。依存追加を伴うが PO 裁定済み

## ユースケース

- 番頭・PO が `.md` ファイルを開くと見出し・リスト・リンク・テーブル・引用・コードブロックがレンダリング表示され、ソースを頭の中で補完せずに読める（長文のスクロールも減る）
- Mermaid 図（`.mmd` / `.mermaid` ファイル、Markdown 内の ` ```mermaid ` コードブロック）が SVG で表示され、図の形状を理解するために頭の中でパースする必要がない
- コード種別ファイル（`.ts` / `.py` / `.rs` 等）が色分け表示され、可読性が高い。テーマ切替（ライト／ダーク）にも対応する
- CSV/TSV ファイルがテーブル表示され、列構造が目視でなく一覧として追える
- diff/patch ファイルが行単位で色分けされ、何が増えて何が減ったかが一目で分かる
- preview/source のモード切替でレンダリング結果と生テキストを行き来できる。source モードでは折り返しトグル（既定 OFF＝現状維持）で長い行の扱いを選べる

## スコープ外

- **PlantUML**: 描画先（URL）を設定したときだけ描く設計（PO 裁定済み）。既定値は空で、設定しない限り外部へ送信しない。設定機構が要るため別タスク
- **draw.io**: ローカル描画（`@maxgraph/core`）は依存追加を伴うため保留
- **画像プレビュー**: workspace モジュール側の API 拡張が必要（`file.read` はテキスト前提）なため対象外。画像を banto へ渡す経路は `2026-07-30-file-attachment.md`（採用済み）が扱う
- **diff/patch の side-by-side 表示**: 今回は unified のみ（色分けは行う）
- **Markdown 内の画像埋め込み表示**: 画像プレビューと同じくモジュール側の対応が必要になるまで対象外
