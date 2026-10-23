# Backlog の Gist バックエンド（2026-10-23、Backlog #535）

仕様は `docs/specs/v4-modules.md` §4.4「Gist の置き場」。ここには決め方と、採らなかった案を残す。

## 前提

- アーキ仕様 §4.6（メタ Project の下書き、`fork/meta-project` に置いてある）：「Gist 1つが台帳全体に当たる（tasks.json を
  1ファイルとして持つ）。楽観ロックは Gist API の blob sha で行う（具体の実装は作るときに決める）」
- 選ぶ場所はモック `mock/components/banto/settings/backlog-config-section.tsx`（`fork/meta-project` 側）——Backlog Module 自身の
  設定 Canvas で、Project ごと

## 楽観ロック——REST の PATCH ではなく、Gist の git への push

**案A（採らなかった）：REST の `PATCH /gists/{id}`**。`GET` で版（`history[0].version`）を読み、書く直前にもう一度読んで
比べ、書く。GitHub の REST には `If-Match` 等の**条件つきの更新が無い**ので、比べてから書くまでの間に入った書き込みは
黙って消える（lost update）。書いた後の返事の `history[1]` で「割り込まれた」ことは分かるが、もう消した後で、直すには
割り込んだ版の上で操作をやり直してもう一度書く——その間にまた割り込まれうる。compare-and-swap にならない。

**案B（採った）：Gist の git（`https://gist.github.com/<id>.git`）に、読んだコミットを親にして force せずに push**。
受け取る側（GitHub）が「fast-forward でない」と断るので、本物の compare-and-swap になる。仕様の下書きの「内部的に小さな
git（blob の sha）で楽観ロックができる——今の tasks.json バックエンドの仕組みをほぼそのまま移植できる」はこちらの形。
版は blob の sha ではなく Gist のコミットの sha（同じ中身に戻した書き込みも区別できる）。

試験は手元の bare のリポジトリを Gist に見立てて、2つの店（別の手元の真似）から同時に6件書き、全部残ることを見る
（20回流して20回とも通った）。

Gist を**作る**のだけは REST（`POST /gists`）——git では作れない。

## 資格情報

- **Vault の alias（`secret`・`oauth-token`）を設定で選び、使うたびに中継で引く**（窓口の `lookupAlias` → 金庫の
  `resolveAlias`。Shell の envSecrets と同じ口）。コンテナの中からなので、alias ごとに初回だけ人に聞かれる
- git へは credential helper で環境変数から渡す（コマンドの引数・URL に入れない）
- **採らなかった：Repositories に頼む**（ブランチを送る口と同じ形）。資格情報をコンテナに入れずに済むが、Repositories の
  GitHub のアカウントは GitHub App のトークンで、Gist の権限（account permission の Gists）を持つかを確かめていない。
  Repositories に Gist の口を足すのはこのタスクの外（規則7）。§4.4「まだ決めていない」に残した

## 店の形

- Module の中に口（`BacklogBackend`：読む・取ってくる・1件書く）を作り、tasks.json の店（`store.ts`）と Gist の店
  （`gist.ts`）がそれを持つ。server が**呼ぶたびに設定を読んで**どちらかへ渡す（画面で置き場を替えたら次の呼び出しから）
- 仕様 §4.4 の「まだ決めていない」は「実装の口は2本目のバックエンドが来たときに分ける」としていた。**別の Module には
  分けていない**（Vault・Publish の形——窓口の Module と実装の Module——にするかは人に上げる）。いまの口は Module の中だけ

## 確かめたこと

- 単体試験：`packages/modules/backlog/src/gist.test.ts`（店）・`server.test.ts`（tool の口で、Gist を選んで作成・分ける・
  更新・一覧、tasks.json に戻す、id・トークンが無ければ保存しない、`createGist`）
- 実ブラウザ：`e2e/specs/backlog.spec.ts` の設定の節で、置き場の選択肢・Gist の欄への切り替え・id が無いときに保存しない
  ことを見る。**本物の GitHub の Gist への読み書きは E2E では見ていない**（GitHub が要る）
