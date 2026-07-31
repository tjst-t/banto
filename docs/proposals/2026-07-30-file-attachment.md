# チャットへの画像・ファイル添付機能の提案

## 現状

チャット入力（`packages/banto-web/src/App.tsx`）は**単純な `<textarea>` のみ**で、ファイル添付機能は一切無い。PO はテキストでしか番頭に情報を渡せない。

プロトコル（`packages/banto-host/src/protocol.ts`）の `TranscriptEntry` は `role: "po"` が `text: string` だけを持ち、ファイルを添付するフィールドが無い。通信路は WebSocket 上の JSON テキストであり、バイナリ転送の仕組みは実装されていない。

ファイルを番頭に見せる手段は間接経路しかない：職人に依頼してワークツリーに置かせ、その上で `file.read` で読ませる。スクリーンショットを撮って貼ったり、設計書 PDF をそのまま渡したりする直接的な方法が存在しない。

画像のプレビュー機能については別提案（`docs/proposals/2026-07-30-file-browser-preview-mode.md`）で検討中だが、これは既存ファイルを file.browser で開いたときの表示品質を改善するものであり、**そもそも画像を banto に渡す手段が無い**現状は変わらない。プレビューの議論より前に、まず添付の経路が必要である。

### 関連する既存機能

- `file.*` / `git.*` ツールは**ワークスペース内の既存ファイル**を閲覧するもので、アップロード機能は持たない
- `.banto/` ディレクトリは既に git 管理から除外（`.gitignore` に記載済み）されており、実行時データの保管領域として使われている（`memory.jsonl`、`worker-pool/`）

## ユースケース

1. **スクリーンショットを貼る**: PO がバグのスクショを撮ってチャットに Ctrl+V で貼り、番頭に「このエラー画面について説明して」と指示する
2. **設計書 PDF を添付**: PO が仕様書 PDF をドラッグ＆ドロップして番頭に読ませる。「この設計書に沿って実装して」
3. **画像を見せながら指示**: 「この画面のここを直して」と画面キャプチャを添付して指示する
4. **ログファイルの添付**: エラーログをファイルで送って番頭に分析させる
5. **音声ファイル・動画の添付**: （将来の拡張として）画像以外のマルチメディアを番頭に渡す

## 検討

### A. 添付方法の選択肢

#### 案1: クリップボード経由（ペースト）

`<textarea>` に `onPaste` イベントを追加し、`ClipboardEvent.clipboardData.files` から画像を取得する。

- Pros: 操作が直感的、スクリーンショットに最適（Win: Win+Shift+S → Ctrl+V、Mac: Cmd+Shift+4 → Cmd+V）
- Cons: 大容量ファイルには不向き、ブラウザによってはペースト可能な MIME タイプに制限がある
- 技術: `ClipboardEvent.clipboardData.items` を走査し、`item.type.startsWith("image/")` で画像を拾う

#### 案2: ドラッグ＆ドロップ

チャット領域に `onDragOver` / `onDrop` を設定し、`DataTransfer.files` からドロップされたファイルを取得する。

- Pros: 複数ファイル対応、OS のファイルマネージャから直接ドロップできる
- Cons: ペーストとは別のイベント処理（重複コードを避けるため共通化が必要）
- 技術: `<div>` 全体をドロップゾーンにし、`DragOver` で `preventDefault()` して受け入れ可能にする

#### 案3: ファイル選択ダイアログ（ボタンクリック）

チャット入力欄の近くに `📎` ボタンを配置し、`<input type="file" hidden>` をトリガーする。

- Pros: 確実、モバイルでも使える、すべてのブラウザで動作
- Cons: クリック数が増える（ペーストよりワンアクション多い）
- 技術: 隠し `<input>` を ref で保持し、ボタンクリックで `inputRef.current.click()` を呼ぶ

#### 推奨案: 3つすべて対応する

ペースト、ドラッグ＆ドロップ、ボタンクリックの3経路をすべて用意する。ユーザーがその場面で最も自然な方法を選べる。技術的にはイベントハンドラが異なるだけで、ファイル取得後の共通処理（バリデーション、base64 エンコード、プレビュー表示）は関数に切り出せる——案の組み合わせではなく「3つの入口から1つのパイプラインへ」の設計。

### B. ファイルの保存先

#### 案A: ワークスペース内の専用ディレクトリ（`.banto/attachments/`）

添付ファイルを `.banto/attachments/` に保存する。番頭は `file.read` でそのまま読める。

- Pros:
  - 番頭（および職人）が既存の `file.*` ツールで直接読める
  - `.banto/` は既に git 管理から除外済み（`.gitignore`）
  - ワークスペースのファイルシステム上にあるため、永続性がある
- Cons:
  - ディスク容量を消費する
  - 同一ファイルの重複保存が起きうる（ハッシュ or タイムスタンプで管理）
  - 番頭の Tool から `file.read` できる範囲が workspace 内であるため、保存先が workspace 内に無いと読めない。`.banto/` は workspace 内なので問題無い

#### 案B: ホスト側の専用ストレージ

ホストプロセスが専用のアップロードディレクトリを持つ（例: `$BANTO_DATA_DIR/uploads/`）。

- Pros: ワークスペースと完全に分離できる。複数ワークスペースを跨ぐ場合もホスト側で一元管理できる
- Cons: 番頭が読むための別経路（専用 Tool: `attachment.read` 等）が必要。既存の `file.*` ツールで読めない
- 補足: `$BANTO_DATA_DIR`（既定 `.banto/`）を使うなら記述が増えるだけで、案A と実質同じになる

#### 案C: メモリ上＋base64 埋め込み（永続化しない）

添付内容を base64 で WebSocket メッセージに直接埋め込んで送る。保存先は持たない。

- Pros: 保存先不要、実装が最もシンプル、再起動時にゴミが残らない
- Cons:
  - メッセージサイズが肥大化（画像1枚で数MB → JSON が巨大に）
  - 再読み込みで添付が消える（会話履歴の復元時にも問題）
  - 大量・大容量ファイルに対応できない
  - 会話履歴（`transcript`）がメモリを圧迫する

#### 推奨案: 案A（`.banto/attachments/`）＋案C（小さいファイルは base64 直接埋め込みも併用）

二段構えにする。

**第一段階（小さいファイル・画像）**: ファイル内容を base64 エンコードし、`PromptMessage` の拡張フィールドとして WebSocket 経由で送る。ホスト側で受けたら:
- 画像（MIME type が `image/*`）かつ 500KB 未満 → base64 のまま会話コンテキストへ展開（画像対応 LLM にそのまま見える）
- 画像以外のテキストファイル → 内容をそのままテキストとして展開
- 上記以外 → `.banto/attachments/` に一旦保存し、パスのみ保持

**第二段階（大きなファイル・将来）**: 10MB を超えるファイルは HTTP エンドポイント経由で事前アップロードし、参照 URL またはパスを WebSocket メッセージに載せる。

初期実装では全ファイルを base64 で済ませてもよい（後述の「プロトコル設計」を参照）。ただし会話履歴（`transcript`）への保存は `.banto/attachments/` へのパスで行い、メモリ上の履歴オブジェクトが肥大化するのを防ぐ。

### C. プロトコル設計

現在の `PromptMessage`（クライアント → サーバ）は `{ type: "prompt", text: string }` のみ。

#### 方式1: base64 で JSON に埋め込む

`PromptMessage` に `attachments` フィールドを追加する。

```typescript
// 拡張後の PromptMessage
export interface Attachment {
  name: string;       // ファイル名（"screenshot.png"）
  mime: string;       // MIME type（"image/png"）
  size: number;       // バイト数
  data: string;       // base64 エンコードされた内容
}

export interface PromptMessage {
  type: "prompt";
  text: string;
  attachments?: Attachment[];  // 追加
}
```

- Pros: 既存の WS 接続をそのまま使える。実装が簡単。既存の `applyDelta` / `record` 機構に最小の変更で載せられる
- Cons: 大きなファイル（> 数 MB）には不向き。JSON が巨大化するとフレームサイズ制限（Node.js の WebSocket 実装ではデフォルトで 1MB？）にひっかかる可能性がある。メッセージのパース時間も増える
- 対策: 添付ファイルの全サイズ合計が 10MB を超える場合は拒否する（クライアント側で事前チェック）

#### 方式2: HTTP アップロードエンドポイント + 参照

別途 HTTP の `/api/upload` エンドポイントを設け、ファイルを先にアップロードする。レスポンスで得た URL またはパスを WebSocket メッセージに載せる。

```typescript
// プロトコルは変わらず、attachments がパス参照になる
export interface Attachment {
  name: string;
  mime: string;
  size: number;
  path: string;       // HTTP アップロード後のパス（".banto/attachments/screenshot.png"）
  data?: never;       // base64 は使わない
}
```

アップロードエンドポイント:

```
POST /api/upload
Content-Type: multipart/form-data

レスポンス: { path: ".banto/attachments/xxx.png", name: "screenshot.png", size: 12345 }
```

- Pros: 大きなファイルに対応、バイナリに最適（base64 より 33% 効率的）、プログレスバーの表示が容易、既存の会話履歴（transcript）の肥大化を防げる
- Cons: 別経路（HTTP）が必要。アップロード中の状態管理（進捗・エラー・キャンセル）が必要。接続している WS とは別の接続管理が必要

#### 推奨案: 方式1（base64）を優先実装、方式2は後に拡張

理由:

1. **初期のユースケースは画像（スクリーンショット）が中心**で、数 MB 以下である。base64 で十分
2. **第一実装のハーネス（pi coding agent）は WebSocket の JSON メッセージをそのままプロンプトへ流す**。HTTP エンドポイントを追加すると、ハーネス側でもファイルの解決経路が必要になる。base64 ならメッセージにデータが載っているので追加の解決が不要
3. **方式2はホストサーバにファイル保存の責務とエンドポイント設計が追加される**。初期実装の複雑さを抑えるために後回しにする

制限: 1メッセージあたりの添付ファイルの全サイズ合計が **10MB** を超える場合はクライアント側でブロックする。超える場合は「ファイルが大きすぎます。HTTP アップロード経由で送るか、ファイルを分割してください」と表示する。

#### 会話履歴での保持

`TranscriptEntry` の `role: "po"` に `attachments` フィールドを追加する。

```typescript
export type TranscriptEntry =
  | { role: "po"; text: string; attachments?: Attachment[] }
  | { role: "banto"; text: string }
  | { role: "notice"; text: string }
  | { role: "tool"; name: string; state: "running" | "ok" | "failed" }
  | { role: "error"; text: string };
```

`Attachment` の `data`（base64）は**履歴に保存するときは省略する**（または `.banto/attachments/` へのパスに置き換える）ことで、`transcript` 配列のメモリ肥大化を防ぐ。再接続時の `HistoryEvent` でも `data` は送らない（代わりに `path` があればそれを送る）。すなわち:

- WebSocket 送信時（`PromptMessage`）: `data`（base64）を含む
- 会話履歴保存時（`transcript`）: `data` は含まず、`path` のみ保持。画像の再表示が必要な場合は `path` から `file.read` で取得する
- クライアントの `ChatRow` 表示: 送信直後はメモリ上の `data` を使ってプレビュー表示。再接続時は `path` から取得

ただしこの「data を履歴から省く」設計は初期実装では複雑すぎる。**最初は base64 のまま履歴に保存してしまっても良い**（会話が長くなければ問題にならない）。問題が顕在化した時点で最適化する（D9: pre-release は壊してよい）。

### D. 番頭（AI）が添付ファイルを読む仕組み

添付ファイルは番頭のプロンプトにどう届けるか。

LLM プロバイダによって、画像を解釈できるもの（Anthropic Claude 3.5+、OpenAI GPT-4o、Google Gemini）とできないもの（テキストのみのモデル）が混在する。プロバイダ層はプラガブル（CLAUDE.md）であり、番頭はモデルの能力を把握して適切に扱う必要がある。

#### 画像ファイルの場合

```typescript
// ホスト側で PromptMessage を受け取った後の処理（疑似コード）
if (attachment.mime.startsWith("image/")) {
  if (modelSupportsVision()) {
    // 画像対応LLM: base64 を直接 image content block としてプロンプトに埋め込む
    prompt.images.push({ source: { type: "base64", media_type: attachment.mime, data: attachment.data } });
  } else {
    // 非対応モデル: メタデータのみ伝える
    prompt.text += `\n\n[添付画像: ${attachment.name} (${formatSize(attachment.size)})]`;
  }
}
```

- **画像対応 LLM**（Anthropic, OpenAI, Gemini 等）: base64 データをマルチモーダル content block としてプロンプトに埋め込む。LLM が直接画像を認識する
- **非対応モデル**: 「画像が添付されました（ファイル名: screenshot.png, サイズ: 120KB）」のようなメタデータをテキストで伝える。番頭は必要に応じて職人にファイル解析を依頼する

#### テキストファイルの場合

```typescript
if (isTextMime(attachment.mime) && attachment.size <= MAX_TEXT_SIZE) {
  prompt.text += `\n\n--- 添付ファイル: ${attachment.name} ---\n${base64Decode(attachment.data)}`;
} else {
  prompt.text += `\n\n[添付ファイル: ${attachment.name} (${formatSize(attachment.size)})]`;
  // 大きなテキストファイルは「必要なら file.read を使って読んでください」と伝える
}
```

- 小〜中サイズのテキストファイル: 内容をそのままテキストとしてプロンプトに展開する
- 大きなテキストファイル（100KB 超）: ファイル名とサイズのみ伝え、番頭が `file.read` で必要な範囲を読む

#### PDF 等のバイナリファイル

```typescript
if (!isTextMime(attachment.mime) && !attachment.mime.startsWith("image/")) {
  prompt.text += `\n\n[添付ファイル: ${attachment.name} (${formatSize(attachment.size)}, ${attachment.mime})]`;
}
```

- ファイル名とサイズのみ通知
- 番頭は必要に応じて職人に解析を依頼する（「このPDFを読んで内容を要約して」）
- PDF のパースや OCR は番頭の責務を超える（D10: 職人へ委譲）

### E. UI 実装

#### 現在のチャット入力（変更前）

```
┌──────────────────────────────────────┐
│ [メッセージを入力…]                    │  ← `<textarea>`
│                                      │
│ Enter で送信 · Shift+Enter で改行  [送る] │
└──────────────────────────────────────┘
```

#### 変更後

```
┌──────────────────────────────────────┐
│                                      │
│  添付ファイルのプレビュー領域          │  ← 新規: 送信前に確認できる
│  [screenshot.png] [log.txt] [×]      │
│                                      │
│ ┌──────────────────────────────────┐ │
│ │ 📎 メッセージを入力…              │ │  ← `<textarea>`＋📎ボタン
│ │                                  │ │
│ └──────────────────────────────────┘ │
│ Enter で送信 · Shift+Enter で改文  [送る] │
│ ここにドロップ（またはペースト）してください │  ← DnDヒント（新規）
└──────────────────────────────────────┘
```

#### 追加する UI 要素

**1. 📎 ファイル添付ボタン**

`<textarea>` の左上または右上に重ねて配置する。

```tsx
<div className="chat-input-wrap">
  <button className="chat-attach-btn" onClick={() => fileInputRef.current?.click()} title="ファイルを添付">
    📎
  </button>
  <textarea className="chat-input" ... />
  <input type="file" ref={fileInputRef} hidden multiple onChange={onFileSelected} />
</div>
```

**2. ドロップゾーン**

`.chat-composer` 全体（またはチャット入力欄を含む領域）をドロップゾーンにする。ドラッグ中は枠の色を変えて視覚的フィードバックを出す。

```tsx
const [dragging, setDragging] = useState(false);

<div
  className={`chat-composer ${dragging ? "is-drag-over" : ""}`}
  onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
  onDragLeave={() => setDragging(false)}
  onDrop={(e) => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files); }}
>
```

**3. ペースト対応**

```tsx
<textarea
  onPaste={(e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault(); // テキストとしてのペーストを抑制
        const file = item.getAsFile();
        if (file) handleFiles([file]);
      }
    }
  }}
/>
```

**4. 添付プレビュー**

送信前に添付ファイルの一覧をサムネイル表示する。各ファイルの×ボタンで削除可能。

```tsx
function AttachmentPreview({ files, onRemove }: { files: AttachmentFile[], onRemove: (index: number) => void }) {
  return (
    <div className="attachment-preview">
      {files.map((file, i) => (
        <div key={i} className="attachment-chip">
          {file.mime.startsWith("image/")
            ? <img src={URL.createObjectURL(file.raw)} className="attachment-thumb" alt={file.name} />
            : <span className="attachment-icon">📄</span>
          }
          <span className="attachment-name">{file.name}</span>
          <span className="attachment-size">{formatSize(file.size)}</span>
          <button className="attachment-remove" onClick={() => onRemove(i)}>×</button>
        </div>
      ))}
    </div>
  );
}
```

**5. ドロップヒント**

`<textarea>` の下に小さなヒントテキストを追加する（DnD が使えることを示す）。

```tsx
<div className="chat-drop-hint">ここにファイルをドロップ（またはペースト）できます</div>
```

#### プロトコル拡張に伴う変更箇所

| ファイル | 変更内容 |
|----------|----------|
| `protocol.ts` | `PromptMessage` に `attachments?: Attachment[]` を追加。`TranscriptEntry` の po ロールに `attachments` を追加 |
| `useBantoSession.ts` | `send()` がファイルを受け取れるように拡張。`submit()` → ファイル付きの `PromptMessage` を送信 |
| `App.tsx` | 添付ボタン・DnD・ペースト・プレビューの実装。`draft` と共に `attachments` 状態を管理 |
| `server.ts` | `onMessage` で `attachments` を受け取り、ホストセッションの `prompt()` に画像 content block として渡す処理を追加 |
| `styles.css` | 添付プレビュー・📎ボタン・DnD オーバーレイのスタイル追加 |

#### プロトコル拡張の詳細

```typescript
// protocol.ts への追加

export interface Attachment {
  name: string;    // ファイル名
  mime: string;    // MIME type
  size: number;    // バイト数
  data: string;    // base64 エンコードされた内容
  path?: string;   // .banto/attachments/ 内のパス（保存した場合、再接続時）
}

// PromptMessage の拡張
export interface PromptMessage {
  type: "prompt";
  text: string;
  attachments?: Attachment[];  // 追加
}

// TranscriptEntry の po ロール拡張
export type TranscriptEntry =
  | { role: "po"; text: string; attachments?: Attachment[] }  // attachments を追加
  | { role: "banto"; text: string }
  | { role: "notice"; text: string }
  | { role: "tool"; name: string; state: "running" | "ok" | "failed" }
  | { role: "error"; text: string };
```

### F. 制限事項

| 項目 | 制限値 | 理由 |
|------|--------|------|
| 1メッセージあたりの最大ファイル数 | 10個 | プロンプトが埋まるのを防ぐ（画像1枚でもトークンを消費する） |
| 1ファイルの最大サイズ | 10 MB | WebSocket フレームサイズ制限を避ける。それ以上は HTTP アップロード経由にフォールバック（将来実装） |
| 許可する MIME タイプ | `image/*`, `text/*`, `application/pdf`, `application/json`, `application/xml` | 実行ファイル（.exe, .zip, .dmg 等）はブロック。ただし workspace に直接置かれているファイルは対象外（別の制御経路） |
| 保存先 | `.banto/attachments/`（永続化） | 再起動後もファイルが利用可能。ただしホスト側で定期的なクリーンアップ（7日超過のファイル削除等）を設けても良い |
| 履歴中の data 保持 | 接続中のみ（再接続時は path 参照） | transcript のメモリ肥大化を防ぐ。ただし初期実装では base64 のまま保持して良い |

#### 拒否するファイル種別

`.exe`, `.dll`, `.so`, `.dylib`, `.bin`, `.zip`, `.tar.gz`, `.7z`, `.rar`, `.iso`, `.dmg` 等の実行ファイル・アーカイブはセキュリティ上の理由から拒否する。リストはクライアント側・サーバ側の両方でチェックする（サーバ側で最終判定）。

### G. サーバ側の処理

ホストサーバ（`server.ts`）で `PromptMessage` を受け取った際の追加処理:

```typescript
// サーバ側（疑似コード）
private async handlePromptMessage(ws: WebSocket, message: PromptMessage): Promise<void> {
  this.record({ role: "po", text: message.text, attachments: message.attachments });
  this.broadcast({ type: "po_message", text: message.text, attachments: message.attachments });

  // 添付ファイルをプロンプトに追加
  const attachments = message.attachments ?? [];
  if (attachments.length > 0) {
    await this.session.prompt(this.buildPromptWithAttachments(message.text, attachments));
  } else {
    await this.session.prompt(message.text);
  }
}

private buildPromptWithAttachments(text: string, attachments: Attachment[]): string {
  // プロバイダの画像対応状況は session のプロパティから判断（抽象化）
  // 画像は content block、テキストは文字列としてマークアップ
  // プロバイダの wire 形式への変換はモジュール（LLM seam）が行う
  let result = text;
  for (const att of attachments) {
    if (att.mime.startsWith("image/")) {
      result += `\n\n![${att.name}](data:${att.mime};base64,${att.data})`;
    } else if (att.mime.startsWith("text/") || att.mime === "application/json") {
      const decoded = Buffer.from(att.data, "base64").toString("utf-8");
      result += `\n\n--- ${att.name} ---\n${decoded}`;
    } else {
      result += `\n\n[添付ファイル: ${att.name} (${att.mime}, ${att.size} bytes)]`;
    }
  }
  return result;
}
```

ただし、画像対応 LLM の場合は Markdown の `data:` URL ではなく、プロバイダの画像 content block 形式で渡す必要がある。この変換は banto-core の LLM seam（プロバイダアダプタ）の責務とする——番頭ホストはプロバイダ非依存の形で添付をプロンプトに載せる。

実際の pi ハーネス（第一実装）での画像転送は pi の Tool 呼び出し規約に従う。pi が画像 content block をサポートしている場合、プロンプトテキストに埋め込む代わりに Tool 呼び出しの引数として base64 画像を渡す方式も検討する（具体的な結合方法はハーネス差し替え可能性の枠組みの中で決定される——ADR-0010）。

### H. 会話履歴への表示

送信された添付ファイル付きメッセージは、会話履歴（`chat`）に以下のように表示される:

**PO 発話（画像添付）:**
```
┌──────────────────────────┐
│ この画面のレイアウトを    │
│ 直してください           │
│                          │
│ ┌──┐                    │
│ │🖼│ screenshot.png      │
│ └──┘  120KB              │
└──────────────────────────┘
```

**PO 発話（テキストファイル添付）:**
```
┌──────────────────────────┐
│ エラーログを読んで原因を  │
│ 教えてください           │
│                          │
│ 📄 error.log  3KB        │
└──────────────────────────┘
```

画像のサムネイルは `data:` URL または `URL.createObjectURL` で表示する。クリックで拡大表示（または新しいタブで開く）を提供するかは、実装時の判断に委ねる（提案の範囲外）。

### I. セキュリティ上の考慮点

1. **base64 データのサイズ制限**: 悪意ある巨大な base64 文字列による DoS を防ぐため、サーバ側でも最大サイズ（10MB）をチェックする
2. **MIME type 検証**: クライアント側のチェックは spoofing 可能。サーバ側でも `file` コマンドや `magic bytes` の簡易チェックを入れる（特に画像の場合: PNG は先頭8バイト `\x89PNG\r\n\x1a\n` 等）
3. **実行ファイルの拒否**: `.exe` 等の実行形式はサーバ側でも拡張子＋magic bytes で拒否する
4. **パス・トラバーサル**: 保存先 `.banto/attachments/` 内でファイル名に `../` 等が混入しないよう、`path.basename` でファイル名のみ取り出す
5. **保存ファイルの削除**: 自動クリーンアップ機能を設ける場合は「番頭が意図せず添付を失わない」よう、既定では削除しない方向とする（手動クリーンアップ可）

### J. 実装の優先順位

1. **プロトコル拡張**: `protocol.ts` に `Attachment` 型・`PromptMessage.attachments`・`TranscriptEntry` の拡張を追加
2. **サーバ側ハンドリング**: `server.ts` で `attachments` を受け取り、プロンプトに展開する処理
3. **📎ボタン＋ファイル選択ダイアログ**: 最も確実な添付経路。最小実装
4. **ドラッグ＆ドロップ**: チャット領域全体で DnD を受け付ける
5. **ペースト対応**: `onPaste` で画像を拾う実装
6. **添付プレビューUI**: 送信前のサムネイル表示と削除
7. **画像対応LLMへの最適化**: プロバイダ seam で画像 content block に変換
8. **保存先の永続化**: `.banto/attachments/` への保存と再接続時の復元
9. **HTTP アップロードエンドポイント**: 大きなファイル向けの別経路（将来拡張）

### K. 関連する既存提案との関係

- **`file-browser-preview-mode.md`**: 既存ファイルのプレビュー機能（Markdown レンダリング・シンタックスハイライト等）を file.browser に追加する提案。これは banto の workspace 内にあるファイルの表示品質を改善するもの。本提案（添付機能）とは目的が異なり、直交する。ただし「画像を file.browser でプレビューできる」は添付画像を過去の会話から見直す際にも有用であり、両者が揃うと相乗効果がある
- **`banto-studio-module.md`**: 記憶・SKILL の GUI 操作。本提案とは独立

## 作成日

2026-07-30

## 状態

**提案。** 採否は未確定。本提案は PO（番頭）の裁定を仰ぐためのものである。

### 決定を仰ぐべき論点

1. **添付機能の優先度**: スクリーンショットの貼り付けは現状のワークフローで最大のペインポイントの1つ。file-browser-preview-mode より先に実装すべきか、あるいは後か
2. **プロトコル方式**: base64 優先（方式1）で進めてよいか。HTTP エンドポイント（方式2）は後でもよいか
3. **保存先**: `.banto/attachments/`（案A）でよいか。それとも記憶とは別の管理領域が必要か
4. **制限値**: ファイル上限 10MB / 10個 / 許可 MIME 一覧は妥当か
5. **画像対応LLMと非対応モデルの扱い**: 非対応モデルへのフォールバック（「画像が添付されました」とだけ伝える）でよいか、あるいは事前に変換（画像を説明するテキストを自動生成）すべきか
6. **会話履歴のサイズ問題**: base64 を履歴に保存してよいか、最初から path 参照方式を取るべきか

### 番頭が自ら決定できる範囲（D9）

以下の項目は番頭が自ら決定する（ただし本提案の採否が決まった後の実装フェーズで判断するもの）：

- 添付プレビューの具体的なレイアウト・スタイル
- ドロップ中の視覚的フィードバック（枠の色・サイズ）
- サムネイルの最大サイズ（何 px まで表示するか）
- ファイルサイズのフォーマット（KB / MB の閾値）
- 自動クリーンアップのポリシー（する場合の期間）
- 各制限値の微調整（MIME タイプの追加・削除）

---

## 採否（2026-07-31、番頭）

**採用。** ただし本提案の「決定を仰ぐべき論点」のうち、下記は番頭の判断で決めた（D9の範囲。
利用体験は変わるが本物のトレードオフではない）。**新しい依存は1つも要らない**ため、
D1 に触れる部分は無い。

- **論点2（プロトコル方式）**：base64 で始める。WS の JSON に載せる形なら経路が1本で済み、
  受け口を増やさずに始められる（D6）。HTTP エンドポイントは大きなファイルが実際に
  詰まってから足す
- **論点3（保存先）**：`.banto/attachments/`。`.banto/` は既に gitignore 済みで、
  実行時データの置き場という既存の意味づけにそのまま乗る（確認済み）
- **論点4（制限値）**：10MB / 10個 で始める。**足りなければ広げればよい**——
  最初から広く取ると、詰まったときの原因が分からなくなる
- **論点6（履歴のサイズ）**：**base64 を会話履歴に持たない。** 保存したファイルのパスと
  サムネイル用の小さなプレビューだけを持つ。会話は task-0036 で永続化する対象なので、
  ここに数MBの文字列を混ぜると、会話を読むたびに引きずることになる（D3：導出できる
  ものを二重に持たない）

**PO の裁定が要るものとして残す**：

- **論点1（優先度）**：他の起票済みタスク（epic-0006 の残り・task-0034 等）との順序。
  これは PO の関心の配分そのもの
- **論点5（画像非対応モデルの扱い）**：フォールバックで「画像が添付されました」とだけ
  伝えるか、説明文を自動生成するか。後者は**LLM呼び出しが1回増える**（コスト）ため、
  利用体験と費用のトレードオフになる

### 提案の前提で1つ補足

「そもそも画像を banto に渡す手段が無い」は、**現状そのとおり**。ただし PO は
palmux 経由で画像を Claude 側に渡せているため、ペインポイントの大きさは
「番頭に渡せない」ことに限られる。実装順序を決めるときはそこを踏まえること。
