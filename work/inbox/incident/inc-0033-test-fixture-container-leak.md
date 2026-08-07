---
id: inc-0033
type: incident
kind: incident
origin: agent
class: resource-leak
status: open
refs: [task-0074, inc-0032]
---

## 内容

**受け入れテストが立てた docker コンテナが 20 時間走り続けていた。**

`docker ps` に `unrelated-proj-1786030924783-svc-1`（Up 20 hours）。名前から
`tests/acceptance/env-docker-teardown-list.spec.ts` の fixture と分かる——
「ドライバの `list` に無関係なプロジェクトが出ないこと」を確かめるために立てる busybox。

テストは `after()` で `docker compose -p <name> down -v` を呼ぶ形になっているので、
**テストが途中で落ちたときの取り残し**と見られる（`after()` が走らなかった）。

## なぜ困るか

- **誰も気づかない**。`env.list` にも出ない（Environment Pool の台帳を通していない、
  テストが直に立てたコンテナなので照合の対象外）
- 実機のメモリと CPU を握り続ける。今回は busybox の `sleep` なので実害は小さいが、
  **同じ形で重いコンテナが残れば効く**
- **task-0074 で直した one-off の畳み忘れとは別の穴**。あちらはドライバの teardown、
  こちらはテスト自身の後始末

## 直し方（案・PO判断）

- テスト側：`after()` に頼らず、**プロセス終了時にも畳む**（`process.on("exit")` は
  非同期処理を待てないので、実際には「テスト開始時に古い fixture を掃除する」方が確実）
- あるいは：fixture のプロジェクト名に共通の接頭辞を付け、**テスト群の入口で
  接頭辞ごと掃除する**（今回の `unrelated-proj-<ts>` は既に接頭辞を持っている）

**このセッションでは手で消しただけ**（PO の問いに答えるのが本題だったため）。
テスト側の後始末は別タスク。
