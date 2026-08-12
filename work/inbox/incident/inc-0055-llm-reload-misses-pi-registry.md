---
id: inc-0055
type: incident
kind: incident
origin: po
class: llm-registry
status: open
refs: [inc-0047, adr-0011]
---

## 内容

**`llm.reload` の後、追加したプロバイダは設定画面に出るのに、会話のモデルとして選べない。**

2026-08-11、調査用のプロバイダ `huihui-tap`（既存 `huihui` の複製で baseUrl だけ差し替え）を
pi の `models.json` に足し、`llm.reload` を実行した。

- **設定画面には出る。** 「採用中のモデル 1・deepseek-v4-flash-abliterated」に
  「番頭」「職人」の印まで正しく付く
- **切り替えは断られる**：`huihui-tap/deepseek-v4-flash-abliterated は使えるモデルの一覧にありません`
  （`bin.ts:1349`）

## 原因

**同じ `models.json` を、別々に読んでいる2つの経路がある。**

| 経路 | 読むもの | `llm.reload` で読み直すか |
|---|---|---|
| 設定画面の一覧 | `LlmCatalog`（`llm-registry.json` ＋ `models.json`） | **する**（`reload()` が overlay を捨てて読み直す） |
| モデルの切り替え | `bin.ts` の `resolveModel` → **pi の `ModelRegistry`** | **しない** |

`ModelRegistry` は起動時に一度だけ `ModelRuntime.create({ modelsPath })` から組まれ
（`bin.ts:684-688`）、以後 `models.json` を読み直さない。`llm.reload`（`llm-tools.ts:543`）が
呼ぶのは `catalog.reload()` だけで、pi 側の runtime には触らない。

そのため**起動後に足したプロバイダは、番頭からは「見えるが使えない」**という状態になる。

**Tool の説明文と実際の振る舞いが食い違っている**（P3）。`llm.reload` は
「pi の設定ファイル（models.json / auth.json）を読み直す」と名乗っているが、
それらから実際にモデルを解決している当のものを読み直していない。

## 確かめたこと（I1）

- **走っているホストでは選べない**（PO 実機・上記エラー）
- **いま `ModelRegistry` を組み直すと見える**：同じ `models.json` から
  `ModelRuntime.create` → `new ModelRegistry` を作って引くと、
  `huihui/deepseek-v4-flash-abliterated` も `huihui-tap/deepseek-v4-flash-abliterated` も
  **両方 `find` で見つかる**。つまり内容の問題ではなく、**読み直していないだけ**
- `models-store.json` には `opencode` / `opencode-go` しかなく、huihui 系は
  `models.json` の静的な `models[]` から解決されている（遠隔の目録は関係ない）

## 当座の回避

**番頭ホストを再起動する**（`system.restart`）。起動時に `ModelRuntime` が組み直されるので
新しいプロバイダが使えるようになる。

再起動そのものは安全であることを確認済み——`/etc/systemd/system/banto.service.d/override.conf`
に `Restart=always` があり（ユニット本体の `Restart=on-failure` はこれに上書きされる）、
`NeedDaemonReload=no`。`system.restart` の `exit(0)` で systemd が起こし直す。

ただし**稼働中の職人は中断され、検証環境は cgroup の巻き添えで落ちる**ので、
事前に `worker.list` / `env.list` を見ること（safe-restart SKILL の手順どおり）。

## 直すべきこと（未着手）

- `llm.reload` で **pi の `ModelRuntime` / `ModelRegistry` も組み直す**。
  `ModelRuntime.create` は非同期なので、`resolveModel` などの閉包が掴んでいる参照を
  差し替えられる形（可変のホルダ経由）にする必要がある
- 直せないなら、**説明文の側を実態に合わせる**（「プロバイダを足したときは再起動が要る」と
  書く）。どちらでもよいが、**食い違ったままにしない**（P3）
- 回帰試験：起動後に `models.json` へプロバイダを足し、`llm.reload` 後に
  `resolveModel` が解決できること
