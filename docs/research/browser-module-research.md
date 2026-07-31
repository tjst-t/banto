# ビルトインブラウザモジュール 調査レポート

> 作成: 2026-07-30
> 目的: banto へのブラウザモジュール組み込みの技術的検討

---

## 1. 調査サマリー（結論・推奨）

### 結論

**Palmux2 のブラウザモジュールは、banto が求める「番頭と人が同時に使えるブラウザ」の参照実装としてほぼそのまま使える。**

banto のモジュールシステム（ADR-0010）と Palmux2 のタブモジュールシステムは驚くほど似た設計思想を持っており、Palmux2 の browser タブ（Chromium + Xvfb + x11vnc + noVNC）は banto の `BantoModule` に自然にマッピングできる。

### 推奨

1. **Palmux2 の browser 実装をベースに banto 用ブラウザモジュールを開発する**
   - アーキテクチャ（Xvfb + Chromium + x11vnc + noVNC + CDP）はそのまま流用
   - ランタイム分離（incus-container コンテナ内で実行）の概念は維持
   - 実装言語は Go → TypeScript（banto-core）に移植

2. **案C（外部ブラウザ連携）を基本とし、案A（Playwright ヘッドレス）を CDP 制御層として併用する**
   - 人が見るための画面 = noVNC ベース（Palmux2 方式）
   - AI が操作するための制御 = CDP + Playwright ラッパー
   - iframe 方式（案B）は CORS 制約が厳しく、実用的でない

3. **Google Workspace 連携への展開は、ブラウザモジュールの CDP 経由で可能**
   - Gmail/GDrive 等の操作はブラウザ自動化の典型的なユースケース
   - 認証済みセッションを共有できる（人がログイン → AI も同じセッションを使える）

---

## 2. Palmux2 の調査結果

### 2.1 概要

Palmux2 は tjst-t 組織が開発する、tmux ベースの Web ターミナルクライアント。複数の Claude Code エージェントを並行運用するユースケースを重視する。Go シングルバイナリ（React/TypeScript フロントエンド埋め込み）。

**リポジトリ**: https://github.com/tjst-t/palmux2
**言語**: Go （バックエンド）/ TypeScript （フロントエンド）
**ライセンス**: 不明（ファイル無し）
**スター数**: 0（社内プロジェクト）

### 2.2 アーキテクチャ

Palmux2 のブラウザモジュールは以下の層で構成される：

```
ブラウザ（noVNC）           ← 人が見る
  │ WS (raw RFB binary)
  ▼
Palmux2 サーバ（Go）
  │ VNC byte-pipe relay
  ▼
incus コンテナ
  ├── x11vnc (VNC サーバ, :5900)
  ├── Xvfb (仮想フレームバッファ, :99)
  ├── Chromium (headful, --remote-debugging-port=9222)
  ├── fcitx5 + mozc (日本語入力)
  ├── dbus-daemon (fcitx5↔Chrome 通信用)
  └── CDP relay (bridgeIP:9222 → 127.0.0.1:9222)
                ↑
          Claude Code（CDP 経由でブラウザ操作）
```

**重要な設計判断**:
- Chromium は明示的な `POST .../start` でのみ起動（workspace open 時には自動起動しない）
- 状態機械: `stopped → starting → running`（または `running → stopped`）
- CDP（Chrome DevTools Protocol）ポート 9222 を常時開放 → AI が programmatic に操作可能
- VNC は raw RFB binary を WebSocket で流す（noVNC がクライアント側で処理）
- コンテナ内で日本語入力まで完結（fcitx5 + mozc）

### 2.3 ブラウザ操作モデル

Palmux2 は「人が Chromium を直接操作する + AI が CDP 経由で操作する」という二股モデル：

| 操作者 | 手段 | できること |
|--------|------|-----------|
| 人間（PO） | noVNC（マウス・キーボード） | 自由なブラウジング、フォーム入力、ログイン |
| AI（番頭） | CDP（Chrome DevTools Protocol） | ナビゲーション、クリック、テキスト抽出、スクリーンショット |

**両者が同じ Chromium インスタンスを共有する**ため、人がログインしたセッションを AI もそのまま使える。これは重要な特性。

### 2.4 タブモジュールシステム

Palmux2 のタブシステムは banto のモジュールシステムと高い類似性を持つ：

```go
// Palmux2 の Provider interface
type Provider interface {
    Type() string              // "browser"
    DisplayName() string       // "Browser"
    Protected() bool
    Multiple() bool
    NeedsTmuxWindow() bool
    OnBranchOpen(ctx, branch) ([]domain.Tab, error)
    OnBranchClose(ctx, branch) error
    RegisterRoutes(mux, prefix)
}
```

新しいタブタイプの追加手順：
1. `internal/tab/{type}/provider.go` で Provider 実装
2. `cmd/palmux/main.go` で `tabRegistry.Register({type}.New())`
3. `frontend/src/tabs/{type}/` に React コンポーネント

これは banto の `BantoModule`（tools + views + skills + endpoint）と概念的に対応する。

### 2.5 Palmux2 がブラウザモジュールから学べること

Palmux2 の実装から以下の知見が直接得られる：

1. **コンテナ分離の必要性**: ブラウザは incus-container ランタイムでのみ利用可能。ホストランタイムでは提供しない（セキュリティ分離のため）。
2. **明示的なライフサイクル**: 自動起動ではなく、ユーザまたは AI が明示的に `start` を呼ぶ。
3. **VNC バイトパイプ**: noVNC との通信は raw RFB binary を WebSocket で流すだけで、サーバ側に複雑な加工は不要。
4. **CDP リレー**: コンテナ内の Chromium の CDP ポートにホストからアクセスできるようにするための TCP リレー。
5. **プロファイル永続化**: ホストから bind-mount で Chromium プロファイルを永続化。
6. **日本語入力対応**: fcitx5 + mozc + dbus-daemon のセットアップ手順。

---

## 3. 類似プロジェクトの調査

### 3.1 Browser-use（Python, 107k stars）

| 項目 | 内容 |
|------|------|
| URL | https://github.com/browser-use/browser-use |
| 言語 | Python |
| ライセンス | MIT |
| 概要 | AI エージェントがブラウザを操作するためのライブラリ。最も人気 |

**アーキテクチャ**:
- Playwright を内部で使用（ヘッドレス Chromium）
- `Agent(task="...", llm=...)` でタスク記述 → AI が自律的にブラウザ操作
- ステートレスな操作モデル（セッションは毎回新規）
- MCP サーバ統合あり
- Cloud 版あり（captcha 解決・プロキシ・proxy ローテーション）

**banto との関係**: 
- 職人（Worker Agent）に browser-use を Skill として持たせることができる
- 番頭が直接ブラウザを見る用途には向かない（ヘッドレスが前提）
- 人が同じ画面を見る仕組みは無い

### 3.2 Stagehand（TypeScript, 23k stars）

| 項目 | 内容 |
|------|------|
| URL | https://github.com/browserbase/stagehand |
| 言語 | TypeScript |
| ライセンス | MIT |
| 概要 | AI-first ブラウザ自動化フレームワーク |

**アーキテクチャ**:
- Playwright + CDP ベース
- `act()`（単一アクション）/ `agent()`（マルチステップ）/ `extract()`（構造化データ抽出）
- 自然言語とコードのハイブリッド
- Browserbase クラウドと統合（ヘッドレスブラウザのホスティング）

**banto との関係**:
- TypeScript 製で banto との相性が良い
- Playwright のラッパーとして banto のブラウザモジュール内部で使える
- ただし人が見る画面は提供しない

### 3.3 Nanobrowser（TypeScript, 13.5k stars）

| 項目 | 内容 |
|------|------|
| URL | https://github.com/nanobrowser/nanobrowser |
| 言語 | TypeScript |
| ライセンス | Apache 2.0 |
| 概要 | Chrome 拡張機能ベースの AI web 自動化ツール |

**アーキテクチャ**:
- Chrome 拡張機能として動作
- マルチエージェントシステム（Planner + Navigator）
- 人のブラウザを直接操作（AI が人のブラウザをリモート操作）
- サイドパネル UI
- プライバシー重視（ローカルで完結）

**banto との関係**:
- 「AI と人でブラウザを共有する」という点で最も近いアプローチ
- Chrome 拡張機能なので banto のサーバプロセスとは別の実行モデル
- サイドパネル方式は banto のキャンバスモデルと統合しにくい

### 3.4 MCP Browser Tools

**mcp-chrome**（TypeScript, 12k stars）:
- Chrome 拡張機能ベースの MCP サーバ
- AI アシスタント（Claude など）がブラウザを制御できる
- Chrome の機能（タブ管理、コンテンツ抽出、検索等）を MCP ツールとして公開

**banto との関係**:
- MCP プロトコルは banto の Tool システムと統合可能
- ただしブラウザの表示共有機能は無い

### 3.5 その他

| プロジェクト | 特徴 | banto との関係 |
|-------------|------|----------------|
| browserwing (Go, 1.4k★) | ブラウザ操作を MCP コマンドに変換 | Go 製、軽量 |
| OpenCLI (JS, 27k★) | 任意の Web サイトを CLI 化 | 概念的に参考 |
| UI-TARS-desktop (TS, 38k★) | マルチモーダル AI エージェント | 参考程度 |

---

## 4. 技術アプローチの比較（案A/B/C）

### 案A: Playwright ヘッドレスブラウザ

**概要**: サーバ側で Playwright がヘッドレス Chromium を起動。番頭は Tool 経由で操作。人はキャンバス上のスクリーンショット or 簡易ビューアで確認。

```
banto サーバ
  └── Playwright (ヘッドレス Chromium)
       ├── browser.goto() → Tool
       ├── browser.click() → Tool
       ├── browser.screenshot() → Tool
       └── CDP → AI が直接操作
```

| Pros | Cons |
|------|------|
| 実装が比較的容易 | 人がリアルタイムで画面を見られない |
| Playwright は成熟したライブラリ | スクリーンショットベースだと動きが分からない |
| TypeScript で書ける | JavaScript ヘビーなページは CDP でも制限あり |
| ステートフルな操作（ログイン保持） | ヘッドレス検出を回避する仕組みが必要 |

### 案B: iframe 埋め込みブラウザ

**概要**: キャンバス内に `<iframe>` で任意の URL を表示する。

| Pros | Cons |
|------|------|
| 実装が極めて簡単 | **CORS/X-Frame-Options でほぼ全てのサイトが表示不可** |
| 追加のサーバプロセス不要 | Google/Docs など主要サービスは全て弾く |
| ブラウザのネイティブ機能が使える | 番頭が操作できない（表示だけ） |
| | セキュリティ制約が厳しく、実用不可 |

**結論**: 単独では使えない。CORS ヘッダを出さないサイトがほとんどで、実質的に動作しない。

### 案C: 外部ブラウザ連携（Palmux2 的アプローチ）★推奨

**概要**: コンテナ内で headful Chromium を起動し、VNC で画面を共有。AI は CDP 経由で操作。

```
banto サーバ
  └── incus コンテナ（または Docker）
       ├── Xvfb (仮想ディスプレイ)
       ├── Chromium (headful, --remote-debugging-port=9222)
       ├── x11vnc (VNC サーバ)
       └── CDP relay
            ├── VNC WebSocket → キャンバス上の noVNC（人が見る）
            └── CDP → Tool 経由の AI 操作
```

| Pros | Cons |
|------|------|
| **人と AI が完全に同じ画面を共有** | コンテナランタイムが必要（incus / Docker） |
| 人がログインしたセッションを AI も使える | Chromium + Xvfb + x11vnc の起動に数秒 |
| あらゆる Web サイトが表示可能 | 実装が最も複雑 |
| 日本語入力もリモート側で処理可能（fcitx5） | リソース消費（メモリ 200-500MB） |
| CDP で精緻な制御が可能 | |

### 比較表

| 観点 | 案A（Playwright） | 案B（iframe） | 案C（VNC+CDP）★ |
|------|:---:|:---:|:---:|
| 人が画面を見られる | △（スクリーンショットのみ） | ○（ただし表示不可サイト多数） | **◎**（リアルタイム） |
| AI が操作できる | **◎**（API 豊富） | ✗ | **◎**（CDP 経由） |
| セッション共有（人↔AI） | ✗ | ✗ | **◎** |
| 実装難易度 | 低 | 極低 | 中〜高 |
| 汎用性 | **○** | ✗（CORS） | **◎** |
| リソース消費 | 低 | 無 | 中 |
| 既存コード流用 | Playwright のみ | 無 | **Palmux2 の実装を流用可** |

---

## 5. banto モジュールとしての設計案

### 5.1 ADR-0010 の4点セットへのマッピング

ADR-0010（決定25・27）のモジュール登録単位にマッピングする：

| モジュール要素 | ブラウザモジュールでの対応 |
|---------------|--------------------------|
| **① 接続情報** | `endpoint: { baseUrl: "/api/browser" }` — banto ホスト自身が提供する組み込みモジュール |
| **② Tool（番頭用）** | 下記の Tool 一覧を参照 |
| **③ GUI（キャンバス用）** | `kind: "browser.viewer"` — noVNC 埋め込みビューア |
| **④ SKILL** | `browser.md` — 番頭がブラウザ操作を学習するための既定 SKILL |

### 5.2 提供する Tool 一覧

名前空間ドメイン: `browser.*`（決定9・決定27a）

| Tool 名 | 説明 | パラメータ |
|---------|------|-----------|
| `browser.start` | ブラウザインスタンスを起動 | `url?: string` — 初期URL（省略時は about:blank） |
| `browser.stop` | ブラウザインスタンスを停止 | なし |
| `browser.navigate` | URL へ移動 | `url: string` |
| `browser.click` | 要素をクリック | `selector: string`（CSS セレクタ） |
| `browser.type` | 要素にテキスト入力 | `selector: string`, `text: string` |
| `browser.screenshot` | スクリーンショット取得 | `fullPage?: boolean` |
| `browser.extract_text` | ページのテキストを抽出 | `selector?: string`（省略時は全体） |
| `browser.extract_html` | ページの HTML を抽出 | `selector?: string` |
| `browser.evaluate` | JavaScript を実行 | `script: string` |
| `browser.get_state` | 現在の状態を取得 | なし（起動中/url/title 等） |
| `browser.wait_for_selector` | 要素が現れるのを待つ | `selector: string`, `timeout?: number` |
| `browser.scroll` | スクロール | `x: number`, `y: number` |
| `browser.key_press` | キー入力 | `key: string` |

### 5.3 提供する GUI

キャンバスビューとして以下を提供：

| kind | コンポーネント | 説明 |
|------|--------------|------|
| `browser.viewer` | `BrowserViewer` | noVNC 埋め込みビューア。人がマウス/キーボードで操作可能 |
| `browser.toolbar` | `BrowserToolbar` | 簡易ツールバー（URL表示・進む/戻る・リロード・全画面） |

**パラメータ**:
```typescript
{
  url?: string      // 初期URL（任意）
  fullscreen?: boolean // 全画面表示モード
}
```

### 5.4 アーキテクチャ

```
┌─────────────────────────────────────────────────────┐
│ banto ホスト                                         │
│                                                      │
│  ┌─────────┐  ┌────────────────┐  ┌──────────────┐ │
│  │ Tool     │  │ Canvas (GUI)   │  │ モジュール    │ │
│  │ レジストリ│  │ レジストリ     │  │ レジストリ   │ │
│  └────┬────┘  └───────┬────────┘  └──────┬───────┘ │
│       │               │                   │         │
│  ┌────▼───────────────▼───────────────────▼───────┐ │
│  │         browser モジュール                      │ │
│  │  ┌────────────────────────────────────────┐    │ │
│  │  │ BrowserManager (インスタンス管理)       │    │ │
│  │  │  ┌──────────────────┐                  │    │ │
│  │  │  │ 状態機械         │                  │    │ │
│  │  │  │ stopped→starting│                  │    │ │
│  │  │  │ →running         │                  │    │ │
│  │  │  └──────────────────┘                  │    │ │
│  │  └────────────┬───────────────────────────┘    │ │
│  └───────────────┼───────────────────────────────┘ │
│                  │                                  │
└──────────────────┼──────────────────────────────────┘
                   │
    ┌──────────────┼──────────────┐
    │              │              │
    ▼              ▼              ▼
  incus コンテナ / Docker コンテナ（per-workspace）
  ┌─────────────────────────────┐
  │  Xvfb :99                    │
  │   ├── Chromium (headful)     │
  │   │    └── CDP :9222 ───────→ AI（Tool経由）
  │   └── x11vnc :5900           │
  │        └── VNC WS ─────────→ キャンバス（noVNC）
  │                              │
  │  fcitx5 + mozc（日本語入力）  │
  │  dbus-daemon                 │
  └─────────────────────────────┘
```

### 5.5 Kobo 依存の有無

**Kobo 非依存**（決定23）。ブラウザモジュールは workspace モジュールや worker pool と同じく、Kobo が無くても価値を持つ汎用の道具。

- ブラウザのライフサイクル管理は banto ホストが直接行う
- イベントログ（状態記録）のみ Kobo に送る＝疎結合
- ただし、コンテナランタイム（incus/Docker）の管理は banto のランタイム層が行う

### 5.6 既存モジュールとの関係

| モジュール | 関係 |
|-----------|------|
| workspace (`file.*` / `git.*`) | 独立。ブラウザは別のツール |
| worker pool | ブラウザ操作の実処理を職人に委譲できる（例：`browser.screenshot` を職人が実行） |
| studio (`memory.*` / `skill.*`) | 独立 |
| キャンバス | ブラウザの GUI を表示 |

### 5.7 コンテナランタイム戦略

Palmux2 は incus-container に限定しているが、banto では以下の選択肢がある：

| ランタイム | Pros | Cons |
|-----------|------|------|
| **incus-container** | Palmux2 の実装をほぼ流用可。Kobo との親和性 | incus 必須 |
| **Docker** | より一般的。portability が高い | ランタイム層の追加実装が必要 |
| **内蔵（同プロセス）** | デプロイが簡単 | セキュリティ分離が不十分。依存関係が重い |
| **外部連携（Chrome拡張）** | 人の実際のブラウザを共有 | インストール・セットアップが必要 |

**推奨**: **incus-container を第一対象とし、Docker をフォールバック**（Palmux2 と同じ方針）。Palmux2 の runtime interface とほぼ同じ抽象化で対応可能。

### 5.8 Palmux2 からの移植ポイント

Palmux2 の browser モジュールを banto に移植する際の主な変更点：

| Palmux2 | banto |
|---------|-------|
| `tab.Provider` インターフェース | `BantoModule` 形式 |
| Go の `http.ServeMux` ルーティング | TypeScript の `express` または `fastify` |
| incus 操作は `runtime.Runtime` 経由 | banto のランタイム層（未実装であれば直接 `incus exec`） |
| `frontend/src/tabs/browser/` | `banto-web` 内のビューコンポーネント |
| CDP 操作用 CLI（palmux-browser） | Tool 経由の CDP 操作 |
| noVNC ライブラリ（@novnc/novnc） | 同じライブラリが使える |
| 日本語入力（fcitx5 + mozc） | 同じ設定が使える |

---

## 6. 実装難易度と優先順位

### 6.1 実装フェーズ

#### Phase 0: 基盤（推定期間: 1-2 sprint）
banto にコンテナランタイム抽象化が無ければ先に作る。Palmux2 の `runtime.Runtime` interface と同等のものを banto-core に定義。

#### Phase 1: コアブラウザ管理（推定期間: 2-3 sprint）
- `BrowserManager`（状態機械、ライフサイクル管理）
- incus/Docker 経由の Chromium 起動・停止
- プロファイル永続化（bind-mount）
- CDP ポートの露出

#### Phase 2: GUI（推定期間: 1 sprint）
- noVNC ベースのブラウザビューア
- キャンバスビューとしての登録
- ツールバー（URL表示・進む/戻る/リロード/全画面）

#### Phase 3: AI 操作用 Tool（推定期間: 1-2 sprint）
- 全 Tool の実装（CDP ラッパー）
- `browser.*` 名前空間での登録
- SKILL `browser.md` の作成

#### Phase 4: 日本語入力・高機能（推定期間: 1 sprint）
- fcitx5 + mozc のセットアップ（Palmux2 の設定を流用）
- パフォーマンス最適化

### 6.2 優先順位

| 優先度 | 項目 | 理由 |
|--------|------|------|
| P0 | コンテナランタイム抽象化 | 前提。無いと始まらない |
| P1 | `browser.start/stop` + 画面共有 | 一番の価値。人と AI の画面共有 |
| P2 | `browser.navigate/click/type` | AI 操作。次に必要 |
| P3 | `browser.screenshot/extract_text` | 情報収集。番頭の認知 |
| P4 | CDP 直接アクセス | 高度な操作 |
| P5 | 日本語入力 | Palmux2 からそのまま流用可 |
| P6 | 全画面/ポップアウト | 利便性 |

### 6.3 リスク

| リスク | 影響 | 対策 |
|--------|------|------|
| incus/Docker が環境に無い | ブラウザモジュール使えない | host ランタイムのフォールバックとして Playwright ヘッドレスを用意 |
| Chromium のメモリ消費（200-500MB） | リソース制約 | コンテナにメモリ制限をかける。使用後は必ず stop する文化 |
| ヘッドレス検出 | 一部サイトでブロック | `--headless=new` モードの使用。undetected-chromedriver の検討 |
| CDP の脆弱性 | セキュリティ | CDP はコンテナ内に閉じ、ホストからは relay 経由でのみアクセス |

---

## 7. Google Workspace 連携との親和性

### 7.1 ブラウザモジュールが Google Workspace 連携の基盤になる理由

ブラウザモジュールの最大の価値の一つが **「人がログインしたセッションを AI が共有できる」** こと。

具体的なシナリオ：

```
1. PO（人）がブラウザモジュールを開き、Gmail/Google Calendar にログイン
2. 番頭が `browser.navigate` で同じタブの Gmail を操作
3. 番頭が `browser.extract_text` でメール内容を抽出
4. 番頭が `browser.click` でメール送信まで実行
```

### 7.2 Google Workspace 操作に必要な Tool

ブラウザモジュール + 以下の Tool でほぼ全ての Google Workspace 操作が可能：

| 操作 | ブラウザ Tool | 備考 |
|------|-------------|------|
| Gmail 閲覧 | `browser.navigate` + `browser.extract_text` | GMail の画面を直接操作 |
| Gmail 送信 | `browser.navigate` + `browser.type` + `browser.click` | フォーム操作 |
| Google Calendar 確認 | `browser.navigate` + `browser.screenshot` | 画面キャプチャを番頭が読む |
| Google Drive ファイル操作 | `browser.navigate` + `browser.click` | Drive UI の操作 |
| Google Docs 編集 | `browser.navigate` + `browser.type` | Document の直接編集 |

### 7.3 専用 API とブラウザ経由の比較

| 観点 | 専用 API（Gmail API / Google Calendar API 等） | ブラウザ経由 |
|------|----------------------------------------------|------------|
| 認証 | OAuth 2.0（別途設定が必要） | 人がブラウザでログイン（ブラウザのセッションを共有） |
| できること | API で公開されている操作のみ | **ブラウザでできることは全て可能** |
| レート制限 | API の制限あり | 実質的に制限なし |
| 信頼性 | 高（安定した API） | 中（UI 変更で壊れる可能性） |
| 実装難易度 | 中（API ラッパー） | 低（ブラウザ操作の延長） |

### 7.4 推奨

**両方を持つ**：
- **ブラウザモジュール** = 汎用的な基盤。セットアップ不要ですぐ使える
- **専用 API ラッパー** = 高速で信頼性の高い操作が必要な場合

ブラウザモジュールが Google Workspace 連携の**最初の一歩**として最適で、API 操作はその後、必要に応じて追加するのが現実的。

### 7.5 pi/OpenClaw エコシステム（task-0039）との関係

調査中の pi/OpenClaw エコシステムともブラウザモジュールは補完関係にある：
- pi の職人（Worker Agent）がブラウザ操作を実行するランタイムとして機能
- OpenClaw の Hermes 記憶システムとブラウザで取得した情報を統合
- OpenClaw の Tool システム経由でブラウザ操作を呼び出し

---

## 8. 出典一覧

### リポジトリ

| プロジェクト | URL | 確認内容 |
|-------------|-----|---------|
| Palmux2（tjst-t） | https://github.com/tjst-t/palmux2 | ブラウザモジュールの完全な実装を確認（provider.go, browser.go, cdp.go, handler.go, browser-view.tsx） |
| Browser-use | https://github.com/browser-use/browser-use | README からアーキテクチャ・利用方法を確認 |
| Stagehand | https://github.com/browserbase/stagehand | README から概要・API を確認 |
| Nanobrowser | https://github.com/nanobrowser/nanobrowser | README からアーキテクチャ・機能を確認 |
| mcp-chrome | https://github.com/hangwin/mcp-chrome | 検索結果から概要を確認（README は 404） |
| BrowserWing | https://github.com/browserwing/browserwing | 検索結果から概要を確認 |
| UI-TARS-desktop | https://github.com/bytedance/UI-TARS-desktop | 検索結果から概要を確認 |

### ドキュメント

| ドキュメント | 参照内容 |
|-------------|---------|
| Palmux2 01-architecture.md | タブモジュールシステム、Provider interface、ルーティング |
| Palmux2 workspace-runtime-design.md | コンテナランタイム抽象化、Browser タブの位置づけ |
| banto module.ts | BantoModule インターフェース、ModuleRegistry |
| banto canvas.ts | CanvasViewSpec、キャンバスカタログ |
| banto tool-namespace.ts | Tool 名前空間規則（決定9） |
| banto module-protocol.ts | モジュール間呼び出しプロトコル（決定27b） |

### 確認したが情報が不足していたもの

| ソース | 試したこと | 結果 |
|--------|-----------|------|
| https://github.com/palmux/palmux2 | GitHub API | 404（存在しない） |
| https://github.com/palmux/palmux | GitHub API | 404（存在しない） |
| WebVoyager | GitHub 検索 | 明確に該当するプロジェクトが見つからず |
| mcp-chrome README | raw.githubusercontent.com | 404（ブランチ名が不明） |
| Playwright / Puppeteer | — | 広く知られたツールのため、改めての調査は不要と判断 |

---

## 付録A: Palmux2 のブラウザモジュール概要図

```
POST /tabs/browser/start
  → Xvfb :99 起動
  → dbus-daemon 起動 (セッションバス)
  → fcitx5 起動 (日本語 IME)
  → Chromium 起動 (headful, CDP :9222)
  → x11vnc 起動 (VNC :5900)
  → CDP relay 起動 (bridgeIP:9222 → 127.0.0.1:9222)
  → VNC ポートの応答を確認 → State=running

POST /tabs/browser/stop
  → CDP relay kill
  → x11vnc / fcitx5 / chromium / Xvfb / dbus-daemon pkill
  → State=stopped

GET  /tabs/browser/state
  → { state: "running"|"starting"|"stopped", cdpReachable: bool, available: bool }

WS   /tabs/browser/attach
  → x11vnc :5900 への生 TCP ↔ WebSocket バイトパイプ
  → noVNC が RFB プロトコルを処理
```

## 付録B: banto モジュール登録コード（スケッチ）

```typescript
// packages/banto-browser/src/module.ts
import { createBrowserTools } from "./tools.js";
import { createBrowserViews } from "./views.js";
import type { BantoModule } from "@banto/host";

export const BROWSER_BASE_URL = "/api/browser";

export function createBrowserModule(): BantoModule {
  return {
    name: "browser",
    title: "ブラウザ",
    description: "番頭とPOが同じ画面を見ながら操作できる共有ブラウザ。" +
      "POはnoVNC経由でマウス/キーボード操作、番頭はTool/CDP経由で操作。",
    endpoint: { baseUrl: BROWSER_BASE_URL },
    tools: createBrowserTools(),
    views: createBrowserViews(),
    skills: [{
      name: "browser",
      description: "共有ブラウザの操作方法。",
      content: readSkillFile("browser.md"),
    }],
  };
}
```
