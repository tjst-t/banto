# Repositories Module の段階1（2026-10-01）

仕様は `docs/specs/v4-modules.md` §2.4。ここは**なぜそうしたか・却下した案・確かめたこと**の記録。

## 段階1の範囲

- Module の骨格（`banto/packages/modules/repositories/`）。既定で入っていて消せない・banto 全体に1本・banto 本体で動く
- 台帳（置き場所・リモートの場所）、origin との突き合わせ、フォルダが見つからない、一覧から外す＋元に戻す
- 既定の置き場（`~/banto`、設定の面で変えられる。値を持って見せるだけ）
- Import（人が選んだフォルダ1つ）
- 一覧の画面（launcher）と設定の面
- banto 全体の Module の入口を、どの Project にも出す（v4-frontend.md §6.2 の改訂の実装）

clone・新しいリポジトリ・GitHub に公開・アカウント・core の新しい Project の画面への持ち込みは段階2以降。

## Module から core の Project の一覧を読む口

**無かった。** 中継（`host-relay-endpoint.ts`）にあったのは他 Module の tool・資源・宛先の一覧・Project の
アドレス・Thread への返信だけ。

考えた案：

1. **Canvas の `hostContext` に Project の一覧を載せる**——却下。v4-frontend.md §6.2 が「渡すのは開かれた場所だけで、
   Project の一覧は渡さない（どの Canvas にも人の Project 名が全部見える）」と決めている。第三者の Module の画面にも
   同じ口が開く
2. **Module が Event Store を直接読む**——却下。core の内部の形に Module が縛られる。データ置き場の外を読むことになる
3. **画面（banto のフロント）が Project の一覧と台帳を突き合わせる**——却下。core が Repositories を名指しで知ることになる
   （§2.4「core は Repositories を名指しで知らない」）
4. **中継に `relayListProjects` を足す**——採用。`relayProjectAddress`（公開の実装が Project のアドレスを引く口）と同じ
   形で、引ける相手と場面を中継が絞る：
   - **同梱だけ**（第三者のコードには渡さない——案1と同じ理由）
   - **banto 本体で動く banto 全体の Module だけ**（コンテナの中では AI が合言葉を読める）
   - **人の画面からの呼び出しを処理している間だけ**（host の台帳 `ModuleCallTracker.originFor` が `canvas`。
     `canvas` は host が `{admin: true}` を刻んだ呼び出しにしか付かない）。AI のターンから引けると、AI が別の Project の
     名前と場所を知る道になる
   - 役割の名前（`repositories`）では絞らない——core は Repositories を名指ししない

返すのは id・名前・根のパス・状態だけ（Memory・会話は渡さない）。

## 入口をどの Project にも出す

`GET /api/projects/:id/ui-launchers` だけを広げると、**入口は出るのに開けない**——画面の中身（`ui-resource`）と
画面からの呼び出し（`ui-tool-call`）は Project の Module 集合しか見ていないので、Project の集合から外した banto 全体の
Module は 404 になる。3つの口を同じ関数（`modulesForProjectCanvas`）に寄せた。画面側（フロント）は API を呼ぶだけで、
変えたのは説明のコメントだけ。

## 決めたこと（仕様に書いたもの）とその理由

- **台帳にアカウントの項目を置かない**——段階1にはアカウントを登録する手が無く、書かれない項目を先に置くと
  「あるのに空」の写しになる。GitHub のものは「読むだけ」と示す
- **フォルダはあるがリポジトリでなくなった・読めない行も出す**——モックは「この相談の外」として一覧に出していなかった。
  黙って消えると、台帳にあるのに見えない行が残る（規則2）
- **フォルダをたどる窓は名前だけ**——モックは中のフォルダごとに git の印と「中にリポジトリが N 個」を出していた。
  それには選ばれていないフォルダの git を読む必要がある。この Module は閉じ込めの外で動くので、読むのは人が選んだ
  フォルダと台帳のフォルダの git だけにした（ユーザーの指示）
- **「git init して Import」は出さない**——新しいリポジトリ（git init）と一緒に作る。段階1で出してよいと言われたのは
  「Project を始める」「GitHub に公開」「clone し直す」の3つだけ（規則13）
- **見出しの右の「URL から clone」「新しいリポジトリ」も出さない**——同じ理由
- **Project の列は名前だけ（押して開かない）**——Canvas から banto の画面遷移を頼む口が無い（`ui/open-link` は
  http/https を別タブで開くだけ）。口を作るのは段階1の外
- **見つからない行の色は danger（banto の stop）**——仕様は turn 系だが、Canvas に渡る色は MCP Apps の標準の名前だけで
  turn に当たる名前が無い。実際の色は紫（stop）になる。**ユーザーに確かめたい点**
- **AI 向けの道具は持たない**——台帳はこのマシンのフォルダの場所で、コンテナの中の AI からは届かない
- **元に戻すは、外した行を画面が持って返す**——モックと同じ形。台帳に「外した印」（tombstone）を残す案もあったが、
  溜まり続けるうえ、段階1で要るのは直後の「元に戻す」だけ。戻すときは Module が形を確かめ、origin に合わせ直す
- **検索は画面に出ている字だけで引く**——最初は絶対パスでも引いていて、E2E の環境（home が `~/.local/…` の下）で
  「local」と打つと全部の行が残った。見えていない字で当たると、なぜ残ったかが分からない

## 確かめたこと

- 単体：Module 19本（本物の git で、使い捨ての home に作る）、core の中継・入口の試験を各1本、宣言・自己申告
- 壊して落ちることを確かめた箇所：刻印の確かめ・呼び出しの印・直したお知らせ・worktree の見分け・壊れた台帳を空と
  読む・並び順・見つからない間に台帳を直す（以上 Module）、中継の出所の判断（`origin !== "canvas"` を緩める）、
  入口の集合（banto 全体の Module を足さない・無い Project にも出す）、自己申告の食い違い
- E2E（`e2e/specs/repositories.spec.ts`）：別のデータディレクトリの core・本物の git・中継・画面。中継で人の画面から
  引けないように壊すと「Project で使っている」が出なくなって落ちることを確かめた
- **呼び出しの印を Module が渡さないように壊しても E2E は通る**——人の画面の呼び出しが1件だけ走っているなら、中継は
  印が無くても接続単位で「人の画面から」と判断する。印が要るのは AI のターンと同時に走るときで、そこは中継の単体試験
  と Module の単体試験が見ている

## 踏んだこと

- この環境（banto のサブエージェントとして動くセッション）では E2E がそのまま走らない：Incus は `sg incus` で、
  claude CLI の資格情報は無いので空の資格情報の置き場（`CLAUDE_SECURESTORAGE_CONFIG_DIR`）で走らせた。Repositories の
  spec は AI を使わない
- `String.raw` のテンプレートの中のコメントに「`」を書くと、TypeScript の文字列が途中で閉じる
