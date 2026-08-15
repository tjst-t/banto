---
id: imp-0053
title: env.verify（docker）が、職人の使っている作業ツリーの node_modules を空にする
status: inbox
kind: improvement
origin: imp-0051 の作業中に実際に踏んだ。番頭が検証を回した直後、同じ作業ツリーで動いていた職人の実行が壊れた
refs:
  - packages/banto-environment-pool/src/docker-driver.ts
  - work/inbox/improvement/imp-0043-gate-env-has-no-node-modules.md
  - work/inbox/incident/inc-0070
created: 2026-08-15
---

## 何が起きたか

imp-0051 の作業中、番頭が

```
env.verify({ repoPath: <職人が作業中のワークツリー>, profile: "test", cmd: "npm run typecheck && npm test" })
```

を回した。その直後、**同じ作業ツリーで動いていた職人の実行が落ちた**——`tsx` /
`typebox` / `typescript` が「ディレクトリだけ残って中身ゼロ」になっていた
（`ERR_MODULE_NOT_FOUND`。生の出力は
`work/inbox/improvement/imp-0051-measurements.log` の 1〜3 回目に残っている）。

原因は imp-0043 で判明している形と同じ筋：**docker の `test` プロファイルは作業ツリーを
bind mount しており、コンテナ側の `setup`（`npm ci --include=dev`）が
node_modules を消してから入れ直す**。その入れ直しの最中（および終わったあと）の
node_modules は、ホスト側から見ると**中身が入れ替わっている**。

同じ頃、`audit-checklist-assets.spec.ts` が
**`EACCES: permission denied, open 'skills/audit-checklist.md'`** で落ちた
（全量2回中1回）。**コンテナの root が書いたファイルがホスト側に残る**筋と符合する。
inc-0070 に「間欠」として挙がっている失敗の一部は、**間欠ではなくこれ**である
可能性がある。

## なぜ気づきにくいか

- `env.verify` は「環境は畳みました」と答えて**正常に終わる**。壊したことは何も言わない
- 壊れるのは**検証した側ではなく、同じ作業ツリーを使っている別の誰か**
- 症状が「依存が入っていない」なので、職人も番頭も**自分の変更**を疑う
- 番頭には作業ツリーが「誰かに使われているか」を確かめる手立てが無い
  （`worker.list` に `worktree` は出るが、`env.verify` はそれを見ていない）

## 直す方向（案）

1. **使用中の作業ツリーへ破壊的な setup を打たない。** `driver: process` には既に
   「稼働中の作業ツリーに破壊的な setup を打とうとしたので弾きました」という関所がある
   （実際に今回も別経路で弾かれた）。**docker ドライバにも同じ判定が要る**——
   bind mount している以上、器の中で走らせても壊れる先はホストである
2. 判定の材料は既にある：`worker.list` が持つ稼働中職人の `worktree`。そこと
   bind 元が重なるなら、**断るか、複製を切ってそちらで回す**
3. 断るときは今回の症状（`ERR_MODULE_NOT_FOUND` / `EACCES`）まで書く。
   「使用中です」だけだと、後から踏んだ人が結び付けられない

## 併せて

- コンテナが**root で**ホストの作業ツリーへ書く点そのものも見直したい
  （imp-0043 の見分け方に「root 所有なら container の npm が書いた」とある）。
  所有者が入れ替わると、以後ホスト側の職人が書けなくなる
- inc-0070 の間欠のうち、`EACCES` / `cancelled` の面は**この線で説明が付かないか**
  洗い直す価値がある（間欠として様子見にすると、原因が別にあるまま数だけ増える）
