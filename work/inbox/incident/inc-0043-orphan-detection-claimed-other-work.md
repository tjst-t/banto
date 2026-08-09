---
id: inc-0043
type: incident
kind: incident
origin: po
class: safety
status: resolved
refs: [spec-environment, inc-0040, inc-0042]
---

## 内容

**検証環境の照合が、banto と無関係な docker プロジェクトを「孤児」として挙げていた。**

孤児（台帳に無い実リソース）を片付ける口を作ろうとしたところ、PO から
「banto 外の別の作業で作ったものを孤児と誤認する可能性はないか」と問われた。実測した。

banto と何の関係もない compose プロジェクトを1つ起こす。ディレクトリ名が `myapp-docker`
というだけのもの（**compose は既定でディレクトリ名をプロジェクト名にする**ので、
ごく普通に在りうる名前）：

```
ドライバの list:  myapp-docker
プールの照合:     orphans: [{"driver":"docker","name":"myapp-docker", ...}]
```

**堂々と孤児として挙がった。** 撤去したら消えた。

## 原因

`docker-driver.ts` の `list` は `docker compose ls` で**この機械の全プロジェクトを列挙**し、
**名前が `-docker` で終わるもの**を「自分のもの」としていた。コード中のコメントも
推測であることを認めていた：

> `We cannot filter by a specific taskId since list has no taskId input (spec §2).`
> `Instead, we return ALL <*>-docker projects`

**所有を名前の綴りから推測していた。** `process` ドライバは最初から自分が起こしたものを
state.json に記録して列挙しており、docker ドライバだけが推測に落ちていた。

## 危なかったところ

この状態で「孤児を自動で畳む」を実装していたら、**POの無関係なコンテナを破壊していた。**
PO が実装前に問わなければ、実装して初めて壊れる形だった。

## 直したこと（PO裁定 2026-08-08：a と b の両方）

**（a）所有は記録する。名前から推測しない**（`spec-environment` §2.1）

- provision で記録し、teardown で落とす。`list` は**記録と実在の積**を返す
- 記録に在るのに実在しないものは記録から落とす（外で消された分を溜めない）
- **記録を失ったら空を返す**＝何も自分のものと言わない。検出は落ちるが、他人のものを
  自分のものと言うことは無い——**倒れる向きを安全側にした**
- 名前空間も `<taskId>-docker` → **`banto-env-<taskId>`** に寄せた。ただしこれは
  二重の守りの片方であって、所有の根拠ではない

**（b）畳むのは名指しで1件ずつ**（`env.teardown_orphan`・spec §5）

- **一括で畳む口は作らない。** 見つからない・複数当たるときは畳まずに断る（I2）
- (a) を入れても誤検出がゼロだと証明はできない。**誤って報告する代償（雑音）と
  誤って畳む代償（取り返しがつかない）は釣り合わない**ので、畳むのは常に人か番頭の明示の一手

## 見張り

`tests/acceptance/env-orphan-ownership.spec.ts`。**検出の試験ではなく誤検出の試験**：

- 記録が空なら何も名乗らない
- **実物の `myapp-docker` を起こしても拾わない**（docker のある機械でだけ走る）
- 記録に在っても実在しなければ挙げない／記録が壊れていても何も名乗らない

docker が無い機械では2件目だけ skip し、記録側の3件は必ず走る——**docker のある機械でしか
回らない見張りは、無い機械では黙って消える**ため。

## 既存の試験が見逃していた理由

`env-docker-teardown-list.spec.ts` には **「list returns our project and excludes the unrelated
project」という試験が最初から在った**。それでもこの穴は通った。無関係な側の名前が
`unrelated-proj-<ts>` で、**ドライバの綴りの条件（`-docker` で終わる）に最初から当たらない
名前**だったため。コメントもそう書いてあった：

> `(it does not have the -docker suffix that the driver uses for its projects)`

つまり**試験が実装の綴りに合わせて書かれていた**ので、確かめていたのは「名前で濾せている」
ことだけだった。**実装の穴が、そのまま試験の穴になっていた。**

直した：無関係な側を `unrelated-proj-<ts>-docker`（＝いちばん紛らわしい名前）にし、
自分のものは**綴りではなく provision が返した handle** で照合するようにした。

## 学び

**「自分のものか」を名前で判断していた。** inc-0040（狭い画面の規約を*列挙*で書いていたので
新しいクラスに効かなかった）と同じ形の誤り——**規約や所有を「綴り」で表すと、綴りが違うものが
すり抜け、綴りが同じだけのものが巻き込まれる。** 根拠は記録に持つ。

もう1つ。**危険な機能は、危険な側の実装より先に「誤判定したら何が起きるか」を測る。**
今回それをしたのは私ではなく PO の問いだった。
