# banto（番頭）

> 記憶を持つAI番頭（steward）が主体となり、決定的な統治基盤（Kobo）の上で、POの代理として店を切り盛りする。第一の店＝ソフトウェア開発。POは番頭を統べ、利用体験を変える本物のトレードオフだけを裁く

## 現状

**2つの層が別々の段階にある。**

- **Kobo（決定的統治基盤・旧称 daemon）は実装済み**。`packages/banto-daemon` / `banto-core` / `banto-cli` にイベントログ・ステートマシン・依存ゲート・マージキュー・環境台帳が入っており、`tests/acceptance` の331テストが通る。構造逆転（ADR-0009）でもこの層は**残す**——番頭はこの上に乗る
- **番頭核（Banto ホスト）は未実装。ハーネスはプラガブル**——Kobo・WorkerAgent（職人）との結合は Tool／SKILL の公開 I/F のみを介し、特定のエージェントハーネス実装に依存しない。**第一実装は pi coding agent**。記憶は自作しない：既存の記憶システムを採用する（参照実装は Hermes Agent）。詳細は ADR-0009・ADR-0010（起票中）

`docs/spec/` の仕様群が設計の真実（living document）。Spec と実態が食い違ったら黙って寄せず incident を積む（P3）。

## Tech Stack

- TypeScript（strict）
- **Banto（番頭）のハーネスは差し替え可能。** 第一実装は pi coding agent。Kobo・WorkerAgent・UI（アテンションキュー／バックログ）とのやりとりはすべて Tool／SKILL の公開 I/F を介し、ハーネスの内部実装に依存しない
- **LLMプロバイダ層はプラガブル＝モデル非依存**（Anthropic / OpenAI / opencode経由 / 将来ローカルLLM）。banto-core に I/F、アダプタで差し替える
- **記憶は既存の記憶システムを採用する（自作しない）。** 参照実装は Hermes Agent（Nous, MIT）。手続き記憶は SKILL.md（agentskills.io）形式
- **pi（earendil-works/pi）は職人（Worker Pool）ランタイム、および番頭ハーネスの第一実装として使う**。無改造で扱う
  - npm は `@earendil-works/pi-coding-agent` / `pi-ai` / `pi-agent-core`。**旧 `@mariozechner/*` は deprecated**（2026-08-08 に 0.73.1 → 0.84.1 へ移行）
- **モジュール（Module）＝ Banto への登録単位**（ADR-0010 決定25・27）。①接続情報 ②番頭へのTool ③キャンバスへのGUI ④SKILL を1単位で登録する。Kobo・基本GUIセット・Worker Pool はいずれもモジュール。`Provider` は LLMプロバイダで埋まっているため使わない。コード内は `BantoModule` 等と接頭辞を付ける（`module` はESモジュールと衝突）
  - **モジュールとドメインの関係**：ドメインは決定9のTool名前空間プレフィックス。各モジュールは1つ以上のドメインを持つが逆は成り立たない（`canvas.*`/`memory.*`/`skill.*` は Banto 中核自身）
  - 散文で世界観を語るときの「店」（vision.md）は商家の比喩として残す。機構を指すときは「モジュール」
- **モジュール間呼び出しはライブラリ＋レジストリ方式**（決定27）。フレームワークがレジストリと呼び出し規約を提供し、**実際の呼び出しはモジュール同士が直接**行う。Banto をブローカーにしない（単一障害点化とKobo→Bantoの依存逆転を避ける）
- **Worker Pool（職人）は Kobo から独立した必須の組み込みモジュールで、Kobo より先に作る**（決定23・27c）。Kobo のサブシステムではない——番頭は Kobo 無しでも職人に実作業を委譲できる（D10がKoboの完成を待たない）
- **Kobo**: HTTP API＋WebSocket（イベント購読）。自宅サーバのUbuntu VM上でsystemdサービスとして常駐。GUI/CLIはその同格クライアント
- banto-core: ランタイム中立の共通ライブラリ（ツール定義・Kobo APIクライアント・プロンプト資産読込・LLMプロバイダseam）
- Skillは SKILL.md（agentskills.io）形式、Toolは内部で正規化しプロバイダ毎のwire形式をアダプタで吸収する

## Commands

```
npm test           # acceptance テスト（tests/acceptance）。docker を要る7ファイルは除く
npm run test:docker # その7ファイルだけ（ホストの docker が要る。meta/environments.yaml の
                    #   test-docker プロファイル＝driver: process で回す。検証コンテナには
                    #   socket を渡さないので、器の中では通らない）
npm run test:e2e   # e2e テスト
npm run build      # tsc -b
npm run typecheck  # tsc --project tsconfig.check.json

npm run dev:web        # WebUI（Vite開発サーバ, :4200）。別途 banto serve が要る
                       #   WS(/ws)は番頭ホストへ中継されるため、公開は4200の1ポートで足りる
                       #   BANTO_WEB_ALLOWED_HOSTS: プロキシ経由のドメイン許可（既定 .ndev.tjstkm.net）
                       #   BANTO_HOST_URL: 中継先の番頭ホスト（既定 http://localhost:4100）
npm run build:web      # WebUIのビルド
npm run typecheck:web  # WebUIの型検査（.tsx を含む）
```

## Development Rules

規則の正典は `docs/principles.md`（ID付き。変更はADR経由のみ）。毎タスクで特に効くもの:

- **D9**（番頭のみ）: 利用体験を変え、**かつ**本物のトレードオフのときだけ PO へ上げる。それ以外は自分で決める。pre-release は壊してよい。ただし外に累積する副作用（公開パッケージ・外部VMコスト・イベントログ形式）は one-way として **D1 に戻る**
- **D1**: 不可逆な選択（公開IF・データモデル・外部依存追加）は自分で決めず escalate / request_design。**番頭の判断では D9 が優先。職人には D1 がそのまま効く**
- **D3**: 状態の真実は一箇所。ファイルは意図、イベントログは実行時状態。導出できる値は保存しない
- **D5**: ロジックは Kobo・番頭核・Extension Pack にだけ書く。Surface（GUI/CLI/TUI固有コード）に判断を持たせない
- **D6**: 依存追加より標準ライブラリと既存資産。追加する場合は理由を1行書く
- **D10**（番頭のみ）: 細かい仕事をしない。調査・実装は職人へ委譲し、自分の文脈は記憶と判断に使う
- **D11**（番頭のみ）: 記憶の有無を役割で分ける。番頭は記憶を持つ、職人は持たない（隠れ状態が無い＝再現可能・監査可能）
- **I1**: テスト・ビルド結果の自己申告を信頼しない。直接実行して確認する
- **I2**: エラーを握りつぶさない。回復不能ならfailedにして止まる
- **I4**: TypeScript strict。anyを書く場合はその行に理由コメント
- **P1**: スコープ外パスに触らない。「ついで」の修正は禁止
- **P3**: Specと実態（コード・挙動）が矛盾していたら、黙ってどちらかに合わせず incident を積む
- **P6**: **間欠的に落ちる試験は、機構が壊れている合図**。待ちを延ばす・リトライを足す・「まれに落ちる」で先へ進む、のいずれもしない。「単体では通る」は無罪の証拠にならない。「既存の不安定さ」は分類であって根拠ではない——根拠は計測（何回中何回落ちるか）。直さない選択はあってよいが、そのときは incident を積む

## References

必要になったときに該当ドキュメントを読むこと:

- **作業の引き継ぎ・現在地: `docs/notes/handoff.md`**（セッションを跨ぐときはここから）

- プロダクト意図: `docs/VISION.json`（原典散文: `docs/vision.md`）
- 判断規則の全21則: `docs/DESIGN_PRINCIPLES.json`（原典散文: `docs/principles.md`）
- 仕様（設計の真実）: `docs/spec/` — daemon-core（＝**Kobo コア**。ファイル名とIDは据え置き）/ document-system / schemas / environment / improvement-loop / multi-project / ui
- 構造逆転の決定: `docs/adr/adr-0009-agent-primary-inversion.md`（accepted）
- ハーネス差し替え可能性・Tool/SKILL I/F・記憶の採用方針: `docs/adr/adr-0010-pluggable-harness.md`（起票中）
- 設計経緯・全体像: `docs/notes/pi-coding-agent-design-v2.md`（逆転前の設計。pi の位置づけは ADR-0009 で分割済み）
- Sprint管理: `docs/ROADMAP.json`
