# modelRoles：モジュールが「役のモデル束縛」を宣言し、核が「役割とモデル」統合表を導出表示する

- 日付: 2026-08-19
- 出所: PO との設定画面再設計相談。「等級既定 vs 役割上書き」が実機で分かりにくく、職人のモデルが黙って別モデルに落ちていた（OpenRouter に設定したのに opencode-go で職人が走る）。あわせて、将来「工場のように直接職人を使うモジュール」が増えたときに、Kobo も WorkerPool も**汎用的な仕組みで**設定画面へ参加できるようにしたい、という要求。
- 位置づけ: 提案。ADR-0021（モデルの台帳は核が持つ。バックエンドは供給元になる）の続き。本提案は「役の決定をモジュールから開く口」を定める。実装は合意の後、番頭の判断で職人へ委譲する。

## 1. 結論

1. **`modelRoles` を `ModuleSettingsSpec` に任意追加する。** モジュールは「自分が提供するモデルを使う役（executor 等）」を、型付きで宣言する。宣言しないモジュールは統合表に出ない。
2. **核の「役割とモデル」統合表が、等級既定（ModelLedger）＋ 全モジュールの `modelRoles` 束縛を集め、行＝役割、欄＝実効・出所・優先順位として表示する。** 保存するのではなく導出表示（D3）。
3. **Kobo は `modelRoles` を宣言して統合表に載る。WorkerPool は宣言しない**（供給＝バックエンド選択だけを持つため）。将来、等級に対する上書きを持ちたくなった WorkerPool も同じ口で載る。
4. **保存先は各モジュール。監査・履歴は決定 ledger（一次）、解決は single resolver。** これらは別レイヤーであり、modelRoles と衝突しない。

## 2. 背景と問題（実測）

### 2.1 現状、モデルの設定が4区画に分散している

| 区画 | 中身 | 保存先 |
|---|---|---|
| `roles` 役ごとのモデル | 番頭 / 職人の等級（worker.\<tier\>）の**既定** | `model-roles.json`（ModelLedger・核） |
| `kobo` 工場（職人の当て方） | executor / rework / audit の**役割上書き** | `kobo-settings.json`（Kobo） |
| `llm` 使えるモデル | 供給（プロバイダ・鍵・採用） | `llm-registry.json` |
| `chapterModel` 章の要約 | 要約用モデル | `banto/settings.json` |

### 2.2 問題の核心（実機 2026-08-18）

- 職人が「何を使うか」は、**等級既定（ModelLedger）と役割上書き（Kobo roleAssignments）の2層**で決まる（ADR-0021 決定99a：既定は核、上書きは呼び出し側）。上書きは等級既定を覆す（daemon.ts の delegateWorker で roleAssignments が優先、pool.ts の planModel で名指しが優先）。
- 実際、`model-roles.json` では worker.\<tier\> の既定が OpenRouter なのに、`kobo-settings.json` の executor 名指しが opencode-go のため、職人は opencode-go で起動した。**どちらが効いているか・なぜかが、画面上どこにも示されない**。
- 画面側にも「等級ごとのモデル」の表示（worker-pool 区画）が残っており、役の決めどころが3か所に見える（実質は2層＋遺物）。

## 3. 設計方針

### 3.1 モデル決定を第一級のドメインデータとして扱う

「誰がどのモデルを使うか」は設定の脇道のフラグではなく、バージョン・監査・比較可能性を持つドメインの中心とする。以下の3層に分け、それぞれを独立させたまま単一の解決に合成する。

| 層 | 持ち主 | 何を答えるか |
|---|---|---|
| 供給（capability） | バックエンド（pi / Claude Code） | このモデルはどの能力（役・等級・コンテキスト・言語）を持てるか |
| 束縛 | 核（既定）＋各モジュール（上書き） | この役にはこのモデル（優先順位付きの重ね合わせ） |
| 制約（将来） | 適用元 | ノード・リポジトリ・タスク・言語・コンテキスト窓による多次元の制約 |

### 3.2 決定の記録は ledger（一次）、現在値は導出 snapshot

- 束縛の**変更イベント**（誰が・いつ・何を・依拠）を追記ログに積む。監査・バージョン・時点比較はイベントから導出される。
- 現在の束縛はその snapshot であり、再導出可能（D3）。実行時は snapshot（数 KB・低頻度）を読み、遡らない。
- この原則は既存の决定 29c／D3／event-log と同じ土台に乗る。

### 3.3 解決は single resolver。呼び出し側は契約だけを叩く

- 呼び出し側（Kobo の delegateWorker / host の番頭セッション）は「役・等級・文脈」を渡し、**実効モデル（または理由付きの未解決）**を受け取る。自分で束縛を参照しない（D5）。
- 候補が無いとき黙って先頭へ落ちず、理由付きで返す（ADR-0021 決定104 と同じ直線。unknown モデルへ黙って落ちる失敗を構造的に塞ぐ）。
- Kobo も host も同じ resolver の契約を共有するため、解決ロジックの食い違いが起きない。

## 4. 契約：`ModuleSettingsSpec.modelRoles`（型）

```ts
// banto-core/src/module-settings.ts
export interface ModuleSettingsSpec {
  title: string;
  description?: string;
  fields: ...;                       // 既存
  read(): Record<string, unknown>;   // 既存
  write(values: Record<string, unknown>): { applied: boolean; message?: string }; // 既存
  view?: string;                     // 既存（決定43）

  /**
   * この区画が「モデルを使う役」の束縛を表すときに宣言する。
   * 核の「役割とモデル」統合表がこれを読み、等級既定（ModelLedger）と併せて実効を導出する。
   * 宣言しなければ統合表には出ない（設定画面の区画としてのみ表示）。
   */
  modelRoles?: Array<{
    id: string;              // 表の行の識別子（例 "executor"）
    key: string;             // read()/write() のキー（例 "executorModel"）
    label: string;           // 表示名（例 "実装"）
    tierDependent?: boolean; // タスクの等級（worker.<tier>）に従う役か → 実効の等級依存を核が知る
  }>;
}
```

非ゴール: 供給（プロバイダの登録・鍵・取り込み）は既存の `llm-registry`／バックエンドのまま。**ここで増えるのは「役の束縛をモジュールから開く口」だけ**であり、特別扱いのルートは追加しない。

## 5. 核の「役割とモデル」統合表（表示仕様）

- 区画 `roles`（既存）を拡張し、**行＝役割**として以下を並べる。
  - 核の役: 番頭（steward）／ 職人・高精度／普通／高速（worker.\<tier\>）
  - 各モジュールが `modelRoles` で宣言した役（例: Kobo の実装／手直し／監査）
- 欄: **等級既定（核）｜上書き（モジュール）｜いま効いている（実効）**
- 実効は「モジュールの上書き ＞ 等級既定 ＞ バックエンド既定」の優先順位で導出し、**出所**（「工場の上書きが優先しています」「等級既定です」）を併記する。
- 等級依存の役（tierDependent）は、実効が「そのタスクが頼まれた等級」で変わることを欄に明示する（例: 「等級に従う」）。
- 優先順位の規則（①工場の上書き ②等級既定 ③バックエンド既定）は表の下に常時固定表示する。
- この表は**導出表示**（D3）。どのモジュールの settings.read() を読んだかを出所として残す。

## 6. モジュールの提供例

### 6.1 Kobo（工場）—— `modelRoles` を宣言して統合表に載る

```ts
export function createKoboSettings(store: RoleAssignmentStore): ModuleSettingsSpec {
  return {
    title: "工場（職人の当て方）",
    description: "実装・手直し・監査にどのモデルの職人を当てるか。",
    modelRoles: [
      { id: "executor", key: "executorModel", label: "実装",     tierDependent: true },
      { id: "rework",   key: "reworkModel",   label: "手直し",   tierDependent: true },
      { id: "audit",    key: "auditModel",    label: "監査（レビュー）", tierDependent: true },
    ],
    fields: /* 役ごとの select（選択肢 worker.models）。既存のまま */,
    read()   { return store.roleAssignments(); },   // 保存先 kobo-settings.json
    write(v) { /* 名指しを自分の保存先へ書く。黒リスト弾き等の既存ロジックを保持 */ },
  };
}
```

### 6.2 WorkerPool（工房）—— 宣言しない。統合表に載らない

```ts
export function createWorkerPoolSettings(pool): ModuleSettingsSpec {
  return {
    title: "職人（バックエンドと安全弁）",
    description: "職人を動かす仕組みと畳み忘れの安全弁。モデルの当て方は「役割とモデル」で。",
    // modelRoles は宣言しない → 統合表に出ない（供給の話であって役の束縛を持たない）
    fields: /* バックエンド選択・アイドル安全弁 */,
    read()   { /* 自分の保存先 */ },
    write(v) { /* 自分の保存先 */ },
  };
}
```

将来 WorkerPool が等級に対する上書きを持ちたくなったときは、`modelRoles` を追加するだけで統合表に載る。Kobo と全く同じ口。

## 7. 決定 ledger と single resolver への接続（ADR-0021 の続き）

- `modelRoles` は束縛層のモジュール参加口。**保存は各モジュール**（現行の kobo-settings.json 等のまま）。
- **監査・履歴**: 束縛の変更を決定イベントとして積む（ledger 一次・snapshot 導出）。
- **解決**: single resolver が「供給（バックエンド名乗り）＋束縛（核＋各モジュール）＋制約（将来）」を合成して実効を返す。呼び出し側（Kobo / host）はこの契約だけを叩く。
- ADR-0021 決定99a の「既定は核、上書きは呼び出し側モジュール」は維持。**Kobo の役割上書きを核へ寄せない**（依存の逆転を避ける）。

## 8. 依存の向きと非ゴール

- 核が参照するのは**契約（`modelRoles` の宣言と `read()`/`write()`）だけ**。モジュールの内部実装には触れない。
- 新しい専用ルート（Kobo 個別の扱い）は作らない。Kobo も WorkerPool も、将来モジュールも、決定25 のモジュール契約に載る「汎用の口」で参加する。
- 今回のスコープで扱わないもの: 実際のログ/監査の整形、多次元制約（ノード・リポジトリ・言語等）の適用、`claude-agent-sdk` 側の供給名乗りの改善（これらは別提案）。

## 9. 段取り（合意後の実装手順の目安）

1. `ModuleSettingsSpec.modelRoles` の型を banto-core に追加。
2. 核の `roles` 区画を「統合表」に拡張（全モジュールの `modelRoles` 集計・実効導出・出所・優先順位表示）。
3. Kobo の `createKoboSettings` へ `modelRoles` を追加。WorkerPool は変更なし（宣言しない実装のまま動くことを確認）。
4. `worker-pool` 区画の遺物（等級ごとのモデル表示）を除去し、役の決めどころを1枚に集約。
5. 決定 ledger（束縛変更イベント）と single resolver への接続（ADR-0021 続き・別ステップ）。
6. acceptance: 設定画面の統合表に Kobo 3役が並び、実効・出所が正しく表示される／WorkerPool が表に出ない／等級既定と上書きの優先順位が検証される。

## 10. 判断待ちの論点

- `modelRoles` の `key` と read()/write() の対応は、既存の kobo 区画（`executorModel` 等）に合わせる（本提案のとおり）。統合表の「実効」を出すため、核は各モジュールの read() を呼ぶ——これは settings.describe の既存経路で取得できる。
- 等級依存の役の実効表示は、実際のタスクの等級に紐づくため「代表値（既定の等級）/ 等級で変動」のどちらを既定表示にするかは実装時に判断。