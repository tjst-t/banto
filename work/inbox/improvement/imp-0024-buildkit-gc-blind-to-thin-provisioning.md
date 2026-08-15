---
id: imp-0024
kind: improvement
status: open
created: 2026-08-14
refs: [imp-0023]
---

# ビルドキャッシュの上限が「ゲストの df」基準で、thin provisioning では効かない

## 何が起きるか

docker のビルドキャッシュが際限なく膨らむ。2026-08-14 のディスク監査では
**6.263 GB**（うち 4.446 GB は回収可能）まで育っていた。prune で 0B にした直後から
**10分で 545.6 MB / 8レコード**まで戻る。

BuildKit には既定の GC ポリシーが入っているのに発火しない。`docker buildx inspect` で
見える値がこれ:

| ルール | Max Used Space | Min Free Space |
|---|---|---|
| rule#0（source.local 等） | 3.346 GiB | — |
| rule#1〜3（全体） | **187.2 GiB** | 47.5 GiB |

**BuildKit はディスクサイズから上限を自動計算する**——250 GiB の約75% が 187.2 GiB、
空きが 47.5 GiB を切ったら GC、という設定になっている。

ところが**この VM は thin provisioning**で、ゲストの `df` が返す「空き 206 GiB」は
ホストの実消費と無関係の嘘である。ゲストから見て空きが潤沢なあいだ、GC は一度も
発火しない。**ホスト側のプールが尽きても、BuildKit から見れば「まだ 180 GiB 使える」。**

2026-08-14、この VM は実空き容量の枯渇で書き込みができなくなり、
**VM ごと落ちた**（メモリ不足ではない）。ビルドキャッシュだけが原因とは言えないが、
「際限なく書き続ける機構が、止まる条件を持っていない」ことは事実として残る。

## なぜ問題か

- **止まる条件が、この環境では嘘の数字に依存している。** 空き容量基準
  （`minFreeSpace` / `reservedSpace`）は thin では意味を成さない。
- **気づく手段が無い。** 膨らんでいることは誰も見ておらず、落ちて初めて分かった。
- 掃除は毎回手作業になる（今回も職人に prune させた）。

## どう直すか

構成: Docker 29.7.1 / buildx driver=`docker`（BuildKit は dockerd 組み込み v0.32.0）。
したがって設定先は `/etc/docker/daemon.json` の `builder.gc`（`buildkitd.toml` は
別ドライバ用で該当しない）。`--keep-storage` はこのバージョンには無く、後継は
`--reserved-space` / `--max-used-space` / `--min-free-space`。

### 案A（本命・ブロックあり）

`/etc/docker/daemon.json` を新規作成する。

```json
{ "builder": { "gc": { "enabled": true,
    "policy": [ { "all": true, "maxUsedSpace": "8GB" } ] } } }
```

要点は **`maxUsedSpace` の絶対値で切ること**。空き容量基準は thin では効かない。
値は実測ピーク 6.263 GB を踏まえて 8 GB（締めるなら 4 GB）。

**ブロッカー**: `/etc` が read-only マウント（`ro,nosuid,relatime`）で
`/etc/docker` を作れない。root での再マウントか、ホスト側のプロビジョニングが要る。
反映には `systemctl restart docker` が要る公算が高く（`ExecReload` は SIGHUP だが
`builder.gc` を拾うかは未確認）、全コンテナが落ちるのでメンテ枠が要る。

### 案B（root 不要・再起動不要・今日から効く）

`docker builder prune -f --max-used-space 8GB` をビルド直後に差し込む。
`ubuntu` は docker グループなので現在の権限で実行できる。差し込み先は
`packages/banto-environment-pool/src/docker-driver.ts` の
**322行目**（`docker compose up -d --build`）と **451行目**（`docker compose build`）。
リポジトリ内に prune 系の呼び出しは現状ひとつも無い。

### 順序

**B を先に入れ、A はメンテ枠で。** A だけを待つと、その間ずっと上限は 187 GiB のまま。

## 確かめていないこと

- **案A の JSON キー名**。`buildx inspect` の表示から `maxUsedSpace` 等と推定しているが、
  旧版は `defaultKeepStorage` / `keepStorage` だった。Docker 29.7 のドキュメントで
  要確認。検証は `dockerd --validate --config-file=...` で稼働中の daemon に触れずにできる。
- SIGHUP のリロードが `builder.gc` を拾うか。
- ホスト側の thin プールが TRIM で実際に返っているか（ゲストからは原理的に見えない）。

## 付記

PO 確認（2026-08-14）: **ホスト側の実空きは十分にあり、この VM はほぼ全容量を使ってよい**。
したがって「容量を空けること」自体は急ぎではない。**上限で締め上げるより、
際限なく膨らんだときに気づけること**の方に価値がある——案B を入れるなら、
prune した量をログに残して見えるようにすること。

測定の詳細は `banto-desk/reports/2026-08-14-disk-audit.md`。
