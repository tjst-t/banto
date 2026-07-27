# banto（番頭）

> 一人のプロダクトオーナー（PO）がAIエージェントのチームを率いて開発するための統治環境。ガバナンスレイヤー＋POコックピットに徹する

## 現状

実装コードはまだない。`docs/spec/` の仕様群が設計の真実（living document）であり、これから実装を始める段階。

## Tech Stack

- TypeScript（strict）
- pi（badlogic/pi-mono）: 無改造のエージェントランタイム。検討・レビューの対話セッションはpi固定
- daemon: HTTP API＋WebSocket（イベント購読）。自宅サーバのUbuntu VM上でsystemdサービスとして常駐
- banto-core: ランタイム中立の共通ライブラリ（ツール定義・daemon APIクライアント・プロンプト資産読込）。pi Extension／agent-sdkアダプタは薄い皮に留める

## Commands

実装開始後に `make test` / `make serve` 等を整備する（現時点でビルド・テスト対象なし）。

## Development Rules

規則の正典は `docs/principles.md`（ID付き。変更はADR経由のみ）。毎タスクで特に効くもの:

- **D1**: 不可逆な選択（公開IF・データモデル・外部依存追加）は自分で決めず escalate / request_design
- **D3**: 状態の真実は一箇所。ファイルは意図、イベントログは実行時状態。導出できる値は保存しない
- **D5**: ロジックはdaemonとExtension Packにだけ書く。Surface（GUI/CLI/TUI固有コード）に判断を持たせない
- **D6**: 依存追加より標準ライブラリと既存資産。追加する場合は理由を1行書く
- **I1**: テスト・ビルド結果の自己申告を信頼しない。直接実行して確認する
- **I2**: エラーを握りつぶさない。回復不能ならfailedにして止まる
- **I4**: TypeScript strict。anyを書く場合はその行に理由コメント
- **P1**: スコープ外パスに触らない。「ついで」の修正は禁止
- **P3**: Specと実態（コード・挙動）が矛盾していたら、黙ってどちらかに合わせず incident を積む

## References

必要になったときに該当ドキュメントを読むこと:

- **作業の引き継ぎ・現在地: `docs/notes/handoff.md`**（セッションを跨ぐときはここから）

- プロダクト意図: `docs/VISION.json`（原典散文: `docs/vision.md`）
- 判断規則の全17則: `docs/DESIGN_PRINCIPLES.json`（原典散文: `docs/principles.md`）
- 仕様（設計の真実）: `docs/spec/` — daemon-core / document-system / schemas / environment / improvement-loop / multi-project / ui / **memory**（Quirefold＝番頭の記憶。Substrate の正典は ADR-0010）
- 設計経緯・全体像: `docs/notes/pi-coding-agent-design-v2.md`
- Sprint管理: `docs/ROADMAP.json`
