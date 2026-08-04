---
id: spec-chat-ui
type: spec
status: draft
refs: [vision, principles, spec-ui, spec-daemon-core, spec-improvement-loop]
---

# Spec: Chat UI（会話面）

番頭との会話面（チャット）の仕様。スレッド（分身）ごとに独立。

第一原理：会話は**ホストが持つ**（D3）。クライアントは表示と操作のみ。

## 1. 画面構成

```
┌──────────────────────────────────────────────────────┐
│ [ThreadTabs...]  ─ 番頭と相談する  │  新しい会話  │  │  header
├───────┬──────────────────────────────────────────────┤
│       │  ┌── ChatScrollArea (StickToBottom) ──┐     │
│       │  │                                     │     │
│       │  │  [Canvas tabs]                       │     │
│       │  │  ─────────                             │     │
│       │  │  ▼ ChatArea                          │     │
│       │  │  - 送り主のメッセージ (po)            │     │
│       │  │  - 推論/思考 (reasoning)             │     │
│       │  │  - 番頭のメッセージ (banto)          │     │
│       │  │  - ツールの状態 (tool)               │     │
│       │  │  - 知らせ (notice)                   │     │
│       │  │  - エラー (error)                    │     │
│       │  │  [自動追従: 最下部にいてストリーミング中]│     │
│       │  └───────────────────────────────────────┘     │
│       │  [↓ ボタン: 最下部にいないとき]                │
│       │  ┌────── Composer ────────────────────┐      │
│       │  │ 入力欄 + 添付 + 送る/中断            │      │
│       │  └─────────────────────────────────────┘      │
│       └──────────────────────────────────────────────┘
│  Canvas（表示状態）    Chat（会話）                     │
├──────────────────────────────────────────────────────┤
│ [Mobile footer: チャット / キャンバス]               │
└──────────────────────────────────────────────────────┘
```

## 2. 会話履歴（Transcript）

### 2.1 エントリタイプ（TranscriptEntry）

| role | 説明 | 表示 | 追記 |
|---|---|---|---|
| `po` | POの発話 | 右寄せテキスト行 | × |
| `reasoning` | 番頭の思考/推論（streaming中はShimmer、「Thought for Xseconds」） | Collapsible（自動開閉） | **あり（streaming中）** |
| `banto` | 番頭の発話（Markdown） | 左寄せMarkdownレンダリング | **あり（streaming中）** |
| `tool` | ツール呼び出し状態 | Collapsible（名前＋ステータスバッジ＋引数JSON＋結果JSON） | **あり（state更新）** |
| `notice` | 外からの知らせ（職人・別の会話） | タグ付き、デフォルト畳み | × |
| `error` | エラー行 | 赤背景、×ボタンで消せる | × |

### 2.2 エントリのマッピング（WS → 表示）

`text_delta` → `reasoning` または `banto` エントリに追記（streamingモード）。
`tool_start` → `tool` エントリ新規作成（`state: 'running'` / `'input-streaming'`）。
`tool_end` → 対応する `tool` エントリの state を更新（`'output-available'` / `'output-error'`）。

### 2.3 追記ルール (applyDelta)

- 新行（`po_message`, `notice`）→ 配列末尾へ追加
- `text_delta` → 既存の最終 `banto` エントリに in-place 追記（参照維持、`React.memo` 最適化）
- `tool_end` → matching な `tool` エントリの state を in-place 変更（`'running'` → `'ok'` / `'failed'`）

```
applyDelta(prev, event):
  po_message    → [...prev, { role: "po", text }]
  notice        → [...prev, { role: "notice", source, text }]
  text_delta    → last.banto.text += delta; return [...prev]
  tool_start    → [...prev, { role: "tool", name, state: "running" }]
  tool_end      → prev[n].state = event.isError ? "failed" : "ok"; return [...prev]
  turn_end      → errorMessage なら [...prev, { role: "error", text }]
  error         → [...prev, { role: "error", text: event.message }]
```

### 2.4 未読 (unread)

見ていないスレッドに `notice` / `text_delta` が届くとき (`marksUnread`)。スレッド切替で解除。

## 3. スクロール追従 (StickToBottom)

Vercel AI Elements (`use-stick-to-bottom`) の準拠仕様。

### 3.1 定数

| 定数 | 値 | 用途 |
|---|---|---|
| `AT_BOTTOM_SLACK_PX` | 70 | "最下部付近"の閾値。scrollDiff <= 70px を locked と判定 |

### 3.2 状態遷移

```
┌────────────────────────────────────────────────────┐
│  INITIAL: wasAtBottom=true                           │ ← マウント時
│  ↓ スクロール（最下部保持）                           │
│  LOCKED (auto-follow)                                 │
│  - atBottom=true                                      │
│  - scrollDiff <= 70px にて自動追従                   │
│  - smooth scroll (spring animation)                  │
│  ↓ スクロールUP かつ 70px超過 かつ 選択中でない       │
│  UNLOCKED (user)                                      │
│  - atBottom=false                                     │
│  - ↓ ボタン表示                                       │
│  ↓ スクロールDOWN かつ 70px内 OR 送信 or チャンネル切替│
│  LOCKED (re-lock: smooth scroll)                     │
└────────────────────────────────────────────────────┘
```

### 3.3 Lock 解除条件（すべて）

1. スクロール UP（`scrollDifference < 0`）
2. 閾値超過（`scrollDifference < -70px`）
3. テキスト選択中でない（`isSelecting() === false`）

### 3.4 Re-lock 条件（いずれか）

1. スクロール DOWN かつ最下部付近（`0 < scrollDifference <= 70px`）
2. PO がメッセージを送信
3. PO がスレッド切替 → 該当スレッドを選択
4. ストリーミング中、番頭が応答を開始（`busy=true`）
5. ↓ ボタンクリック

### 3.5 spring animation 定数

| パラメータ | 値 | 用途 |
|---|---|---|
| `damping` | 0.7 | 減衰率 |
| `stiffness` | 0.05 | 加速度 |
| `mass` | 1.25 | 慣性 |

### 3.6 イベント順序ガード

```
ResizeObserver → content 変更を検知
  ↓ (setTimeout 1ms)
scroll event → ignore (animation 由来) または user action として処理
```

## 4. ストリーミング表示

### 4.1 文字列折り返し

`banto` / `reasoning` エントリの `text` がストリーミング中に逐次更新される。表示は `text-wrap` ありで折り返す。

### 4.2 Markdown レンダリング

各 `text_delta` 到着時に全文を再レンダリング。プラグイン:
- `remark-gfm`（表、打ち消し線、タスクリスト）– banto 独自拡張
- CJKテキストセグメンテーション – ai-elements から
- コードハイライト（Shiki）– banto 維持

### 4.3 途切れ防止（Partial Response）

`text_delta` は 1文字〜数文字単位。各delta到着時の再レンダリングでは既存のDOMツリーを再利用しつつ変更行のみを更新。`React.memo` + 参照維持が有効に働く。

## 5. 推論/思考表示 (Reasoning)

Vercel AI Elements の `<Reasoning>` コンポーネントに相当する仕様。

### 5.1 表示パターン

| ストリーミング中 | 表示内容 |
|---|---|
| `isStreaming=true` | Shimmer（脈打つインジケータ）+ "Thinking..."（日本語: "考えています"） |
| `isStreaming=false`, `duration=0` | 「X秒間考えました」 |
| `isStreaming=false`, `duration>0` | 「X秒間考えました」 |
| `isStreaming=false`, `duration=null` | 「考えました」 |

### 5.2 開閉自動制御

| 状態 | 動作 |
|---|---|
| **ストリーミング開始** | Collapsible **自動開く**（`defaultOpen=false` で明示的に閉じていない場合） |
| **ストリーミング終了、初回** | **1秒後に自動閉じる**（`AUTO_CLOSE_DELAY=1000ms`） |
| **ユーザーが手動操作** | 自動開閉無効（`isOpen` は user 制御） |

### 5.3 実装（React context）

`ReasoningContext` を Collapsible 内で提供：
- `isStreaming: boolean` – ストリーミング状態
- `isOpen: boolean` – Collapsible 開閉状態
- `isExplicitlyClosed: boolean` – 明示的に閉じられたか
- `hasEverStreamed: boolean` – 過去にストリーミングしたか
- `startTimeMs: number | null` – ストリーミング開始時刻

### 5.4 banto での実装例

```tsx
function ReasoningRow({ text, isStreaming }) {
  const [isOpen, setIsOpen] = useControllableState({
    defaultProp: isStreaming,  // streaming 中 → 開く
    prop: undefined,
  });

  // streaming 開始 → 自動開く
  useEffect(() => {
    if (isStreaming && !isOpen) setIsOpen(true);
  }, [isStreaming, isOpen]);

  // streaming 終了 → 1秒後に自動閉じる
  useEffect(() => {
    if (!isStreaming && isOpen && hasEverStreamed) {
      const t = setTimeout(() => setIsOpen(false), 1000);
      return () => clearTimeout(t);
    }
  }, [isStreaming, isOpen]);

  return (
    <Collapsible open={isOpen}>
      <CollapsibleTrigger>
        {isStreaming ? <Shimmer>"考えています"</Shimmer> : (
          `考えました (${duration}秒)`
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Markdown>{text}</Markdown>
      </CollapsibleContent>
    </Collapsible>
  );
}
```

## 6. ツール呼び出し表示 (ToolCall)

Vercel AI Elements の `<Tool>` コンポーネントに相当する仕様。

### 6.1 ツール状態遷移

Vercel AI の `ToolUIPart` / `DynamicToolUIPart` におけるツール状態は以下の5状態:

| 状態 | banto でのマッピング | 表示 |
|---|---|---|
| `input-streaming` | `tool_start` 直後 | `ツール名 ・ ・ ・` （Pending / 待機中） |
| `input-available` | ツール実行中 | `ツール名 ・ ・ ・` （Running / 実行中、pulse icon） |
| `approval-requested` | 未使用 | 将来対応（Awaiting Approval） |
| `output-available` | `tool_end {success}` | `ツール名 ✓` （Completed） |
| `output-error` | `tool_end {error}` | `ツール名 ✗` （Error / Error表示） |
| `output-denied` | 未使用 | 将来対応（Denied） |
| `approval-responded` | 未使用 | 将来対応（Responded） |

### 6.2 ツール表示UI

```
┌────────────────────────────────┐
│ 🔧 ファイル読込          Running ▸│  ← header（開ける）
│                                │
│  Parameters                   │
│  ```                        │  ← CollapsibleContent 内の引数表示
│  { "path": "/", "glob":  │        （jsonコード）
│   }                         │
│                                │
│  Result                       │
│  ```                        │  ← 結果表示
│  [file content...]          │        （jsonコード）
│  ```                        │
└────────────────────────────────┘
```

### 6.3 ステータスバッジ

| 状態 | バッジ | アイコン | 色 |
|---|---|---|---|
| `input-streaming` | Pending | ○ | – |
| `input-available` | Running | ● | 青（pulse） |
| `output-available` | Completed | ○ | 緑 |
| `output-error` | Error | × | 赤 |
| `approval-requested` | Awaiting Approval | ● | 黄 |
| `approval-responded` | Responded | ○ | 青 |

### 6.4 banto での簡易実装

```tsx
function ToolRow({ entry }) {
  const [isOpen, setIsOpen] = useState(false);
  const stateLabel = entry.state === 'running' ? '' :
                     entry.state === 'ok' ? ' ✓' : ' ✗';

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger>
        <span className="tool-dot" />
        {entry.name}{stateLabel}
        <ChevronDownIcon className={isOpen ? 'rotate-180' : ''} />
      </CollapsibleTrigger>
      {isOpen && (
        <CollapsibleContent>
          <pre>{entry.input && JSON.stringify(entry.input, null, 2)}</pre>
          <pre>{entry.output && JSON.stringify(entry.output, null, 2)}</pre>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
```

## 7. コンポーザ (Composer)

### 7.1 入力欄

| 項目 | 仕様 |
|---|---|
| 高さ | 自動伸長（`scrollHeight` 基準）、最大キャップあり |
| 自動リサイズ | `draft` 変更時に `scrollHeight` を基準に再計測 |
| キャップ | `chatPaneRef.clientHeight / 3`（コンポーザーが会話の 1/3 を超えない）|
| 最低高 | 56px（`MIN_COMPOSER_HEIGHT_PX`） |
| placeholder | `busy=true` のとき「番頭が考えています...」、otherwise「番頭に相談する」 |
| 背景色 | `busy=true` のとき入力不可（`disabled`） |

### 7.2 キーボード

| キー | 動作 |
|---|---|
| `Enter` | 送信（IME 変換中は送信しない：`isComposing` チェック） |
| `Shift+Enter` | 改行（IME 変換中でも可） |
| `Ctrl+Enter` | 送信（IME 中も可） |
| `Backspace` | 未実装（次回以降） |

### 7.3 添付ファイル

| ファイル種別 | 扱いは | 上限 |
|---|---|---|
| 画像 | base64 に変換、`vision` 対応モデルのみ | 20MB |
| テキスト | 内容そのまま WS ペイロードに | 100KB |

### 7.4 クリップボード画像

`onPaste` で画像をキャプチャ → `FileUIPart` として `pending` 状態に加える。テキストのみの貼り付けは textarea に渡す。

### 7.5 ドラッグ&ドロップ

`onDrop` でファイルを受け付ける。画像の場合は base64 に変換、テキストの場合は内容読み取り。

## 8. スレッド管理（分身）

### 8.1 スレッド状態

| 状態 | 説明 | タブ表示 | 履歴表示 |
|---|---|---|---|
| `open` | 現在アクティブまたは複数開ける | 表示（`ThreadTabs`） | 表示 |
| `closed` | 畳まれた | 非表示 | `ThreadHistory` 表示 |

### 8.2 切替ルール

- `new_session` → **自分**のみ自動的に新スレッドへ移行（`followNewThread` flag）。番頭が別の分身を開いたときは移らない（決定2「目の前の話は壊れない」）
- スレッド畳む → 開いている先頭のタブへ自動移行
- スレッド再オープン → 即座に切替 + 未読解除

## 9. スクロール位置のリバウンド（Reflow）

### 9.1 問題

画像/テキストファイルの読込（`FileReader`/`readAsBase64`）の完了で `pending` 配列が増え、Composer の高さが変わる → コンテナの高さが変わり、スクロール位置が変化。

### 9.2 対策

`useLayoutEffect` で composer 高さを計測 → `requestAnimationFrame` 後に `scrollToBottom()` を呼ばない（re-lock 条件を満たすなら呼び出す）。

## 10. Edge Cases

| ケース | 振る舞い |
|---|---|
| WebSocket 再接続 | 全 `chat` を `history` で復元。`wasAtBottom` は復元後の測定で再計算 |
| 同時接続 | 各スレッドの状態はスレッド毎に独立。delta 混線なし |
| 大きな画像添付 | base64 変換中、Composer 高さが動的に変動。re-lock 判定に支障なし（measure は直前で再実行） |
| メッセージ送信中 | `send()` → 即座に `busy=true` + `turn_start`。送信完了まで UI は入力不可 |
| 画面サイズ変更 | `ResizeObserver` にて検知 → re-lock 判定。`atBottom` が `true` なら smooth scroll で追随 |
| ストリーリング折り返し | ツール呼び出しが長文の場合、CollapsibleContent が折り返す。overflow-x: auto が有効に働く |
| 空の会話 | 空状態メッセージ（「番頭に話しかけてください...」）を表示 |

## 11. 未決事項

- 70px 閾値の妥当性（実際の UX で微調整必要なら `docs/notes/` で記録）
- スクロールアニメーションの spring 定数の最適化（damping/stiffness/mass は Vercel と同じ値で十分か）
- `text_delta` のバッチ処理閾値（一度の delta から UI 更新まで、何 ms あるいは何文字ごとにバッチするか）
- `reasoning` データの送信方法（`text_delta` とは別 `reasoning_delta` 事件として送信するか、テキストの一部として含めるか）
- ツールの引数・結果表示の詳細（banto のツールは引数・結果を現在保持していないが、今後追加するかどうか）
