# imp-0015: チャットに画像・ファイルを添付できるようにする

- status: open
- created: 2026-08-02
- related: task-0117

## 問題
WebUI のチャットはテキストのみ。画像やファイルを張り付けて banto に読ませる手段が無い（PO 依頼 2026-08-02）。

## 方針（PO 裁定 2026-08-02）
- 画像: モデルが vision 対応なら張り付け可（LLM に直接渡す）。非対応なら「<モデル名>は画像非対応です」エラーを出して添付させない
- テキストファイル: 常に張り付け可。work/attachments/ に保存し、番頭が file.read で読める（プロンプトにパス注釈）

## 調査結果（task-0116、裏取り済み）
- 送信経路: WS のみ（App.tsx submit → useBantoSession.send → /ws に {type:"prompt", threadId, text}）
- protocol.ts の PromptMessage は text のみ
- pi SDK は画像対応済み（PromptOptions.images、wire は data URI）
- モデルの vision 対応判定: pi の getModel(id).input.includes("image")。現行 deepseek-v4-flash-free は非対応（pi が画像をプレースホルダに置換する）
- 添付の置き場所: work/attachments/ が適切（BANTO_PLACES で読み書き可）。.gitignore 追加が必要
- ws maxPayload 既定 100MiB（base64 で 33% 増）

## 変更範囲（想定）
- protocol.ts: PromptMessage に attachments 追加
- banto-web: 添付 UI（画像プレビュー・エラー表示・ファイル選択）
- banto-host: モデル情報 API（vision 対応）、prompt 分岐で attachments 処理（画像 → images オプション / ファイル → work/attachments/ 保存 + パス注釈）
- HostSession.prompt に images オプション追加
- .gitignore: work/attachments/

## 懸念
- 画像を base64 で渡すと会話履歴（JSONL）が肥大化する（許容。将来の軽量化は別タスク）
- work/attachments/ の掃除（TTL）は未設計
