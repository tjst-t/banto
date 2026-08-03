# 監査チェックリスト v0

タスクの監査で確認すべき項目の一覧。すべての項目がパスした場合のみ `verdict: "pass"` を報告する。
一つでも問題があれば `verdict: "fail"` とし、具体的な指摘を findings に記述する。

## 必須チェック項目

### 1. タスク定義の acceptance criteria の充足
- [ ] タスク定義ファイル（frontmatter）に記載されたすべての acceptance criteria が満たされているか
- [ ] 各 acceptance criteria の検証コマンド（verify フィールド）があれば、その結果が正常か

### 2. スコープ遵守（P1）
- [ ] タスクの `scope.paths` に指定されたファイル以外の変更が含まれていないか
- [ ] スコープ外ファイルへの変更が「ついで」で行われていないか
- [ ] スコープ外で発見した問題は incident として記録されているか（直接修正されていないか）

### 3. エラー取り扱い（I2）
- [ ] エラーが握りつぶされていないか（空の catch ブロック、サイレントな失敗など）
- [ ] 回復不能なエラーは failed 状態として記録されているか

### 4. 型安全性（I4）
- [ ] TypeScript strict モードに違反していないか
- [ ] `any` を使う場合は、その行に理由コメントが付いているか

### 5. 依存追加の理由記録（D6）
- [ ] 新しい外部依存を追加した場合、追加理由が 1 行コメントで記録されているか

### 6. エスカレーション未判断事項（D1）
- [ ] 不可逆な選択（公開 IF 変更、データモデル変更、外部依存追加）を自己判断していないか
- [ ] 判断が必要な場合は escalate されているか

## 合格基準

上記すべての項目がパスした場合のみ `verdict: "pass"` を報告する。
疑わしい点がある場合は `verdict: "fail"` として findings に具体的な問題を記述する。

## 基準の変更について

この checklist の変更は git diff として見える（D2: 基準はテキスト、機構はコード）。
基準を変更する場合はこのファイルを編集し、変更理由を commit message に記録する。

CHECK-MARKER-42

CHECK-MARKER-42

CHECK-MARKER-42

CHECK-MARKER-42

CHECK-MARKER-42

CHECK-MARKER-42

CHECK-MARKER-42

CHECK-MARKER-42

CHECK-MARKER-42
