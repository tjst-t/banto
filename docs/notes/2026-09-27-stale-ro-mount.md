# 報告：起動元を切り替えたあと、Project のコンテナに古い読み取り専用マウントが残る

**宛先**：修正を担当する AI。この文書だけで作業に入れるように書いてある。

## 1. 背景

- banto は Project ごとに Incus のシステムコンテナを作り、その中で Project の Module を動かす
  （`docs/specs/v4-security.md` §1・§2）
- コンテナには2種類の disk デバイスを付ける（`banto/packages/container/src/project-container.ts` の `ensureNow`、
  コミット `ccd056a3` 時点）
  - `banto`：banto 自身のコードの置き場（`bantoDir`＝ `cli.ts` の `monorepoRoot`）。**読み取り専用**、同じ絶対パス
  - `project`：Project の根。読み書き可、同じ絶対パス
- 置き場が変わっていれば、`incus config device remove <name> banto` で外してから、`addDevices`
  （`incus query -X PATCH /1.0/instances/<name>` で devices を足す）で付け直す。**コンテナは起こし直さない**
  （起こし直すのは `security.nesting` が変わったときだけ）
- 2026-09-27、稼働中の banto の起動元を、開発用リポジトリ `~/ghq/github.com/tjst-t/banto` から
  リリース用の clone `~/.local/share/banto-release` に切り替えた（`docs/runbooks/release.md`）。
  理由は下の「3. 元の問題」

## 2. 起きたこと（実測、2026-09-27、banto 開発の Project のコンテナの中で）

切り替えて host を再起動し、その Project で話しかけた（Module が起き直した）あとの `/proc/self/mountinfo`：

```
1280 1309 8:1 /home/ubuntu/ghq/github.com/tjst-t/banto/banto /home/ubuntu/ghq/github.com/tjst-t/banto/banto ro,relatime ...   ← 古い。残っている
1285 1309 8:1 /home/ubuntu/ghq/github.com/tjst-t/banto       /home/ubuntu/ghq/github.com/tjst-t/banto       rw,relatime ...   ← Project の根
1286 1309 8:1 /home/ubuntu/.local/share/banto-release/banto  /home/ubuntu/.local/share/banto-release/banto  ro,relatime ...   ← 新しい。期待どおり
```

- 新しい置き場は ro で見え、`touch` は `Read-only file system` で断られた（期待どおり）
- Module 3つ（shell・filesystem・subagent）は 06:33:05 に新しい置き場のパスから起き直していた（`ps`）
- 06:35 と 06:42 の2回見て、古いマウント（1280）はどちらも残っていた
- コンテナの PID 1 の起動は 2026-09-25 09:55:25——**コンテナは切り替えのあいだ一度も起こし直されていない**

## 3. 元の問題（切り替えの前から。これが切り替えの理由）

- banto で banto を開発する Project では、`bantoDir`（`…/banto/banto`）が Project の根（`…/banto`）の**中**にある
- mountinfo では ro の `…/banto/banto`（1280）が先、rw の根（1285）が後に乗っていた。**後から乗った親に隠れて、
  ro が効いていなかった**（中から `banto/` 以下に書き込めた、2026-09-27 実測）
- 帰結：コンテナの中の AI が書き換えたコードが、次の再起動で host の権限のまま動く（Vault など banto 本体で
  動く Module も同じコードを読む）。**閉じ込めの抜け道**
- 起動元を根の外に移したので、この Project ではいまは起きない。**ただしコードに防ぎは無い**——`bantoDir` が
  どこかの Project の根の中にあれば、同じことが黙って起きる

## 4. 推測（未確認）

- **古いマウントが残る理由**：`device remove` のとき Incus は中でそのパスを外そうとするが、そのパスは親の rw
  マウントに隠れていて、パスで指しても隠れたマウントに届かない。外す処理が空振り（または失敗を無視）した
- **順番の理由**：`banto` と `project` は同じ PATCH で足されるが、Incus が付ける順番（名前順・深さ順など）は
  確かめていない。コンテナの起動時と、動いているときの後付けで順番が違う可能性もある
- host 側で `incus config device show <コンテナ名>` を見れば、古いデバイスが登録から消えているか
  （＝マウントだけ残った）、登録ごと残っているか（＝remove が失敗した）が分かる。
  `poc/10-project-vm/probe.sh` の手順 0c がこれを出す（まだ実行していない）

## 5. 影響

- **今回残った古いマウントの実害はほぼ無い**：親に隠れていて中から辿れない。コンテナを起こし直せば消える見込み
- **重いのは 3. のほう**：根の中に `bantoDir` がある構成で、ro が効かないことに誰も気づけない

## 6. 直してほしいこと

1. **`bantoDir` が Project の根の中（または根と同じ）なら、そのコンテナを作らず断る**（規則2：黙って弱い形に落ちない）。
   理由と直し方（`docs/runbooks/release.md` の手順で別の clone から動かす）を受信箱に出す。
   逆向き（根が `bantoDir` の中）も、ro の中に rw が乗るので同じく検討する
2. **disk デバイスを付け直したあと、中のマウントが実際にそうなっているかを確かめる**。
   `incus exec <name> -- cat /proc/self/mountinfo` で、`banto` のパスが ro で**いちばん上**に見えること・
   外した古いパスのマウントが残っていないことを見る。合わなければコンテナを起こし直す
   （起こし直しは既存の `stop`→`start` の経路と、止めすぎないための上限を使う）
3. 4. の推測を host で確かめ、どちらだったかをこの文書に追記する

## 7. 確かめ方（完了の条件）

- 単体（`project-container.test.ts`、偽の Incus）：
  - `bantoDir` が根の中なら ensure が理由つきで失敗する
  - 置き場が変わったときに付け直し、確かめで古いマウントが見えたら stop→start が呼ばれる
- 統合（`project-container.integration.test.ts`、本物の Incus、host で）：
  - 根の外の置き場 A で作る → 置き場 B に変えて ensure → 中の mountinfo に A が無く、B が ro で見える
- **直したコードを元に戻すと、新しいテストが落ちることを確かめる**

## 8. 触らないもの

- 起動元を分ける方針そのもの（`v4-security.md` §2、決定済み）
- Project の根のマウントの持ち方（rw・同じ絶対パス）
