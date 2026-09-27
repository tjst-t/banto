# 依頼：Project のコンテナのマウントを2点直す

**宛先**：修正を担当する AI。この文書だけで作業に入れるように書いてある。
**やることは2つだけ**（§3）。ユーザーと相談して範囲を絞った（2026-09-27）。

## 1. 仕組み（前提）

- banto は Project ごとに Incus のシステムコンテナを作り、その中で Project の Module を動かす
  （`docs/specs/v4-security.md` §1・§2）
- コンテナには disk デバイスを付ける。場所は `banto/packages/container/src/project-container.ts` の `ensureNow`
  （呼び出し元は `banto/packages/core/src/cli.ts` の `containers.ensure({...})`）
  - `banto`：banto 自身のコードの置き場（`spec.bantoDir`＝ `cli.ts` の `monorepoRoot`）。**読み取り専用**・同じ絶対パス
  - `project`：Project の根（`spec.root`）。読み書き可・同じ絶対パス
- 置き場が変わっていれば、`incus config device remove` で外してから `addDevices`（`incus query -X PATCH`）で
  付け直す。**いまはコンテナを起こし直さない**（起こし直すのは `security.nesting` が変わったときだけ）

## 2. 何が起きたか（平易に）

**① 「書き換え禁止」が効いていなかった**
banto で banto を開発する Project では、banto のコードの置き場（`…/banto/banto`）が Project の根（`…/banto`）の
**中**にあった。中のマウントでは、読み取り専用の `…/banto/banto` の**上に**、後から読み書き可の根が乗り、
読み取り専用を隠していた（2026-09-27 実測。中から `banto/` 以下に書き込めた）。コンテナの中の AI が書き換えた
コードが、次の再起動で host の権限のまま動きうる——閉じ込めの抜け道。
**いまは解消済み**：稼働中の banto をリリース用の clone（`~/.local/share/banto-release`）から動かすようにした
（`docs/runbooks/release.md`）。**ただしコードに防ぎが無く**、同じ置き方をしても黙って動く。
Project の根をホームにした場合も同じで、banto のコード・データ（Vault の中身を含む）・設定がすべて根の中に入る。

**② 付け直したあと、古いマウントが残った**
起動元を切り替えたあと、中の `/proc/self/mountinfo` に古い `…/ghq/github.com/tjst-t/banto/banto`（ro）が
残っていた（新しい置き場は ro で正しく見え、書き込みも断られた）。コンテナは切り替えのあいだ一度も起こし直されて
いない。古いマウントは親の根に隠れて中から辿れないので実害はほぼ無いが、中の状態が宣言とずれている。
原因の推測（未確認）：隠れたマウントはパスで指しても届かず、外す処理が空振りした。

## 3. 直してほしいこと

### 3.1 危ない場所を Project の根にさせない

**Project の根が、次のどれかを含む（または同じ）なら、そのコンテナを作らず理由つきで断る**：

- banto のコードの置き場（`spec.bantoDir`）
- banto のデータの置き場（`spec.owner`＝ bootstrap の `dataDir`。既定 `~/.local/share/banto`）
- banto の設定（`resolveBootstrapConfigPath()` のあるフォルダ。既定 `~/.config/banto`）

- 判定は realpath 同士で、「根がこれらの祖先か同じか」を見る（`path.relative` で `..` から始まらない等）
- 断るときは、既存の「前提が欠けていれば断る」と同じく**受信箱に理由と直し方**が出るようにする
  （直し方の例：「Project の根をもっと狭いフォルダにしてください」／banto 開発なら runbook の別 clone）
- ユーザーはホームを根にする Project を作らないと決めた（2026-09-27）ので、断って困る使い方は無い

### 3.2 付け直したらコンテナを起こし直す

- `ensureNow` で **`banto` か `project` の disk デバイスを外して付け直したときは、コンテナを起こし直す**
  （既存の `needsRestart` に乗せる。`stop` の、止めすぎないための上限もそのまま使う）
- 作ったばかり（`created`）で初めて付けるときは起こし直さなくてよい
- `ensureDisk`（Module の置き場）は対象外——こちらは付け足しだけで、置き場の移動は起きない
- 起こし直すと中で動いていたものは止まる。置き場が変わるのはまれで、Service（`docs/specs/v4-modules.md` §4.2）は
  コンテナの起動時に systemd が起こすので、これで許容する

## 4. 完了の条件

- 単体（`banto/packages/container/src/project-container.test.ts`、偽の Incus）：
  - 根が `bantoDir`・`owner`・設定のフォルダを含むと、`ensure` が理由つきで失敗し、コンテナを作らない。
    根が兄弟や子（例 `~/ghq/x` と `~/.local/share/banto`）なら通る
  - 動いているコンテナで `bantoDir` を変えて `ensure` → remove・add のあと stop→start が呼ばれる。`root` を変えても同じ
  - 何も変わらない `ensure` では stop が呼ばれない
- 統合（`project-container.integration.test.ts`、本物の Incus、host で）：
  根の外の置き場 A で作る → B に変えて `ensure` → 中の mountinfo に A が無く、B が ro で見える
- **直したコードを元に戻すと、新しいテストが落ちることを確かめる**
- 稼働中の banto への反映は `docs/runbooks/release.md` の B（人が host で行う）

## 5. 触らないもの

- 起動元を分ける方針（`v4-security.md` §2、決定済み）
- Project の根のマウントの持ち方（読み書き可・同じ絶対パス）
- 仕様の更新：3.1 と 3.2 を `docs/specs/v4-security.md` §2 に「決定」として書き、同じ節にある
  「切り替え後も古い読み取り専用のマウントが残った」の項を、直したことに合わせて書き換える
