# pi / OpenClaw エコシステム調査レポート

> 作成: 2026-07-30 | 調査者: 職人（Worker Agent）
> 目的: pi coding agent / OpenClaw の拡張機能エコシステムを調査し、banto のモジュールシステム（ADR-0010）との連携可能性を評価する

---

## 1. 調査サマリー（結論・推奨）

### 結論

**pi と OpenClaw のエコシステムは、banto のモジュールシステムと高い親和性を持つ。特に OpenClaw の Plugin SDK は、banto が目指す「モジュール＝4点セット（接続情報・Tool・GUI・SKILL）」の参照実装として極めて有用である。**

1. **pi は拡張性に優れた軽量ハーネス。** 6375 の pi パッケージが npm に存在。Extension API による Tool 追加は極めて簡単（20〜50行の TypeScript）。一方で GUI は TUI（ターミナルUI）に限定される。

2. **OpenClaw は成熟したプラグインエコシステムを持つ。** Plugin SDK（openclaw/plugin-sdk/*）により Tool・Provider・Channel・Hook・CLI backend などを宣言的に登録可能。Plugin Manifest（openclaw.plugin.json）による declarative config validation が秀逸。ClawHub パッケージレジストリあり。

3. **Google Workspace 連携は既に存在する。** OpenClaw 用の公式 Google Workspace プラグイン（@tensorfold/openclaw-google-workspace）が24の Tool を提供。MCP 経由の Google Workspace サーバも複数存在（taylorwilsdon/google_workspace_mcp: ⭐2938）。

4. **banto のモジュールシステム（ADR-0010 決定25・27）は OpenClaw Plugin のサブセットに近い。** banto モジュール＝接続情報＋Tool＋GUI＋SKILL は、OpenClaw Plugin の manifest + registerTool + registerChannel + registerHttpRoute でほぼそのまま表現できる。

5. **「Toolは簡単・GUIは大変」は概ね正しいが、OpenClaw が真価を発揮する。** 単純な API 叩きは Tool だけで十分。複数選択・ドラッグ・設定画面等は GUI が必要だが、OpenClaw の Control UI はタブ・パネル・データバインディングを宣言的に追加できる。

### 推奨

1. **banto のモジュールシステム設計は OpenClaw Plugin SDK を参照する。** 特に `openclaw.plugin.json`（manifest）、`definePluginEntry`、`registerTool`、tool policy のアーキテクチャは banto の設計に直接応用できる。

2. **OpenClaw プラグインを banto モジュールとして wrap するブリッジを検討する。** OpenClaw のエコシステムをそのまま banto でも使えるようにする。

3. **MCP 互換性は後回し。** pi 自体が「No MCP」を掲げて CLI Tool を推奨している。banto も SKILL.md ＋ Tool 方式を優先し、MCP は必要な場合のみブリッジを用意する。

4. **Google Workspace 連携は既存の OSS 資産を活用する。** OpenClaw プラグインまたは MCP サーバを wrap する形で実装するのが現実的。OAuth2 の実装は既存ライブラリ（googleapis）を使えばツール 1 つあたり 100〜200 行。

---

## 2. pi coding agent のエコシステム

### 2.1 基本アーキテクチャ

- **リポジトリ**: [badlogic/pi-mono](https://github.com/badlogic/pi-mono)（MIT）
- **言語**: TypeScript（strict）
- **インストール**: `npm install -g @mariozechner/pi-coding-agent`
- **モード**: interactive, print, JSON, RPC, SDK embedding
- **設計思想**: 「最小限のコア、徹底的な拡張性」— サブエージェント・プランモード・パーミッションポップアップ等は拡張で実現するスタイル

### 2.2 拡張ポイント

pi は 4 種類の拡張メカニズムを持つ：

| 拡張種別 | 形式 | 用途 | 発見方法 |
|----------|------|------|----------|
| **Extension** | TypeScript モジュール（`export default function(pi: ExtensionAPI)`） | カスタムTool・イベント購読・コマンド・UIコンポーネント | `~/.pi/agent/extensions/` / `.pi/extensions/` / pi package |
| **Skill** | SKILL.md（agentskills.io 形式） | ワークフロー定義・手続き記憶 | `~/.pi/agent/skills/` / `.pi/skills/` / pi package |
| **Prompt Template** | Markdown ファイル（`{{variable}}`） | 再利用可能なプロンプト | `~/.pi/agent/prompts/` / `.pi/prompts/` |
| **Theme** | TypeScript / JSON | 配色・UI テーマ | `~/.pi/agent/themes/` / `.pi/themes/` |

### 2.3 Extension API の詳細

Extension は以下の機能を提供する：

```typescript
export default function (pi: ExtensionAPI) {
  // カスタム Tool の登録
  pi.registerTool({
    name: "my_tool",
    label: "My Tool",
    description: "Does something",
    parameters: Type.Object({ /* TypeBox schema */ }),
    execute: async (toolCallId, params, signal, onUpdate, ctx) => ({
      content: [{ type: "text", text: "Done" }],
      details: {},
    }),
  });

  // スラッシュコマンド
  pi.registerCommand("stats", { description: "...", handler: async (args, ctx) => {} });

  // キーボードショートカット
  pi.registerShortcut("ctrl+shift+p", { description: "...", handler: async (ctx) => {} });

  // CLI フラグ
  pi.registerFlag("plan", { type: "boolean", default: false });

  // イベント購読
  pi.on("session_start", async (event, ctx) => {});
  pi.on("tool_call", async (event, ctx) => { /* ブロック可能 */ });
  pi.on("tool_result", async (event, ctx) => { /* 変更可能 */ });
  pi.on("before_agent_start", async (event, ctx) => { /* system prompt 変更 */ });
  pi.on("context", async (event, ctx) => { /* メッセージ変更 */ });
  // ... 他多数
}
```

**提供される UI API（ctx.ui）**:
- `ctx.ui.notify(msg, level)` — 通知
- `ctx.ui.confirm(title, msg)` — 確認ダイアログ
- `ctx.ui.select(title, options)` — 選択肢
- `ctx.ui.input(title, placeholder)` — テキスト入力
- `ctx.ui.setStatus(key, text)` — フッターステータス
- `ctx.ui.setWidget(name, lines, placement?)` — editor 上部/下部の Widget
- `ctx.ui.setHeader(component)` / `ctx.ui.setFooter(component)` — カスタムヘッダー/フッター
- `ctx.ui.setEditorText(text)` — editor のテキスト設定
- `ctx.ui.custom(component)` — 任意の TUI コンポーネント（キーボード操作可）
- など

### 2.4 既定の Tool

| Tool | 説明 |
|------|------|
| `read` | ファイル読み取り（画像も対応） |
| `bash` | シェルコマンド実行 |
| `edit` | ファイル編集（exact text replacement） |
| `write` | ファイル作成/上書き |
| `grep` | テキスト検索 |
| `find` | ファイル検索 |
| `ls` | ディレクトリ一覧 |

`--tools` フラグでフィルタ、`--no-builtin-tools` / `--no-tools` で無効化可能。

### 2.5 エコシステムの規模

- **npm pi パッケージ**: 6375 件（`keywords: pi-package`）— 2026-07-30 現在
- **主要なサードパーティ拡張**:
  - `pi-mcp-adapter`（⭐人気）— MCP サーバを pi で使うブリッジ
  - `pi-subagents` — サブエージェント委譲
  - `pi-web-access` — Web 検索・URL 取得
  - `pi-hermes-memory` — Hermes Agent 記憶システム連携
  - `pi-lens` — LSP・リンター・フォーマッタ統合
  - `context-mode` — コンテキスト最適化
  - `@remnic/plugin-pi` — 記憶拡張
  - `@tintinweb/pi-subagents` — Claude Code スタイル subagents

### 2.6 pi パッケージシステム

```bash
pi install npm:@foo/pi-package     # npm から
pi install git:github.com/user/repo # git から
pi update                          # 一括更新
pi list                            # 一覧表示
pi config                          # 拡張の有効/無効
```

`package.json` の `pi` キーで manifest を定義：

```json
{
  "name": "my-pi-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

### 2.7 MCP との関係

- **pi の公式スタンス**: 「No MCP」（[理由ブログ](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/)）
  - CLI Tool + bash で十分なケースが多い
  - MCP サーバは Tool 定義が肥大化しコンテキストを消費する
  - ただし `pi-mcp-adapter` や `pi-mcp-extension` は公式・非公式に存在
- **コミュニティ実装**: `pi-mcp-adapter`（v2.15.0）は `.mcp.json` を読み込み、1つの proxy tool 経由でオンデマンドに MCP ツールを呼び出す。Context window 節約設計。

---

## 3. OpenClaw のエコシステム

### 3.1 基本アーキテクチャ

- **リポジトリ**: [openclaw/openclaw](https://github.com/openclaw/openclaw)（MIT）
- **組織**: OpenClaw Foundation（非営利）
- **言語**: TypeScript（pnpm workspace）
- **インストール**: `npm install -g openclaw@latest`
- **モード**: Gateway デーモンとして常駐 + WebSocket 経由の各種チャネル接続
- **設計思想**: 「自分だけのパーソナル AI アシスタント、自分のデバイスで動作」
- **pi との関係**: pi の README で「OpenClaw 参照 = 現実世界の SDK 統合例」として明記

### 3.2 チャネル（対応数 25+）

WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, iMessage, SMS（Twilio）, IRC, Microsoft Teams, Matrix, Feishu, LINE, Mattermost, Nextcloud Talk, Nostr, Synology Chat, Tlon, Twitch, Zalo, QQ, WebChat 等

### 3.3 Plugin アーキテクチャ（3層）

OpenClaw は「Tool・Skill・Plugin」の3層で機能を拡張する：

| 層 | 説明 | 実装 |
|----|------|------|
| **Tool** | Agent が呼び出す型付き関数 | `api.registerTool()` |
| **Skill** | SKILL.md 命令パック（agentskills.io） | ワークスペースの `skills/<name>/SKILL.md` |
| **Plugin** | ツール・プロバイダ・チャネル・フックを1単位でパッケージ | **Plugin Manifest + Plugin SDK** |

### 3.4 Plugin Manifest（openclaw.plugin.json）

**banto のモジュールシステム設計にとって最重要の参照資料。**

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "description": "...",
  "configSchema": { "type": "object", "properties": {} },
  "contracts": {
    "tools": ["my_tool"]
  },
  "activation": { "onStartup": true },
  // オプション:
  "channels": ["discord"],
  "providers": ["anthropic"],
  "skills": ["./skills"],
  "dashboard": { "dataBindings": [...], "actionVerbs": [...] },
  "setup": { "providers": [{ "id": "example", "envVars": ["API_KEY"] }] },
  "providerAuthChoices": [...],
  "toolMetadata": { "my_tool": { "optional": true, "replaySafe": true } },
  "mcpServers": { "example": { "transport": "stdio", "command": "node", "args": ["./server.js"] } }
}
```

**ポイント**:
- `configSchema` で設定を宣言的にバリデーション（Plugin コード未ロードでも検査可能）
- `contracts.tools` で所有 Tool を宣言（実行時 import 不要で発見可能）
- `activation.onStartup` で起動時ロードを明示的に選択
- `dashboard` で Web UI のタブ・データバインディングを宣言
- `toolMetadata` で Tool の optional / auth 必要性を宣言

### 3.5 Plugin SDK（openclaw/plugin-sdk/*）

SDK はサブパスインポート方式：

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";

export default definePluginEntry({
  id: "my-plugin",
  register(api) {
    api.registerTool({
      name: "my_tool",
      description: "...",
      parameters: Type.Object({ input: Type.String() }),
      outputSchema: Type.Object({ ... }),
      async execute(id, params) {
        return { content: [{ type: "text", text: `Got: ${params.input}` }], details: {} };
      },
    });
  },
});
```

**登録可能なもの一覧**:

| メソッド | 登録対象 |
|----------|----------|
| `api.registerTool(tool, opts?)` | Agent Tool（必須または optional） |
| `api.registerProvider(...)` | LLM プロバイダ |
| `api.registerChannel(...)` | メッセージングチャネル |
| `api.registerCommand(def)` | カスタムコマンド（LLM バイパス） |
| `api.registerHook(events, handler, opts?)` | イベントフック |
| `api.registerHttpRoute(params)` | Gateway HTTP エンドポイント |
| `api.registerGatewayMethod(name, handler)` | Gateway RPC メソッド |
| `api.registerService(service)` | バックグラウンドサービス |
| `api.registerCli(registrar, opts?)` | CLI サブコマンド |
| `api.registerSpeechProvider(...)` | TTS/STT |
| `api.registerAgentHarness(...)` | ネイティブ Agent 実行基盤 |
| `api.session.controls.registerControlUiDescriptor(...)` | ** Control UI タブ・パネル** |
| `api.registerMcpServerConnectionResolver(...)` | MCP サーバ接続解決 |
| `api.registerTrustedToolPolicy(...)` | Tool 呼び出しポリシー |

### 3.6 Control UI と GUI 拡張

**OpenClaw は宣言的な Web UI 拡張を備える。**

```typescript
api.session.controls.registerControlUiDescriptor({
  surface: "tab",
  id: "logbook",
  label: "Logbook",
  description: "Your day as a timeline.",
  icon: "sun",
  group: "control",    // control | agent
  order: 10,
  requiredScopes: ["operator.write"],
  // 外部 UI なら path を指定（sandboxed iframe で表示）
  path: "/plugin/logbook",
});
```

dashboard manifest でデータバインディングも宣言可能：

```json
{
  "dashboard": {
    "dataBindings": [
      { "id": "items.list", "method": "example.items.list", "description": "List items." }
    ],
    "actionVerbs": [
      { "id": "refresh", "method": "example.items.refresh", "description": "Refresh.", "paramShape": {} }
    ]
  }
}
```

### 3.7 エコシステムの規模

- **ClawHub パッケージレジストリ**: [clawhub.ai](https://clawhub.ai) — プラグイン配布ハブ
- **npm の OpenClaw プラグイン**: 多数存在（`openclaw` を依存関係に持つパッケージ）
- **主要サードパーティプラグイン**:
  - `@tensorfold/openclaw-google-workspace` — Google Workspace 全サービス連携
  - `composio-community/openclaw-composio-plugin` — 1000+ サードパーティ Tool（Gmail, Slack, GitHub, Notion 等）
  - `agenticros/agenticros` — ROS ロボット統合
  - `proyecto26/notebooklm-ai-plugin` — Google NotebookLM 連携
  - `wbbtmusic/openclaw-antigravity-oauth` — Google Antigravity OAuth

### 3.8 pi と OpenClaw の関係まとめ

| 観点 | pi | OpenClaw |
|------|----|----------|
| **役割** | ターミナルコーディングエージェント | パーソナル AI アシスタント |
| **UI** | TUI（Terminal UI） | チャネル（WhatsApp/Telegram 等）+ Web Control UI |
| **拡張** | Extension（TS ファイル） | Plugin（manifest + SDK） |
| **インストール** | `pi install npm:pkg` | `openclaw plugins install clawhub:pkg` |
| **マニフェスト** | `package.json#pi` | `openclaw.plugin.json` |
| **SDK 埋め込み** | `@mariozechner/pi-coding-agent` | デーモンとして外部アプリから RPC / SDK |
| **メモリ/記憶** | 拡張で追加（Hermes Agent 等） | 内蔵（セッション永続化 + プラグイン拡張） |
| **Tool 登録** | `pi.registerTool()` | `api.registerTool()` |
| **MCP** | 「No MCP」— CLI Tool 推奨 | 対応（MCPサーバ宣言可能） |
| **ライセンス** | MIT | MIT |

**両者の関係は競合ではなく補完。** pi は banto の職人ハーネス、OpenClaw は常駐型パーソナルアシスタントとして、banto の異なる側面を実装できる。

---

## 4. エコシステム活用の可能性

### 4.1 banto モジュールとのマッピング

ADR-0010 決定25「モジュール＝4点セット」：

| banto 要素 | pi での表現 | OpenClaw での表現 |
|------------|-------------|-------------------|
| **接続情報**（認証・設定） | Extension 内の定数 / env | `configSchema` + `providerAuthChoices` |
| **Tool** | `pi.registerTool()` | `api.registerTool()` + `contracts.tools` |
| **GUI**（Canvas） | なし（TUI のみ） | `registerControlUiDescriptor()` + Dashboard |
| **SKILL** | `SKILL.md` ファイル | `skills/` + plugin manifest |

### 4.2 pi Extension を banto Module としてラップ

pi の Extension を banto で使うには、2つの方法がある：

**A. 直接利用（pi がハーネスの場合）**
- banto の Worker Pool が pi をランタイムとして使う場合、pi の Extension をそのままロード
- 制約: pi の `ExtensionAPI` 型に依存。GUI（Canvas）は pi の TUI に限定

**B. アダプタ経由（pi 非依存の場合）**
- pi の Extension の `registerTool` 呼び出しを banto-core の `NamespacedToolDefinition` に変換
- Tool 定義は TypeBox / JSON Schema で統一可能（pi は TypeBox を使用）
- イベントフック（`tool_call`, `tool_result`）は banto の Tool middleware に相当

### 4.3 OpenClaw Plugin を banto Module としてラップ

OpenClaw Plugin の方がマッピングが容易：

```typescript
// OpenClaw Plugin の Tool
api.registerTool({
  name: "google_gmail_search",
  parameters: Type.Object({ query: Type.String() }),
  execute: async (id, params) => { /* ... */ },
});

// → banto Module の Tool（ほぼ同じ形状）
// banto-core の NamespacedToolDefinition として wrap
```

**特に OpenClaw の以下の機能は banto 設計に直接応用できる：**

1. **Plugin Manifest による宣言的設定バリデーション** → banto もモジュールごとに設定スキーマを持ち、configSchema で validation
2. **`contracts.tools` による所有権宣言** → banto のドメイン名前空間プレフィックス（決定9）と同趣旨
3. **`activation.onStartup`** → banto のモジュールロード戦略
4. **`registerControlUiDescriptor`** → banto の Canvas GUI 宣言
5. **`api.registerTool(..., { optional: true })`** → banto の依存ゲート発想に近い

### 4.4 MCP との関係

**推奨: banto は MCP を直接採用せず、必要な場合のみブリッジ。** 理由：

- pi の哲学に従い「CLI Tool + bash で十分」の判断
- MCP サーバは Tool 定義が肥大化しコンテキストを消費
- `pi-mcp-adapter` のような既存ブリッジで対応可能
- banto の SKILL.md（agentskills.io）形式で MCP と同等の機能をカバーできる

**ただし MCP エコシステムの資産は無視できない**（Google Workspace MCP サーバ: ⭐2938）。

```
banto Module ──► MCP Bridge ──► MCP Server（Google Workspace 等）
```

のようなアダプタパターンを用意しておくのが現実的。

---

## 5. Google Workspace 連携ケーススタディ

### 5.1 既存実装の状況

**OpenClaw プラグイン**（最も完成度が高い）:
- `@tensorfold/openclaw-google-workspace` — 1つのOAuthフローで6サービス（Gmail, Calendar, Drive, Contacts, Tasks, Sheets）をカバー。24のToolを提供。⭐実績あり
- `composio-community/openclaw-composio-plugin` — 1000+ツール（Gmail等を含む）

**MCP サーバ**（pi互換）:
- `taylorwilsdon/google_workspace_mcp`（⭐2938） — Gmail, Calendar, Docs, Sheets, Slides, Chat, Forms, Tasks, Search & Drive
- `aaronsb/google-workspace-mcp`（⭐164） — 認証＋Gmail＋Calendar＋Drive
- `Get-Concord-AI/concord-mcp`（⭐167） — AI Agent 向け Google Workspace
- `dguido/google-workspace-mcp`（⭐39） — Drive, Docs, Sheets, Slides, Calendar, Gmail, Contacts
- `j3k0/mcp-google-workspace`（⭐32） — Gmail + Calendar

### 5.2 OAuth2 認証の扱い

Google Workspace 連携で最大の課題は OAuth2：

- **OpenClaw プラグイン方式**: OAuth Desktop Client 型の credential JSON をファイル保存。`begin_auth` → URL 発行 → コード入力 → `complete_auth` の3ステップ。トークンは自動リフレッシュ。`chmod 600` で保護。
- **MCP サーバ方式**: 同様の OAuth フロー。サーバ側でトークン管理。
- **banto での論点**: Kobo の環境台帳で OAuth トークンを管理できるか。または各モジュールが独自にトークンを保持するか。

**推奨**: banto のモジュールシステムで、接続情報（OAuth クライアント認証情報＋トークン）をモジュール設定として保持。トークンの暗号化保存は Kobo の責務か、モジュールローカルで行うかの判断が必要。

### 5.3 GUI が必要な操作と不要な操作

| サービス | Tool で十分 | GUI があったほうが良い |
|----------|------------|----------------------|
| **Gmail** | 検索・既読一覧・メール送信 | 複数メールの選択操作・ドラッグでの振り分け |
| **Calendar** | 予定一覧・作成・検索 | カレンダーUIでの日付選択・時間調整の視覚的確認 |
| **Drive** | ファイル検索・一覧・読み取り | フォルダ階層の視覚的ブラウズ |
| **Sheets** | データ読み取り・単純書き込み | セル編集・行列操作 |
| **Contacts** | 検索・取得 | 一覧ブラウズ |
| **Tasks** | 一覧・作成・完了 | 並び替え・プロジェクト管理 |

**検証結果**: 「Toolを作るのは簡単でもGUIは作りこまないといけない」は **状況による**。
- **単発取得・単純操作**: Tool だけで十分（メール検索、予定作成、ファイル検索等） → GUI 不要
- **複数選択・ドラッグ・視覚的操作**: GUI が必要（カレンダーの時間調整、ファイルのフォルダ間移動等）
- **設定画面**: 設定の種類による。OpenClaw の `configSchema` 宣言方式で十分な場合と専用 UI が必要な場合がある。
- **OAuth 認証フロー**: Web UI が便利だが、`begin_auth` → URL 発行 → コード入力の Tool 連鎖でも実用可能

**banto のモジュールシステム（4点セット）にとっての意味**：
- 多くのモジュールは「Tool + 接続情報」のみで十分
- GUI が必要なモジュールは「Tool + GUI + 接続情報」が基本
- SKILL は全モジュールに共通して追加可能

---

## 6. banto で OpenClaw Plugin をそのまま使う可能性

### 6.1 理想的な未来像

PO（たくみさん）の構想する理想は以下のような姿である：

> banto ユーザーが OpenClaw の ClawHub からプラグインを探してインストールし、banto のモジュールとしてそのまま使える。
> 例: `banto module install clawhub:@tensorfold/openclaw-google-workspace` で Google Workspace 連携が使える

この未来が実現すれば、banto は一からモジュールエコシステムを育てる必要がなく、OpenClaw の豊富なプラグイン資産（24のGoogle Workspace Tool、1000+のComposio連携、25+のチャネルプラグイン、多数のプロバイダ・スピーチ・メディアプラグイン）に即座にアクセスできる。

ただし、この理想にはいくつかの技術的ハードルがあり、それぞれに異なる解像度の対応が必要である。

---

### 6.2 技術的ハードル

#### 6.2.1 API の互換性（Tool登録I/F）

OpenClaw Plugin の Tool 登録は `api.registerTool()` を通じて行われ、banto-core の `NamespacedToolDefinition` と**形状が非常に近い**：

| 要素 | OpenClaw `api.registerTool()` | banto-core `NamespacedToolDefinition` | 互換性 |
|------|-------------------------------|----------------------------------------|--------|
| 名前 | `name: string` | `name: string`（but namespaced） | ⚠️ 名前空間プレフィックスの有無 |
| 説明 | `description: string` | `description: string` | ✅ 同じ |
| パラメータ | `parameters: TypeBox TObject` | `parameters: JSON Schema` | ⚠️ TypeBox→JSON Schema変換が必要 |
| 実行 | `execute(id, params) => ToolResult` | `execute(params, context) => ToolResult` | ⚠️ シグネチャ違い（id/context） |
| 出力 | `outputSchema?: TypeBox TObject` | なし（banto未定義） | — |
| 結果 | `{ content, details, isError }` | 同様の構造 | ✅ 同じ |

**ハードル**:
- OpenClaw は TypeBox を使用し、banto は JSON Schema を使用。両者の変換は技術的に可能（TypeBox → JSON Schema の変換器が存在）だが、ランタイムでの変換オーバーヘッドが生じる。
- 名前空間の扱い：OpenClaw はフラットな Tool 名空間（`google_gmail_search`）だが、banto はドメイン名前空間（`google.gmail.search` 相当）を採用予定（決定9）。変換時に名前のマッピングが必要。
- Tool 実行のシグネチャ：`execute(id, params, signal, onUpdate, ctx)` vs `execute(params, context)` の差はアダプタで吸収可能。

**難易度**: 低〜中。ツール定義の変換は機械的に行える。pi Extension と banto Tool の変換（案B方式）とほぼ同工数。

#### 6.2.2 GUI の互換性

OpenClaw の GUI 拡張は `registerControlUiDescriptor()` による Control UI タブの追加と、manifest の `dashboard` ブロックによるデータバインディングの2系統がある。

| 要素 | OpenClaw | banto（Canvas / GUI） | 互換性 |
|------|----------|----------------------|--------|
| UI 追加 | `registerControlUiDescriptor({ surface: "tab", ... })` | 未設計（Canvas にタブ追加？） | ❌ 未定義 |
| データ表示 | `dashboard.dataBindings`（宣言的） | 未設計 | ❌ 未定義 |
| 操作 | `dashboard.actionVerbs`（宣言的） | 未設計 | ❌ 未定義 |
| 設定画面 | `configSchema` + `uiHints`（自動生成） | 未設計（configSchema は決定済み？） | ❌ 未定義 |
| 認証フロー | `providerAuthChoices`（宣言的） | 未設計 | ❌ 未定義 |

**ハードル**:
- banto の GUI（Canvas）が未設計のため、互換性の議論が現時点では難しい。
- OpenClaw の Control UI は「Web ダッシュボードにタブを追加」するモデルだが、banto の Canvas は「エージェントが操作するビジュアルキャンバス」と読める。両者の前提が異なる。
- 宣言的UI（configSchema から自動生成）であれば変換は容易だが、カスタム UI コンポーネント（独自の React/TypeScript 実装）の場合は banto 側で同等の描画環境が必要。

**難易度**: 中〜高。banto の GUI 設計が固まるまでは判断不能。OpenClaw の `configSchema` のような宣言的設定画面は banto にも導入すべき（変換が容易なため）。

#### 6.2.3 依存関係（OpenClaw ランタイム）

OpenClaw Plugin は以下のランタイムに依存する：

| 依存対象 | 例 | banto での提供可否 |
|----------|-----|-------------------|
| `openclaw/plugin-sdk/*` | `definePluginEntry`, `api.registerTool()` | ⚠️ banto 側で互換 SDK を実装するか、shim を提供 |
| OpenClaw Gateway RPC | `api.registerGatewayMethod()`, `api.registerHttpRoute()` | ❌ banto は Kobo が HTTP API を持つが、Gateway RPC 相当は未設計 |
| OpenClaw チャネル | `api.registerChannel()` | ❌ banto はチャネルを想定していない（番頭＝単一ユーザー対話） |
| OpenClaw プロバイダ | `api.registerProvider()` | ❌ banto-core に LLM プロバイダ層はあるが、I/F が異なる |
| OpenClaw フック | `api.registerHook()` | ⚠️ banto の Tool middleware / event system で代替可能 |
| npm 依存パッケージ | `googleapis`, `typebox` 等 | ✅ 通常の npm 依存として解決可能 |

**ハードル**:
- Plugin が Gateway 機能（HTTP ルート・チャネル・プロバイダ）に依存していなければ、Tool のみの抽出は比較的容易。
- 逆に Gateway 機能に深く依存するプラグイン（チャネルプラグイン・プロバイダプラグイン）は banto に移植するのが難しい。
- ただし banto が想定するモジュールの多くは「Tool + 接続情報」であり、Gateway 機能への依存は稀と予想される。

**難易度**: 中。Tool-only プラグインなら低。チャネル/プロバイダプラグインなら高。

#### 6.2.4 設定・認証

| 要素 | OpenClaw | banto | 互換性 |
|------|----------|-------|--------|
| 設定スキーマ | `configSchema`（JSON Schema inline） | 未決定（JSON Schema 採用を示唆） | ✅ 共通形式なら容易 |
| 認証選択肢 | `providerAuthChoices`（宣言的） | 未設計 | ❌ |
| 認証フロー | OAuth / API key / device code | 未設計（Kobo 環境台帳？） | ❌ |
| 環境変数 | env var 経由の設定上書き | 未設計 | ❌ |

**ハードル**:
- `configSchema` は JSON Schema であり、banto でも JSON Schema を採用すれば変換不要。最も互換性の高い部分。
- 認証フロー（特に OAuth2）はプロダクト横断的な設計が必要。OpenClaw はデスクトップ OAuth リダイレクト＋コード入力方式だが、banto が Web UI を持つなら Web リダイレクト方式も選択可能。
- Kobo の環境台帳とどう統合するかが未決定。

**難易度**: 低〜中。configSchema は共通化可能。認証は設計次第。

---

### 6.3 実現方法の選択肢

#### 案A: アダプタ/ブリッジ方式（推奨）

banto 側に OpenClaw Plugin 互換レイヤを実装し、OpenClaw Plugin をそのまま読み込んで banto モジュールに変換する。

```typescript
// banto-core の OpenClaw 互換レイヤ（概念コード）
import { createOpenClawCompat } from "banto/module-bridge/openclaw";

const bridge = createOpenClawCompat({
  // OpenClaw Plugin の api メソッドを banto の登録に変換
  onRegisterTool: (toolDef) => banto.registerTool(convertToBantoTool(toolDef)),
  onRegisterCommand: (cmd) => banto.registerCommand(cmd),
  onRegisterControlUi: (desc) => banto.registerGUITab(desc),
});

// OpenClaw Plugin を読み込み
await bridge.loadPlugin("@tensorfold/openclaw-google-workspace");
```

**Pros**:
- OpenClaw のエコシステム資産をそのまま活用できる（6000+ npm パッケージ、ClawHub の全プラグイン）
- プラグイン作者が banto を意識する必要なし
- 新しいプラグインが自動的に banto でも使える

**Cons**:
- 互換性維持のコスト（OpenClaw SDK のバージョンアップへの追従）
- 完全な互換性は難しく、サブセット対応になりがち
- OpenClaw に依存しないプラグイン（チャネル・プロバイダ）は読み込めない
- Gateway RPC 等、banto にない機能の扱い

#### 案B: ラッパー/アダプタパターン（現実的）

各 OpenClaw Plugin を手動で banto モジュールとしてラップする。ツール単位で変換し、banto の4点セットにマッピング。

```typescript
// banto module: Google Workspace（OpenClaw plugin のラッパー）
import { defineBantoModule } from "banto/module-sdk";

export default defineBantoModule({
  id: "google-workspace",
  domains: ["google.gmail", "google.calendar", "google.drive"],
  configSchema: { /* JSON Schema */ },
  tools: [
    {
      name: "google.gmail.search",
      description: "Search Gmail messages",
      execute: async (params) => {
        // 内部で OpenClaw Plugin の Tool を呼ぶ？
        // または Google API を直接叩く
      },
    },
  ],
  gui: {
    tabs: [{ id: "gmail", label: "Gmail", component: GmailView }],
  },
});
```

**Pros**:
- 制御が容易。banto の設計に最適化できる
- banto 独自機能（Canvas GUI・Kobo 統合）を活用できる
- 依存関係がクリーン（OpenClaw SDK 不要）

**Cons**:
- プラグインごとに手動ラップが必要
- OpenClaw エコシステムの恩恵が限定的（ラップしたものだけ）
- メンテナンス負荷（OpenClaw Plugin が更新されたら追従が必要）

#### 案C: 相互運用プロトコルの標準化（長期的）

banto と OpenClaw の間で共通の Module/Tool/GUI 交換プロトコルを定義する。双方がこのプロトコルでプラグインを提供できるようにする。

```typescript
// 共通モジュールフォーマット（概念）
interface StandardModuleManifest {
  id: string;
  configSchema: JSONSchema;
  tools: ToolDefinition[];
  gui?: GUIContribution[];
  skills?: string[];
}
```

**Pros**:
- 究極の相互運用性
- 一度標準化すれば両方のエコシステムが活性化

**Cons**:
- 標準化のコストが大きい
- 両プロジェクトの協力が必要（OSS の政治的問題）
- OpenClaw のスケールに対して banto が小さすぎる（交渉力不足）
- 標準化が完了するまで時間がかかる

---

### 6.4 結論・推奨

#### 推奨：短期〜中期は「案B（ラッパー）」、長期は「案A（ブリッジ）」

**短期（MVP）**: 案B（ラッパー）
- OpenClaw のエコシステムを参考に、必要なプラグインを厳選して banto モジュールとして手動実装
- 最初のターゲット：Google Workspace（6サービス）、Web 検索、ファイル操作
- OpenClaw Plugin Manifest の設計パターンを取り入れる（configSchema, contracts.tools 等）
- この段階では「OpenClaw プラグインがそのまま動く」は目指さない

**中期（モジュールエコシステム確立）**: 案B→案A への移行準備
- banto-core に OpenClaw Tool 互換のアダプタレイヤを準備
- `defineBantoModule()` の設計を OpenClaw の `definePluginEntry()` と互換性を持つ形に
- 可能な範囲から OpenClaw Plugin の直接読み込みを試験導入
- 最初の試験対象: Tool-only プラグイン（チャネル・プロバイダ非依存）

**長期（エコシステム主導）**: 案A（ブリッジ）の本格導入
- OpenClaw Plugin 互換レイヤを安定化
- ClawHub との統合（`banto module install clawhub:...`）
- banto 独自モジュールも同じ形式で提供

#### 「OpenClaw Plugin をそのまま使う未来はありか？」

**結論: 「あり」だが、段階的に進めるべき。**

- **Tool レベルでは完全互換が可能。** Tool 定義の形状が十分に近く、TypeBox↔JSON Schema の変換も技術的に容易。
- **GUI レベルは banto の Canvas 設計次第。** OpenClaw の Control UI タブ＋dashboard 宣言は banto の GUI 設計の参考になるが、現時点では互換性を議論できない。
- **ランタイム依存のあるプラグイン（チャネル・プロバイダ）は直接利用が難しい。** しかし banto で使いたいプラグインの大半は Tool-only であり、大きな制約にはならない。
- **最大のリスクはメンテナンス負荷。** OpenClaw の SDK は活発に開発されており（beta タグが頻繁にリリース）、互換レイヤの追従には継続的な投資が必要。

**現実的な着地点**: 2〜3の主要プラグイン（Google Workspace・Web検索・Composio）を優先的にラップし、その経験から汎用ブリッジの設計を固める。全面互換を目指すより、実需のある範囲から始めるのが banto のリソースに適う。

---

### 6.5 出典

本セクションの分析は以下の調査に基づく：

- **一次情報**: OpenClaw Plugin SDK（`openclaw/plugin-sdk/*`）のAPIリファレンス、Plugin Manifest のフィールド定義 — 本レポートのセクション3.4・3.5より
- **Tool 定義比較**: banto-core の `NamespacedToolDefinition`（`docs/spec/` 内）と OpenClaw `ToolDescriptor` の形状比較 — 本レポートのセクション4.3より
- **GUI 比較**: OpenClaw `registerControlUiDescriptor()` と banto Canvas（未設計）— 本レポートのセクション3.6より
- **実現方式の分析**: 本レポートのセクション4.2（pi Extension ラップ）と 4.3（OpenClaw Plugin ラップ）のパターンを拡張
- **エコシステム規模**: ClawHub パッケージ（セクション3.7）、npm pi パッケージ数（セクション2.5）

---

## 7. Tool vs GUI の考察

### 7.1 Tool の実装難易度

**「Toolを作るのは簡単」は正しい。** 以下の実績から：

- pi の Extension: 最小構成で **15〜30行**（TypeScript）
- OpenClaw Plugin: 最小構成で **30〜50行**（manifest + entry + 1 tool）
- Google API を叩く Tool: 認証なしなら **50〜100行**、認証ありなら **150〜300行**（OAuth2含む）

```typescript
// pi の最も簡単な Tool（15行）
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "hello",
    label: "Hello",
    description: "Say hello",
    parameters: Type.Object({ name: Type.String() }),
    execute: async (id, params) => ({
      content: [{ type: "text", text: `Hello, ${params.name}!` }],
      details: {},
    }),
  });
}
```

### 7.2 GUI の実装難易度

**「GUIは作りこまないといけない」も状況によるが、OpenClaw が軽減する。**

- **TUI のみで済む場合**（pi の ctx.ui 系）: 20〜50行のコードで select/confirm/input を実現
- **Web UI が必要な場合**:
  - OpenClaw の Control UI タブ: manifest の `dashboard` + `registerControlUiDescriptor` で宣言的に追加 → **100〜500行**
  - 独自 Canvas UI（banto の場合）: フロントエンド実装が必要 → **1000行〜**
- **認証設定画面**: OpenClaw の `configSchema` + `uiHints` + `setup.providers` で自動生成可能。→ **0行（宣言のみ）**

### 7.3 banto への示唆

| 操作種別 | 実装形態 | 見積もり工数 |
|----------|----------|------------|
| 単純データ取得（API GET） | Tool のみ | 30〜80行 |
| データ作成・更新（API POST） | Tool のみ | 50〜100行 |
| 認証ありの操作 | Tool + OAuth 接続情報 | 100〜300行 |
| 複数選択・バッチ操作 | Tool + 簡易 GUI | 200〜500行 |
| 視覚的操作（カレンダー等） | Tool + 本格 GUI | 500〜2000行 |
| 設定画面 | configSchema 宣言のみ | 20〜50行（宣言）〜500行（専用UI） |

**結論**: 多くのモジュール（Gmail検索・ファイル読み取り・タスク管理）は Tool のみで実用十分。GUI が必要なケースは「カレンダーの日付調整」「ファイルブラウザ」「複数選択操作」など、特定のユースケースに限定される。

---

## 8. banto への提言

### 8.1 短期（MVP）

1. **pi を職人ハーネスとして固定**（現計画通り）
   - pi の Extension 機構をそのまま利用
   - banto-core の Tool 定義は pi の `ToolDefinition` 型と互換性を持たせる

2. **OpenClaw Plugin Manifest の設計を参考に banto モジュール manifest を設計**
   - `configSchema` + `contracts.tools` + `activation` の3点セットは特に重要
   - banto 独自の要素（`domains` = Tool 名前空間プレフィックス）を追加

3. **Google Workspace は既存 OSS を wrap**
   - `@tensorfold/openclaw-google-workspace` 相当のプラグインを banto モジュールとして実装
   - または MCP サーバ（taylorwilsdon/google_workspace_mcp）を pi-mcp-adapter 経由で利用

### 8.2 中期（モジュールエコシステム確立）

1. **OpenClaw Plugin SDK の設計パターンを banto モジュール SDK に取り込む**
   - `defineBantoModule()`（`definePluginEntry` 相当）
   - サブパスインポート方式（`banto/module-sdk/*`）
   - 宣言的設定バリデーション（`configSchema`）

2. **OpenClaw プラグインと banto モジュールの相互運用ブリッジを検討**
   - OpenClaw の Tool 登録を banto が読み込めるラッパー
   - 認証情報の共有（OAuth トークンストア）

3. **GUI の要否基準を明確化**
   - 「Tool で十分」判断基準: 単一操作・確認不要・戻り値がテキスト
   - 「GUI 必要」判断基準: 複数選択・視覚的フィードバック・設定画面

### 8.3 長期（エコシステム主導）

1. **banto モジュールマーケットプレイスの構想**
   - OpenClaw の ClawHub に相当するレジストリ
   - ただし最初は npm + GitHub で十分

2. **MCP との標準ブリッジ**
   - banto-core に MCP アダプタを組み込み、MCP サーバを banto モジュールとして自動登録
   - `pi-mcp-adapter` のアプローチ（単一 proxy tool + オンデマンド発見）を採用

3. **エコシステム間の相互運用**
   - pi Extension ↔ banto Module ↔ OpenClaw Plugin の相互変換/ラップ
   - 統一 Tool 定義（TypeBox JSON Schema）を共通基盤に

---

## 出典一覧

### 一次情報（プロダクト公式）

| ソース | 内容 | 取得方法 |
|--------|------|----------|
| pi README | 全体像・CLI・拡張機構・哲学 | ローカル `node_modules/@mariozechner/pi-coding-agent/README.md` |
| pi docs/extensions.md | Extension API 完全リファレンス | 同上 `docs/extensions.md` |
| pi docs/sdk.md | SDK embed 方法 | 同上 `docs/sdk.md` |
| pi examples/extensions/ | 60+ の Extension サンプル | 同上 `examples/extensions/README.md` |
| pi docs/packages.md | Pi パッケージシステム | 同上 `docs/packages.md` |
| OpenClaw README | 全体像・インストール・チャネル一覧 | `curl` GitHub raw |
| OpenClaw Tools Overview | Tool/Skill/Plugin の3層 | `curl` docs.openclaw.ai |
| OpenClaw Plugin SDK | SDK サブパス・登録API完全リファレンス | `curl` docs.openclaw.ai（markdown raw） |
| OpenClaw Plugin Manifest | Manifest 全フィールドリファレンス | `curl` docs.openclaw.ai（markdown raw） |
| OpenClaw Building Plugins | プラグイン開発クイックスタート | `curl` docs.openclaw.ai（markdown raw） |
| pi 哲学「What if you don't need MCP?」 | MCP 不要論の論拠 | `curl` mariozechner.at |
| pi npm packages | 6375 packages（keyword: pi-package） | `curl` registry.npmjs.org |
| pi MCP 関連パッケージ | pi-mcp-adapter, pi-mcp-extension 等 | `curl` registry.npmjs.org |

### 二次情報（サードパーティプロダクト）

| プロダクト | 内容 | 取得方法 |
|-----------|------|----------|
| `@tensorfold/openclaw-google-workspace` | OpenClaw 用 Google Workspace プラグイン（24 Tool） | `curl` GitHub raw README |
| `composio-community/openclaw-composio-plugin` | OpenClaw 用 1000+ ツール統合 | `curl` GitHub（404: README未確認） |
| `taylorwilsdon/google_workspace_mcp`（⭐2938） | Google Workspace MCP サーバ（最多スター） | `curl` GitHub Search API |
| `aaronsb/google-workspace-mcp`（⭐164） | Google Workspace MCP サーバ（認証+3サービス） | 同上 |
| `Get-Concord-AI/concord-mcp`（⭐167） | AI Agent 向け Google Workspace | 同上 |
| `dguido/google-workspace-mcp`（⭐39） | Google Workspace MCP サーバ（6サービス） | 同上 |
| `wbbtmusic/openclaw-antigravity-oauth`（⭐10） | Google Antigravity OAuth for OpenClaw | 同上 |
| `tensorfold/openclaw-google-workspace`（⭐4） | All-in-one Google Workspace plugin | 同上 |
| `sanjay3290/ai-skills`（⭐362） | 24 Agent Skills（Google Workspace 含む） | 同上 |
| ClawHub API | OpenClaw プラグインレジストリ | `curl` clawhub.ai/api/v1/packages |

### 未確認ソース

| ソース | 試行結果 |
|--------|----------|
| OpenClaw docs/architecture.md（GitHub） | 404 Not Found（docs/ は GitHub Pages 未公開） |
| `composio-community/openclaw-composio-plugin` README | 404, リポジトリ存在確認のみ |
| ClawHub Google 検索結果 | スキルパッケージのみ（「Fish Respiratory Rate」等）。Google Workspace 関連パッケージは未発見 |

---

## 付録: 参照したローカルファイル

調査過程で参照した主要なローカルファイル（banto プロジェクト内）：

- `node_modules/@mariozechner/pi-coding-agent/README.md` — pi 全体像
- `node_modules/@mariozechner/pi-coding-agent/docs/extensions.md` — Extension API（2597行）
- `node_modules/@mariozechner/pi-coding-agent/docs/sdk.md` — SDK embed API
- `node_modules/@mariozechner/pi-coding-agent/docs/packages.md` — Pi packages
- `node_modules/@mariozechner/pi-coding-agent/docs/settings.md` — Settings
- `node_modules/@mariozechner/pi-coding-agent/examples/extensions/README.md` — 60+ サンプル一覧
- `docs/adr/adr-0010-pluggable-harness.md` — 起票中。モジュールシステムの設計
- `docs/spec/` — 各種仕様書。Tool 定義・ドメイン名前空間等
