---
id: imp-0049
title: 「setup が exit 0 なら用意できている」という契約が甘い
status: inbox
kind: improvement
origin: imp-0043 の職人からの申し送り（案 b を意図的に入れずに残した部分）
refs:
  - packages/banto-environment-pool/src/docker-driver.ts
  - docs/adr/adr-0026-one-entrance-contract-from-the-tool.md
created: 2026-08-15
---

## 何が残っているか

imp-0043 で、**symlink がボリュームの載り先を横取りする形**は関所
（`assertVolumeTargetsAreNotSymlinks`）で塞いだ。しかし塞いだのは**その形だけ**で、
契約そのものは「`setup` が exit 0 を返したら用意できている」のまま。

したがって **symlink 以外の理由で「用意した場所」と「検証コンテナが見る場所」がずれる形**は
依然として素通りする。ずれたときの症状は今回と同じ——`npm test` が exit=127
（`vitest: not found`）、`npm run build` が exit=127（`tsc: not found`）で、
**中身と無関係にマージ前ゲートだけが落ちる**。原因が環境側にあるとは読めないので、
番頭も職人も実装を疑って時間を溶かす。

## 直す方向（案）

`setup` の終了コードではなく、**用意の成果が検証コマンドと同じ器から見えること**を
provision の成功条件にする。imp-0043 の試験 a2 が既にその形を持っている
（`cat /app/node_modules/marker` → `prepared` を**検証コンテナ側から**読む）ので、
これを試験の中だけでなく provision 本体の関所へ引き上げる。

- 見るものはプロファイルの `cache.path`（`test` なら `/app/node_modules`）
- 「空でないこと」ではなく「**setup が置いたはずの目印が読めること**」で判定する
  （空でない判定だと、古い置き場を掴んでいる場合に通ってしまう）
- 通らなかったときは、どのパスを・どの器から・何を期待して見たのかをエラーに書く

## 併せて考えること

- I2：確認できないときに「壊れている」と言わない線引きは imp-0043 の判断を踏襲する
  （`docker compose config` が引けないときは確認を飛ばして続行する）。
  ただし**この関所は「見えなければ落とす」側**——用意の成果が見えないなら、
  検証は必ず落ちるのだから、先に読める理由で断る方がよい。
- ADR-0026（道具からの一本の入口）の線と衝突しないか確認すること。
